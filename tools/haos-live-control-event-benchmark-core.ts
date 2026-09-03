export const DEFAULT_LIVE_CONTROL_EVENT_ENTITY_ID = "switch.deiteorum_ibculib_nagam_togeul_2";

const SAFE_ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/u;
const SAFE_STATES = new Set(["on", "off"]);
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SAFE_BRIDGE_DEVICE_ID = /^dev_[A-Za-z0-9]{3,64}$/u;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const EXPECTED_BRIDGE_SWITCH_COMPONENT = "main";
const EXPECTED_BRIDGE_SWITCH_CAPABILITY = "switch";
const EXPECTED_BRIDGE_SWITCH_ATTRIBUTE = "switch";

export interface BridgeStateBinding {
  deviceId: string;
  component: string;
  capability: string;
  attribute: string;
}

export interface HomeAssistantState {
  entityId: string;
  state: string;
  lastUpdated: string;
  attributes?: unknown;
}

export interface HaStateChangedEvent {
  entityId: string;
  state: "on" | "off";
  lastUpdated: string;
  receivedAt: string;
}

export interface HomeAssistantEventSubscription {
  unsubscribe(): Promise<void>;
}

export interface HomeAssistantEventControlClient {
  getState(entityId: string): Promise<HomeAssistantState>;
  callService(domain: string, service: string, data: Record<string, string>): Promise<void>;
  subscribeStateChanged(
    entityId: string,
    onEvent: (event: HaStateChangedEvent) => void
  ): Promise<HomeAssistantEventSubscription>;
}

export interface BridgeSseSubscription {
  unsubscribe(): Promise<void>;
}

export interface BridgeSseBenchmarkClient {
  subscribeEvents(onEvent: (event: unknown) => void): Promise<BridgeSseSubscription>;
}

export interface LiveControlEventBenchmarkClock {
  nowIso(): string;
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
}

export interface LiveControlEventBenchmarkOptions {
  entityId: string;
  allowedEntityIds: readonly string[];
  execute: boolean;
  cycles: number;
  ha: HomeAssistantEventControlClient;
  bridge?: BridgeSseBenchmarkClient;
  bridgeStateBinding?: BridgeStateBinding;
  /** Legacy canonical binding retained for older callers and fixtures. */
  bridgeDeviceId?: string;
  clock?: LiveControlEventBenchmarkClock;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  baselineHaObservedAfterRequestMs?: number;
  writeArtifact?: (fileName: string, value: LiveControlEventBenchmarkArtifact) => Promise<void>;
}

export interface LiveControlEventBenchmarkPreview {
  schemaVersion: 1;
  mode: "preview";
  entityId: string;
  cycles: number;
  willExecute: false;
  initialState: SafeHaEventStateObservation;
  executionEligible: boolean;
}

export interface SafeHaEventStateObservation {
  state: "on" | "off";
  lastUpdated: string;
  receivedAt?: string;
}

export interface SafeBridgeEventObservation {
  sequence: number;
  receivedAt: string;
  receivedAfterRequestMs: number;
  updatedAt?: string;
  updatedAtAfterRequestMs?: number;
  value: "on" | "off";
  component?: string;
  capability?: string;
  attribute?: string;
}

export interface LiveControlEventTransition {
  cycle: number;
  targetState: "on" | "off";
  service: "turn_on" | "turn_off";
  serviceRequestedAt: string;
  serviceReturnedAt: string;
  serviceDurationMs: number;
  haEventSeenAfterRequestMs: number;
  haLastUpdatedAfterRequestMs: number;
  ha: SafeHaEventStateObservation;
  bridge?: SafeBridgeEventObservation;
  bridgeToHaEventMs?: number;
}

