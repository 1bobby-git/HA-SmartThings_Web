import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { SafeDeviceEventSummary } from "./device-event-summary.js";
import type { ProtocolAnalysisResult } from "./protocol-analyzer.js";

export const PHYSICAL_ACTION_PRESETS = {
  contact_open: {
    capability: "contactSensor",
    attribute: "contact",
    value: "open",
    requireStateChange: true
  },
  contact_close: {
    capability: "contactSensor",
    attribute: "contact",
    value: "closed",
    requireStateChange: true
  },
  motion_active: {
    capability: "motionSensor",
    attribute: "motion",
    value: "active",
    requireStateChange: true
  },
  switch_manual_on: {
    capability: "switch",
    attribute: "switch",
    value: "on",
    requireStateChange: true
  },
  switch_manual_off: {
    capability: "switch",
    attribute: "switch",
    value: "off",
    requireStateChange: true
  },
  button_push: {
    capability: "button",
    attribute: "button",
    value: "pushed",
    requireStateChange: false
  }
} as const;

export interface ProbeRuntimeEvidence {
  live: boolean;
  ready: boolean;
  state: string;
  browserIsolated: boolean;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
}

export type ProbeState = "idle" | "armed" | "pass" | "ambiguous" | "fail" | "voided";

export type ProbeResultReason =
  | "manual_reset"
  | "no_match"
  | "multiple_candidates"
  | "browser_not_isolated"
  | "runtime_not_ready"
  | "protocol_changed"
  | "runtime_restarted"
  | "invalid_frame_increase"
  | "counter_regression"
  | "unsafe_event"
  | "candidate_overflow"
  | "internal_failure";

export type ProbeFailureReason = Exclude<
  ProbeResultReason,
  "manual_reset" | "no_match" | "multiple_candidates"
>;

export interface ProbeArmRequest {
  actionType: keyof typeof PHYSICAL_ACTION_PRESETS;
  targetDeviceAlias?: string;
  windowSeconds?: number;
}

export type ProbeArmError = "probe_conflict" | "browser_not_isolated" | "not_ready";

export type ProbeArmResult =
  | { ok: true; snapshot: PhysicalActionProbeSnapshot }
  | { ok: false; error: ProbeArmError };

export interface ProbeCounterSnapshot {
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  protocolInvalidFrameCount: number;
  protocolChangeCount: number;
  restartCount: number;
}

export interface ProbeCandidateSnapshot {
  deviceAlias: string;
  component: string;
  capability: string;
  attribute: string;
  valueType: SafeDeviceEventSummary["valueType"];
  unitPresent: boolean;
  stateChange: boolean | null;
  expectedValueMatched: boolean;
  identitySource: "event_id" | "fingerprint";
  logicalEventHash: string;
  uniqueLogicalEventCount: 1;
  deliveryCount: number;
  receiveAfterArmMs: number;
  sourceAfterArmMs?: number;
}

export interface PhysicalActionProbeSnapshot {
  schemaVersion: 1;
  state: ProbeState;
  actionType?: keyof typeof PHYSICAL_ACTION_PRESETS;
  targetDeviceAlias?: string;
  windowSeconds?: number;
  elapsedMs: number;
  remainingMs: number;
  live: boolean;
  ready: boolean;
  runtimeState: string;
  browserIsolated: boolean;
  baseline?: ProbeCounterSnapshot;
  current: ProbeCounterSnapshot;
  candidateCount: number;
  reasons: ProbeResultReason[];
  candidates: ProbeCandidateSnapshot[];
}

interface PhysicalActionCorrelationProbeOptions {
  monotonicNow?: () => number;
  wallClockNow?: () => number;
}

interface WindowState {
  state: ProbeState;
  reasons: ProbeResultReason[];
  actionType?: keyof typeof PHYSICAL_ACTION_PRESETS;
  targetDeviceAlias?: string;
  windowSeconds?: number;
  armMonotonicMs?: number;
  armWallClockMs?: number;
  deadlineMonotonicMs?: number;
  baseline?: ProbeCounterSnapshot;
  candidates: ProbeCandidateSnapshot[];
  candidateHashes: Set<string>;
}

