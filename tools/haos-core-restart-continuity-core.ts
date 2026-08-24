import type { SoakHealthObservation } from "./haos-soak-core.js";
import type { SoakDeploymentGateResult } from "./haos-soak-deployment-gate-core.js";
import { parseGuestExecText } from "./haos-runtime-api-audit-core.js";

const SAFE_VERSION = /^[0-9A-Za-z_.+-]{1,120}$/u;
const SAFE_ADDON_SLUG = /^[A-Za-z0-9_-]{1,120}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const DOCKER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export type HaosCoreRestartPreflightReason =
  | "soak_gate_blocked"
  | "core_version_mismatch"
  | "core_boot_disabled"
  | "core_watchdog_disabled"
  | "core_container_not_running"
  | "bridge_version_mismatch"
  | "bridge_not_live"
  | "bridge_not_ready"
  | "bridge_not_connected"
  | "keeper_not_location"
  | "snapshot_missing"
  | "browser_uptime_missing"
  | "protocol_changed"
  | "runtime_restarted";

export type HaosCoreRestartContinuityFailure =
  | "core_restart_not_observed"
  | "core_posture_changed"
  | "bridge_health_sample_error"
  | "bridge_unavailable_during_restart"
  | "post_health_unusable"
  | "bridge_version_changed"
  | "browser_version_changed"
  | "protocol_version_changed"
  | "browser_restarted"
  | "runtime_restart_count_changed"
  | "protocol_change_count_changed"
  | "invalid_frame_count_changed"
  | "device_inventory_changed"
  | "counter_regression";

export interface HaosCoreInfo {
  version: string;
  versionLatest: string;
  boot: boolean;
  watchdog: boolean;
}

export interface HaosCoreContainerState {
  containerId: string;
  startedAt: string;
  running: boolean;
}

export interface HaosCoreRestartPreflight {
  schemaVersion: 1;
  executionEligible: boolean;
  reasons: HaosCoreRestartPreflightReason[];
  soak: {
    evidenceState: SoakDeploymentGateResult["evidenceState"];
    reasons: SoakDeploymentGateResult["reasons"];
    sampleCount?: number;
  };
  core: HaosCoreInfo & { containerRunning: boolean };
  bridge: HealthEvidence;
}

export interface HaosCoreRestartContinuitySummary {
  schemaVersion: 1;
  scenario: "ha_core_restart";
  status: "pass" | "fail";
  startedAt: string;
  endedAt: string;
  durationMs: number;
  failures: HaosCoreRestartContinuityFailure[];
  checks: {
    coreRestartObserved: boolean;
    coreStartedAtAdvanced: boolean;
    corePosturePreserved: boolean;
    bridgeAvailableEverySample: boolean;
    bridgeVersionPreserved: boolean;
    browserVersionPreserved: boolean;
    protocolVersionPreserved: boolean;
    browserUptimeAdvanced: boolean;
    runtimeRestartCountPreserved: boolean;
    protocolChangeCountPreserved: boolean;
    invalidFrameCountPreserved: boolean;
    deviceInventoryPreserved: boolean;
    countersMonotonic: boolean;
    postHealthUsable: boolean;
  };
  monitoring: {
    healthSampleCount: number;
    healthSampleErrorCount: number;
    unhealthyHealthSampleCount: number;
  };
  baseline: HealthEvidence;
  post: HealthEvidence;
  core: {
    baselineVersion: string;
    postVersion: string;
    baselineStartedAt: string;
    postStartedAt: string;
    containerIdentityChanged: boolean;
  };
  limitations: readonly [
    "single_controlled_core_restart",
    "home_assistant_client_reconnect_requires_phase2_integration"
  ];
}

interface HealthEvidence {
  live: boolean;
  ready: boolean;
  state: string;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
  bridgeVersion: string;
  browserVersion: string;
  protocolVersion: string;
  initialSnapshotObserved: boolean;
  browserUptimeMs?: number;
}

export function buildHaosCoreInfoRemoteCommand(vmId: number): string {
  assertVmId(vmId);
  return `qm guest exec ${String(vmId)} -- ha core info --raw-json`;
}

export function buildHaosCoreContainerStateRemoteCommand(vmId: number): string {
  assertVmId(vmId);
  return `qm guest exec ${String(vmId)} -- docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.State.Running}}' homeassistant`;
}

export function buildHaosCoreRestartRemoteCommand(vmId: number): string {
  assertVmId(vmId);
  return `qm guest exec ${String(vmId)} -- ha core restart`;
}

