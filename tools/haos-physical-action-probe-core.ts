import {
  PHYSICAL_ACTION_PRESETS,
  type PhysicalActionProbeSnapshot,
  type ProbeCandidateSnapshot,
  type ProbeCounterSnapshot,
  type ProbeResultReason
} from "../bridge/src/inspector/physical-action-correlation-probe.js";
import {
  haosAddonContainerName,
  parseGuestExecText
} from "./haos-runtime-api-audit-core.js";

const MAX_RESPONSE_BYTES = 65_536;
const PROBE_STATES = new Set(["idle", "armed", "pass", "ambiguous", "fail", "voided"]);
const VALUE_TYPES = new Set(["null", "boolean", "number", "string", "array", "object"]);
const IDENTITY_SOURCES = new Set(["event_id", "fingerprint"]);
const ACTION_TYPES = new Set(Object.keys(PHYSICAL_ACTION_PRESETS));
const RESULT_REASONS = new Set<ProbeResultReason>([
  "manual_reset",
  "no_match",
  "multiple_candidates",
  "browser_not_isolated",
  "runtime_not_ready",
  "protocol_changed",
  "runtime_restarted",
  "invalid_frame_increase",
  "counter_regression",
  "unsafe_event",
  "candidate_overflow",
  "internal_failure"
]);
const FIXED_ERRORS = new Set([
  "invalid_json",
  "invalid_body",
  "unknown_key",
  "unsupported_action",
  "unsafe_target_alias",
  "window_out_of_range",
  "browser_not_isolated",
  "probe_conflict",
  "method_not_allowed",
  "body_too_large",
  "content_type_unsupported",
  "not_ready",
  "probe_unavailable",
  "internal_error",
  "not_found"
]);

export type PhysicalProbeOperation =
  | { kind: "status" }
  | { kind: "reset" }
  | {
      kind: "arm";
      actionType: keyof typeof PHYSICAL_ACTION_PRESETS;
      targetDeviceAlias?: string;
      windowSeconds?: number;
    };

export type PhysicalProbeHttpResult =
  | { ok: true; httpStatus: 200 | 201; snapshot: PhysicalActionProbeSnapshot }
  | { ok: false; httpStatus: number; error: string };

export interface PhysicalProbeRemoteOptions {
  vmId: number;
  addonSlug: string;
  operation: PhysicalProbeOperation;
}

export function buildPhysicalProbeRemoteCommand(options: PhysicalProbeRemoteOptions): string {
  const vmId = safePositiveInteger(options.vmId, "probe_command_invalid");
  const addonSlug = safeAddonSlug(options.addonSlug);
  const containerName = haosAddonContainerName(addonSlug);
  const path =
    options.operation.kind === "status"
      ? "/probe/physical-action"
      : options.operation.kind === "reset"
        ? "/probe/physical-action/reset"
        : "/probe/physical-action/arm";
  const base = [
    `qm guest exec ${String(vmId)} -- docker exec ${containerName}`,
    "curl -sS --connect-timeout 10 --max-time 30",
    "-w '\\n%{http_code}'"
  ];
  if (options.operation.kind === "status") {
    return `${base.join(" ")} http://127.0.0.1:8098${path}`;
  }
  const body =
    options.operation.kind === "reset" ? {} : sanitizeArmOperation(options.operation);
  return `${base.join(" ")} -X POST -H 'Content-Type: application/json' --data-binary '${JSON.stringify(body)}' http://127.0.0.1:8098${path}`;
}

export function parsePhysicalProbeGuestResponse(raw: string): PhysicalProbeHttpResult {
  const output = parseGuestExecText(
    raw,
    "probe_command_failed",
    "probe_response_invalid"
  );
  if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("probe_response_invalid");
  }
  const delimiter = output.lastIndexOf("\n");
  if (delimiter < 0) {
    throw new Error("probe_response_invalid");
  }
  const bodyText = output.slice(0, delimiter).trim();
  const statusText = output.slice(delimiter + 1).trim();
  if (!/^\d{3}$/u.test(statusText) || bodyText === "") {
    throw new Error("probe_response_invalid");
  }
  const httpStatus = Number(statusText);
  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error("probe_response_invalid");
  }
  if (httpStatus === 200 || httpStatus === 201) {
    return { ok: true, httpStatus, snapshot: sanitizeProbeSnapshot(body) };
  }
  const record = requireRecord(body, "probe_response_invalid");
  const error = record.error;
  if (typeof error !== "string" || !FIXED_ERRORS.has(error)) {
    throw new Error("probe_response_invalid");
  }
  return { ok: false, httpStatus, error };
}

export function isPhysicalActionType(
  value: string
): value is keyof typeof PHYSICAL_ACTION_PRESETS {
  return ACTION_TYPES.has(value);
}

function sanitizeArmOperation(
  operation: Extract<PhysicalProbeOperation, { kind: "arm" }>
): Record<string, string | number> {
  if (!isPhysicalActionType(operation.actionType)) {
    throw new Error("probe_command_invalid");
  }
  const result: Record<string, string | number> = { actionType: operation.actionType };
  if (operation.targetDeviceAlias !== undefined) {
    result.targetDeviceAlias = safeDeviceAlias(operation.targetDeviceAlias, "probe_command_invalid");
  }
  if (operation.windowSeconds !== undefined) {
    const windowSeconds = safePositiveInteger(operation.windowSeconds, "probe_command_invalid");
    if (windowSeconds < 15 || windowSeconds > 120) {
      throw new Error("probe_command_invalid");
    }
    result.windowSeconds = windowSeconds;
  }
  return result;
}

