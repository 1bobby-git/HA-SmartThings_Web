import { createHash } from "node:crypto";

export interface EventIdentityInput {
  eventId?: string | null;
  deviceId?: string | null;
  locationId?: string | null;
  component?: string | null;
  capability?: string | null;
  attribute?: string | null;
  stateChange?: boolean | null;
  payloadHash?: string | null;
}

export interface EventIdentity {
  key: string;
  source: "event_id" | "fingerprint";
}

export interface EventDeduplicatorOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export interface EventDedupeResult extends EventIdentity {
  duplicate: boolean;
  occurrence: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

interface SeenEvent {
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  occurrence: number;
  identity: EventIdentity;
}

export function createEventIdentity(input: EventIdentityInput): EventIdentity {
  const eventId = normalizeText(input.eventId);
  if (eventId) {
    return { key: `event_id:${eventId}`, source: "event_id" };
  }
  const canonical = canonicalJson({
    attribute: normalizeText(input.attribute),
    capability: normalizeText(input.capability),
    component: normalizeText(input.component),
    deviceId: normalizeText(input.deviceId),
    locationId: normalizeText(input.locationId),
    payloadHash: normalizeText(input.payloadHash),
    stateChange: input.stateChange ?? null
  });
  return {
    key: `fingerprint:${createHash("sha256").update(canonical).digest("hex")}`,
    source: "fingerprint"
  };
}

export function createEventPayloadHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function extractDeviceEventIdentity(input: unknown): EventIdentityInput | null {
  const delivery = asRecord(input);
  const data = asRecord(delivery?.["data"]);
  const eventType = readString(data, "event_type", "eventType");
  if (eventType !== "DEVICE_EVENT") {
    return null;
  }
  const event = asRecord(data?.["device_event"] ?? data?.["deviceEvent"]);
  if (!event) {
    return null;
  }
  return {
    eventId: readString(event, "event_id", "eventId"),
    deviceId: readString(event, "device_id", "deviceId"),
    locationId: readString(event, "location_id", "locationId"),
    component: readString(event, "component", "componentId"),
    capability: readString(event, "capability"),
    attribute: readString(event, "attribute"),
    stateChange: readBoolean(event, "state_change", "stateChange"),
    payloadHash:
      readString(delivery, "payload_hash", "payloadHash") ??
      createEventPayloadHash({
        eventTime: readString(event, "event_time", "eventTime") ??
          readString(data, "event_time", "eventTime"),
        unit: readString(event, "unit"),
        value: event.value
      })
  };
}

export class EventDeduplicator {
  readonly #seen = new Map<string, SeenEvent>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: EventDeduplicatorOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("ttlMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("maxEntries must be a positive safe integer");
    }
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#seen.size;
  }

  reset(): void {
    this.#seen.clear();
  }

  observe(input: EventIdentityInput): EventDedupeResult {
    const now = this.#now();
    this.#prune(now);
    const identity = createEventIdentity(input);
    const existing = this.#seen.get(identity.key);
    if (existing) {
      existing.lastSeenAtMs = now;
      existing.occurrence += 1;
      return toResult(existing, true);
    }

    while (this.#seen.size >= this.#maxEntries) {
      const oldestKey = this.#oldestKey();
      if (!oldestKey) {
        break;
      }
      this.#seen.delete(oldestKey);
    }
    const entry: SeenEvent = {
      identity,
      firstSeenAtMs: now,
      lastSeenAtMs: now,
      occurrence: 1
    };
    this.#seen.set(identity.key, entry);
    return toResult(entry, false);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#seen) {
      if (now - entry.firstSeenAtMs >= this.#ttlMs) {
        this.#seen.delete(key);
      }
    }
  }

  #oldestKey(): string | undefined {
    let oldest: [string, SeenEvent] | undefined;
    for (const entry of this.#seen) {
      if (!oldest || entry[1].firstSeenAtMs < oldest[1].firstSeenAtMs) {
        oldest = entry;
      }
    }
    return oldest?.[0];
  }
}

function toResult(entry: SeenEvent, duplicate: boolean): EventDedupeResult {
  return {
    ...entry.identity,
    duplicate,
    occurrence: entry.occurrence,
    firstSeenAtMs: entry.firstSeenAtMs,
    lastSeenAtMs: entry.lastSeenAtMs
  };
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return null;
}

function readBoolean(
  value: Record<string, unknown> | undefined,
  ...keys: string[]
): boolean | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return null;
}
