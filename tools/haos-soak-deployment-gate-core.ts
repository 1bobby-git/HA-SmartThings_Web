import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import type {
  SoakEvaluation,
  SoakEvaluationCounters,
  SoakFailureCode,
  SoakWarningCode
} from "./haos-soak-core.js";

export const MINIMUM_SOAK_DURATION_MS = 72 * 60 * 60 * 1_000;
export const MAXIMUM_SOAK_INTERVAL_MS = 5 * 60 * 1_000;
export const MINIMUM_SOAK_SAMPLE_COUNT =
  Math.floor(MINIMUM_SOAK_DURATION_MS / MAXIMUM_SOAK_INTERVAL_MS) + 1;
export const MAXIMUM_MEMORY_GROWTH_BYTES = 256 * 1_024 * 1_024;

const MAX_JSON_ARTIFACT_BYTES = 128 * 1_024;
const MAX_HASH_ARTIFACT_BYTES = 256;
const RUN_KEYS = new Set([
  "schemaVersion",
  "status",
  "startedAt",
  "expectedEndAt",
  "durationMs",
  "intervalMs",
  "outputPolicy"
]);
const SUMMARY_KEYS = new Set([
  "schemaVersion",
  "status",
  "startedAt",
  "expectedEndAt",
  "lastSampledAt",
  "expectedDurationMs",
  "expectedIntervalMs",
  "completed",
  "sampleCount",
  "successfulSampleCount",
  "errorSampleCount",
  "failures",
  "warnings",
  "maxGapMs",
  "memoryStartMedianBytes",
  "memoryEndMedianBytes",
  "memoryPeakBytes",
  "memoryGrowthBytes",
  "baseline",
  "final"
]);
const COUNTER_KEYS = new Set([
  "observedDeviceCount",
  "decodedDeviceEventCount",
  "uniqueLogicalEventCount",
  "duplicateEventCount",
  "protocolInvalidFrameCount",
  "protocolChangeCount",
  "restartCount"
]);
const RUN_STATUSES = new Set(["running", "completed", "interrupted"]);
const SOAK_STATUSES = new Set(["pending", "pass", "fail"]);
const FAILURE_CODES = new Set<SoakFailureCode>([
  "sample_error",
  "timestamp_invalid",
  "timestamp_order",
  "not_live",
  "not_ready",
  "state_not_connected",
  "protocol_changed",
  "runtime_restarted",
  "invalid_frame_increase",
  "counter_regression",
  "sample_gap",
  "memory_growth",
  "insufficient_samples"
]);
const WARNING_CODES = new Set<SoakWarningCode>(["event_counters_flat"]);

export type SoakRunStatus = "running" | "completed" | "interrupted";
export type SoakDeploymentGateReason =
  | "run_metadata_invalid"
  | "status_invalid"
  | "summary_missing"
  | "summary_invalid"
  | "summary_hash_missing"
  | "summary_hash_invalid"
  | "summary_hash_mismatch"
  | "run_not_completed"
  | "soak_not_passed"
  | "summary_not_completed"
  | "duration_below_minimum"
  | "interval_above_maximum"
  | "run_summary_mismatch"
  | "completion_time_invalid"
  | "insufficient_samples"
  | "sample_errors_present"
  | "successful_sample_mismatch"
  | "failures_present"
  | "sample_gap_exceeded"
  | "memory_growth_exceeded"
  | "completion_evidence_missing"
  | "counter_evidence_invalid";

export interface SoakRunMetadata {
  schemaVersion: 1;
  status: SoakRunStatus;
  startedAt: string;
  expectedEndAt: string;
  durationMs: number;
  intervalMs: number;
  outputPolicy: "allowlisted_aggregates_only";
}

export interface SoakDeploymentGateResult {
  schemaVersion: 1;
  deploymentEligible: boolean;
  evidenceState: "eligible" | "pending" | "blocked" | "invalid";
  reasons: SoakDeploymentGateReason[];
  runStatus?: SoakRunStatus;
  soakStatus?: SoakEvaluation["status"];
  startedAt?: string;
  expectedEndAt?: string;
  durationMs?: number;
  intervalMs?: number;
  sampleCount?: number;
  successfulSampleCount?: number;
  errorSampleCount?: number;
  failures?: SoakFailureCode[];
  warnings?: SoakWarningCode[];
  summarySha256?: string;
}

