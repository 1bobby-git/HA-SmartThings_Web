import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  assertHaosCoreRestartGuestResponse,
  buildHaosBridgeHealthRemoteCommand,
  buildHaosCoreContainerStateRemoteCommand,
  buildHaosCoreInfoRemoteCommand,
  buildHaosCoreRestartRemoteCommand,
  evaluateHaosCoreRestartContinuity,
  evaluateHaosCoreRestartPreflight,
  healthIsUsable,
  parseHaosCoreContainerStateGuestResponse,
  parseHaosCoreInfoGuestResponse,
  type HaosCoreContainerState
} from "./haos-core-restart-continuity-core.js";
import { parseHealthGuestExec, assertOutputDirectoryOutsideRepo } from "./haos-soak-core.js";
import { inspectSoakDeploymentGate } from "./haos-soak-deployment-gate-core.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const DEFAULT_WAIT_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 2;
const REQUIRED_HEALTHY_SAMPLES_AFTER_RESTART = 3;

interface CliOptions {
  execute: boolean;
  runDirectory: string;
  outputDirectory: string;
  repositoryRoot: string;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
  expectedCoreVersion: string;
  expectedBridgeVersion: string;
  maximumWaitMs: number;
  intervalMs: number;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const commands = {
    coreInfo: buildHaosCoreInfoRemoteCommand(options.vmId),
    coreContainer: buildHaosCoreContainerStateRemoteCommand(options.vmId),
    bridgeHealth: buildHaosBridgeHealthRemoteCommand(options.vmId, options.addonSlug),
    coreRestart: buildHaosCoreRestartRemoteCommand(options.vmId)
  };
  const [soakGate, baselineCoreInfo, baselineCoreContainer, baselineHealth] = await Promise.all([
    inspectSoakDeploymentGate({
      runDirectory: options.runDirectory,
      repositoryRoot: options.repositoryRoot
    }),
    collectCoreInfo(options.sshTarget, commands.coreInfo),
    collectCoreContainer(options.sshTarget, commands.coreContainer),
    collectHealth(options.sshTarget, commands.bridgeHealth)
  ]);
  const preflight = evaluateHaosCoreRestartPreflight({
    soakGate,
    coreInfo: baselineCoreInfo,
    coreContainer: baselineCoreContainer,
    health: baselineHealth,
    expectedCoreVersion: options.expectedCoreVersion,
    expectedBridgeVersion: options.expectedBridgeVersion
  });