export interface LiveControlEventBenchmarkResult {
  schemaVersion: 1;
  mode: "execute";
  entityId: string;
  cycles: number;
  startedAt: string;
  endedAt: string;
  transitions: LiveControlEventTransition[];
  sequence: { first?: number; last?: number; gaps: number };
  speedup: {
    baselineHaObservedAfterRequestMs: number | undefined;
    measuredP95HaEventSeenAfterRequestMs: number;
    factor: number | undefined;
  };
  latency: {
    minimumHaEventSeenAfterRequestMs: number;
    medianHaEventSeenAfterRequestMs: number;
    p95HaEventSeenAfterRequestMs: number;
    maximumHaEventSeenAfterRequestMs: number;
  };
  finalState: SafeHaEventStateObservation;
}

export type LiveControlEventBenchmarkArtifact =
  | LiveControlEventBenchmarkResult
  | LiveControlEventBenchmarkFailureResult;

export interface LiveControlEventBenchmarkFailureResult {
  schemaVersion: 1;
  mode: "failure";
  entityId: string;
  cycles: number;
  startedAt: string;
  endedAt: string;
  transitions: LiveControlEventTransition[];
  sequence: { first?: number; last?: number; gaps: number };
  error: string;
  finalStateKnown: boolean;
  finalState?: SafeHaEventStateObservation;
}

export async function createLiveControlEventBenchmarkPreview(
  options: Omit<LiveControlEventBenchmarkOptions, "execute" | "clock" | "writeArtifact"> & {
    clock?: LiveControlEventBenchmarkClock;
  }
): Promise<LiveControlEventBenchmarkPreview> {
  validateEntityAllowed(options.entityId, options.allowedEntityIds);
  validateCycles(options.cycles);
  const initialState = sanitizeHaState(await options.ha.getState(options.entityId));
  return {
    schemaVersion: 1,
    mode: "preview",
    entityId: options.entityId,
    cycles: options.cycles,
    willExecute: false,
    initialState,
    executionEligible: initialState.state === "off"
  };
}

export async function runLiveControlEventBenchmark(
  options: LiveControlEventBenchmarkOptions
): Promise<LiveControlEventBenchmarkResult> {
  validateEntityAllowed(options.entityId, options.allowedEntityIds);
  validateCycles(options.cycles);
  if (!options.execute) throw new Error("live_control_event_benchmark_execute_required");
  const bridgeStateBinding = options.bridge ? resolveBridgeStateBinding(options) : undefined;
  if (options.bridge && bridgeStateBinding === undefined) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }

  const clock = options.clock ?? systemClock;
  const waitTimeoutMs = safeDuration(options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const pollIntervalMs = safeNonNegativeDuration(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const initialState = sanitizeHaState(await options.ha.getState(options.entityId));
  if (initialState.state !== "off") {
    throw new Error("live_control_event_benchmark_initial_state_not_off");
  }

  const haEvents: HaStateChangedEvent[] = [];
  const bridgeEvents: SafeBridgeEventObservation[] = [];
  const bridgeSequences: number[] = [];
  let haSubscription: HomeAssistantEventSubscription | undefined;
  let bridgeSubscription: BridgeSseSubscription | undefined;
  let finalState: SafeHaEventStateObservation | undefined;
  const startedAt = clock.nowIso();
  const transitions: LiveControlEventTransition[] = [];
  let lastBridgeSequence: number | undefined;

  try {
    haSubscription = await options.ha.subscribeStateChanged(options.entityId, (event) => {
      const sanitized = sanitizeHaEvent(event, options.entityId);
      if (sanitized) haEvents.push(sanitized);
    });
    if (options.bridge) {
      bridgeSubscription = await options.bridge.subscribeEvents((event) => {
        const sequence = sanitizeBridgeSequence(event);
        if (sequence !== undefined) bridgeSequences.push(sequence);
        const sanitized = sanitizeBridgeEvent(event, bridgeStateBinding!);
        if (sanitized) bridgeEvents.push(sanitized);
      });
    }

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
      const onTransition = await executeEventTransition(
        options,
        clock,
        haEvents,
        bridgeEvents,
        cycle,
        "on",
        "turn_on",
        waitTimeoutMs,
        pollIntervalMs,
        lastBridgeSequence
      );
      transitions.push(onTransition);
      lastBridgeSequence = onTransition.bridge?.sequence ?? lastBridgeSequence;
      const offTransition = await executeEventTransition(
        options,
        clock,
        haEvents,
        bridgeEvents,
        cycle,
        "off",
        "turn_off",
        waitTimeoutMs,
        pollIntervalMs,
        lastBridgeSequence
      );
      transitions.push(offTransition);
      lastBridgeSequence = offTransition.bridge?.sequence ?? lastBridgeSequence;
    }
    finalState = await ensureOff(options, clock, waitTimeoutMs, pollIntervalMs);
  } catch (error) {
    let finalStateKnown = true;
    let failureError = error;
    try {
      finalState = await ensureOff(options, clock, waitTimeoutMs, pollIntervalMs);
    } catch (cleanupError) {
      finalStateKnown = false;
      failureError = benchmarkCleanupError(error, cleanupError);
    }
    await options.writeArtifact?.(
      artifactFileName(startedAt),
      failureResult({
        entityId: options.entityId,
        cycles: options.cycles,
        startedAt,
        endedAt: clock.nowIso(),
        transitions,
        receivedSequences: bridgeSequences,
        error: failureError,
        finalStateKnown,
        finalState
      })
    );
    throw failureError;
  } finally {
    await bridgeSubscription?.unsubscribe();
    await haSubscription?.unsubscribe();
  }

  const result: LiveControlEventBenchmarkResult = {
    schemaVersion: 1,
    mode: "execute",
    entityId: options.entityId,
    cycles: options.cycles,
    startedAt,
    endedAt: clock.nowIso(),
    transitions,
    sequence: summarizeSequences(bridgeSequences),
    speedup: summarizeSpeedup(transitions, options.baselineHaObservedAfterRequestMs),
    latency: summarizeLatency(transitions),
    finalState: finalState ?? { state: "off", lastUpdated: startedAt }
  };
  await options.writeArtifact?.(artifactFileName(startedAt), result);
  return result;
}