function sanitizeProbeSnapshot(value: unknown): PhysicalActionProbeSnapshot {
  const record = requireRecord(value, "probe_response_invalid");
  if (record.schemaVersion !== 1 || typeof record.state !== "string" || !PROBE_STATES.has(record.state)) {
    throw new Error("probe_response_invalid");
  }
  const actionType = optionalString(record.actionType);
  if (actionType !== undefined && !isPhysicalActionType(actionType)) {
    throw new Error("probe_response_invalid");
  }
  const targetDeviceAlias = optionalString(record.targetDeviceAlias);
  const windowSeconds = optionalNumber(record.windowSeconds);
  if (windowSeconds !== undefined && (!Number.isSafeInteger(windowSeconds) || windowSeconds < 15 || windowSeconds > 120)) {
    throw new Error("probe_response_invalid");
  }
  const reasons = requireArray(record.reasons, "probe_response_invalid").map((reason) => {
    if (typeof reason !== "string" || !RESULT_REASONS.has(reason as ProbeResultReason)) {
      throw new Error("probe_response_invalid");
    }
    return reason as ProbeResultReason;
  });
  const candidates = requireArray(record.candidates, "probe_response_invalid").map(
    sanitizeProbeCandidate
  );
  if (candidates.length > 32 || safeNonNegativeInteger(record.candidateCount) !== candidates.length) {
    throw new Error("probe_response_invalid");
  }
  const runtimeState = record.runtimeState;
  if (typeof runtimeState !== "string" || !/^[A-Z_]{1,32}$/u.test(runtimeState)) {
    throw new Error("probe_response_invalid");
  }
  return {
    schemaVersion: 1,
    state: record.state as PhysicalActionProbeSnapshot["state"],
    ...(actionType === undefined ? {} : { actionType }),
    ...(targetDeviceAlias === undefined
      ? {}
      : { targetDeviceAlias: safeDeviceAlias(targetDeviceAlias) }),
    ...(windowSeconds === undefined ? {} : { windowSeconds }),
    elapsedMs: safeNonNegativeNumber(record.elapsedMs),
    remainingMs: safeNonNegativeNumber(record.remainingMs),
    live: safeBoolean(record.live),
    ready: safeBoolean(record.ready),
    runtimeState,
    browserIsolated: safeBoolean(record.browserIsolated),
    ...(record.baseline === undefined ? {} : { baseline: sanitizeCounters(record.baseline) }),
    current: sanitizeCounters(record.current),
    candidateCount: candidates.length,
    reasons,
    candidates
  };
}

function sanitizeCounters(value: unknown): ProbeCounterSnapshot {
  const record = requireRecord(value, "probe_response_invalid");
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

function sanitizeProbeCandidate(value: unknown): ProbeCandidateSnapshot {
  const record = requireRecord(value, "probe_response_invalid");
  const valueType = record.valueType;
  const identitySource = record.identitySource;
  const stateChange = record.stateChange;
  if (
    typeof valueType !== "string" ||
    !VALUE_TYPES.has(valueType) ||
    typeof identitySource !== "string" ||
    !IDENTITY_SOURCES.has(identitySource) ||
    (stateChange !== null && typeof stateChange !== "boolean") ||
    record.uniqueLogicalEventCount !== 1
  ) {
    throw new Error("probe_response_invalid");
  }
  const logicalEventHash = record.logicalEventHash;
  if (typeof logicalEventHash !== "string" || !/^[a-f0-9]{64}$/u.test(logicalEventHash)) {
    throw new Error("probe_response_invalid");
  }
  const sourceAfterArmMs = optionalNumber(record.sourceAfterArmMs);
  return {
    deviceAlias: safeDeviceAlias(requireString(record.deviceAlias)),
    component: safeProtocolToken(record.component),
    capability: safeProtocolToken(record.capability),
    attribute: safeProtocolToken(record.attribute),
    valueType: valueType as ProbeCandidateSnapshot["valueType"],
    unitPresent: safeBoolean(record.unitPresent),
    stateChange,
    expectedValueMatched: safeBoolean(record.expectedValueMatched),
    identitySource: identitySource as ProbeCandidateSnapshot["identitySource"],
    logicalEventHash,
    uniqueLogicalEventCount: 1,
    deliveryCount: safePositiveInteger(record.deliveryCount, "probe_response_invalid"),
    receiveAfterArmMs: safeNonNegativeNumber(record.receiveAfterArmMs),
    ...(sourceAfterArmMs === undefined
      ? {}
      : { sourceAfterArmMs: safeNonNegativeNumber(sourceAfterArmMs) })
  };
}

function safeAddonSlug(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(value)) {
    throw new Error("probe_command_invalid");
  }
  return value;
}

function safeDeviceAlias(value: string, code = "probe_response_invalid"): string {
  if (!/^dev_[0-9]{3,32}$/u.test(value)) {
    throw new Error(code);
  }
  return value;
}

function safeProtocolToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    throw new Error("probe_response_invalid");
  }
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("probe_response_invalid");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("probe_response_invalid");
  }
  return value;
}

function safeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("probe_response_invalid");
  }
  return value;
}

function safeNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("probe_response_invalid");
  }
  return value;
}

function safeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("probe_response_invalid");
  }
  return Number(value);
}

function safePositiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(code);
  }
  return Number(value);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(code);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(code);
  }
  return value;
}
