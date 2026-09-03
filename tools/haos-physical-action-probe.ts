import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PhysicalActionProbeSnapshot } from "../bridge/src/inspector/physical-action-correlation-probe.js";

import {
  buildPhysicalProbeRemoteCommand,
  isPhysicalActionType,
  parsePhysicalProbeGuestResponse,
  type PhysicalProbeHttpResult,
  type PhysicalProbeOperation
} from "./haos-physical-action-probe-core.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

interface CliOptions {
  command: "status" | "reset" | "arm";
  operation: PhysicalProbeOperation;
  wait: boolean;
  pollMs: number;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const initial = await executeProbeRequest(options, options.operation);
  if (!initial.ok) {
    writeResult({ event: "physical_action_probe_error", ...initial });
    process.exitCode = 1;
    return;
  }
  if (options.command !== "arm" || !options.wait || initial.snapshot.state !== "armed") {
    writeResult({ event: "physical_action_probe_result", ...initial });
    return;
  }

  writeProgress(initial.snapshot);
  const deadlineMs = Date.now() + initial.snapshot.remainingMs + 15_000;
  let latest = initial;
  while (latest.snapshot.state === "armed" && Date.now() <= deadlineMs) {
    await delay(options.pollMs);
    const result = await executeProbeRequest(options, { kind: "status" });
    if (!result.ok) {
      writeResult({ event: "physical_action_probe_error", ...result });
      process.exitCode = 1;
      return;
    }
    latest = result;
    writeProgress(latest.snapshot);
  }

  if (latest.snapshot.state === "armed") {
    writeResult({ event: "physical_action_probe_error", error: "probe_wait_timeout" });
    process.exitCode = 1;
    return;
  }
  writeResult({ event: "physical_action_probe_result", ...latest });
  if (latest.snapshot.state !== "pass") {
    process.exitCode = 1;
  }
}

async function executeProbeRequest(
  options: CliOptions,
  operation: PhysicalProbeOperation
): Promise<PhysicalProbeHttpResult> {
  const remoteCommand = buildPhysicalProbeRemoteCommand({
    vmId: options.vmId,
    addonSlug: options.addonSlug,
    operation
  });
  const result = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      options.sshTarget,
      remoteCommand
    ],
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true
    }
  );
  return parsePhysicalProbeGuestResponse(result.stdout);
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const command = args[0];
  if (command !== "status" && command !== "reset" && command !== "arm") {
    throw new Error("probe_arguments_invalid");
  }
  const values = new Map<string, string>();
  let wait = false;
  for (let index = 1; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--wait") {
      wait = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("probe_arguments_invalid");
    }
    values.set(key, value);
    index += 1;
  }
  const allowed = new Set([
    "--action",
    "--target-device-alias",
    "--window-seconds",
    "--poll-seconds",
    "--ssh-target",
    "--vm-id",
    "--addon-slug"
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error("probe_arguments_invalid");
    }
  }
  if (
    command !== "arm" &&
    (wait ||
      values.has("--action") ||
      values.has("--target-device-alias") ||
      values.has("--window-seconds") ||
      values.has("--poll-seconds"))
  ) {
    throw new Error("probe_arguments_invalid");
  }
  const sshTarget = safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true);
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    false
  );
  const vmId = boundedInteger(values.get("--vm-id") ?? "100", 1, 2_147_483_647);
  const pollMs = boundedInteger(values.get("--poll-seconds") ?? "2", 1, 10) * 1_000;
  let operation: PhysicalProbeOperation;
  if (command === "status") {
    operation = { kind: "status" };
  } else if (command === "reset") {
    operation = { kind: "reset" };
  } else {
    const actionType = values.get("--action");
    if (!actionType || !isPhysicalActionType(actionType)) {
      throw new Error("probe_arguments_invalid");
    }
    const targetDeviceAlias = values.get("--target-device-alias");
    if (targetDeviceAlias !== undefined && !/^dev_[0-9]{3,32}$/u.test(targetDeviceAlias)) {
      throw new Error("probe_arguments_invalid");
    }
    const windowSeconds = boundedInteger(values.get("--window-seconds") ?? "60", 15, 120);
    operation = {
      kind: "arm",
      actionType,
      ...(targetDeviceAlias === undefined ? {} : { targetDeviceAlias }),
      windowSeconds
    };
  }
  return { command, operation, wait, pollMs, sshTarget, vmId, addonSlug };
}

function writeProgress(snapshot: PhysicalActionProbeSnapshot): void {
  writeResult({
    event: "physical_action_probe_progress",
    state: snapshot.state,
    remainingMs: snapshot.remainingMs,
    candidateCount: snapshot.candidateCount
  });
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("probe_arguments_invalid");
  }
  return parsed;
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]+$/u : /^[A-Za-z0-9_-]+$/u;
  if (!pattern.test(value) || value.length > 120) {
    throw new Error("probe_arguments_invalid");
  }
  return value;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

void main().catch(() => {
  process.stderr.write("physical_action_probe_operator_failed\n");
  process.exitCode = 1;
});
