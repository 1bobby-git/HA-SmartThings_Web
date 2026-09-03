export const DEFAULT_LIVE_CONTROL_ENTITY_ID = "switch.deiteorum_ibculib_nagam_togeul_2";

const SAFE_ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/u;
const SAFE_STATES = new Set(["on", "off"]);
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export interface HomeAssistantState {
  entityId: string;
  state: string;
  lastUpdated: string;
  attributes?: unknown;
}

export interface HomeAssistantControlClient {
  getState(entityId: string): Promise<HomeAssistantState>;
  callService(domain: string, service: string, data: Record<string, string>): Promise<void>;
}

export interface BridgeHealthClient {
  getHealth(): Promise<Record<string, unknown>>;
}

export interface LiveControlBenchmarkClock {
  nowIso(): string;
  sleep(milliseconds: number): Promise<void>;
}

export interface LiveControlBenchmarkOptions {
  entityId: string;
  allowedEntityIds: readonly string[];
  execute: boolean;
  cycles: number;
  ha: HomeAssistantControlClient;
  bridge: BridgeHealthClient;
  clock?: LiveControlBenchmarkClock;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  writeArtifact?: (fileName: string, value: LiveControlBenchmarkResult) => Promise<void>;
}

export interface LiveControlBenchmarkPreview {
  schemaVersion: 1;
  mode: "preview";
  entityId: string;
  cycles: number;
  willExecute: false;
  initialState: SafeHaStateObservation;
  executionEligible: boolean;
}

export interface SafeHaStateObservation {
  state: string;
  lastUpdated: string;
  observedAt?: string;
}

export interface SafeBridgeObservation {
  state?: string;
  sequence?: number;
  activeConnections?: number;
  decodedDeviceEventCount?: number;
  uniqueLogicalEventCount?: number;
  duplicateEventCount?: number;
  pushAgeMs?: number;
  bridgeVersion?: string;
  protocolVersion?: string;
}

export interface LiveControlTransition {
  cycle: number;
  targetState: "on" | "off";
  service: "turn_on" | "turn_off";
  serviceRequestedAt: string;
  serviceReturnedAt: string;
  serviceDurationMs: number;
  haLastUpdatedAfterRequestMs: number;
  haObservedAfterRequestMs: number;
  ha: SafeHaStateObservation;
  bridge: SafeBridgeObservation;
}

export interface LiveControlBenchmarkResult {
  schemaVersion: 1;
  mode: "execute";
  entityId: string;
  cycles: number;
  startedAt: string;
  endedAt: string;
  transitions: LiveControlTransition[];
  finalState: SafeHaStateObservation;
}

export async function createLiveControlBenchmarkPreview(
  options: Omit<LiveControlBenchmarkOptions, "execute" | "clock" | "writeArtifact"> & {
    clock?: LiveControlBenchmarkClock;
  }
): Promise<LiveControlBenchmarkPreview> {
  validateEntityAllowed(options.entityId, options.allowedEntityIds);
  validateCycles(options.cycles);
  const initial = sanitizeHaState(await options.ha.getState(options.entityId));
  return {
    schemaVersion: 1,
    mode: "preview",
    entityId: options.entityId,
    cycles: options.cycles,
    willExecute: false,
    initialState: initial,
    executionEligible: initial.state === "off"
  };
}

export async function runLiveControlBenchmark(
  options: LiveControlBenchmarkOptions
): Promise<LiveControlBenchmarkResult> {
  validateEntityAllowed(options.entityId, options.allowedEntityIds);
  validateCycles(options.cycles);
  const clock = options.clock ?? systemClock;
  const waitTimeoutMs = safeDuration(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = safeNonNegativeDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const initial = sanitizeHaState(await options.ha.getState(options.entityId));
  if (initial.state !== "off") {
    throw new Error("live_control_benchmark_initial_state_not_off");
  }
  if (!options.execute) {
    throw new Error("live_control_benchmark_execute_required");
  }

  const startedAt = clock.nowIso();
  const transitions: LiveControlTransition[] = [];
  try {
    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      transitions.push(
        await executeTransition(options, clock, cycle, "on", "turn_on", waitTimeoutMs, pollIntervalMs)
      );
      transitions.push(
        await executeTransition(options, clock, cycle, "off", "turn_off", waitTimeoutMs, pollIntervalMs)
      );
    }
    const finalState = sanitizeHaState(await options.ha.getState(options.entityId));
    const result: LiveControlBenchmarkResult = {
      schemaVersion: 1,
      mode: "execute",
      entityId: options.entityId,
      cycles: options.cycles,
      startedAt,
      endedAt: clock.nowIso(),
      transitions,
      finalState
    };
    await options.writeArtifact?.(artifactFileName(startedAt), result);
    return result;
  } finally {
    await ensureOff(options, clock, waitTimeoutMs, pollIntervalMs);
  }
}

