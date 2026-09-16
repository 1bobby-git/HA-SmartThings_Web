/** Read-only reconciliation safety net; transport/session heartbeats are not data. */
export interface StateSyncObservation {
  decodedDeviceEventCount: number;
  advancedInventoryLastSyncAtMs?: number | undefined;
}

export interface StateSyncDiagnostic {
  outcome: "ok" | "failed";
  reason: "quiet" | "interval";
  durationMs: number;
  consecutiveFailures: number;
}

export class StateSyncWatchdog {
  #observedCount: number | undefined;
  #lastProgressAtMs: number | undefined;
  #lastSyncAtMs: number | undefined;
  #lastTickAtMs: number | undefined;
  #retryAtMs = 0;
  #failures = 0;
  #inFlight: Promise<void> | undefined;
  readonly #now: () => number;

  constructor(private readonly options: {
    observe: () => StateSyncObservation;
    canRun: () => boolean;
    refresh: () => Promise<void>;
    intervalMs: number;
    quietMs?: number;
    now?: () => number;
    onDiagnostic?: (diagnostic: StateSyncDiagnostic) => void;
  }) {
    this.#now = options.now ?? Date.now;
  }

  tick(): Promise<void> {
    const now = this.#now();
    const observation = this.options.observe();
    const reset = this.#lastTickAtMs !== undefined && now < this.#lastTickAtMs;
    if (reset) {
      this.#lastProgressAtMs = now;
      this.#lastSyncAtMs = now;
      this.#retryAtMs = 0;
    }
    this.#lastTickAtMs = now;
    if (this.#observedCount !== observation.decodedDeviceEventCount) {
      this.#observedCount = observation.decodedDeviceEventCount;
      this.#lastProgressAtMs = now;
    }
    this.#lastProgressAtMs ??= now;
    this.#lastSyncAtMs ??= now;
    const synced = observation.advancedInventoryLastSyncAtMs;
    if (synced !== undefined && synced <= now && synced > this.#lastSyncAtMs) {
      this.#lastSyncAtMs = synced;
    }
    if (this.#inFlight) return this.#inFlight;
    const quiet = now - Math.max(this.#lastProgressAtMs, this.#lastSyncAtMs) >=
      (this.options.quietMs ?? 120_000);
    const periodic = now - this.#lastSyncAtMs >= this.options.intervalMs;
    if ((!quiet && !periodic) || now < this.#retryAtMs || !this.options.canRun()) {
      return Promise.resolve();
    }
    const reason = periodic ? "interval" : "quiet";
    // Start on a microtask so synchronous throws are handled and concurrent ticks coalesce.
    const operation = Promise.resolve().then(() => this.options.refresh()).then(
      () => {
        this.#lastSyncAtMs = this.#now();
        this.#retryAtMs = 0;
        this.#failures = 0;
        this.#diagnostic("ok", reason, now);
      },
      () => {
        this.#failures += 1;
        this.#retryAtMs = this.#now() + Math.min(300_000, 30_000 * 2 ** Math.min(4, this.#failures - 1));
        this.#diagnostic("failed", reason, now);
      }
    );
    const settled = operation.finally(() => {
      if (this.#inFlight === settled) this.#inFlight = undefined;
    });
    this.#inFlight = settled;
    return settled;
  }

  #diagnostic(outcome: StateSyncDiagnostic["outcome"], reason: StateSyncDiagnostic["reason"], started: number): void {
    try {
      this.options.onDiagnostic?.({ outcome, reason,
        durationMs: Math.max(0, this.#now() - started), consecutiveFailures: this.#failures });
    } catch { /* Diagnostics must not suspend synchronization. */ }
  }
}
