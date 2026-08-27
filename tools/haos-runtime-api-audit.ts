import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { assertOutputDirectoryOutsideRepo } from "./haos-soak-core.js";
import {
  createRuntimeSocketSample,
  haosAddonContainerName,
  parseGuestExecText,
  parseProcTcpTable,
  parseRuntimeProcessTable,
  parseSocketFdListings,
  retryVolatileRuntimeRead,
  selectRuntimeProcesses,
  summarizeRuntimeApiAudit,
  type RuntimeSocketSample
} from "./haos-runtime-api-audit-core.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_INTERVAL_SECONDS = 5;

interface CliOptions {
  durationMs: number;
  intervalMs: number;
  outputDirectory: string;
  repositoryRoot: string;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  const startedAtMs = Date.now();
  const expectedEndAtMs = startedAtMs + options.durationMs;
  const samples: RuntimeSocketSample[] = [];
  let nextSampleAtMs = startedAtMs;

  for (;;) {
    const waitMs = nextSampleAtMs - Date.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
    const sample = await collectSample(options);
    samples.push(sample);
    writeProgress({
      event: "runtime_api_audit_sample",
      sampledAt: sample.sampledAt,
      status: sample.status,
      bridgeExternalConnectionCount: sample.bridge.establishedExternalCount,
      browserExternalConnectionCount: sample.chromium.establishedExternalCount
    });
    if (Date.now() >= expectedEndAtMs) {
      break;
    }
    nextSampleAtMs += options.intervalMs;
    if (nextSampleAtMs <= Date.now()) {
      nextSampleAtMs = Date.now() + options.intervalMs;
    }
  }

  const summary = summarizeRuntimeApiAudit(
    samples,
    new Date(startedAtMs).toISOString(),
    new Date().toISOString()
  );
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  await writeFile(join(outputDirectory, "summary.json"), serialized, {
    encoding: "utf8",
    mode: 0o600
  });
  await writeFile(join(outputDirectory, "summary.json.sha256"), `${digest}  summary.json\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  writeProgress({
    event: "runtime_api_audit_completed",
    status: summary.status,
    sampleCount: summary.sampleCount,
    bridgeExternalConnectionObserved: summary.checks.bridgeExternalConnectionObserved,
    browserExternalConnectionObserved: summary.checks.browserExternalConnectionObserved,
    summarySha256: digest,
    outputDirectory
  });
  if (summary.status !== "pass") {
    process.exitCode = 1;
  }
}

async function collectSample(options: CliOptions): Promise<RuntimeSocketSample> {
  return retryVolatileRuntimeRead(() => collectSampleOnce(options));
}

async function collectSampleOnce(options: CliOptions): Promise<RuntimeSocketSample> {
  const processTable = parseRuntimeProcessTable(
    parseGuestExecText(
      await runSsh(options.sshTarget, processCommand(options)),
      "runtime_process_command_failed",
      "runtime_process_response_invalid"
    )
  );
  const selection = selectRuntimeProcesses(processTable);
  if (!selection) {
    return createRuntimeSocketSample({
      sampledAt: new Date().toISOString(),
      selection: null,
      socketsByProcess: new Map(),
      tcpEntries: []
    });
  }
  const processIds = [selection.bridgeProcessId, ...selection.browserProcessIds];
  const [fdRaw, tcpRaw, tcp6Raw] = await Promise.all([
    runSsh(options.sshTarget, fdCommand(options, processIds)),
    runSsh(options.sshTarget, tcpCommand(options, selection.bridgeProcessId, false)),
    runSsh(options.sshTarget, tcpCommand(options, selection.bridgeProcessId, true))
  ]);
  const socketsByProcess = parseSocketFdListings(
    parseGuestExecText(fdRaw, "runtime_fd_command_failed", "runtime_fd_response_invalid"),
    processIds
  );
  const tcpEntries = [
    ...parseProcTcpTable(
      parseGuestExecText(tcpRaw, "runtime_tcp_command_failed", "runtime_tcp_response_invalid"),
      "ipv4"
    ),
    ...parseProcTcpTable(
      parseGuestExecText(tcp6Raw, "runtime_tcp6_command_failed", "runtime_tcp6_response_invalid"),
      "ipv6"
    )
  ];
  return createRuntimeSocketSample({
    sampledAt: new Date().toISOString(),
    selection,
    socketsByProcess,
    tcpEntries
  });
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

function processCommand(options: CliOptions): string {
  return `qm guest exec ${String(options.vmId)} -- docker top ${haosAddonContainerName(options.addonSlug)} -eo pid,ppid,comm`;
}

function fdCommand(options: CliOptions, processIds: readonly number[]): string {
  const paths = processIds.map((processId) => `/proc/${String(processId)}/fd`).join(" ");
  return `qm guest exec ${String(options.vmId)} -- ls -l ${paths}`;
}

function tcpCommand(options: CliOptions, processId: number, ipv6: boolean): string {
  const table = ipv6 ? "tcp6" : "tcp";
  return `qm guest exec ${String(options.vmId)} -- cat /proc/${String(processId)}/net/${table}`;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("runtime_audit_arguments_invalid");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--duration-seconds",
    "--interval-seconds",
    "--output-dir",
    "--repository-root",
    "--ssh-target",
    "--vm-id",
    "--addon-slug"
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error("runtime_audit_arguments_invalid");
    }
  }
  const durationSeconds = boundedInteger(
    values.get("--duration-seconds") ?? String(DEFAULT_DURATION_SECONDS),
    5,
    3_600
  );
  const intervalSeconds = boundedInteger(
    values.get("--interval-seconds") ?? String(DEFAULT_INTERVAL_SECONDS),
    1,
    durationSeconds
  );
  const sshTarget = safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true);
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    false
  );
  const vmId = boundedInteger(values.get("--vm-id") ?? "100", 1, 2_147_483_647);
  const repositoryRoot = resolve(values.get("--repository-root") ?? process.cwd());
  const outputDirectory = resolve(
    values.get("--output-dir") ?? defaultOutputDirectory(new Date())
  );
  return {
    durationMs: durationSeconds * 1_000,
    intervalMs: intervalSeconds * 1_000,
    outputDirectory,
    repositoryRoot,
    sshTarget,
    vmId,
    addonSlug
  };
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("runtime_audit_arguments_invalid");
  }
  return parsed;
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]+$/u : /^[A-Za-z0-9_-]+$/u;
  if (!pattern.test(value) || value.length > 120) {
    throw new Error("runtime_audit_arguments_invalid");
  }
  return value;
}

function defaultOutputDirectory(now: Date): string {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const runId = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return join(base, "HA-SmartThings-Web", "runtime-api-audit", runId);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function writeProgress(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main().catch(() => {
  process.stderr.write("runtime_api_audit_failed\n");
  process.exitCode = 1;
});