function failureResult(input: {
  entityId: string;
  cycles: number;
  startedAt: string;
  endedAt: string;
  transitions: LiveControlEventTransition[];
  receivedSequences: readonly number[];
  error: unknown;
  finalStateKnown: boolean;
  finalState: SafeHaEventStateObservation | undefined;
}): LiveControlEventBenchmarkFailureResult {
  return {
    schemaVersion: 1,
    mode: "failure",
    entityId: input.entityId,
    cycles: input.cycles,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    transitions: input.transitions,
    sequence: summarizeSequences(input.receivedSequences),
    error: safeErrorMessage(input.error),
    finalStateKnown: input.finalStateKnown,
    ...(input.finalState === undefined ? {} : { finalState: input.finalState })
  };
}

async function executeEventTransition(
  options: LiveControlEventBenchmarkOptions,
  clock: LiveControlEventBenchmarkClock,
  haEvents: readonly HaStateChangedEvent[],
  bridgeEvents: readonly SafeBridgeEventObservation[],
  cycle: number,
  targetState: "on" | "off",
  service: "turn_on" | "turn_off",
  waitTimeoutMs: number,
  pollIntervalMs: number,
  afterBridgeSequence: number | undefined
): Promise<LiveControlEventTransition> {
  const serviceRequestedAt = clock.nowIso();
  await options.ha.callService(domainFromEntityId(options.entityId), service, {
    entity_id: options.entityId
  });
  const serviceReturnedAt = clock.nowIso();
  const ha = await waitForHaEvent(
    haEvents,
    clock,
    serviceRequestedAt,
    targetState,
    waitTimeoutMs,
    pollIntervalMs
  );
  const rawBridge = options.bridge
    ? await waitForBridgeEvent(
        bridgeEvents,
        clock,
        serviceRequestedAt,
        targetState,
        afterBridgeSequence,
        waitTimeoutMs,
        pollIntervalMs
      )
    : undefined;
  const bridge =
    rawBridge === undefined ? undefined : bridgeWithRequestTiming(rawBridge, serviceRequestedAt);
  return {
    cycle,
    targetState,
    service,
    serviceRequestedAt,
    serviceReturnedAt,
    serviceDurationMs: elapsedMilliseconds(serviceRequestedAt, serviceReturnedAt),
    haEventSeenAfterRequestMs: elapsedMilliseconds(serviceRequestedAt, ha.receivedAt ?? ha.lastUpdated),
    haLastUpdatedAfterRequestMs: elapsedMilliseconds(serviceRequestedAt, ha.lastUpdated),
    ha,
    ...(bridge === undefined ? {} : { bridge }),
    ...(bridge === undefined
      ? {}
      : { bridgeToHaEventMs: signedElapsedMilliseconds(bridge.receivedAt, ha.receivedAt ?? ha.lastUpdated) })
  };
}