const DEFAULT_WINDOW_SECONDS = 60;
const MAX_CANDIDATES = 32;
const CONNECTED_STATE = "CONNECTED";

export class PhysicalActionCorrelationProbe {
  readonly #monotonicNow: () => number;
  readonly #wallClockNow: () => number;
  #window: WindowState = createIdleWindow();

  constructor(options: PhysicalActionCorrelationProbeOptions = {}) {
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#wallClockNow = options.wallClockNow ?? (() => Date.now());
  }

  arm(request: ProbeArmRequest, evidence: ProbeRuntimeEvidence): ProbeArmResult {
    const now = this.#monotonicNow();
    if (this.#window.state === "armed") {
      if (!this.#isExpired(now)) {
        return { ok: false, error: "probe_conflict" };
      }
      this.#finalizeExpired(evidence, now);
    }

    const readinessError = armReadinessError(evidence);
    if (readinessError) {
      return { ok: false, error: readinessError };
    }

    const baseline = countersFromEvidence(evidence);
    const windowSeconds = request.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    const armWallClockMs = this.#wallClockNow();
    this.#window = {
      state: "armed",
      reasons: [],
      actionType: request.actionType,
      ...(request.targetDeviceAlias === undefined
        ? {}
        : { targetDeviceAlias: request.targetDeviceAlias }),
      windowSeconds,
      armMonotonicMs: now,
      armWallClockMs,
      deadlineMonotonicMs: now + windowSeconds * 1_000,
      baseline,
      candidates: [],
      candidateHashes: new Set()
    };

    return { ok: true, snapshot: this.#snapshotFromWindow(evidence, now) };
  }

  observe(result: Extract<ProtocolAnalysisResult, { kind: "new" | "duplicate" }>): void {
    const now = this.#monotonicNow();
    if (this.#window.state !== "armed" || this.#isExpired(now)) {
      return;
    }

    const logicalEventHash = sha256(result.key);
    if (result.kind === "duplicate") {
      const candidate = this.#window.candidates.find(
        (item) => item.logicalEventHash === logicalEventHash
      );
      if (candidate) {
        candidate.deliveryCount += 1;
      }
      return;
    }

    if (!result.event || !this.#matchesPreset(result.event, this.#window.actionType)) {
      return;
    }

    if (this.#window.candidateHashes.has(logicalEventHash)) {
      return;
    }
    if (this.#window.candidates.length >= MAX_CANDIDATES) {
      this.#failActive("candidate_overflow");
      return;
    }

