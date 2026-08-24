import { appendFile, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const RUNTIME_STATES = new Set([
  "STARTING",
  "BROWSER_STARTING",
  "LOGIN_REQUIRED",
  "AUTHENTICATING",
  "PAGE_LOADING",
  "DISCOVERING_PROTOCOL",
  "SYNCING",
  "CONNECTED",
  "STALE",
  "RECONNECTING",
  "REAUTH_REQUIRED",
  "PROTOCOL_CHANGED",
  "BROWSER_FAILED",
  "FATAL"
]);

const URL_CATEGORIES = new Set([
  "none",
  "smartthings_location",
  "smartthings_advanced",
  "samsung_login",
  "other",
  "error"
]);

const OPTIONAL_HEALTH_AGE_FIELDS = [
  "initialSnapshotAgeMs",
  "lastSnapshotAgeMs",
  "frameAgeMs",
  "eventAgeMs",
  "parserAgeMs",
  "pushAgeMs",
  "browserUptimeMs"
] as const;

const MONOTONIC_HEALTH_COUNTERS = [
  "decodedDeviceEventCount",
  "uniqueLogicalEventCount",
  "duplicateEventCount"
] as const;

const BROWSER_UPTIME_ROLLBACK_TOLERANCE_MS = 5_000;
const SAMPLE_OBSERVATION_KEYS = new Set(["schemaVersion", "kind", "sampledAt", "health", "resources"]);
const ERROR_OBSERVATION_KEYS = new Set(["schemaVersion", "kind", "sampledAt", "code"]);
const HEALTH_OBSERVATION_KEYS = new Set([
  "live",
  "ready",
  "state",
  "urlCategory",
  "activeConnections",
  "observedDeviceCount",
  "decodedDeviceEventCount",
  "uniqueLogicalEventCount",
  "duplicateEventCount",
  "dedupeJournalSize",
  "protocolInvalidFrameCount",
  "protocolChangeCount",
  "restartCount",
  "bridgeVersion",
  "browserVersion",
  "protocolVersion",
  "heartbeatAgeMs",
  "snapshotAgeMs",
  ...OPTIONAL_HEALTH_AGE_FIELDS
]);
const RESOURCE_OBSERVATION_KEYS = new Set([
  "cpuPercent",
  "memoryUsageBytes",
  "memoryLimitBytes",
  "memoryPercent",
  "networkRxBytes",
  "networkTxBytes",
  "blockReadBytes",
  "blockWriteBytes"
]);

export type SoakErrorCode =
  | "health_command_failed"
  | "health_response_invalid"
  | "stats_command_failed"
  | "stats_response_invalid";

export type SoakFailureCode =
  | "sample_error"
  | "timestamp_invalid"
  | "timestamp_order"
  | "not_live"
  | "not_ready"
  | "state_not_connected"
  | "protocol_changed"
  | "runtime_restarted"
  | "invalid_frame_increase"
  | "counter_regression"
  | "sample_gap"
  | "memory_growth"
  | "insufficient_samples";

export type SoakWarningCode = "event_counters_flat";

export interface SoakHealthObservation {
  live: boolean;
  ready: boolean;
  state: string;
  urlCategory: string;
  activeConnections: number;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  dedupeJournalSize: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
  bridgeVersion: string;
  browserVersion: string;
  protocolVersion: string;
  heartbeatAgeMs: number;
  snapshotAgeMs: number;
  initialSnapshotAgeMs?: number;
  lastSnapshotAgeMs?: number;
  frameAgeMs?: number;
  eventAgeMs?: number;
  parserAgeMs?: number;
  pushAgeMs?: number;
  browserUptimeMs?: number;
}

export interface SoakResourceObservation {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
}

export interface SoakSample {
  schemaVersion: 1;
  kind: "sample";
  sampledAt: string;
  health: SoakHealthObservation;
  resources: SoakResourceObservation;
}

export interface SoakErrorObservation {
  schemaVersion: 1;
  kind: "error";
  sampledAt: string;
  code: SoakErrorCode;
}

export type SoakObservation = SoakSample | SoakErrorObservation;

export interface CreateSoakSampleInput {
  sampledAt: string;
  health: SoakHealthObservation;
  resources: SoakResourceObservation;
}

export interface EvaluateSoakOptions {
  runStartedAtMs: number;
  expectedDurationMs: number;
  expectedIntervalMs: number;
  maxSustainedMemoryGrowthBytes?: number;
}

export interface SoakEvaluation {
  schemaVersion: 1;
  status: "pending" | "pass" | "fail";
  startedAt: string;
  expectedEndAt: string;
  lastSampledAt?: string;
  expectedDurationMs: number;
  expectedIntervalMs: number;
  completed: boolean;
  sampleCount: number;
  successfulSampleCount: number;
  errorSampleCount: number;
  failures: SoakFailureCode[];
  warnings: SoakWarningCode[];
  maxGapMs: number;
  memoryStartMedianBytes?: number;
  memoryEndMedianBytes?: number;
  memoryPeakBytes?: number;
  memoryGrowthBytes?: number;
  baseline?: SoakEvaluationCounters;
  final?: SoakEvaluationCounters;
}

export interface SoakEvaluationCounters {
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
}

export function parseHealthGuestExec(raw: string): SoakHealthObservation {
  const inner = parseGuestExec(raw, "health_command_failed", "health_response_invalid");
  try {
    const report = requireRecord(inner);
    const details = requireRecord(report.details);
    return sanitizeHealth({
      ...details,
      live: report.live,
      ready: report.ready
    });
  } catch {
    throw new Error("health_response_invalid");
  }
}

export function parseStatsGuestExec(raw: string): SoakResourceObservation {
  const inner = parseGuestExec(raw, "stats_command_failed", "stats_response_invalid");
  try {
    const response = requireRecord(inner);
    if (response.result !== "ok") {
      throw new Error("unexpected stats result");
    }
    return sanitizeResources(requireRecord(response.data));
  } catch {
    throw new Error("stats_response_invalid");
  }
}

export function createSoakSample(input: CreateSoakSampleInput): SoakSample {
  return {
    schemaVersion: 1,
    kind: "sample",
    sampledAt: sanitizeTimestamp(input.sampledAt),
    health: sanitizeHealth(input.health as unknown as Record<string, unknown>),
    resources: sanitizeResources(input.resources as unknown as Record<string, unknown>)
  };
}

export async function assertOutputDirectoryOutsideRepo(
  outputDirectory: string,
  repositoryRoot: string
): Promise<string> {
  const resolvedOutput = resolve(outputDirectory);
  const resolvedRepository = resolve(repositoryRoot);
  const realRepository = await realpath(resolvedRepository);
  if (isSameOrWithin(resolvedOutput, resolvedRepository)) {
    throw new Error("soak_output_must_be_outside_repository");
  }
  const existingAncestor = await nearestExistingAncestor(resolvedOutput);
  const realAncestor = await realpath(existingAncestor);
  const projectedOutput = resolve(realAncestor, relative(existingAncestor, resolvedOutput));
  if (isSameOrWithin(projectedOutput, realRepository)) {
    throw new Error("soak_output_must_be_outside_repository");
  }
  await mkdir(resolvedOutput, { recursive: true, mode: 0o700 });
  const realOutput = await realpath(resolvedOutput);
  if (isSameOrWithin(realOutput, realRepository)) {
    throw new Error("soak_output_must_be_outside_repository");
  }
  return realOutput;
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error("soak_output_parent_unavailable");
    }
    candidate = parent;
  }
}