async function waitForHaEvent(
  events: readonly HaStateChangedEvent[],
  clock: LiveControlEventBenchmarkClock,
  serviceRequestedAt: string,
  targetState: "on" | "off",
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<SafeHaEventStateObservation> {
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / Math.max(1, pollIntervalMs)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = events.find(
      (event) =>
        event.state === targetState &&
        Date.parse(event.receivedAt) >= Date.parse(serviceRequestedAt) &&
        Date.parse(event.lastUpdated) >= Date.parse(serviceRequestedAt)
    );
    if (found) {
      return {
        state: found.state,
        lastUpdated: found.lastUpdated,
        receivedAt: found.receivedAt
      };
    }
    if (attempt + 1 < attempts) await clock.sleep(pollIntervalMs);
  }
  throw new Error("live_control_event_benchmark_state_timeout");
}

async function waitForBridgeEvent(
  events: readonly SafeBridgeEventObservation[],
  clock: LiveControlEventBenchmarkClock,
  serviceRequestedAt: string,
  targetState: "on" | "off",
  afterSequence: number | undefined,
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<SafeBridgeEventObservation> {
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / Math.max(1, pollIntervalMs)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = findBridgeEvent(events, serviceRequestedAt, targetState, afterSequence);
    if (found) return found;
    if (attempt + 1 < attempts) await clock.sleep(pollIntervalMs);
  }
  throw new Error("live_control_event_benchmark_bridge_timeout");
}

