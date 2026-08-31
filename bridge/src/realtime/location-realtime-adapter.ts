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
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
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
    return true;
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