export function sanitizeBridgeHealth(input: Record<string, unknown>): SafeBridgeObservation {
  const result: SafeBridgeObservation = {};
  copySafeString(input, result, "state");
  copySafeInteger(input, result, "sequence");
  copySafeInteger(input, result, "activeConnections");
  copySafeInteger(input, result, "decodedDeviceEventCount");
  copySafeInteger(input, result, "uniqueLogicalEventCount");
  copySafeInteger(input, result, "duplicateEventCount");
  copySafeInteger(input, result, "pushAgeMs");
  copySafeString(input, result, "bridgeVersion");
  copySafeString(input, result, "protocolVersion");
  return result;
}

async function executeTransition(
  options: LiveControlBenchmarkOptions,
  clock: LiveControlBenchmarkClock,
  cycle: number,
  targetState: "on" | "off",
  service: "turn_on" | "turn_off",
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<LiveControlTransition> {
  const serviceRequestedAt = clock.nowIso();
  await options.ha.callService(domainFromEntityId(options.entityId), service, {
    entity_id: options.entityId
  });
  const serviceReturnedAt = clock.nowIso();
  const observed = await waitForState(
    options.ha,
    clock,
    options.entityId,
    targetState,
    waitTimeoutMs,
    pollIntervalMs
  );
  return {
    cycle,
    targetState,
    service,
    serviceRequestedAt,
    serviceReturnedAt,
    serviceDurationMs: elapsedMilliseconds(serviceRequestedAt, serviceReturnedAt),
    haLastUpdatedAfterRequestMs: elapsedMilliseconds(
      serviceRequestedAt,
      observed.lastUpdated
    ),
    haObservedAfterRequestMs: elapsedMilliseconds(
      serviceRequestedAt,
      observed.observedAt ?? observed.lastUpdated
    ),
    ha: observed,
    bridge: sanitizeBridgeHealth(await options.bridge.getHealth())
  };
}

async function ensureOff(
  options: LiveControlBenchmarkOptions,
  clock: LiveControlBenchmarkClock,
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<void> {
  if (!options.execute) return;
  const state = sanitizeHaState(await options.ha.getState(options.entityId));
  if (state.state === "off") return;
  await options.ha.callService(domainFromEntityId(options.entityId), "turn_off", {
    entity_id: options.entityId
  });
  await waitForState(options.ha, clock, options.entityId, "off", waitTimeoutMs, pollIntervalMs);
}

async function waitForState(
  ha: HomeAssistantControlClient,
  clock: LiveControlBenchmarkClock,
  entityId: string,
  targetState: "on" | "off",
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<SafeHaStateObservation> {
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / Math.max(1, pollIntervalMs)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const observedAt = clock.nowIso();
    const state = sanitizeHaState(await ha.getState(entityId), observedAt);
    if (state.state === targetState) return state;
    if (attempt + 1 < attempts) await clock.sleep(pollIntervalMs);
  }
  throw new Error("live_control_benchmark_state_timeout");
}

function sanitizeHaState(input: HomeAssistantState, observedAt?: string): SafeHaStateObservation {
  if (!SAFE_STATES.has(input.state) || !isSafeTimestamp(input.lastUpdated)) {
    throw new Error("live_control_benchmark_state_invalid");
  }
  const result: SafeHaStateObservation = {
    state: input.state,
    lastUpdated: input.lastUpdated
  };
  if (observedAt !== undefined) result.observedAt = observedAt;
  return result;
}

function validateEntityAllowed(entityId: string, allowedEntityIds: readonly string[]): void {
  if (!SAFE_ENTITY_ID.test(entityId) || !allowedEntityIds.includes(entityId)) {
    throw new Error("live_control_benchmark_entity_not_allowed");
  }
}

function validateCycles(cycles: number): void {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 20) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
}

function safeDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return value;
}

function safeNonNegativeDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return value;
}

function domainFromEntityId(entityId: string): string {
  return entityId.split(".", 1)[0] ?? "switch";
}

function artifactFileName(startedAt: string): string {
  return `haos-live-control-benchmark-${startedAt.replaceAll(":", "-")}.json`;
}

function copySafeInteger(
  input: Record<string, unknown>,
  output: SafeBridgeObservation,
  key: keyof SafeBridgeObservation
): void {
  const value = input[key];
  if (Number.isSafeInteger(value) && Number(value) >= 0) {
    (output as Record<string, unknown>)[key] = value;
  }
}

function copySafeString(
  input: Record<string, unknown>,
  output: SafeBridgeObservation,
  key: keyof SafeBridgeObservation
): void {
  const value = input[key];
  if (typeof value === "string" && value.length > 0 && value.length <= 120) {
    (output as Record<string, unknown>)[key] = value;
  }
}

function isSafeTimestamp(value: string): boolean {
  return value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function elapsedMilliseconds(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new Error("live_control_benchmark_timing_invalid");
  }
  return elapsed;
}

const systemClock: LiveControlBenchmarkClock = {
  nowIso() {
    return new Date().toISOString();
  },
  sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
};