async function ensureOff(
  options: LiveControlEventBenchmarkOptions,
  clock: LiveControlEventBenchmarkClock,
  waitTimeoutMs: number,
  pollIntervalMs: number
): Promise<SafeHaEventStateObservation> {
  const current = sanitizeHaState(await options.ha.getState(options.entityId));
  if (current.state === "off") return current;
  await options.ha.callService(domainFromEntityId(options.entityId), "turn_off", {
    entity_id: options.entityId
  });
  const attempts = Math.max(1, Math.ceil(waitTimeoutMs / Math.max(1, pollIntervalMs)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = sanitizeHaState(await options.ha.getState(options.entityId));
    if (state.state === "off") return state;
    if (attempt + 1 < attempts) await clock.sleep(pollIntervalMs);
  }
  throw new Error("live_control_event_benchmark_state_timeout");
}

function sanitizeHaState(input: HomeAssistantState): SafeHaEventStateObservation {
  if (!SAFE_STATES.has(input.state) || !isSafeTimestamp(input.lastUpdated)) {
    throw new Error("live_control_event_benchmark_state_invalid");
  }
  return {
    state: input.state as "on" | "off",
    lastUpdated: input.lastUpdated
  };
}

function sanitizeHaEvent(
  event: HaStateChangedEvent,
  entityId: string
): HaStateChangedEvent | undefined {
  if (
    event.entityId !== entityId ||
    !SAFE_STATES.has(event.state) ||
    !isSafeTimestamp(event.lastUpdated) ||
    !isSafeTimestamp(event.receivedAt)
  ) {
    return undefined;
  }
  return {
    entityId: event.entityId,
    state: event.state,
    lastUpdated: event.lastUpdated,
    receivedAt: event.receivedAt
  };
}

function sanitizeBridgeEvent(
  event: unknown,
  binding: BridgeStateBinding
): SafeBridgeEventObservation | undefined {
  if (!isRecord(event)) return undefined;
  const state = isRecord(event.state) ? event.state : event;
  const component = stringValue(state.component) ?? stringValue(event.component);
  const capability = stringValue(state.capability) ?? stringValue(event.capability);
  const attribute = stringValue(state.attribute) ?? stringValue(event.attribute);
  if (
    event.schemaVersion !== 1 ||
    event.type !== "state" ||
    event.deviceId !== binding.deviceId ||
    !Number.isSafeInteger(event.sequence) ||
    Number(event.sequence) < 0 ||
    component !== binding.component ||
    capability !== binding.capability ||
    attribute !== binding.attribute ||
    (state.value !== "on" && state.value !== "off") ||
    !isSafeTimestamp(event.receivedAt) ||
    !isSafeTimestamp(state.updatedAt)
  ) {
    return undefined;
  }
  const result: SafeBridgeEventObservation = {
    sequence: Number(event.sequence),
    receivedAt: event.receivedAt,
    receivedAfterRequestMs: 0,
    updatedAt: state.updatedAt,
    updatedAtAfterRequestMs: 0,
    value: state.value,
    component,
    capability,
    attribute
  };
  return result;
}

function sanitizeBridgeSequence(event: unknown): number | undefined {
  if (!isRecord(event) || event.schemaVersion !== 1 || !Number.isSafeInteger(event.sequence)) {
    return undefined;
  }
  const sequence = Number(event.sequence);
  return sequence >= 0 ? sequence : undefined;
}

function findBridgeEvent(
  events: readonly SafeBridgeEventObservation[],
  serviceRequestedAt: string,
  targetState: "on" | "off",
  afterSequence: number | undefined
): SafeBridgeEventObservation | undefined {
  return events.find(
    (event) =>
      event.value === targetState &&
      Date.parse(event.receivedAt) >= Date.parse(serviceRequestedAt) &&
      Date.parse(event.updatedAt ?? "") >= Date.parse(serviceRequestedAt) &&
      (afterSequence === undefined || event.sequence > afterSequence)
  );
}

function resolveBridgeStateBinding(
  options: LiveControlEventBenchmarkOptions
): BridgeStateBinding | undefined {
  const binding = options.bridgeStateBinding ?? (
    options.bridgeDeviceId === undefined
      ? undefined
      : {
          deviceId: options.bridgeDeviceId,
          component: EXPECTED_BRIDGE_SWITCH_COMPONENT,
          capability: EXPECTED_BRIDGE_SWITCH_CAPABILITY,
          attribute: EXPECTED_BRIDGE_SWITCH_ATTRIBUTE
        }
  );
  if (
    binding === undefined ||
    !SAFE_BRIDGE_DEVICE_ID.test(binding.deviceId) ||
    !SAFE_TOKEN.test(binding.component) ||
    !SAFE_TOKEN.test(binding.capability) ||
    binding.attribute !== EXPECTED_BRIDGE_SWITCH_ATTRIBUTE
  ) {
    return undefined;
  }
  return { ...binding };
}

function bridgeWithRequestTiming(
  bridge: SafeBridgeEventObservation,
  serviceRequestedAt: string
): SafeBridgeEventObservation {
  return {
    ...bridge,
    receivedAfterRequestMs: elapsedMilliseconds(serviceRequestedAt, bridge.receivedAt),
    ...(bridge.updatedAt === undefined
      ? {}
      : {
          updatedAtAfterRequestMs: signedElapsedMilliseconds(
            serviceRequestedAt,
            bridge.updatedAt
          )
        })
  };
}

function summarizeSequences(
  receivedSequences: readonly number[]
): { first?: number; last?: number; gaps: number } {
  const sequences = [...new Set(receivedSequences)].sort((left, right) => left - right);
  if (sequences.length === 0) return { gaps: 0 };
  let gaps = 0;
  for (let index = 1; index < sequences.length; index += 1) {
    gaps += Math.max(0, sequences[index]! - sequences[index - 1]! - 1);
  }
  return {
    first: sequences[0]!,
    last: sequences[sequences.length - 1]!,
    gaps
  };
}

function summarizeSpeedup(
  transitions: readonly LiveControlEventTransition[],
  baselineHaObservedAfterRequestMs: number | undefined
): LiveControlEventBenchmarkResult["speedup"] {
  const measuredP95HaEventSeenAfterRequestMs = summarizeLatency(
    transitions
  ).p95HaEventSeenAfterRequestMs;
  const factor =
    baselineHaObservedAfterRequestMs !== undefined && measuredP95HaEventSeenAfterRequestMs > 0
      ? Math.round((baselineHaObservedAfterRequestMs / measuredP95HaEventSeenAfterRequestMs) * 100) / 100
      : undefined;
  return {
    baselineHaObservedAfterRequestMs,
    measuredP95HaEventSeenAfterRequestMs,
    factor
  };
}

function summarizeLatency(
  transitions: readonly LiveControlEventTransition[]
): LiveControlEventBenchmarkResult["latency"] {
  const values = transitions
    .map((transition) => transition.haEventSeenAfterRequestMs)
    .sort((left, right) => left - right);
  if (values.length === 0) {
    throw new Error("live_control_event_benchmark_timing_invalid");
  }
  return {
    minimumHaEventSeenAfterRequestMs: values[0]!,
    medianHaEventSeenAfterRequestMs: percentile(values, 0.5),
    p95HaEventSeenAfterRequestMs: percentile(values, 0.95),
    maximumHaEventSeenAfterRequestMs: values.at(-1)!
  };
}

function percentile(sortedValues: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sortedValues.length * quantile) - 1);
  return sortedValues[index]!;
}

