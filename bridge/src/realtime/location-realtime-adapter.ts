export interface LocationRealtimeSnapshot {
  awaitingRecoveredFrame: boolean;
  reconnectCount: number;
  lastReconnectAtMs?: number;
  lastReceivedAtMs?: number;
}

export class LocationRealtimeAdapter {
  #awaitingRecoveredFrame = false;
  #reconnectCount = 0;
  #lastReconnectAtMs: number | undefined;
  #lastReceivedAtMs: number | undefined;
  #backoffMs = 1_000;
  #recoveryPromise: Promise<void> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #frameTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  readonly #now: () => number;
  readonly #recover: (() => Promise<void>) | undefined;
  readonly #canRecover: () => boolean;
  readonly #onRecoveryAttempt: () => void;
  readonly #onRecoveryFailed: () => void;
  readonly #onRecovered: () => void;
  readonly #recoveredFrameTimeoutMs: number;

  constructor(options: {
    now?: () => number;
    recover?: () => Promise<void>;
    canRecover?: () => boolean;
    onRecoveryAttempt?: () => void;
    onRecoveryFailed?: () => void;
    onRecovered?: () => void;
    recoveredFrameTimeoutMs?: number;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#recover = options.recover;
    this.#canRecover = options.canRecover ?? (() => true);
    this.#onRecoveryAttempt = options.onRecoveryAttempt ?? (() => undefined);
    this.#onRecoveryFailed = options.onRecoveryFailed ?? (() => undefined);
    this.#onRecovered = options.onRecovered ?? (() => undefined);
    this.#recoveredFrameTimeoutMs = Math.max(1, options.recoveredFrameTimeoutMs ?? 30_000);
  }

  requestRecovery(): void {
    if (this.#stopped || !this.#recover || this.#recoveryPromise || this.#retryTimer || this.#frameTimer) return;
    if (!this.#canRecover()) {
      this.#scheduleRetry(1_000);
      return;
    }
    this.recoveryStarted();
    this.#notify(this.#onRecoveryAttempt);
    const recover = this.#recover;
    const operation = Promise.resolve().then(() => {
      if (!this.#stopped) return recover();
    }).then(
      () => {
        if (this.#stopped || !this.#awaitingRecoveredFrame) return;
        // Successful navigation is not proof of a restored subscription.
        this.#frameTimer = setTimeout(() => {
          this.#frameTimer = undefined;
          if (this.#stopped || !this.#awaitingRecoveredFrame) return;
          this.#notify(this.#onRecoveryFailed);
          this.#scheduleRetry(this.recoveryFailed());
        }, this.#recoveredFrameTimeoutMs);
        this.#frameTimer.unref?.();
      },
      () => {
        if (this.#stopped || !this.#awaitingRecoveredFrame) return;
        this.#notify(this.#onRecoveryFailed);
        this.#scheduleRetry(this.recoveryFailed());
      }
    );
    this.#recoveryPromise = operation;
    void operation.finally(() => {
      if (this.#recoveryPromise === operation) this.#recoveryPromise = undefined;
    });
  }

  #scheduleRetry(delay: number): void {
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.requestRecovery();
    }, delay);
    this.#retryTimer.unref?.();
  }

  #notify(callback: () => void): void {
    try { callback(); } catch { /* Observers must not break recovery. */ }
  }

  recoveryStarted(): void {
    if (this.#stopped) return;
    this.#awaitingRecoveredFrame = true;
    this.#reconnectCount += 1;
    this.#lastReconnectAtMs = this.#now();
  }

  observeFrame(direction: "sent" | "received"): boolean {
    if (this.#stopped || direction !== "received") return false;
    this.#lastReceivedAtMs = this.#now();
    if (!this.#awaitingRecoveredFrame) return false;
    this.#awaitingRecoveredFrame = false;
    this.#backoffMs = 1_000;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#retryTimer = undefined;
    this.#frameTimer = undefined;
    this.#notify(this.#onRecovered);
    return true;
  }

  recoveryFailed(): number {
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(60_000, this.#backoffMs * 2);
    return delay;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    if (this.#frameTimer) clearTimeout(this.#frameTimer);
    this.#retryTimer = undefined;
    this.#frameTimer = undefined;
  }

  snapshot(): LocationRealtimeSnapshot {
    return {
      awaitingRecoveredFrame: this.#awaitingRecoveredFrame,
      reconnectCount: this.#reconnectCount,
      ...(this.#lastReconnectAtMs === undefined ? {} : { lastReconnectAtMs: this.#lastReconnectAtMs }),
      ...(this.#lastReceivedAtMs === undefined ? {} : { lastReceivedAtMs: this.#lastReceivedAtMs }),
    };
  }
}
