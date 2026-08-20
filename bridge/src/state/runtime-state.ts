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

export type UrlCategory = "unknown" | "signin" | "map" | "account" | "error";

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
  protocolChangeCount: number;
  restartCount: number;
  bridgeVersion: string;
  protocolVersion: string;
  heartbeatAtMs: number;
  updatedAtMs: number;
  initialSnapshotCompletedAtMs: number | undefined;
  lastPushAtMs: number | undefined;
  lastParserSuccessAtMs: number | undefined;
  lastBrowserStartAtMs: number | undefined;
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
  "protocolChangeCount",
  "restartCount",
  "bridgeVersion",
  "protocolVersion",
  "heartbeatAtMs",
  "updatedAtMs",
  "initialSnapshotCompletedAtMs",
  "lastPushAtMs",
  "lastParserSuccessAtMs",
  "lastBrowserStartAtMs",
  "lastStateChangeAtMs"
]);

const counterKeys = new Set<keyof RuntimeStatusSnapshot>([
  "activeConnections",
  "observedDeviceCount",
  "protocolChangeCount",
  "restartCount"
]);

export class RuntimeStatusStore {
  #snapshot: RuntimeStatusSnapshot;
  #listeners = new Set<RuntimeStatusListener>();
  readonly #now: () => number;

  constructor(options: RuntimeStatusStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    const now = this.#now();
    this.#snapshot = freezeSnapshot({
      state: "STARTING",
      urlCategory: "unknown",
      chromiumRunning: false,
      keeperPresent: false,
      authenticated: false,
      pushConnected: false,
      initialSnapshotComplete: false,
      parserHealthy: false,
      dbAvailable: false,
      activeConnections: 0,
      observedDeviceCount: 0,
      protocolChangeCount: 0,
      restartCount: 0,
      bridgeVersion: "0.0.0-dev",
      protocolVersion: "unknown",
      heartbeatAtMs: now,
      updatedAtMs: now,
      initialSnapshotCompletedAtMs: undefined,
      lastPushAtMs: undefined,
      lastParserSuccessAtMs: undefined,
      lastBrowserStartAtMs: undefined,
      lastStateChangeAtMs: now,
      ...options.initial
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
    validatePatch(patch);

    const now = this.#now();
    const previous = this.#snapshot;
    const next = freezeSnapshot({
      ...previous,
      ...patch,
      updatedAtMs: now,
      lastStateChangeAtMs: patch.state && patch.state !== previous.state ? now : previous.lastStateChangeAtMs,
      initialSnapshotCompletedAtMs:
        patch.initialSnapshotCompletedAtMs ??
        (patch.initialSnapshotComplete === true && previous.initialSnapshotComplete === false
          ? now
          : previous.initialSnapshotCompletedAtMs)
    });

    this.#snapshot = next;
    for (const listener of this.#listeners) {
      listener(next, previous);
    }
    return next;
  }

  heartbeat(atMs = this.#now()): RuntimeStatusSnapshot {
    return this.update({ heartbeatAtMs: atMs });
  }
}

function validatePatch(patch: RuntimeStatusPatch): void {
  for (const key of Object.keys(patch) as (keyof RuntimeStatusSnapshot)[]) {
    if (!snapshotKeys.has(key)) {
      throw new Error(`unsupported runtime status field: ${String(key)}`);
    }
    const value = patch[key];
    if (value !== undefined && counterKeys.has(key) && !isSafeCount(value)) {
      throw new Error(`runtime status counter must be a non-negative integer: ${String(key)}`);
    }
  }
}

function isSafeCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function freezeSnapshot(snapshot: RuntimeStatusSnapshot): RuntimeStatusSnapshot {
  return Object.freeze({ ...snapshot });
}