function validateEntityAllowed(entityId: string, allowedEntityIds: readonly string[]): void {
  if (!SAFE_ENTITY_ID.test(entityId) || !allowedEntityIds.includes(entityId)) {
    throw new Error("live_control_event_benchmark_entity_not_allowed");
  }
}

function validateCycles(cycles: number): void {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 20) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
}

function safeDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return value;
}

function safeNonNegativeDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
    throw new Error("live_control_event_benchmark_arguments_invalid");
  }
  return value;
}

function domainFromEntityId(entityId: string): string {
  return entityId.split(".", 1)[0] ?? "switch";
}

function artifactFileName(startedAt: string): string {
  return `haos-live-control-event-benchmark-${startedAt.replaceAll(":", "-")}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

function isSafeTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    !/(?:authorization|cookie|password|token|secret|csrf|session)/iu.test(value)
  );
}

function elapsedMilliseconds(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
    throw new Error("live_control_event_benchmark_timing_invalid");
  }
  return elapsed;
}

function signedElapsedMilliseconds(start: string, end: string): number {
  const elapsed = Date.parse(end) - Date.parse(start);
  if (!Number.isSafeInteger(elapsed)) {
    throw new Error("live_control_event_benchmark_timing_invalid");
  }
  return elapsed;
}

function benchmarkCleanupError(primaryError: unknown, cleanupError: unknown): Error {
  const error = new Error(
    `live_control_event_benchmark_cleanup_failed_final_state_unknown: primary=${errorMessage(
      primaryError
    )}; cleanup=${errorMessage(cleanupError)}`
  ) as Error & {
    primaryError?: unknown;
    cleanupError?: unknown;
    finalStateKnown?: boolean;
  };
  error.primaryError = primaryError;
  error.cleanupError = cleanupError;
  error.finalStateKnown = false;
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (
    message.length <= 256 &&
    /^live_control_event_benchmark[a-z0-9_:;= -]*$/u.test(message) &&
    !/(?:authorization|cookie|password|token|secret|csrf|session)/iu.test(message)
  ) {
    return message;
  }
  return "live_control_event_benchmark_failed";
}

const systemClock: LiveControlEventBenchmarkClock = {
  nowIso() {
    return new Date().toISOString();
  },
  nowMs() {
    return Date.now();
  },
  sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
};
