import type { ProtocolMismatchSurface } from "../inspector/protocol-contract.js";

export const RUNTIME_STATES = [
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
] as const;

export type RuntimeState = (typeof RUNTIME_STATES)[number];

export const URL_CATEGORIES = [
  "none",
  "smartthings_location",
  "smartthings_advanced",
  "samsung_login",
  "other",
  "error"
] as const;

export type UrlCategory = (typeof URL_CATEGORIES)[number];

// Allows small ordering jitter between Chromium, DB, and daemon clocks without accepting synthetic future health.
export const MAX_CLOCK_SKEW_MS = 5_000;

export interface RuntimeStatusSnapshot {
  state: RuntimeState;
  urlCategory: UrlCategory;
  chromiumRunning: boolean;
  keeperPresent: boolean;
  authenticated: boolean;
  pushConnected: boolean;
  initialSnapshotComplete: boolean;
  parserHealthy: boolean;
  dbAvailable: boolean;
  activeConnections: number;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  dedupeJournalSize: number;
  protocolInvalidFrameCount: number;
  detailDiscoveryFailureCount: number;
  protocolChangeCount: number;
  protocolMismatchSurface: ProtocolMismatchSurface | undefined;
  restartCount: number;
  architectureVersion: string;
  advancedInventoryDeviceCount: number;
  advancedInventoryLocationCount: number;
  advancedInventoryPageCount: number;
  adapterFailureCount: number;
  pendingCommandCount: number;
  domFallbackCount: number;
  reconnectCount: number;
  lastCommandTransport: string | undefined;
  lastCommandConfirmation: string | undefined;
  bridgeVersion: string;
  browserVersion: string;
  protocolVersion: string;
  heartbeatAtMs: number;
  updatedAtMs: number;
  initialSnapshotCompletedAtMs: number | undefined;
  lastSnapshotAtMs: number | undefined;
  lastFrameAtMs: number | undefined;
  lastEventAtMs: number | undefined;
  lastPushAtMs: number | undefined;
  lastParserSuccessAtMs: number | undefined;
  lastBrowserStartAtMs: number | undefined;
  advancedInventoryLastSyncAtMs: number | undefined;
  lastReconnectAtMs: number | undefined;
  lastStateChangeAtMs: number;
}

export type RuntimeStatusPatch = Partial<RuntimeStatusSnapshot>;

export type RuntimeStatusListener = (
  snapshot: RuntimeStatusSnapshot,
  previous: RuntimeStatusSnapshot
) => void;

export interface RuntimeStatusStoreOptions {
  now?: () => number;
  initial?: RuntimeStatusPatch;
  onListenerError?: (error: unknown) => void;
}

const snapshotKeys = new Set<keyof RuntimeStatusSnapshot>([
  "state",
  "urlCategory",
  "chromiumRunning",
  "keeperPresent",
  "authenticated",
  "pushConnected",
  "initialSnapshotComplete",
  "parserHealthy",
  "dbAvailable",
  "activeConnections",
  "observedDeviceCount",
  "decodedDeviceEventCount",
  "uniqueLogicalEventCount",
  "duplicateEventCount",
  "dedupeJournalSize",
  "protocolInvalidFrameCount",
  "detailDiscoveryFailureCount",
  "protocolChangeCount",
  "protocolMismatchSurface",
  "restartCount",
  "architectureVersion",
  "advancedInventoryDeviceCount",
  "advancedInventoryLocationCount",
  "advancedInventoryPageCount",
  "adapterFailureCount",
  "pendingCommandCount",
  "domFallbackCount",
  "reconnectCount",
  "lastCommandTransport",
  "lastCommandConfirmation",
  "bridgeVersion",
  "browserVersion",
  "protocolVersion",
  "heartbeatAtMs",
  "updatedAtMs",
  "initialSnapshotCompletedAtMs",
  "lastSnapshotAtMs",
  "lastFrameAtMs",
  "lastEventAtMs",
  "lastPushAtMs",
  "lastParserSuccessAtMs",
  "lastBrowserStartAtMs",
  "advancedInventoryLastSyncAtMs",
  "lastReconnectAtMs",
  "lastStateChangeAtMs"
]);

