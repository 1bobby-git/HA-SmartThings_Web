import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertOutputDirectoryOutsideRepo,
  createSoakSample,
  evaluateSoak,
  parseHealthGuestExec,
  parseLocalBridgeInventory,
  parseLocalBridgeSseEvent,
  readCgroupMemoryUsage,
  parseStatsGuestExec,
  writeSanitizedObservation,
  type SoakErrorCode,
  type SoakErrorObservation,
  type SoakEvaluation,
  type SoakHealthObservation,
  type SoakObservation
} from "./haos-soak-core.js";
import {
  createSoakCollectorConfig,
  createSoakCollectorLock,
  createSoakResumeState,
  MAX_SOAK_OBSERVATION_LOG_BYTES,
  parseSoakCollectorConfig,
  parseSoakCollectorLock,
  SOAK_COLLECTOR_CONFIG_NAME,
  SOAK_COLLECTOR_LOCK_NAME,
  type SoakCollectorConfig,
  type SoakCollectorLock
} from "./haos-soak-resume-core.js";
import type { SoakRunMetadata } from "./haos-soak-deployment-gate-core.js";

const execFileAsync = promisify(execFile);
const DEFAULT_DURATION_HOURS = 72;
const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_MAX_MEMORY_GROWTH_MIB = 256;
const COMMAND_TIMEOUT_MS = 45_000;
const LOCAL_BRIDGE_TIMEOUT_MS = 10_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const DEFAULT_LOCAL_BRIDGE_URL = "http://127.0.0.1:8098";
const DEFAULT_LOCAL_DATA_DIR = "/data";
const RESUME_DIRECTORY_ENTRIES = new Set([
  SOAK_COLLECTOR_LOCK_NAME,
  SOAK_COLLECTOR_CONFIG_NAME,
  "run.json",
  "samples.jsonl",
  "status.json",
  "final-summary.json",
  "final-summary.json.sha256"
]);

export type CliOptions = QgaCliOptions | LocalBridgeCliOptions;

interface BaseCliOptions {
  resume: boolean;
  durationMs: number;
  intervalMs: number;
  maxMemoryGrowthBytes: number;
  outputDirectory: string;
  repositoryRoot: string;
}

export interface QgaCliOptions extends BaseCliOptions {
  mode: "qga";
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

export interface LocalBridgeCliOptions extends BaseCliOptions {
  mode: "local_bridge";
  bridgeUrl: string;
  bridgeTokenFile: string;
}

let stopRequested = false;
let wakePendingDelay: (() => void) | undefined;

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  const collectorLock = await acquireCollectorLock(outputDirectory);
  try {
    await runCollector(options, outputDirectory);
  } finally {
    await releaseCollectorLock(outputDirectory, collectorLock);
  }
}