export async function writeSanitizedObservation(
  outputFile: string,
  observation: SoakObservation
): Promise<void> {
  const sanitized = parseSoakObservation(observation);
  await mkdir(dirname(resolve(outputFile)), { recursive: true, mode: 0o700 });
  await appendFile(resolve(outputFile), `${JSON.stringify(sanitized)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

export function evaluateSoak(
  observations: readonly SoakObservation[],
  options: EvaluateSoakOptions
): SoakEvaluation {
  validateEvaluationOptions(options);
  const failures = new Set<SoakFailureCode>();
  const warnings = new Set<SoakWarningCode>();
  const successful = observations.filter((observation): observation is SoakSample => observation.kind === "sample");
  const parsedTimes: number[] = [];
  let maxGapMs = 0;

  if (observations.some((observation) => observation.kind === "error")) {
    failures.add("sample_error");
  }

  for (const observation of observations) {
    const timestamp = Date.parse(observation.sampledAt);
    if (!Number.isFinite(timestamp)) {
      failures.add("timestamp_invalid");
      continue;
    }
    const previous = parsedTimes.at(-1);
    if (previous !== undefined) {
      const gap = timestamp - previous;
      if (gap < 0) {
        failures.add("timestamp_order");
      } else {
        maxGapMs = Math.max(maxGapMs, gap);
        if (gap > options.expectedIntervalMs * 2) {
          failures.add("sample_gap");
        }
      }
    }
    parsedTimes.push(timestamp);
  }

  let previousSample: SoakSample | undefined;
  const invalidFrameBaseline = successful[0]?.health.protocolInvalidFrameCount;
  for (const sample of successful) {
    if (!sample.health.live) {
      failures.add("not_live");
    }
    if (!sample.health.ready) {
      failures.add("not_ready");
    }
    if (sample.health.state !== "CONNECTED") {
      failures.add("state_not_connected");
    }
    if (sample.health.protocolChangeCount > 0) {
      failures.add("protocol_changed");
    }
    if (sample.health.restartCount > 0) {
      failures.add("runtime_restarted");
    }
    if (
      invalidFrameBaseline !== undefined &&
      sample.health.protocolInvalidFrameCount > invalidFrameBaseline
    ) {
      failures.add("invalid_frame_increase");
    }
    if (previousSample && countersRegressed(previousSample, sample)) {
      failures.add("counter_regression");
    }
    if (previousSample && browserUptimeRegressed(previousSample, sample)) {
      failures.add("runtime_restarted");
    }
    previousSample = sample;
  }

  const lastParsedTime = parsedTimes.at(-1);
  const expectedEndAtMs = options.runStartedAtMs + options.expectedDurationMs;
  const completed = lastParsedTime !== undefined && lastParsedTime >= expectedEndAtMs;
  if (completed && successful.length < 2) {
    failures.add("insufficient_samples");
  }

  const memory = successful.map((sample) => sample.resources.memoryUsageBytes);
  const memoryWindowSize = Math.min(12, Math.max(1, Math.ceil(memory.length / 10)));
  const memoryStartMedianBytes = median(memory.slice(0, memoryWindowSize));
  const memoryEndMedianBytes = median(memory.slice(-memoryWindowSize));
  const memoryPeakBytes = memory.length > 0 ? Math.max(...memory) : undefined;
  const memoryGrowthBytes =
    memoryStartMedianBytes === undefined || memoryEndMedianBytes === undefined
      ? undefined
      : memoryEndMedianBytes - memoryStartMedianBytes;
  const maximumMemoryGrowth = options.maxSustainedMemoryGrowthBytes ?? 256 * 1024 * 1024;
  if (memoryGrowthBytes !== undefined && memoryGrowthBytes > maximumMemoryGrowth) {
    failures.add("memory_growth");
  }

  const firstSample = successful[0];
  const lastSample = successful.at(-1);
  if (
    firstSample &&
    lastSample &&
    firstSample.health.decodedDeviceEventCount === lastSample.health.decodedDeviceEventCount &&
    firstSample.health.uniqueLogicalEventCount === lastSample.health.uniqueLogicalEventCount
  ) {
    warnings.add("event_counters_flat");
  }

  const evaluation: SoakEvaluation = {
    schemaVersion: 1,
    status: failures.size > 0 ? "fail" : completed ? "pass" : "pending",
    startedAt: new Date(options.runStartedAtMs).toISOString(),
    expectedEndAt: new Date(expectedEndAtMs).toISOString(),
    expectedDurationMs: options.expectedDurationMs,
    expectedIntervalMs: options.expectedIntervalMs,
    completed,
    sampleCount: observations.length,
    successfulSampleCount: successful.length,
    errorSampleCount: observations.length - successful.length,
    failures: [...failures],
    warnings: [...warnings],
    maxGapMs
  };

  const lastObservation = observations.at(-1);
  if (lastObservation) {
    evaluation.lastSampledAt = sanitizeTimestamp(lastObservation.sampledAt);
  }
  if (memoryStartMedianBytes !== undefined) {
    evaluation.memoryStartMedianBytes = memoryStartMedianBytes;
  }
  if (memoryEndMedianBytes !== undefined) {
    evaluation.memoryEndMedianBytes = memoryEndMedianBytes;
  }
  if (memoryPeakBytes !== undefined) {
    evaluation.memoryPeakBytes = memoryPeakBytes;
  }
  if (memoryGrowthBytes !== undefined) {
    evaluation.memoryGrowthBytes = memoryGrowthBytes;
  }
  if (firstSample) {
    evaluation.baseline = evaluationCounters(firstSample);
  }
  if (lastSample) {
    evaluation.final = evaluationCounters(lastSample);
  }
  return evaluation;
}

function parseGuestExec(raw: string, commandCode: SoakErrorCode, responseCode: SoakErrorCode): unknown {
  try {
    const wrapper = requireRecord(JSON.parse(raw));
    if (wrapper.exitcode !== 0 || wrapper.exited !== 1) {
      throw new Error(commandCode);
    }
    if (wrapper["out-truncated"] !== undefined && wrapper["out-truncated"] !== 0) {
      throw new Error(responseCode);
    }
    if (typeof wrapper["out-data"] !== "string" || wrapper["out-data"].length > 1_000_000) {
      throw new Error(responseCode);
    }
    return JSON.parse(wrapper["out-data"]);
  } catch (error) {
    if (error instanceof Error && (error.message === commandCode || error.message === responseCode)) {
      throw error;
    }
    throw new Error(responseCode);
  }
}

function sanitizeHealth(record: Record<string, unknown>): SoakHealthObservation {
  const state = safeEnum(record.state, RUNTIME_STATES);
  const urlCategory = safeEnum(record.urlCategory, URL_CATEGORIES);
  const result: SoakHealthObservation = {
    live: safeBoolean(record.live),
    ready: safeBoolean(record.ready),
    state,
    urlCategory,
    activeConnections: safeInteger(record.activeConnections),
    observedDeviceCount: safeInteger(record.observedDeviceCount),
    decodedDeviceEventCount: safeInteger(record.decodedDeviceEventCount),
    uniqueLogicalEventCount: safeInteger(record.uniqueLogicalEventCount),
    duplicateEventCount: safeInteger(record.duplicateEventCount),
    dedupeJournalSize: safeInteger(record.dedupeJournalSize),
    protocolInvalidFrameCount: safeInteger(record.protocolInvalidFrameCount),
    protocolChangeCount: safeInteger(record.protocolChangeCount),
    restartCount: safeInteger(record.restartCount),
    bridgeVersion: safeVersion(record.bridgeVersion),
    browserVersion: safeVersion(record.browserVersion),
    protocolVersion: safeVersion(record.protocolVersion),
    heartbeatAgeMs: safeInteger(record.heartbeatAgeMs),
    snapshotAgeMs: safeInteger(record.snapshotAgeMs)
  };
  for (const field of OPTIONAL_HEALTH_AGE_FIELDS) {
    if (record[field] !== undefined) {
      result[field] = safeInteger(record[field]);
    }
  }
  return result;
}

function sanitizeResources(record: Record<string, unknown>): SoakResourceObservation {
  return {
    cpuPercent: safeNumber(record.cpuPercent ?? record.cpu_percent),
    memoryUsageBytes: safeInteger(record.memoryUsageBytes ?? record.memory_usage),
    memoryLimitBytes: safeInteger(record.memoryLimitBytes ?? record.memory_limit),
    memoryPercent: safeNumber(record.memoryPercent ?? record.memory_percent),
    networkRxBytes: safeInteger(record.networkRxBytes ?? record.network_rx),
    networkTxBytes: safeInteger(record.networkTxBytes ?? record.network_tx),
    blockReadBytes: safeInteger(record.blockReadBytes ?? record.blk_read),
    blockWriteBytes: safeInteger(record.blockWriteBytes ?? record.blk_write)
  };
}

export function parseSoakObservation(observation: unknown): SoakObservation {
  const record = requireRecord(observation);
  if (record.schemaVersion !== 1) {
    throw new Error("soak_observation_invalid");
  }
  if (record.kind === "sample") {
    assertAllowedKeys(record, SAMPLE_OBSERVATION_KEYS);
    const health = requireRecord(record.health);
    const resources = requireRecord(record.resources);
    assertAllowedKeys(health, HEALTH_OBSERVATION_KEYS);
    assertAllowedKeys(resources, RESOURCE_OBSERVATION_KEYS);
    return createSoakSample({
      sampledAt: sanitizeTimestamp(record.sampledAt),
      health: sanitizeHealth(health),
      resources: sanitizeResources(resources)
    });
  }
  if (record.kind === "error" && isSoakErrorCode(record.code)) {
    assertAllowedKeys(record, ERROR_OBSERVATION_KEYS);
    return {
      schemaVersion: 1,
      kind: "error",
      sampledAt: sanitizeTimestamp(record.sampledAt),
      code: record.code
    };
  }
  throw new Error("soak_observation_invalid");
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("soak_observation_invalid");
  }
}

function countersRegressed(previous: SoakSample, current: SoakSample): boolean {
  return MONOTONIC_HEALTH_COUNTERS.some(
    (field) => current.health[field] < previous.health[field]
  );
}

function browserUptimeRegressed(previous: SoakSample, current: SoakSample): boolean {
  const previousUptime = previous.health.browserUptimeMs;
  const currentUptime = current.health.browserUptimeMs;
  return (
    previousUptime !== undefined &&
    currentUptime !== undefined &&
    currentUptime + BROWSER_UPTIME_ROLLBACK_TOLERANCE_MS < previousUptime
  );
}

function evaluationCounters(sample: SoakSample): SoakEvaluationCounters {
  return {
    observedDeviceCount: sample.health.observedDeviceCount,
    decodedDeviceEventCount: sample.health.decodedDeviceEventCount,
    uniqueLogicalEventCount: sample.health.uniqueLogicalEventCount,
    duplicateEventCount: sample.health.duplicateEventCount,
    protocolInvalidFrameCount: sample.health.protocolInvalidFrameCount,
    protocolChangeCount: sample.health.protocolChangeCount,
    restartCount: sample.health.restartCount
  };
}

function validateEvaluationOptions(options: EvaluateSoakOptions): void {
  for (const value of [
    options.runStartedAtMs,
    options.expectedDurationMs,
    options.expectedIntervalMs
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("soak_evaluation_options_invalid");
    }
  }
  if (options.expectedDurationMs === 0 || options.expectedIntervalMs === 0) {
    throw new Error("soak_evaluation_options_invalid");
  }
  if (
    options.maxSustainedMemoryGrowthBytes !== undefined &&
    (!Number.isSafeInteger(options.maxSustainedMemoryGrowthBytes) ||
      options.maxSustainedMemoryGrowthBytes < 0)
  ) {
    throw new Error("soak_evaluation_options_invalid");
  }
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (Number(sorted[middle - 1]) + Number(sorted[middle])) / 2;
}

function safeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("unsafe boolean");
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("unsafe integer");
  }
  return Number(value);
}

function safeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("unsafe number");
  }
  return value;
}

function safeEnum(value: unknown, allowed: ReadonlySet<string>): string {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error("unsafe enum");
  }
  return value;
}

function safeVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /https?:\/\//iu.test(value) ||
    /[?&#=]/u.test(value) ||
    /(?:authorization|cookie|password|token|secret|csrf|session)/iu.test(value)
  ) {
    throw new Error("unsafe version");
  }
  return value;
}

function sanitizeTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("unsafe timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("unsafe timestamp");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function isSoakErrorCode(value: unknown): value is SoakErrorCode {
  return (
    value === "health_command_failed" ||
    value === "health_response_invalid" ||
    value === "stats_command_failed" ||
    value === "stats_response_invalid"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isSameOrWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const pathFromParent = relative(normalizedParent, normalizedCandidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent))
  );
}
