import { decodeSocketIoTextFrame } from "./socketio-decoder.js";

export const REQUIRED_SNAPSHOT_CATEGORIES = [
  "locations",
  "rooms",
  "device_cards",
  "device_states",
  "device_health",
  "scenes"
] as const;

export type SnapshotCategory = (typeof REQUIRED_SNAPSHOT_CATEGORIES)[number];

export interface SnapshotCorrelation {
  kind: "snapshot";
  requestEvent: string;
  category: SnapshotCategory;
  count: number;
}

export interface SnapshotProtocolChanged {
  kind: "protocol_changed";
  surface: `snapshot:${SnapshotCategory}:response_shape`;
  category?: never;
}

export type SnapshotObservation = SnapshotCorrelation | SnapshotProtocolChanged;

export interface SnapshotDetectorSnapshot {
  complete: boolean;
  categories: Partial<Record<SnapshotCategory, number>>;
  pendingRequests: number;
}

export interface SnapshotDetectorOptions {
  maxPendingRequests?: number;
}

interface PendingSnapshotRequest {
  requestEvent: string;
  categoryHint: SnapshotCategory;
}

export class SnapshotDetector {
  readonly #maxPendingRequests: number;
  readonly #pending = new Map<string, PendingSnapshotRequest>();
  readonly #categories = new Map<SnapshotCategory, number>();

  constructor(options: SnapshotDetectorOptions = {}) {
    this.#maxPendingRequests = options.maxPendingRequests ?? 1_000;
    if (!Number.isSafeInteger(this.#maxPendingRequests) || this.#maxPendingRequests <= 0) {
      throw new Error("maxPendingRequests must be a positive safe integer");
    }
  }

  observeSentFrame(raw: string, connectionId = "legacy"): void {
    const decoded = decodeSocketIoTextFrame(raw);
    if (decoded.kind !== "event" || decoded.ackId === undefined) {
      return;
    }
    const categoryHint = inferSnapshotCategoryHint(decoded.eventName, decoded.args);
    if (categoryHint === undefined) {
      return;
    }
    while (this.#pending.size >= this.#maxPendingRequests) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(pendingKey(connectionId, decoded.ackId), {
      requestEvent: decoded.eventName,
      categoryHint
    });
  }

  observeReceivedFrame(raw: string, connectionId = "legacy"): SnapshotObservation | null {
    const decoded = decodeSocketIoTextFrame(raw);
    if (decoded.kind !== "ack" || decoded.ackId === undefined) {
      return null;
    }
    const key = pendingKey(connectionId, decoded.ackId);
    const pending = this.#pending.get(key);
    if (!pending) {
      return null;
    }
    this.#pending.delete(key);
    const classified = classifySnapshotResponse(decoded.args, pending.categoryHint);
    if (!classified) {
      return {
        kind: "protocol_changed",
        surface: `snapshot:${pending.categoryHint}:response_shape`
      };
    }
    const current = this.#categories.get(classified.category) ?? 0;
    this.#categories.set(classified.category, Math.max(current, classified.count));
    return { kind: "snapshot", requestEvent: pending.requestEvent, ...classified };
  }

  snapshot(): SnapshotDetectorSnapshot {
    const categories = Object.fromEntries(this.#categories) as Partial<
      Record<SnapshotCategory, number>
    >;
    return {
      complete: REQUIRED_SNAPSHOT_CATEGORIES.every((category) => this.#categories.has(category)),
      categories,
      pendingRequests: this.#pending.size
    };
  }

  reset(): void {
    this.#pending.clear();
    this.#categories.clear();
  }
}

function pendingKey(connectionId: string, ackId: number): string {
  return `${connectionId}\u0000${ackId}`;
}

function classifySnapshotResponse(
  ackArgs: unknown[],
  categoryHint: SnapshotCategory
): { category: SnapshotCategory; count: number } | null {
  const data = ackArgs[0] === null ? ackArgs[1] : ackArgs;
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return categoryHint !== "device_cards"
        ? { category: categoryHint, count: 0 }
        : null;
    }
    const objects = data.map(asRecord);
    if (objects.some((value) => value === undefined)) {
      return null;
    }
    const classified = classifyHomogeneousRecords(
      objects as Record<string, unknown>[]
    );
    return acceptHint(classified, categoryHint);
  }

  const record = asRecord(data);
  const rawItems = record?.["data"];
  if (!Array.isArray(rawItems)) {
    return null;
  }
  if (rawItems.length === 0) {
    return categoryHint === "device_cards" ? { category: "device_cards", count: 0 } : null;
  }
  const items = rawItems.map(asRecord);
  if (items.some((value) => value === undefined)) {
    return null;
  }
  const classified = (items as Record<string, unknown>[]).every(isDeviceCardRecord)
    ? { category: "device_cards" as const, count: items.length }
    : null;
  return acceptHint(classified, categoryHint);
}

function inferSnapshotCategoryHint(
  requestEvent: string,
  args: unknown[]
): SnapshotCategory | undefined {
  if (requestEvent !== "find") {
    return undefined;
  }
  const queryName = args[0];
  if (typeof queryName !== "string") {
    return undefined;
  }
  const categoriesByQuery: Readonly<Record<string, SnapshotCategory>> = {
    "api/location": "locations",
    "api/room": "rooms",
    "api/device": "device_cards",
    "api/device/status": "device_states",
    "api/device/health": "device_health",
    "api/scene": "scenes"
  };
  return categoriesByQuery[queryName];
}

function classifyHomogeneousRecords(
  records: Record<string, unknown>[]
): { category: SnapshotCategory; count: number } | null {
  const predicates: ReadonlyArray<
    readonly [SnapshotCategory, (record: Record<string, unknown>) => boolean]
  > = [
    ["rooms", (record) => hasAll(record, ["roomId", "locationId"])],
    ["scenes", (record) => hasAll(record, ["actions", "dateCreated", "name"])],
    ["device_states", (record) => hasAll(record, ["deviceId", "capabilityId", "attributeName"])],
    ["device_health", (record) => hasAll(record, ["deviceId", "state", "lastUpdatedDate"])],
    [
      "locations",
      (record) =>
        hasAll(record, ["locationId", "name", "parent"]) &&
        !hasOwn(record, "deviceId") &&
        !hasOwn(record, "roomId")
    ]
  ];
  for (const [category, predicate] of predicates) {
    if (records.every(predicate)) {
      return { category, count: records.length };
    }
  }
  return null;
}

function acceptHint(
  classified: { category: SnapshotCategory; count: number } | null,
  categoryHint: SnapshotCategory
): { category: SnapshotCategory; count: number } | null {
  if (!classified || classified.category !== categoryHint) {
    return null;
  }
  return classified;
}

function isDeviceCardRecord(record: Record<string, unknown>): boolean {
  return (
    hasOwn(record, "type") &&
    (hasOwn(record, "basic") || hasOwn(record, "cloud") || hasOwn(record, "camera"))
  );
}

function hasAll(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => hasOwn(record, key));
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