export interface InspectSoakDeploymentGateOptions {
  runDirectory: string;
  repositoryRoot: string;
}

export async function inspectSoakDeploymentGate(
  options: InspectSoakDeploymentGateOptions
): Promise<SoakDeploymentGateResult> {
  const runDirectory = await assertExternalRunDirectory(
    options.runDirectory,
    options.repositoryRoot
  );
  const metadataText = await readArtifact(resolve(runDirectory, "run.json"), MAX_JSON_ARTIFACT_BYTES);
  if (metadataText === undefined) {
    return invalidResult("run_metadata_invalid");
  }

  let metadata: SoakRunMetadata;
  try {
    metadata = parseSoakRunMetadata(metadataText);
  } catch {
    return invalidResult("run_metadata_invalid");
  }

  if (metadata.status !== "completed") {
    const statusText = await readArtifact(
      resolve(runDirectory, "status.json"),
      MAX_JSON_ARTIFACT_BYTES
    );
    if (statusText === undefined) {
      return invalidResult("status_invalid", metadata);
    }
    try {
      return evaluateSoakDeploymentGate(metadata, parseSoakEvaluation(statusText));
    } catch {
      return invalidResult("status_invalid", metadata);
    }
  }

  const summaryText = await readArtifact(
    resolve(runDirectory, "final-summary.json"),
    MAX_JSON_ARTIFACT_BYTES
  );
  if (summaryText === undefined) {
    return invalidResult("summary_missing", metadata);
  }
  const hashText = await readArtifact(
    resolve(runDirectory, "final-summary.json.sha256"),
    MAX_HASH_ARTIFACT_BYTES
  );
  if (hashText === undefined) {
    return invalidResult("summary_hash_missing", metadata);
  }

  let summary: SoakEvaluation;
  let expectedDigest: string;
  try {
    summary = parseSoakEvaluation(summaryText);
  } catch {
    return invalidResult("summary_invalid", metadata);
  }
  try {
    expectedDigest = parseSummaryDigest(hashText);
  } catch {
    return invalidResult("summary_hash_invalid", metadata);
  }
  const actualDigest = createHash("sha256").update(summaryText).digest("hex");
  return evaluateSoakDeploymentGate(metadata, summary, {
    summarySha256: actualDigest,
    summaryHashMatches: actualDigest === expectedDigest
  });
}

export function parseSoakRunMetadata(text: string): SoakRunMetadata {
  const record = parseRecord(text, "run metadata");
  assertAllowedKeys(record, RUN_KEYS);
  if (
    record.schemaVersion !== 1 ||
    typeof record.status !== "string" ||
    !RUN_STATUSES.has(record.status) ||
    record.outputPolicy !== "allowlisted_aggregates_only"
  ) {
    throw new Error("soak_run_metadata_invalid");
  }
  return {
    schemaVersion: 1,
    status: record.status as SoakRunStatus,
    startedAt: safeTimestamp(record.startedAt),
    expectedEndAt: safeTimestamp(record.expectedEndAt),
    durationMs: safePositiveInteger(record.durationMs),
    intervalMs: safePositiveInteger(record.intervalMs),
    outputPolicy: "allowlisted_aggregates_only"
  };
}