async function runCollector(options: CliOptions, outputDirectory: string): Promise<void> {
  const samplesFile = join(outputDirectory, "samples.jsonl");
  const statusFile = join(outputDirectory, "status.json");
  const metadataFile = join(outputDirectory, "run.json");
  const configFile = join(outputDirectory, SOAK_COLLECTOR_CONFIG_NAME);
  let startedAtMs: number;
  let expectedEndAtMs: number;
  let nextSampleAtMs: number;
  let observations: SoakObservation[];
  let metadata: SoakRunMetadata;

  if (options.resume) {
    await assertResumeDirectoryEntries(outputDirectory);
    const [metadataText, observationsText, configText] = await Promise.all([
      readBoundedRegularFile(metadataFile, 4_096),
      readBoundedRegularFile(samplesFile, MAX_SOAK_OBSERVATION_LOG_BYTES, true),
      readBoundedRegularFile(configFile, 4_096)
    ]);
    const config = parseSoakCollectorConfig(configText);
    if (!collectorConfigMatchesOptions(config, options)) {
      throw new Error("soak_resume_config_mismatch");
    }
    const resume = createSoakResumeState({
      metadataText,
      observationsText,
      requestedDurationMs: options.durationMs,
      requestedIntervalMs: options.intervalMs
    });
    startedAtMs = resume.startedAtMs;
    expectedEndAtMs = resume.expectedEndAtMs;
    nextSampleAtMs = resume.nextSampleAtMs;
    observations = [...resume.observations];
    metadata = { ...resume.metadata, status: "running" };
    const evaluation = evaluateSoak(observations, evaluationOptions(options, startedAtMs));
    await writeJson(statusFile, evaluation);
    await writeJson(metadataFile, metadata);
    writeProgress({
      event: "soak_resumed",
      startedAt: metadata.startedAt,
      expectedEndAt: metadata.expectedEndAt,
      intervalMs: metadata.intervalMs,
      sampleCount: observations.length,
      outputDirectory
    });
    if (evaluation.completed) {
      await completeRun(outputDirectory, metadataFile, metadata, evaluation);
      return;
    }
  } else {
    await assertFreshOutputDirectory(outputDirectory);
    startedAtMs = Date.now();
    expectedEndAtMs = startedAtMs + options.durationMs;
    nextSampleAtMs = startedAtMs;
    observations = [];
    metadata = {
      schemaVersion: 1,
      status: "running",
      startedAt: new Date(startedAtMs).toISOString(),
      expectedEndAt: new Date(expectedEndAtMs).toISOString(),
      durationMs: options.durationMs,
      intervalMs: options.intervalMs,
      outputPolicy: "allowlisted_aggregates_only"
    };
    await writeJson(
      configFile,
      createSoakCollectorConfig(
        options.mode === "qga"
          ? {
              mode: "qga",
              sshTarget: options.sshTarget,
              vmId: options.vmId,
              addonSlug: options.addonSlug,
              maxMemoryGrowthBytes: options.maxMemoryGrowthBytes
            }
          : {
              mode: "local_bridge",
              bridgeUrl: options.bridgeUrl,
              bridgeTokenFile: options.bridgeTokenFile,
              maxMemoryGrowthBytes: options.maxMemoryGrowthBytes
            }
      )
    );
    await writeJson(metadataFile, metadata);
    writeProgress({
      event: "soak_started",
      startedAt: metadata.startedAt,
      expectedEndAt: metadata.expectedEndAt,
      intervalMs: metadata.intervalMs,
      outputDirectory
    });
  }

  stopRequested = false;
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    while (!stopRequested) {
      const now = Date.now();
      if (now < nextSampleAtMs) {
        await delay(nextSampleAtMs - now);
        if (stopRequested) {
          break;
        }
      }

      const observation = await collectObservation(options);
      observations.push(observation);
      await writeSanitizedObservation(samplesFile, observation);
      const evaluation = evaluateSoak(observations, evaluationOptions(options, startedAtMs));
      await writeJson(statusFile, evaluation);
      writeProgress(progressFromObservation(observation, evaluation));

      if (Date.parse(observation.sampledAt) >= expectedEndAtMs) {
        await completeRun(outputDirectory, metadataFile, metadata, evaluation);
        return;
      }
      nextSampleAtMs += options.intervalMs;
      if (nextSampleAtMs <= Date.now()) {
        nextSampleAtMs = Date.now() + options.intervalMs;
      }
    }
  } catch (error) {
    await writeJson(metadataFile, { ...metadata, status: "interrupted" });
    throw error;
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }

  await writeJson(metadataFile, { ...metadata, status: "interrupted" });
  writeProgress({ event: "soak_interrupted", sampledCount: observations.length });
}

async function collectObservation(options: CliOptions): Promise<SoakObservation> {
  if (options.mode === "local_bridge") {
    return collectLocalBridgeObservation(options);
  }
  return collectQgaObservation(options);
}

