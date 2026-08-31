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
  #stopped = false;
  readonly #now: () => number;
  readonly #recover: (() => Promise<void>) | undefined;
  readonly #canRecover: () => boolean;
  readonly #onRecoveryAttempt: () => void;
  readonly #onRecoveryFailed: () => void;
  readonly #onRecovered: () => void;

  constructor(options: {
    now?: () => number;
    recover?: () => Promise<void>;
    canRecover?: () => boolean;
    onRecoveryAttempt?: () => void;
    onRecoveryFailed?: () => void;
    onRecovered?: () => void;
  } = {}) {
    this.#now = options.now ?? Date.now;
    this.#recover = options.recover;
    this.#canRecover = options.canRecover ?? (() => true);
    this.#onRecoveryAttempt = options.onRecoveryAttempt ?? (() => undefined);
    this.#onRecoveryFailed = options.onRecoveryFailed ?? (() => undefined);
    this.#onRecovered = options.onRecovered ?? (() => undefined);
  }

  requestRecovery(): void {
    if (
      this.#stopped ||
      !this.#recover ||
      !this.#canRecover() ||
      this.#recoveryPromise
    ) {
      return;
    }
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.recoveryStarted();
    this.#onRecoveryAttempt();
    const operation = this.#recover();
    this.#recoveryPromise = operation;
    void operation.then(
      () => undefined,
      () => {
        this.#onRecoveryFailed();
        const retry = setTimeout(() => {
          this.#retryTimer = undefined;
          this.requestRecovery();
        }, this.recoveryFailed());
        retry.unref?.();
        this.#retryTimer = retry;
      }
    ).finally(() => {
      if (this.#recoveryPromise === operation) this.#recoveryPromise = undefined;
    });
  }

  recoveryStarted(): void {
    this.#awaitingRecoveredFrame = true;
    this.#reconnectCount += 1;
    this.#lastReconnectAtMs = this.#now();
  }

  observeFrame(direction: "sent" | "received"): boolean {
    if (direction !== "received") return false;
    this.#lastReceivedAtMs = this.#now();
    if (!this.#awaitingRecoveredFrame) return false;
    this.#awaitingRecoveredFrame = false;
    this.#backoffMs = 1_000;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#onRecovered();
    return true;
  }

  recoveryFailed(): number {
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(60_000, this.#backoffMs * 2);
    return delay;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  snapshot(): LocationRealtimeSnapshot {
    return {
      awaitingRecoveredFrame: this.#awaitingRecoveredFrame,
      reconnectCount: this.#reconnectCount,
      ...(this.#lastReconnectAtMs === undefined
        ? {}
        : { lastReconnectAtMs: this.#lastReconnectAtMs }),
      ...(this.#lastReceivedAtMs === undefined
        ? {}
        : { lastReceivedAtMs: this.#lastReceivedAtMs }),
    };
  }
}