  if (!options.execute || !preflight.executionEligible) {
    writeProgress({
      event: options.execute ? "haos_core_restart_blocked" : "haos_core_restart_preview",
      mode: options.execute ? "execute" : "preview",
      remoteMutationPerformed: false,
      executionEligible: preflight.executionEligible,
      reasons: preflight.reasons,
      preflight
    });
    if (!preflight.executionEligible) {
      process.exitCode = 1;
    }
    return;
  }

  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error("haos_core_restart_output_not_empty");
  }
  const startedAtMs = Date.now();
  assertHaosCoreRestartGuestResponse(
    await runSsh(options.sshTarget, commands.coreRestart)
  );

  let healthSampleCount = 0;
  let healthSampleErrorCount = 0;
  let unhealthyHealthSampleCount = 0;
  let consecutiveHealthySamples = 0;
  let lastHealth = baselineHealth;
  let lastCoreContainer: HaosCoreContainerState = baselineCoreContainer;
  const deadlineMs = startedAtMs + options.maximumWaitMs;
  while (Date.now() < deadlineMs) {
    await delay(options.intervalMs);
    const [healthResult, containerResult] = await Promise.allSettled([
      collectHealth(options.sshTarget, commands.bridgeHealth),
      collectCoreContainer(options.sshTarget, commands.coreContainer)
    ]);
    if (healthResult.status === "fulfilled") {
      healthSampleCount += 1;
      lastHealth = healthResult.value;
      if (healthIsUsable(lastHealth)) {
        consecutiveHealthySamples += 1;
      } else {
        unhealthyHealthSampleCount += 1;
        consecutiveHealthySamples = 0;
      }
    } else {
      healthSampleErrorCount += 1;
      consecutiveHealthySamples = 0;
    }
    if (containerResult.status === "fulfilled") {
      lastCoreContainer = containerResult.value;
    }
    const restartObserved =
      Date.parse(lastCoreContainer.startedAt) > Date.parse(baselineCoreContainer.startedAt);
    writeProgress({
      event: "haos_core_restart_monitor",
      restartObserved,
      healthSampleCount,
      healthSampleErrorCount,
      unhealthyHealthSampleCount,
      consecutiveHealthySamples
    });
    if (
      restartObserved &&
      consecutiveHealthySamples >= REQUIRED_HEALTHY_SAMPLES_AFTER_RESTART
    ) {
      break;
    }
  }

  const postCoreInfo = await collectCoreInfo(options.sshTarget, commands.coreInfo);
  const postCoreContainer = lastCoreContainer;
  const postHealth = lastHealth;
  const endedAtMs = Date.now();
  const summary = evaluateHaosCoreRestartContinuity({
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    baselineCoreInfo,
    postCoreInfo,
    baselineCoreContainer,
    postCoreContainer,
    baselineHealth,
    postHealth,
    healthSampleCount,
    healthSampleErrorCount,
    unhealthyHealthSampleCount
  });
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  await writeFile(join(outputDirectory, "summary.json"), serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await writeFile(join(outputDirectory, "summary.json.sha256"), `${digest}  summary.json\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  writeProgress({
    event: "haos_core_restart_completed",
    mode: "execute",
    remoteMutationPerformed: true,
    status: summary.status,
    failures: summary.failures,
    durationMs: summary.durationMs,
    healthSampleCount: summary.monitoring.healthSampleCount,
    summarySha256: digest,
    outputDirectory
  });
  if (summary.status !== "pass") {
    process.exitCode = 1;
  }
}

async function collectCoreInfo(target: string, command: string) {
  return parseHaosCoreInfoGuestResponse(await runSsh(target, command));
}

async function collectCoreContainer(target: string, command: string) {
  return parseHaosCoreContainerStateGuestResponse(await runSsh(target, command));
}

async function collectHealth(target: string, command: string) {
  return parseHealthGuestExec(await runSsh(target, command));
}

async function runSsh(target: string, remoteCommand: string): Promise<string> {
  const result = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      target,
      remoteCommand
    ],
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true
    }
  );
  return result.stdout;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const allowedValues = new Set([
    "--run-dir",
    "--output-dir",
    "--repository-root",
    "--ssh-target",
    "--vm-id",
    "--addon-slug",
    "--expected-core-version",
    "--expected-bridge-version",
    "--maximum-wait-seconds",
    "--interval-seconds"
  ]);
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < args.length; ) {
    const key = args[index];
    if (key === "--execute") {
      if (execute) {
        throw new Error("haos_core_restart_arguments_invalid");
      }
      execute = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      !allowedValues.has(key) ||
      values.has(key) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("haos_core_restart_arguments_invalid");
    }
    values.set(key, value);
    index += 2;
  }
  const runDirectory = requiredPath(values.get("--run-dir"));
  const expectedCoreVersion = safeVersion(values.get("--expected-core-version"));
  const expectedBridgeVersion = safeVersion(values.get("--expected-bridge-version"));
  const repositoryRoot = resolve(values.get("--repository-root") ?? process.cwd());
  const outputDirectory = resolve(
    values.get("--output-dir") ?? defaultOutputDirectory(new Date())
  );
  if (execute && !values.has("--output-dir")) {
    throw new Error("haos_core_restart_arguments_invalid");
  }
  const sshTarget = safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true);
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    false
  );
  const vmId = boundedInteger(values.get("--vm-id") ?? "100", 1, 2_147_483_647);
  const maximumWaitMs =
    boundedInteger(
      values.get("--maximum-wait-seconds") ?? String(DEFAULT_WAIT_SECONDS),
      30,
      600
    ) * 1_000;
  const intervalMs =
    boundedInteger(
      values.get("--interval-seconds") ?? String(DEFAULT_INTERVAL_SECONDS),
      1,
      10
    ) * 1_000;
  return {
    execute,
    runDirectory,
    outputDirectory,
    repositoryRoot,
    sshTarget,
    vmId,
    addonSlug,
    expectedCoreVersion,
    expectedBridgeVersion,
    maximumWaitMs,
    intervalMs
  };
}

function requiredPath(value: string | undefined): string {
  if (!value || value.length > 1_024) {
    throw new Error("haos_core_restart_arguments_invalid");
  }
  return resolve(value);
}

function safeVersion(value: string | undefined): string {
  if (!value || !/^[0-9A-Za-z_.+-]{1,120}$/u.test(value)) {
    throw new Error("haos_core_restart_arguments_invalid");
  }
  return value;
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]{1,120}$/u : /^[A-Za-z0-9_-]{1,120}$/u;
  if (!pattern.test(value)) {
    throw new Error("haos_core_restart_arguments_invalid");
  }
  return value;
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("haos_core_restart_arguments_invalid");
  }
  return parsed;
}

function defaultOutputDirectory(now: Date): string {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const runId = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return join(base, "HA-SmartThings-Web", "core-restart", runId);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function writeProgress(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main().catch(() => {
  process.stderr.write("haos_core_restart_failed\n");
  process.exitCode = 1;
});