    const safe = result.event.safe;
    const receiveWallClockMs = this.#wallClockNow();
    const candidate: ProbeCandidateSnapshot = {
      deviceAlias: safe.deviceAlias,
      component: safe.component,
      capability: safe.capability,
      attribute: safe.attribute,
      valueType: safe.valueType,
      unitPresent: safe.unitPresent,
      stateChange: safe.stateChange,
      expectedValueMatched: true,
      identitySource: result.identitySource,
      logicalEventHash,
      uniqueLogicalEventCount: 1,
      deliveryCount: 1,
      receiveAfterArmMs: Math.max(0, now - (this.#window.armMonotonicMs ?? now)),
      ...sourceDelta(safe.sourceEventAtMs, this.#window.armWallClockMs, receiveWallClockMs)
    };
    this.#window.candidates.push(candidate);
    this.#window.candidateHashes.add(logicalEventHash);
  }

  observeUnsafeEvent(): void {
    this.#failActive("unsafe_event");
  }

  recordBrowserIsolation(isolated: boolean): void {
    if (!isolated) {
      this.#failActive("browser_not_isolated");
    }
  }

  fail(reason: ProbeFailureReason): void {
    this.#failActive(reason);
  }

  reset(evidence: ProbeRuntimeEvidence): PhysicalActionProbeSnapshot {
    const now = this.#monotonicNow();
    if (this.#window.state === "idle") {
      this.#window = createIdleWindow();
      return this.#snapshotFromWindow(evidence, now);
    }

    const previous = this.#window;
    this.#window = {
      state: "voided",
      reasons: ["manual_reset"],
      ...(previous.actionType === undefined ? {} : { actionType: previous.actionType }),
      ...(previous.targetDeviceAlias === undefined
        ? {}
        : { targetDeviceAlias: previous.targetDeviceAlias }),
      ...(previous.windowSeconds === undefined ? {} : { windowSeconds: previous.windowSeconds }),
      ...(previous.armMonotonicMs === undefined ? {} : { armMonotonicMs: previous.armMonotonicMs }),
      ...(previous.armWallClockMs === undefined ? {} : { armWallClockMs: previous.armWallClockMs }),
      ...(previous.deadlineMonotonicMs === undefined
        ? {}
        : { deadlineMonotonicMs: previous.deadlineMonotonicMs }),
      ...(previous.baseline === undefined ? {} : { baseline: previous.baseline }),
      candidates: [],
      candidateHashes: new Set()
    };
    return this.#snapshotFromWindow(evidence, now);
  }

  snapshot(evidence: ProbeRuntimeEvidence): PhysicalActionProbeSnapshot {
    const now = this.#monotonicNow();
    if (this.#window.state === "armed") {
      const failure = failClosedReason(evidence, this.#window.baseline);
      if (failure) {
        this.#failActive(failure);
      } else if (this.#isExpired(now)) {
        this.#finalizeExpired(evidence, now);
      }
    }
    return this.#snapshotFromWindow(evidence, now);
  }

  #matchesPreset(
    event: Extract<ProtocolAnalysisResult, { kind: "new" | "duplicate" }>["event"],
    actionType: keyof typeof PHYSICAL_ACTION_PRESETS | undefined
  ): boolean {
    if (!event || !actionType) {
      return false;
    }
    const preset = PHYSICAL_ACTION_PRESETS[actionType];
    const safe = event.safe;
    if (this.#window.targetDeviceAlias && safe.deviceAlias !== this.#window.targetDeviceAlias) {
      return false;
    }
    if (safe.capability !== preset.capability || safe.attribute !== preset.attribute) {
      return false;
    }
    if (preset.requireStateChange && safe.stateChange !== true) {
      return false;
    }
    return event.matchesExpectedValue(preset.value);
  }

  #isExpired(now: number): boolean {
    return this.#window.deadlineMonotonicMs !== undefined && now >= this.#window.deadlineMonotonicMs;
  }