export function buildHaosBridgeHealthRemoteCommand(vmId: number, addonSlug: string): string {
  assertVmId(vmId);
  if (!SAFE_ADDON_SLUG.test(addonSlug)) {
    throw new Error("haos_core_restart_command_invalid");
  }
  return `qm guest exec ${String(vmId)} -- docker exec app_${addonSlug} curl -fsS http://127.0.0.1:8098/health/details`;
}

export function parseHaosCoreInfoGuestResponse(raw: string): HaosCoreInfo {
  try {
    const output = parseGuestExecText(
      raw,
      "haos_core_info_command_failed",
      "haos_core_info_response_invalid"
    );
    const envelope = requireRecord(JSON.parse(output) as unknown);
    if (envelope.result !== "ok") {
      throw new Error("invalid result");
    }
    const data = requireRecord(envelope.data);
    return {
      version: safeVersion(data.version),
      versionLatest: safeVersion(data.version_latest),
      boot: safeBoolean(data.boot),
      watchdog: safeBoolean(data.watchdog)
    };
  } catch (error) {
    if (error instanceof Error && error.message === "haos_core_info_command_failed") {
      throw error;
    }
    throw new Error("haos_core_info_response_invalid");
  }
}

export function parseHaosCoreContainerStateGuestResponse(raw: string): HaosCoreContainerState {
  try {
    const output = parseGuestExecText(
      raw,
      "haos_core_container_command_failed",
      "haos_core_container_response_invalid"
    ).trim();
    const parts = output.split("|");
    const containerId = parts[0];
    const rawStartedAt = parts[1];
    const rawRunning = parts[2];
    if (
      parts.length !== 3 ||
      !containerId ||
      !CONTAINER_ID.test(containerId) ||
      !rawStartedAt ||
      !DOCKER_TIMESTAMP.test(rawStartedAt) ||
      !Number.isFinite(Date.parse(rawStartedAt)) ||
      (rawRunning !== "true" && rawRunning !== "false")
    ) {
      throw new Error("invalid state");
    }
    return {
      containerId,
      startedAt: new Date(Date.parse(rawStartedAt)).toISOString(),
      running: rawRunning === "true"
    };
  } catch (error) {
    if (error instanceof Error && error.message === "haos_core_container_command_failed") {
      throw error;
    }
    throw new Error("haos_core_container_response_invalid");
  }
}

export function assertHaosCoreRestartGuestResponse(raw: string): void {
  parseGuestExecText(
    raw,
    "haos_core_restart_command_failed",
    "haos_core_restart_response_invalid"
  );
}

export function evaluateHaosCoreRestartPreflight(input: {
  soakGate: SoakDeploymentGateResult;
  coreInfo: HaosCoreInfo;
  coreContainer: HaosCoreContainerState;
  health: SoakHealthObservation;
  expectedCoreVersion: string;
  expectedBridgeVersion: string;
}): HaosCoreRestartPreflight {
  safeVersion(input.expectedCoreVersion);
  safeVersion(input.expectedBridgeVersion);
  const reasons: HaosCoreRestartPreflightReason[] = [];
  addReason(reasons, input.soakGate.deploymentEligible, "soak_gate_blocked");
  addReason(reasons, input.coreInfo.version === input.expectedCoreVersion, "core_version_mismatch");
  addReason(reasons, input.coreInfo.boot, "core_boot_disabled");
  addReason(reasons, input.coreInfo.watchdog, "core_watchdog_disabled");
  addReason(reasons, input.coreContainer.running, "core_container_not_running");
  addReason(reasons, input.health.bridgeVersion === input.expectedBridgeVersion, "bridge_version_mismatch");
  addReason(reasons, input.health.live, "bridge_not_live");
  addReason(reasons, input.health.ready, "bridge_not_ready");
  addReason(reasons, input.health.state === "CONNECTED", "bridge_not_connected");
  addReason(reasons, input.health.urlCategory === "smartthings_location", "keeper_not_location");
  addReason(
    reasons,
    input.health.observedDeviceCount > 0 && input.health.initialSnapshotAgeMs !== undefined,
    "snapshot_missing"
  );
  addReason(reasons, input.health.browserUptimeMs !== undefined, "browser_uptime_missing");
  addReason(reasons, input.health.protocolChangeCount === 0, "protocol_changed");
  addReason(reasons, input.health.restartCount === 0, "runtime_restarted");
  return {
    schemaVersion: 1,
    executionEligible: reasons.length === 0,
    reasons,
    soak: {
      evidenceState: input.soakGate.evidenceState,
      reasons: [...input.soakGate.reasons],
      ...(input.soakGate.sampleCount === undefined ? {} : { sampleCount: input.soakGate.sampleCount })
    },
    core: { ...input.coreInfo, containerRunning: input.coreContainer.running },
    bridge: healthEvidence(input.health)
  };
}