async function collectQgaObservation(options: QgaCliOptions): Promise<SoakObservation> {
  const sampledAt = new Date().toISOString();
  const [healthResult, statsResult] = await Promise.allSettled([
    runSsh(options.sshTarget, healthCommand(options)),
    runSsh(options.sshTarget, statsCommand(options))
  ]);

  if (healthResult.status === "rejected") {
    return errorObservation(sampledAt, "health_command_failed");
  }
  let health;
  try {
    health = parseHealthGuestExec(healthResult.value);
  } catch (error) {
    return errorObservation(sampledAt, errorCode(error, "health_response_invalid"));
  }

  if (statsResult.status === "rejected") {
    return errorObservation(sampledAt, "stats_command_failed");
  }
  try {
    const resources = parseStatsGuestExec(statsResult.value);
    return createSoakSample({ sampledAt, health, resources });
  } catch (error) {
    return errorObservation(sampledAt, errorCode(error, "stats_response_invalid"));
  }
}

export async function collectLocalBridgeObservation(options: LocalBridgeCliOptions): Promise<SoakObservation> {
  const sampledAt = new Date().toISOString();
  let bridgeToken;
  try {
    bridgeToken = await readLocalBridgeToken(options.bridgeTokenFile);
  } catch {
    return errorObservation(sampledAt, "bridge_auth_failed");
  }
  const [healthResult, inventoryResult, eventResult] = await Promise.allSettled([
    fetchBridgeJson(`${options.bridgeUrl}/health/details`),
    fetchBridgeJson(`${options.bridgeUrl}/api/v1/inventory`, bridgeToken),
    fetchBridgeSseEvent(`${options.bridgeUrl}/api/v1/events`, bridgeToken)
  ]);

  if (healthResult.status === "rejected") {
    return errorObservation(
      sampledAt,
      isErrorMessage(healthResult.reason, "bridge_response_invalid")
        ? "health_response_invalid"
        : "health_command_failed"
    );
  }
  if (inventoryResult.status === "rejected") {
    return errorObservation(
      sampledAt,
      isErrorMessage(inventoryResult.reason, "bridge_response_invalid")
        ? "inventory_response_invalid"
        : errorCode(inventoryResult.reason, "inventory_request_failed")
    );
  }
  if (eventResult.status === "rejected") {
    return errorObservation(sampledAt, errorCode(eventResult.reason, "events_request_failed"));
  }

  let health;
  let inventory;
  let event;
  try {
    health = parseLocalBridgeHealth(healthResult.value);
  } catch {
    return errorObservation(sampledAt, "health_response_invalid");
  }
  try {
    inventory = parseLocalBridgeInventory(inventoryResult.value);
  } catch {
    return errorObservation(sampledAt, "inventory_response_invalid");
  }
  try {
    event = parseLocalBridgeSseEvent(eventResult.value);
  } catch {
    return errorObservation(sampledAt, "events_response_invalid");
  }
  try {
    return createSoakSample({
      sampledAt,
      health: {
        ...health,
        inventoryDeviceCount: inventory.deviceCount,
        inventorySequence: inventory.sequence,
        eventSequence: event.sequence
      },
      resources: await collectLocalResources()
    });
  } catch (error) {
    return errorObservation(sampledAt, errorCode(error, "stats_response_invalid"));
  }
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

async function fetchBridgeJson(url: string, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("bridge_auth_failed");
      }
      throw new Error("bridge_request_failed");
    }
    try {
      return await response.json();
    } catch {
      throw new Error("bridge_response_invalid");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBridgeSseEvent(url: string, token: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_BRIDGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    if (!response.ok || !response.body) {
      if (response.status === 401 || response.status === 403) {
        throw new Error("bridge_auth_failed");
      }
      throw new Error("bridge_events_failed");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (Buffer.byteLength(text, "utf8") <= 64 * 1_024) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("\n\n") || text.includes("\r\n\r\n")) {
        return text;
      }
    }
    throw new Error("bridge_events_failed");
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function readLocalBridgeToken(path: string): Promise<string> {
  const token = (await readBoundedRegularFile(path, 1_024)).trim();
  if (!/^[A-Za-z0-9_.:-]{32,512}$/u.test(token)) {
    throw new Error("soak_local_bridge_token_invalid");
  }
  return token;
}

function parseLocalBridgeHealth(input: unknown): SoakHealthObservation {
  const record = requireRecord(input);
  const details = requireRecord(record.details);
  if (typeof record.live !== "boolean" || typeof record.ready !== "boolean") {
    throw new Error("health_response_invalid");
  }
  const health = {
    ...details,
    live: record.live,
    ready: record.ready
  } as unknown as SoakHealthObservation;
  return createSoakSample({
    sampledAt: new Date(0).toISOString(),
    health,
    resources: zeroResources()
  }).health;
}

async function collectLocalResources() {
  return zeroResources(await readCgroupMemoryUsage(undefined, () => process.memoryUsage().rss));
}

function zeroResources(memoryUsageBytes = 0) {
  return {
    cpuPercent: 0,
    memoryUsageBytes,
    memoryLimitBytes: 0,
    memoryPercent: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0
  };
}

function healthCommand(options: QgaCliOptions): string {
  return `qm guest exec ${String(options.vmId)} -- docker exec app_${options.addonSlug} curl -fsS http://127.0.0.1:8098/health/details`;
}

function statsCommand(options: QgaCliOptions): string {
  return `qm guest exec ${String(options.vmId)} -- ha apps stats ${options.addonSlug} --raw-json`;
}

async function completeRun(
  outputDirectory: string,
  metadataFile: string,
  metadata: SoakRunMetadata,
  evaluation: SoakEvaluation
): Promise<void> {
  const summaryFile = join(outputDirectory, "final-summary.json");
  const serialized = `${JSON.stringify(evaluation, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  await writeFile(summaryFile, serialized, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(outputDirectory, "final-summary.json.sha256"), `${digest}  final-summary.json\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await writeJson(metadataFile, { ...metadata, status: "completed" });
  writeProgress({
    event: "soak_completed",
    status: evaluation.status,
    sampleCount: evaluation.sampleCount,
    failures: evaluation.failures,
    warnings: evaluation.warnings,
    summarySha256: digest
  });
}

function evaluationOptions(options: CliOptions, startedAtMs: number) {
  return {
    runStartedAtMs: startedAtMs,
    expectedDurationMs: options.durationMs,
    expectedIntervalMs: options.intervalMs,
    maxSustainedMemoryGrowthBytes: options.maxMemoryGrowthBytes
  };
}

async function acquireCollectorLock(outputDirectory: string): Promise<SoakCollectorLock> {
  const lockPath = join(outputDirectory, SOAK_COLLECTOR_LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = createSoakCollectorLock(process.pid, Date.now());
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return lock;
    } catch (error) {
      if (!isFileExistsError(error) || attempt > 0) {
        throw error;
      }
      const existing = parseSoakCollectorLock(
        await readBoundedRegularFile(lockPath, 1_024)
      );
      if (processIsAlive(existing.pid)) {
        throw new Error("soak_collector_already_running");
      }
      await unlink(lockPath);
    }
  }
  throw new Error("soak_collector_lock_failed");
}