  #finalizeExpired(_evidence: ProbeRuntimeEvidence, _now: number): void {
    if (this.#window.state !== "armed") {
      return;
    }
    if (this.#window.candidates.length === 0) {
      this.#window.state = "fail";
      this.#window.reasons = ["no_match"];
      return;
    }
    if (this.#window.candidates.length === 1) {
      this.#window.state = "pass";
      this.#window.reasons = [];
      return;
    }
    this.#window.state = "ambiguous";
    this.#window.reasons = ["multiple_candidates"];
  }

  #failActive(reason: ProbeFailureReason): void {
    if (this.#window.state !== "armed") {
      return;
    }
    this.#window.state = "fail";
    this.#window.reasons = [reason];
  }

  #snapshotFromWindow(evidence: ProbeRuntimeEvidence, now: number): PhysicalActionProbeSnapshot {
    const elapsedMs =
      this.#window.armMonotonicMs === undefined ? 0 : Math.max(0, now - this.#window.armMonotonicMs);
    const remainingMs =
      this.#window.deadlineMonotonicMs === undefined
        ? 0
        : Math.max(0, this.#window.deadlineMonotonicMs - now);

    return {
      schemaVersion: 1,
      state: this.#window.state,
      ...(this.#window.actionType === undefined ? {} : { actionType: this.#window.actionType }),
      ...(this.#window.targetDeviceAlias === undefined
        ? {}
        : { targetDeviceAlias: this.#window.targetDeviceAlias }),
      ...(this.#window.windowSeconds === undefined ? {} : { windowSeconds: this.#window.windowSeconds }),
      elapsedMs,
      remainingMs,
      live: evidence.live,
      ready: evidence.ready,
      runtimeState: evidence.state,
      browserIsolated: evidence.browserIsolated,
      ...(this.#window.baseline === undefined
        ? {}
        : { baseline: copyCounters(this.#window.baseline) }),
      current: countersFromEvidence(evidence),
      candidateCount: this.#window.candidates.length,
      reasons: [...this.#window.reasons],
      candidates: this.#window.candidates.map(copyCandidate)
    };
  }
}

function createIdleWindow(): WindowState {
  return {
    state: "idle",
    reasons: [],
    candidates: [],
    candidateHashes: new Set()
  };
}

function armReadinessError(evidence: ProbeRuntimeEvidence): ProbeArmError | null {
  if (!evidence.browserIsolated) {
    return "browser_not_isolated";
  }
  if (
    !evidence.live ||
    !evidence.ready ||
    evidence.state !== CONNECTED_STATE ||
    evidence.observedDeviceCount <= 0 ||
    evidence.protocolChangeCount !== 0 ||
    evidence.restartCount !== 0
  ) {
    return "not_ready";
  }
  return null;
}

function failClosedReason(
  evidence: ProbeRuntimeEvidence,
  baseline: ProbeCounterSnapshot | undefined
): ProbeFailureReason | null {
  if (!evidence.live || !evidence.ready || evidence.state !== CONNECTED_STATE) {
    return "runtime_not_ready";
  }
  if (!evidence.browserIsolated) {
    return "browser_not_isolated";
  }
  if (!baseline) {
    return "internal_failure";
  }
  if (evidence.protocolChangeCount !== 0 || evidence.protocolChangeCount > baseline.protocolChangeCount) {
    return "protocol_changed";
  }
  if (evidence.restartCount !== 0 || evidence.restartCount > baseline.restartCount) {
    return "runtime_restarted";
  }
  if (evidence.protocolInvalidFrameCount > baseline.protocolInvalidFrameCount) {
    return "invalid_frame_increase";
  }
  if (
    evidence.observedDeviceCount < baseline.observedDeviceCount ||
    evidence.decodedDeviceEventCount < baseline.decodedDeviceEventCount ||
    evidence.uniqueLogicalEventCount < baseline.uniqueLogicalEventCount ||
    evidence.duplicateEventCount < baseline.duplicateEventCount
  ) {
    return "counter_regression";
  }
  return null;
}

function countersFromEvidence(evidence: ProbeRuntimeEvidence): ProbeCounterSnapshot {
  return {
    observedDeviceCount: evidence.observedDeviceCount,
    decodedDeviceEventCount: evidence.decodedDeviceEventCount,
    uniqueLogicalEventCount: evidence.uniqueLogicalEventCount,
    duplicateEventCount: evidence.duplicateEventCount,
    protocolInvalidFrameCount: evidence.protocolInvalidFrameCount,
    protocolChangeCount: evidence.protocolChangeCount,
    restartCount: evidence.restartCount
  };
}

function copyCounters(counters: ProbeCounterSnapshot): ProbeCounterSnapshot {
  return { ...counters };
}

function copyCandidate(candidate: ProbeCandidateSnapshot): ProbeCandidateSnapshot {
  return {
    deviceAlias: candidate.deviceAlias,
    component: candidate.component,
    capability: candidate.capability,
    attribute: candidate.attribute,
    valueType: candidate.valueType,
    unitPresent: candidate.unitPresent,
    stateChange: candidate.stateChange,
    expectedValueMatched: candidate.expectedValueMatched,
    identitySource: candidate.identitySource,
    logicalEventHash: candidate.logicalEventHash,
    uniqueLogicalEventCount: 1,
    deliveryCount: candidate.deliveryCount,
    receiveAfterArmMs: candidate.receiveAfterArmMs,
    ...(candidate.sourceAfterArmMs === undefined ? {} : { sourceAfterArmMs: candidate.sourceAfterArmMs })
  };
}

function sourceDelta(
  sourceEventAtMs: number | undefined,
  armWallClockMs: number | undefined,
  receiveWallClockMs: number
): { sourceAfterArmMs?: number } {
  if (
    sourceEventAtMs === undefined ||
    armWallClockMs === undefined ||
    sourceEventAtMs < armWallClockMs ||
    sourceEventAtMs > receiveWallClockMs + 5_000
  ) {
    return {};
  }
  return { sourceAfterArmMs: sourceEventAtMs - armWallClockMs };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