export function evaluateHaosCoreRestartContinuity(input: {
  startedAt: string;
  endedAt: string;
  baselineCoreInfo: HaosCoreInfo;
  postCoreInfo: HaosCoreInfo;
  baselineCoreContainer: HaosCoreContainerState;
  postCoreContainer: HaosCoreContainerState;
  baselineHealth: SoakHealthObservation;
  postHealth: SoakHealthObservation;
  healthSampleCount: number;
  healthSampleErrorCount: number;
  unhealthyHealthSampleCount: number;
}): HaosCoreRestartContinuitySummary {
  const startedAt = safeTimestamp(input.startedAt);
  const endedAt = safeTimestamp(input.endedAt);
  const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
  for (const count of [
    input.healthSampleCount,
    input.healthSampleErrorCount,
    input.unhealthyHealthSampleCount
  ]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("haos_core_restart_evidence_invalid");
    }
  }
  if (
    durationMs < 0 ||
    input.unhealthyHealthSampleCount > input.healthSampleCount
  ) {
    throw new Error("haos_core_restart_evidence_invalid");
  }
  const coreContainerIdentityChanged =
    input.postCoreContainer.containerId !== input.baselineCoreContainer.containerId;
  const coreStartedAtAdvanced =
    Date.parse(input.postCoreContainer.startedAt) > Date.parse(input.baselineCoreContainer.startedAt);
  const coreRestartObserved = coreStartedAtAdvanced;
  const corePosturePreserved =
    input.postCoreContainer.running &&
    input.postCoreInfo.version === input.baselineCoreInfo.version &&
    input.postCoreInfo.boot === input.baselineCoreInfo.boot &&
    input.postCoreInfo.watchdog === input.baselineCoreInfo.watchdog;
  const bridgeAvailableEverySample =
    input.healthSampleCount >= 2 &&
    input.healthSampleErrorCount === 0 &&
    input.unhealthyHealthSampleCount === 0;
  const bridgeVersionPreserved =
    input.postHealth.bridgeVersion === input.baselineHealth.bridgeVersion;
  const browserVersionPreserved =
    input.postHealth.browserVersion === input.baselineHealth.browserVersion;
  const protocolVersionPreserved =
    input.postHealth.protocolVersion === input.baselineHealth.protocolVersion;
  const browserUptimeAdvanced =
    input.baselineHealth.browserUptimeMs !== undefined &&
    input.postHealth.browserUptimeMs !== undefined &&
    input.postHealth.browserUptimeMs >= input.baselineHealth.browserUptimeMs;
  const runtimeRestartCountPreserved =
    input.baselineHealth.restartCount === 0 && input.postHealth.restartCount === 0;
  const protocolChangeCountPreserved =
    input.baselineHealth.protocolChangeCount === 0 && input.postHealth.protocolChangeCount === 0;
  const invalidFrameCountPreserved =
    input.postHealth.protocolInvalidFrameCount === input.baselineHealth.protocolInvalidFrameCount;
  const deviceInventoryPreserved =
    input.postHealth.observedDeviceCount === input.baselineHealth.observedDeviceCount;
  const countersMonotonic = countersDidNotRegress(input.baselineHealth, input.postHealth);
  const postHealthUsable = healthIsUsable(input.postHealth);
  const checks = {
    coreRestartObserved,
    coreStartedAtAdvanced,
    corePosturePreserved,
    bridgeAvailableEverySample,
    bridgeVersionPreserved,
    browserVersionPreserved,
    protocolVersionPreserved,
    browserUptimeAdvanced,
    runtimeRestartCountPreserved,
    protocolChangeCountPreserved,
    invalidFrameCountPreserved,
    deviceInventoryPreserved,
    countersMonotonic,
    postHealthUsable
  };
  const failures: HaosCoreRestartContinuityFailure[] = [];
  addFailure(failures, checks.coreRestartObserved, "core_restart_not_observed");
  addFailure(failures, checks.corePosturePreserved, "core_posture_changed");
  addFailure(failures, input.healthSampleErrorCount === 0, "bridge_health_sample_error");
  addFailure(failures, checks.bridgeAvailableEverySample, "bridge_unavailable_during_restart");
  addFailure(failures, checks.postHealthUsable, "post_health_unusable");
  addFailure(failures, checks.bridgeVersionPreserved, "bridge_version_changed");
  addFailure(failures, checks.browserVersionPreserved, "browser_version_changed");
  addFailure(failures, checks.protocolVersionPreserved, "protocol_version_changed");
  addFailure(failures, checks.browserUptimeAdvanced, "browser_restarted");
  addFailure(failures, checks.runtimeRestartCountPreserved, "runtime_restart_count_changed");
  addFailure(failures, checks.protocolChangeCountPreserved, "protocol_change_count_changed");
  addFailure(failures, checks.invalidFrameCountPreserved, "invalid_frame_count_changed");
  addFailure(failures, checks.deviceInventoryPreserved, "device_inventory_changed");
  addFailure(failures, checks.countersMonotonic, "counter_regression");
  return {
    schemaVersion: 1,
    scenario: "ha_core_restart",
    status: failures.length === 0 ? "pass" : "fail",
    startedAt,
    endedAt,
    durationMs,
    failures,
    checks,
    monitoring: {
      healthSampleCount: input.healthSampleCount,
      healthSampleErrorCount: input.healthSampleErrorCount,
      unhealthyHealthSampleCount: input.unhealthyHealthSampleCount
    },
    baseline: healthEvidence(input.baselineHealth),
    post: healthEvidence(input.postHealth),
    core: {
      baselineVersion: input.baselineCoreInfo.version,
      postVersion: input.postCoreInfo.version,
      baselineStartedAt: input.baselineCoreContainer.startedAt,
      postStartedAt: input.postCoreContainer.startedAt,
      containerIdentityChanged: coreContainerIdentityChanged
    },
    limitations: [
      "single_controlled_core_restart",
      "home_assistant_client_reconnect_requires_phase2_integration"
    ]
  };
}