const counterKeys = new Set<keyof RuntimeStatusSnapshot>([
  "activeConnections",
  "observedDeviceCount",
  "decodedDeviceEventCount",
  "uniqueLogicalEventCount",
  "duplicateEventCount",
  "dedupeJournalSize",
  "protocolInvalidFrameCount",
  "detailDiscoveryFailureCount",
  "protocolChangeCount",
  "restartCount"
  ,"advancedInventoryDeviceCount"
  ,"advancedInventoryLocationCount"
  ,"advancedInventoryPageCount"
  ,"adapterFailureCount"
  ,"pendingCommandCount"
  ,"domFallbackCount"
  ,"reconnectCount"
]);

const booleanKeys = new Set<keyof RuntimeStatusSnapshot>([
  "chromiumRunning",
  "keeperPresent",
  "authenticated",
  "pushConnected",
  "initialSnapshotComplete",
  "parserHealthy",
  "dbAvailable"
]);

const timestampKeys = new Set<keyof RuntimeStatusSnapshot>([
  "heartbeatAtMs",
  "updatedAtMs",
  "initialSnapshotCompletedAtMs",
  "lastSnapshotAtMs",
  "lastFrameAtMs",
  "lastEventAtMs",
  "lastPushAtMs",
  "lastParserSuccessAtMs",
  "lastBrowserStartAtMs",
  "advancedInventoryLastSyncAtMs",
  "lastReconnectAtMs",
  "lastStateChangeAtMs"
]);

const versionKeys = new Set<keyof RuntimeStatusSnapshot>([
  "bridgeVersion",
  "browserVersion",
  "protocolVersion"
  ,"architectureVersion"
]);

const diagnosticStringKeys = new Set<keyof RuntimeStatusSnapshot>([
  "lastCommandTransport",
  "lastCommandConfirmation"
]);

const protocolMismatchSurfaces = new Set<ProtocolMismatchSurface>([
  "snapshot:locations:response_shape",
  "snapshot:rooms:response_shape",
  "snapshot:device_cards:response_shape",
  "snapshot:device_states:response_shape",
  "snapshot:device_health:response_shape",
  "snapshot:scenes:response_shape",
  "event:device_event:identity"
]);

export class RuntimeStatusStore {
  #snapshot: RuntimeStatusSnapshot;
  #listeners = new Set<RuntimeStatusListener>();
  readonly #now: () => number;
  readonly #onListenerError: ((error: unknown) => void) | undefined;

  constructor(options: RuntimeStatusStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onListenerError = options.onListenerError;
    const now = this.#now();
    const initial = options.initial ?? {};
    validatePatch(initial, now);
    this.#snapshot = freezeSnapshot({
      state: "STARTING",
      urlCategory: "none",
      chromiumRunning: false,
      keeperPresent: false,
      authenticated: false,
      pushConnected: false,
      initialSnapshotComplete: false,
      parserHealthy: false,
      dbAvailable: false,
      activeConnections: 0,
      observedDeviceCount: 0,
      decodedDeviceEventCount: 0,
      uniqueLogicalEventCount: 0,
      duplicateEventCount: 0,
      dedupeJournalSize: 0,
      protocolInvalidFrameCount: 0,
      detailDiscoveryFailureCount: 0,
      protocolChangeCount: 0,
      protocolMismatchSurface: undefined,
      restartCount: 0,
      architectureVersion: "unknown",
      advancedInventoryDeviceCount: 0,
      advancedInventoryLocationCount: 0,
      advancedInventoryPageCount: 0,
      adapterFailureCount: 0,
      pendingCommandCount: 0,
      domFallbackCount: 0,
      reconnectCount: 0,
      lastCommandTransport: undefined,
      lastCommandConfirmation: undefined,
      bridgeVersion: "0.0.0-dev",
      browserVersion: "unknown",
      protocolVersion: "unknown",
      heartbeatAtMs: now,
      updatedAtMs: now,
      initialSnapshotCompletedAtMs: undefined,
      lastSnapshotAtMs: undefined,
      lastFrameAtMs: undefined,
      lastEventAtMs: undefined,
      lastPushAtMs: undefined,
      lastParserSuccessAtMs: undefined,
      lastBrowserStartAtMs: undefined,
      advancedInventoryLastSyncAtMs: undefined,
      lastReconnectAtMs: undefined,
      lastStateChangeAtMs: now,
      ...initial
    });
  }

  getSnapshot(): RuntimeStatusSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: RuntimeStatusListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  update(patch: RuntimeStatusPatch): RuntimeStatusSnapshot {
    const now = this.#now();
    validatePatch(patch, now);

    const previous = this.#snapshot;
    const next = freezeSnapshot({
      ...previous,
      ...patch,
      updatedAtMs: now,
      lastStateChangeAtMs: patch.state && patch.state !== previous.state ? now : previous.lastStateChangeAtMs,
      initialSnapshotCompletedAtMs:
        patch.initialSnapshotComplete === false
          ? undefined
          : (patch.initialSnapshotCompletedAtMs ??
            (patch.initialSnapshotComplete === true && previous.initialSnapshotComplete === false
              ? now
              : previous.initialSnapshotCompletedAtMs))
    });

    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener(next, previous);
      } catch (error) {
        this.#onListenerError?.(error);
      }
    }
    return next;
  }

  heartbeat(atMs = this.#now()): RuntimeStatusSnapshot {
    return this.update({ heartbeatAtMs: atMs });
  }
}