export function parseSoakEvaluation(text: string): SoakEvaluation {
  const record = parseRecord(text, "summary");
  assertAllowedKeys(record, SUMMARY_KEYS);
  if (
    record.schemaVersion !== 1 ||
    typeof record.status !== "string" ||
    !SOAK_STATUSES.has(record.status) ||
    typeof record.completed !== "boolean"
  ) {
    throw new Error("soak_summary_invalid");
  }
  const lastSampledAt =
    record.lastSampledAt === undefined ? undefined : safeTimestamp(record.lastSampledAt);
  const memoryStartMedianBytes = optionalNonNegativeNumber(record.memoryStartMedianBytes);
  const memoryEndMedianBytes = optionalNonNegativeNumber(record.memoryEndMedianBytes);
  const memoryPeakBytes = optionalNonNegativeInteger(record.memoryPeakBytes);
  const memoryGrowthBytes = optionalFiniteNumber(record.memoryGrowthBytes);
  const baseline =
    record.baseline === undefined ? undefined : sanitizeCounters(record.baseline);
  const final = record.final === undefined ? undefined : sanitizeCounters(record.final);
  return {
    schemaVersion: 1,
    status: record.status as SoakEvaluation["status"],
    startedAt: safeTimestamp(record.startedAt),
    expectedEndAt: safeTimestamp(record.expectedEndAt),
    ...(lastSampledAt === undefined ? {} : { lastSampledAt }),
    expectedDurationMs: safePositiveInteger(record.expectedDurationMs),
    expectedIntervalMs: safePositiveInteger(record.expectedIntervalMs),
    completed: record.completed,
    sampleCount: safeNonNegativeInteger(record.sampleCount),
    successfulSampleCount: safeNonNegativeInteger(record.successfulSampleCount),
    errorSampleCount: safeNonNegativeInteger(record.errorSampleCount),
    failures: safeEnumArray(record.failures, FAILURE_CODES),
    warnings: safeEnumArray(record.warnings, WARNING_CODES),
    maxGapMs: safeNonNegativeInteger(record.maxGapMs),
    ...(memoryStartMedianBytes === undefined ? {} : { memoryStartMedianBytes }),
    ...(memoryEndMedianBytes === undefined ? {} : { memoryEndMedianBytes }),
    ...(memoryPeakBytes === undefined ? {} : { memoryPeakBytes }),
    ...(memoryGrowthBytes === undefined ? {} : { memoryGrowthBytes }),
    ...(baseline === undefined ? {} : { baseline }),
    ...(final === undefined ? {} : { final })
  };
}

export function parseSummaryDigest(text: string): string {
  const match = /^([a-f0-9]{64})  final-summary\.json\r?\n?$/u.exec(text);
  if (!match?.[1]) {
    throw new Error("soak_summary_hash_invalid");
  }
  return match[1];
}

export function evaluateSoakDeploymentGate(
  metadata: SoakRunMetadata,
  summary: SoakEvaluation,
  integrity?: { summarySha256: string; summaryHashMatches: boolean }
): SoakDeploymentGateResult {
  const reasons: SoakDeploymentGateReason[] = [];
  const safeSummarySha256 =
    integrity !== undefined && /^[a-f0-9]{64}$/u.test(integrity.summarySha256)
      ? integrity.summarySha256
      : undefined;
  if (metadata.status !== "completed") {
    reasons.push("run_not_completed");
  }
  if (summary.status !== "pass") {
    reasons.push("soak_not_passed");
  }
  if (!summary.completed) {
    reasons.push("summary_not_completed");
  }
  if (metadata.durationMs < MINIMUM_SOAK_DURATION_MS) {
    reasons.push("duration_below_minimum");
  }
  if (metadata.intervalMs > MAXIMUM_SOAK_INTERVAL_MS) {
    reasons.push("interval_above_maximum");
  }
  if (!metadataAndSummaryMatch(metadata, summary)) {
    reasons.push("run_summary_mismatch");
  }
  if (!completionTimeIsValid(summary)) {
    reasons.push("completion_time_invalid");
  }
  if (summary.sampleCount < MINIMUM_SOAK_SAMPLE_COUNT) {
    reasons.push("insufficient_samples");
  }
  if (summary.errorSampleCount > 0) {
    reasons.push("sample_errors_present");
  }
  if (
    summary.successfulSampleCount + summary.errorSampleCount !== summary.sampleCount ||
    summary.successfulSampleCount !== summary.sampleCount
  ) {
    reasons.push("successful_sample_mismatch");
  }
  if (summary.failures.length > 0) {
    reasons.push("failures_present");
  }
  if (summary.maxGapMs > summary.expectedIntervalMs * 2) {
    reasons.push("sample_gap_exceeded");
  }
  if (
    summary.memoryGrowthBytes !== undefined &&
    summary.memoryGrowthBytes > MAXIMUM_MEMORY_GROWTH_BYTES
  ) {
    reasons.push("memory_growth_exceeded");
  }
  if (!hasCompleteEvidence(summary)) {
    reasons.push("completion_evidence_missing");
  } else if (!counterEvidenceIsValid(summary.baseline, summary.final)) {
    reasons.push("counter_evidence_invalid");
  }
  if (metadata.status === "completed") {
    if (integrity === undefined) {
      reasons.push("summary_hash_missing");
    } else if (safeSummarySha256 === undefined) {
      reasons.push("summary_hash_invalid");
    } else if (!integrity.summaryHashMatches) {
      reasons.push("summary_hash_mismatch");
    }
  }

  const deploymentEligible = reasons.length === 0;
  return {
    schemaVersion: 1,
    deploymentEligible,
    evidenceState: deploymentEligible
      ? "eligible"
      : metadata.status === "running" || summary.status === "pending"
        ? "pending"
        : "blocked",
    reasons,
    runStatus: metadata.status,
    soakStatus: summary.status,
    startedAt: metadata.startedAt,
    expectedEndAt: metadata.expectedEndAt,
    durationMs: metadata.durationMs,
    intervalMs: metadata.intervalMs,
    sampleCount: summary.sampleCount,
    successfulSampleCount: summary.successfulSampleCount,
    errorSampleCount: summary.errorSampleCount,
    failures: [...summary.failures],
    warnings: [...summary.warnings],
    ...(safeSummarySha256 === undefined ? {} : { summarySha256: safeSummarySha256 })
  };
}