export function healthIsUsable(health: SoakHealthObservation): boolean {
  return (
    health.live &&
    health.ready &&
    health.state === "CONNECTED" &&
    health.urlCategory === "smartthings_location" &&
    health.observedDeviceCount > 0 &&
    health.initialSnapshotAgeMs !== undefined &&
    health.browserUptimeMs !== undefined &&
    health.protocolChangeCount === 0 &&
    health.restartCount === 0
  );
}

function countersDidNotRegress(
  baseline: SoakHealthObservation,
  post: SoakHealthObservation
): boolean {
  return (
    post.decodedDeviceEventCount >= baseline.decodedDeviceEventCount &&
    post.uniqueLogicalEventCount >= baseline.uniqueLogicalEventCount &&
    post.duplicateEventCount >= baseline.duplicateEventCount &&
    post.protocolInvalidFrameCount >= baseline.protocolInvalidFrameCount
  );
}

function healthEvidence(health: SoakHealthObservation): HealthEvidence {
  return {
    live: health.live,
    ready: health.ready,
    state: health.state,
    observedDeviceCount: health.observedDeviceCount,
    decodedDeviceEventCount: health.decodedDeviceEventCount,
    uniqueLogicalEventCount: health.uniqueLogicalEventCount,
    duplicateEventCount: health.duplicateEventCount,
    protocolInvalidFrameCount: health.protocolInvalidFrameCount,
    protocolChangeCount: health.protocolChangeCount,
    restartCount: health.restartCount,
    bridgeVersion: health.bridgeVersion,
    browserVersion: health.browserVersion,
    protocolVersion: health.protocolVersion,
    initialSnapshotObserved: health.initialSnapshotAgeMs !== undefined,
    ...(health.browserUptimeMs === undefined ? {} : { browserUptimeMs: health.browserUptimeMs })
  };
}

function safeVersion(value: unknown): string {
  if (typeof value !== "string" || !SAFE_VERSION.test(value)) {
    throw new Error("haos_core_restart_evidence_invalid");
  }
  return value;
}

function safeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("invalid boolean");
  }
  return value;
}

function safeTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("haos_core_restart_evidence_invalid");
  }
  return value;
}

function assertVmId(vmId: number): void {
  if (!Number.isSafeInteger(vmId) || vmId <= 0) {
    throw new Error("haos_core_restart_command_invalid");
  }
}

function addReason(
  reasons: HaosCoreRestartPreflightReason[],
  passed: boolean,
  reason: HaosCoreRestartPreflightReason
): void {
  if (!passed) {
    reasons.push(reason);
  }
}

function addFailure(
  failures: HaosCoreRestartContinuityFailure[],
  passed: boolean,
  failure: HaosCoreRestartContinuityFailure
): void {
  if (!passed) {
    failures.push(failure);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}