async function releaseCollectorLock(
  outputDirectory: string,
  expected: SoakCollectorLock
): Promise<void> {
  const lockPath = join(outputDirectory, SOAK_COLLECTOR_LOCK_NAME);
  try {
    const current = parseSoakCollectorLock(await readBoundedRegularFile(lockPath, 1_024));
    if (current.pid === expected.pid && current.createdAt === expected.createdAt) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

async function assertFreshOutputDirectory(outputDirectory: string): Promise<void> {
  const entries = await readdir(outputDirectory);
  if (entries.some((entry) => entry !== SOAK_COLLECTOR_LOCK_NAME)) {
    throw new Error("soak_output_not_empty");
  }
}

async function assertResumeDirectoryEntries(outputDirectory: string): Promise<void> {
  const entries = await readdir(outputDirectory);
  if (entries.some((entry) => !RESUME_DIRECTORY_ENTRIES.has(entry))) {
    throw new Error("soak_resume_directory_invalid");
  }
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  optional = false
): Promise<string> {
  let fileStats;
  try {
    fileStats = await lstat(path);
  } catch (error) {
    if (optional && isMissingPathError(error)) {
      return "";
    }
    throw error;
  }
  if (
    fileStats.isSymbolicLink() ||
    !fileStats.isFile() ||
    fileStats.size > maximumBytes
  ) {
    throw new Error("soak_resume_file_invalid");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new Error("soak_resume_file_invalid");
  }
  return text;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isErrorMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const allowedValueArguments = new Set([
    "--duration-hours",
    "--interval-seconds",
    "--max-memory-growth-mib",
    "--ssh-target",
    "--addon-slug",
    "--vm-id",
    "--bridge-url",
    "--bridge-token-file",
    "--repository-root",
    "--output-dir"
  ]);
  const values = new Map<string, string>();
  let resume = false;
  let localBridge = false;
  for (let index = 0; index < args.length; ) {
    const key = args[index];
    if (key === "--resume") {
      if (resume) {
        throw new Error("duplicate soak argument: --resume");
      }
      resume = true;
      index += 1;
      continue;
    }
    if (key === "--local-bridge") {
      if (localBridge) {
        throw new Error("duplicate soak argument: --local-bridge");
      }
      localBridge = true;
      index += 1;
      continue;
    }
    if (!key?.startsWith("--")) {
      throw new Error("invalid soak arguments");
    }
    if (!allowedValueArguments.has(key)) {
      throw new Error(`unsupported soak argument: ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`duplicate soak argument: ${key}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("invalid soak arguments");
    }
    values.set(key, value);
    index += 2;
  }
  if (resume && !values.has("--output-dir")) {
    throw new Error("soak resume requires --output-dir");
  }

  const durationHours = positiveNumber(
    values.get("--duration-hours") ?? String(DEFAULT_DURATION_HOURS),
    "duration-hours"
  );
  const intervalSeconds = positiveNumber(
    values.get("--interval-seconds") ?? String(DEFAULT_INTERVAL_SECONDS),
    "interval-seconds"
  );
  const maximumMemoryGrowthMiB = nonNegativeNumber(
    values.get("--max-memory-growth-mib") ?? String(DEFAULT_MAX_MEMORY_GROWTH_MIB),
    "max-memory-growth-mib"
  );
  const sshTarget = safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", "ssh-target", true);
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    "addon-slug"
  );
  const vmId = positiveInteger(values.get("--vm-id") ?? "100", "vm-id");
  const repositoryRoot = resolve(values.get("--repository-root") ?? process.cwd());
  if (
    localBridge &&
    (values.has("--ssh-target") ||
      values.has("--addon-slug") ||
      values.has("--vm-id"))
  ) {
    throw new Error("soak_local_bridge_arguments_invalid");
  }
  if (!localBridge && (values.has("--bridge-url") || values.has("--bridge-token-file"))) {
    throw new Error("soak_qga_arguments_invalid");
  }
  const mode = localBridge ? "local_bridge" : "qga";
  const outputDirectory = resolve(
    values.get("--output-dir") ?? defaultOutputDirectory(new Date(), mode)
  );
  const base = {
    resume,
    durationMs: Math.max(1, Math.round(durationHours * 60 * 60 * 1000)),
    intervalMs: Math.max(1, Math.round(intervalSeconds * 1000)),
    maxMemoryGrowthBytes: Math.round(maximumMemoryGrowthMiB * 1024 * 1024),
    outputDirectory,
    repositoryRoot
  };
  if (mode === "local_bridge") {
    return {
      ...base,
      mode,
      bridgeUrl: safeLocalBridgeUrl(values.get("--bridge-url") ?? DEFAULT_LOCAL_BRIDGE_URL),
      bridgeTokenFile: resolve(values.get("--bridge-token-file") ?? join(DEFAULT_LOCAL_DATA_DIR, "bridge-secret"))
    };
  }
  return {
    ...base,
    mode,
    sshTarget,
    vmId,
    addonSlug
  };
}

function collectorConfigMatchesOptions(config: SoakCollectorConfig, options: CliOptions): boolean {
  if (config.mode !== options.mode || config.maxMemoryGrowthBytes !== options.maxMemoryGrowthBytes) {
    return false;
  }
  if (config.mode === "qga" && options.mode === "qga") {
    return (
      config.sshTarget === options.sshTarget &&
      config.vmId === options.vmId &&
      config.addonSlug === options.addonSlug
    );
  }
  if (config.mode === "local_bridge" && options.mode === "local_bridge") {
    return config.bridgeUrl === options.bridgeUrl && config.bridgeTokenFile === options.bridgeTokenFile;
  }
  return false;
}

function defaultOutputDirectory(now: Date, mode: CliOptions["mode"]): string {
  const base = mode === "local_bridge" ? DEFAULT_LOCAL_DATA_DIR : process.env.LOCALAPPDATA ?? tmpdir();
  const runId = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return mode === "local_bridge"
    ? join(base, "soak", runId)
    : join(base, "HA-SmartThings-Web", "soak", runId);
}

function errorObservation(sampledAt: string, code: SoakErrorCode): SoakErrorObservation {
  return { schemaVersion: 1, kind: "error", sampledAt, code };
}

function errorCode(error: unknown, fallback: SoakErrorCode): SoakErrorCode {
  if (
    error instanceof Error &&
    (error.message === "bridge_auth_failed" ||
      error.message === "health_command_failed" ||
      error.message === "health_response_invalid" ||
      error.message === "inventory_request_failed" ||
      error.message === "inventory_response_invalid" ||
      error.message === "events_request_failed" ||
      error.message === "events_response_invalid" ||
      error.message === "stats_command_failed" ||
      error.message === "stats_response_invalid")
  ) {
    return error.message;
  }
  return fallback;
}

function progressFromObservation(
  observation: SoakObservation,
  evaluation: SoakEvaluation
): Record<string, unknown> {
  if (observation.kind === "error") {
    return {
      event: "soak_sample_error",
      sampledAt: observation.sampledAt,
      code: observation.code,
      status: evaluation.status,
      sampleCount: evaluation.sampleCount
    };
  }
  return {
    event: "soak_sample",
    sampledAt: observation.sampledAt,
    live: observation.health.live,
    ready: observation.health.ready,
    state: observation.health.state,
    decodedDeviceEventCount: observation.health.decodedDeviceEventCount,
    uniqueLogicalEventCount: observation.health.uniqueLogicalEventCount,
    protocolInvalidFrameCount: observation.health.protocolInvalidFrameCount,
    protocolChangeCount: observation.health.protocolChangeCount,
    restartCount: observation.health.restartCount,
    memoryUsageBytes: observation.resources.memoryUsageBytes,
    status: evaluation.status,
    sampleCount: evaluation.sampleCount,
    failures: evaluation.failures,
    warnings: evaluation.warnings
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

function writeProgress(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function positiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function nonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function safeIdentifier(value: string, name: string, allowDots = false): string {
  const pattern = allowDots ? /^[a-zA-Z0-9_.-]+$/u : /^[a-zA-Z0-9_-]+$/u;
  if (!pattern.test(value) || value.length > 120) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function safeLocalBridgeUrl(value: string): string {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("soak_local_bridge_arguments_invalid");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("soak_local_bridge_arguments_invalid");
  }
  return url.toString().replace(/\/$/u, "");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function requestStop(): void {
  stopRequested = true;
  wakePendingDelay?.();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    const finish = (): void => {
      clearTimeout(timer);
      wakePendingDelay = undefined;
      resolveDelay();
    };
    const timer = setTimeout(finish, milliseconds);
    wakePendingDelay = finish;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch(() => {
    process.stderr.write("haos_soak_failed\n");
    process.exitCode = 1;
  });
}