async function assertExternalRunDirectory(
  runDirectory: string,
  repositoryRoot: string
): Promise<string> {
  const resolvedRun = resolve(runDirectory);
  const resolvedRepository = resolve(repositoryRoot);
  if (isSameOrWithin(resolvedRun, resolvedRepository)) {
    throw new Error("soak_deployment_gate_path_invalid");
  }
  await assertPathHasNoSymbolicLinks(resolvedRun);
  const runStats = await lstat(resolvedRun);
  if (!runStats.isDirectory() || runStats.isSymbolicLink()) {
    throw new Error("soak_deployment_gate_path_invalid");
  }
  const [realRun, realRepository] = await Promise.all([
    realpath(resolvedRun),
    realpath(resolvedRepository)
  ]);
  if (isSameOrWithin(realRun, realRepository)) {
    throw new Error("soak_deployment_gate_path_invalid");
  }
  return realRun;
}

async function assertPathHasNoSymbolicLinks(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const currentStats = await lstat(current);
    if (currentStats.isSymbolicLink()) {
      throw new Error("soak_deployment_gate_path_invalid");
    }
  }
}

async function readArtifact(path: string, maximumBytes: number): Promise<string | undefined> {
  let artifactStats;
  try {
    artifactStats = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
  if (!artifactStats.isFile() || artifactStats.isSymbolicLink() || artifactStats.size > maximumBytes) {
    return undefined;
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    return undefined;
  }
  return text;
}

function invalidResult(
  reason: SoakDeploymentGateReason,
  metadata?: SoakRunMetadata
): SoakDeploymentGateResult {
  return {
    schemaVersion: 1,
    deploymentEligible: false,
    evidenceState: "invalid",
    reasons: [reason],
    ...(metadata === undefined
      ? {}
      : {
          runStatus: metadata.status,
          startedAt: metadata.startedAt,
          expectedEndAt: metadata.expectedEndAt,
          durationMs: metadata.durationMs,
          intervalMs: metadata.intervalMs
        })
  };
}

function metadataAndSummaryMatch(
  metadata: SoakRunMetadata,
  summary: SoakEvaluation
): boolean {
  const expectedEndAtMs = Date.parse(metadata.startedAt) + metadata.durationMs;
  const summaryExpectedEndAtMs = Date.parse(summary.startedAt) + summary.expectedDurationMs;
  return (
    Date.parse(metadata.expectedEndAt) === expectedEndAtMs &&
    Date.parse(summary.expectedEndAt) === summaryExpectedEndAtMs &&
    metadata.startedAt === summary.startedAt &&
    metadata.expectedEndAt === summary.expectedEndAt &&
    metadata.durationMs === summary.expectedDurationMs &&
    metadata.intervalMs === summary.expectedIntervalMs
  );
}

function completionTimeIsValid(summary: SoakEvaluation): boolean {
  return (
    summary.lastSampledAt !== undefined &&
    Date.parse(summary.lastSampledAt) >= Date.parse(summary.expectedEndAt)
  );
}

function hasCompleteEvidence(
  summary: SoakEvaluation
): summary is SoakEvaluation & {
  baseline: SoakEvaluationCounters;
  final: SoakEvaluationCounters;
  memoryStartMedianBytes: number;
  memoryEndMedianBytes: number;
  memoryPeakBytes: number;
  memoryGrowthBytes: number;
} {
  return (
    summary.baseline !== undefined &&
    summary.final !== undefined &&
    summary.memoryStartMedianBytes !== undefined &&
    summary.memoryEndMedianBytes !== undefined &&
    summary.memoryPeakBytes !== undefined &&
    summary.memoryGrowthBytes !== undefined
  );
}

function counterEvidenceIsValid(
  baseline: SoakEvaluationCounters,
  final: SoakEvaluationCounters
): boolean {
  return (
    baseline.observedDeviceCount > 0 &&
    final.observedDeviceCount > 0 &&
    final.protocolChangeCount === baseline.protocolChangeCount &&
    baseline.restartCount === 0 &&
    final.restartCount === 0 &&
    final.protocolInvalidFrameCount === baseline.protocolInvalidFrameCount &&
    baseline.uniqueLogicalEventCount + baseline.duplicateEventCount ===
      baseline.decodedDeviceEventCount &&
    final.uniqueLogicalEventCount + final.duplicateEventCount ===
      final.decodedDeviceEventCount &&
    final.decodedDeviceEventCount >= baseline.decodedDeviceEventCount &&
    final.uniqueLogicalEventCount >= baseline.uniqueLogicalEventCount &&
    final.duplicateEventCount >= baseline.duplicateEventCount
  );
}

function sanitizeCounters(value: unknown): SoakEvaluationCounters {
  const record = requireRecord(value);
  assertAllowedKeys(record, COUNTER_KEYS);
  return {
    observedDeviceCount: safeNonNegativeInteger(record.observedDeviceCount),
    decodedDeviceEventCount: safeNonNegativeInteger(record.decodedDeviceEventCount),
    uniqueLogicalEventCount: safeNonNegativeInteger(record.uniqueLogicalEventCount),
    duplicateEventCount: safeNonNegativeInteger(record.duplicateEventCount),
    protocolInvalidFrameCount: safeNonNegativeInteger(record.protocolInvalidFrameCount),
    protocolChangeCount: safeNonNegativeInteger(record.protocolChangeCount),
    restartCount: safeNonNegativeInteger(record.restartCount)
  };
}

function parseRecord(text: string, _label: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_ARTIFACT_BYTES) {
    throw new Error("soak_artifact_too_large");
  }
  try {
    return requireRecord(JSON.parse(text) as unknown);
  } catch {
    throw new Error("soak_artifact_invalid");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("soak_artifact_invalid");
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("soak_artifact_invalid");
  }
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("soak_artifact_invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("soak_artifact_invalid");
  }
  return value;
}

function safePositiveInteger(value: unknown): number {
  const parsed = safeNonNegativeInteger(value);
  if (parsed === 0) {
    throw new Error("soak_artifact_invalid");
  }
  return parsed;
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("soak_artifact_invalid");
  }
  return Number(value);
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("soak_artifact_invalid");
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : safeNonNegativeInteger(value);
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("soak_artifact_invalid");
  }
  return value;
}

function safeEnumArray<T extends string>(value: unknown, allowed: ReadonlySet<T>): T[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !allowed.has(item as T))) {
    throw new Error("soak_artifact_invalid");
  }
  const result = value as T[];
  if (new Set(result).size !== result.length) {
    throw new Error("soak_artifact_invalid");
  }
  return [...result];
}

function isSameOrWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedParent = normalizeForComparison(parent);
  const pathFromParent = relative(normalizedParent, normalizedCandidate);
  return (
    pathFromParent === "" ||
    (pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromParent))
  );
}

function normalizeForComparison(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
