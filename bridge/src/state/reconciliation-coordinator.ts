import type {
  AdvancedLocationRow,
  AdvancedRoomRow
} from "../advanced/inventory-adapter.js";
import type { AdvancedDeviceRow } from "../advanced/types.js";

export type ReconciliationReason =
  | "startup"
  | "login"
  | "reconnect"
  | "reload"
  | "topology"
  | "interval"
  | "command_status";

export interface ReconciliationSnapshot {
  devices: AdvancedDeviceRow[];
  locations: AdvancedLocationRow[];
  rooms: AdvancedRoomRow[];
  pageCount: number;
  fetchedAtMs: number;
}

export interface ReconciliationStatus {
  inFlight: boolean;
  lastReason?: ReconciliationReason;
  lastSyncAtMs?: number;
  deviceCount: number;
  locationCount: number;
  pageCount: number;
  failureCount: number;
}

export class StateReconciliationCoordinator {
  #inFlight: Promise<void> | undefined;
  #lastReason: ReconciliationReason | undefined;
  #lastSyncAtMs: number | undefined;
  #deviceCount = 0;
  #locationCount = 0;
  #pageCount = 0;
  #failureCount = 0;
  readonly #now: () => number;

  constructor(
    private readonly options: {
      load: () => Promise<ReconciliationSnapshot>;
      apply: (snapshot: ReconciliationSnapshot, reason: ReconciliationReason) => void;
      now?: () => number;
    }
  ) {
    this.#now = options.now ?? Date.now;
  }

  request(reason: ReconciliationReason): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const operation = this.#run(reason);
    const settled = operation.finally(() => {
      if (this.#inFlight === settled) this.#inFlight = undefined;
    });
    this.#inFlight = settled;
    return settled;
  }

  snapshot(): ReconciliationStatus {
    return {
      inFlight: this.#inFlight !== undefined,
      ...(this.#lastReason === undefined ? {} : { lastReason: this.#lastReason }),
      ...(this.#lastSyncAtMs === undefined ? {} : { lastSyncAtMs: this.#lastSyncAtMs }),
      deviceCount: this.#deviceCount,
      locationCount: this.#locationCount,
      pageCount: this.#pageCount,
      failureCount: this.#failureCount
    };
  }

  async #run(reason: ReconciliationReason): Promise<void> {
    try {
      const snapshot = await this.options.load();
      this.options.apply(snapshot, reason);
      this.#lastReason = reason;
      this.#lastSyncAtMs = this.#now();
      this.#deviceCount = snapshot.devices.length;
      this.#locationCount = snapshot.locations.length;
      this.#pageCount = snapshot.pageCount;
    } catch (error) {
      this.#failureCount += 1;
      throw error;
    }
  }
}