function validatePatch(patch: RuntimeStatusPatch, now: number): void {
  for (const key of Object.keys(patch) as (keyof RuntimeStatusSnapshot)[]) {
    if (!snapshotKeys.has(key)) {
      throw new Error(`unsupported runtime status field: ${String(key)}`);
    }
    const value = patch[key];
    if (value !== undefined && counterKeys.has(key) && !isSafeCount(value)) {
      throw new Error(`runtime status counter must be a non-negative integer: ${String(key)}`);
    }
    if (value !== undefined && booleanKeys.has(key) && typeof value !== "boolean") {
      throw new Error(`runtime status flag must be boolean: ${String(key)}`);
    }
    if (key === "state" && value !== undefined && !isRuntimeState(value)) {
      throw new Error(`invalid runtime state: ${String(value)}`);
    }
    if (key === "urlCategory" && value !== undefined && !isUrlCategory(value)) {
      throw new Error(`invalid URL category: ${String(value)}`);
    }
    if (key === "protocolMismatchSurface" && value !== undefined && !isProtocolMismatchSurface(value)) {
      throw new Error(`invalid protocol mismatch surface: ${String(value)}`);
    }
    if (value !== undefined && timestampKeys.has(key)) {
      if (!isSafeTimestamp(value)) {
        throw new Error(`runtime status timestamp must be a non-negative integer: ${String(key)}`);
      }
      if (value > now + MAX_CLOCK_SKEW_MS) {
        throw new Error(`runtime status timestamp exceeds allowed clock skew: ${String(key)}`);
      }
    }
    if (value !== undefined && versionKeys.has(key) && !isSafeVersion(value)) {
      throw new Error(`unsafe runtime status version: ${String(key)}`);
    }
    if (
      value !== undefined &&
      diagnosticStringKeys.has(key) &&
      (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/u.test(value))
    ) {
      throw new Error(`unsafe runtime diagnostic string: ${String(key)}`);
    }
  }
}

function isSafeCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRuntimeState(value: unknown): value is RuntimeState {
  return typeof value === "string" && RUNTIME_STATES.includes(value as RuntimeState);
}

function isUrlCategory(value: unknown): value is UrlCategory {
  return typeof value === "string" && URL_CATEGORIES.includes(value as UrlCategory);
}

function isProtocolMismatchSurface(value: unknown): value is ProtocolMismatchSurface {
  return typeof value === "string" && protocolMismatchSurfaces.has(value as ProtocolMismatchSurface);
}

function isSafeVersion(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 120) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  if (/https?:\/\//i.test(value)) {
    return false;
  }
  if (/[?&#=]/u.test(value)) {
    return false;
  }
  if (/(?:authorization|cookie|password|token|secret|csrf|session)/i.test(value)) {
    return false;
  }
  return true;
}

function freezeSnapshot(snapshot: RuntimeStatusSnapshot): RuntimeStatusSnapshot {
  return Object.freeze({ ...snapshot });
}
