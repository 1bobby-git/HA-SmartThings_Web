import type { SanitizedCaptureRecord } from "./capture-store.js";
import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";

export type BridgeJsonValue = null | boolean | number | string | BridgeJsonValue[] | {
  [key: string]: BridgeJsonValue;
};

export interface BridgeLocation {
  id: string;
  name: string;
}

export interface BridgeRoom {
  id: string;
  locationId: string;
  name: string;
}

export interface BridgeDeviceState {
  component: string;
  capability: string;
  attribute: string;
  value: BridgeJsonValue;
  unit: string | null;
  updatedAt: string | null;
}

export interface BridgeDevice {
  id: string;
  locationId: string;
  roomId: string | null;
  name: string;
  type: string | null;
  online: boolean;
  states: BridgeDeviceState[];
}

export interface BridgeInventory {
  schemaVersion: 1;
  sequence: number;
  locations: BridgeLocation[];
  rooms: BridgeRoom[];
  devices: BridgeDevice[];
}

export type BridgeDeviceStoreEvent =
  | { schemaVersion: 1; sequence: number; type: "inventory" }
  | {
      schemaVersion: 1;
      sequence: number;
      type: "state";
      deviceId: string;
      state: BridgeDeviceState;
    };

type Listener = (event: BridgeDeviceStoreEvent) => void;
type StateTokenNormalizer = (value: string) => string;
type SnapshotQuery =
  | "api/location"
  | "api/room"
  | "api/device"
  | "api/device/status"
  | "api/device/health";

interface PendingSnapshot {
  query: SnapshotQuery;
}

interface MutableDevice {
  id: string;
  locationId: string;
  roomId: string | null;
  name: string;
  type: string | null;
  online: boolean;
  states: Map<string, BridgeDeviceState>;
}

const SNAPSHOT_QUERIES = new Set<SnapshotQuery>([
  "api/location",
  "api/room",
  "api/device",
  "api/device/status",
  "api/device/health"
]);
const ID_PATTERN = /^(?:loc|dev|identifier)_[A-Za-z0-9]{3,64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/u;

export class DeviceStore {
  readonly #locations = new Map<string, BridgeLocation>();
  readonly #rooms = new Map<string, BridgeRoom>();
  readonly #devices = new Map<string, MutableDevice>();
  readonly #pending = new Map<number, PendingSnapshot>();
  readonly #listeners = new Set<Listener>();
  readonly #normalizeStateToken: StateTokenNormalizer;
  #sequence = 0;

  constructor(options: { normalizeStateToken?: StateTokenNormalizer } = {}) {
    this.#normalizeStateToken = options.normalizeStateToken ?? ((value) => value);
  }

  observe(record: SanitizedCaptureRecord): void {
    const frame = extractTextFrame(record);
    if (!frame) {
      return;
    }
    const decoded = decodeSocketIoTextFrame(frame.text);
    if (frame.direction === "sent" && decoded.kind === "event") {
      const query = decoded.args[0];
      if (
        decoded.eventName === "find" &&
        decoded.ackId !== undefined &&
        typeof query === "string" &&
        SNAPSHOT_QUERIES.has(query as SnapshotQuery)
      ) {
        this.#pending.set(decoded.ackId, { query: query as SnapshotQuery });
      }
      return;
    }
    if (frame.direction !== "received") {
      return;
    }
    if (decoded.kind === "ack" && decoded.ackId !== undefined) {
      const pending = this.#pending.get(decoded.ackId);
      if (!pending) {
        return;
      }
      this.#pending.delete(decoded.ackId);
      if (this.#applySnapshot(pending.query, snapshotBody(decoded.args))) {
        this.#publish({ schemaVersion: 1, sequence: this.#nextSequence(), type: "inventory" });
      }
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription DEVICE_EVENT") {
      this.#applyDeviceEvent(decoded.args[0]);
    }
  }

  snapshot(): BridgeInventory {
    return {
      schemaVersion: 1,
      sequence: this.#sequence,
      locations: [...this.#locations.values()].sort(byId).map((value) => ({ ...value })),
      rooms: [...this.#rooms.values()].sort(byId).map((value) => ({ ...value })),
      devices: [...this.#devices.values()].sort(byId).map((device) => ({
        id: device.id,
        locationId: device.locationId,
        roomId: device.roomId,
        name: device.name,
        type: device.type,
        online: device.online,
        states: [...device.states.values()].sort(byState).map(cloneState)
      }))
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    this.#pending.clear();
  }

  #applySnapshot(query: SnapshotQuery, body: unknown): boolean {
    const rows = snapshotRows(body);
    if (!rows) {
      return false;
    }
    let changed = false;
    if (query === "api/location") {
      for (const row of rows) {
        const id = safeId(row.locationId, "loc");
        const name = safeName(row.name);
        if (!id || !name) continue;
        changed = setIfChanged(this.#locations, id, { id, name }) || changed;
      }
      return changed;
    }
    if (query === "api/room") {
      for (const row of rows) {
        const id = safeId(row.roomId, "identifier");
        const locationId = safeId(row.locationId, "loc");
        const name = safeName(row.name);
        if (!id || !locationId || !name) continue;
        changed = setIfChanged(this.#rooms, id, { id, locationId, name }) || changed;
      }
      return changed;
    }
    if (query === "api/device") {
      for (const card of rows) {
        const source = firstRecord(card.basic, card.cloud, card.camera);
        if (!source) continue;
        const id = safeId(source.deviceId, "dev");
        const locationId = safeId(source.locationId, "loc");
        if (!id || !locationId) continue;
        const device = this.#ensureDevice(id, locationId);
        const nextName = safeName(source.deviceName) ?? device.name;
        const nextRoomId = safeId(source.roomId, "identifier");
        const typeData = asRecord(source.deviceTypeData);
        const nextType = safeName(typeData?.type);
        if (device.name !== nextName || device.roomId !== nextRoomId || device.type !== nextType) {
          device.name = nextName;
          device.roomId = nextRoomId;
          device.type = nextType;
          changed = true;
        }
      }
      return changed;
    }
    if (query === "api/device/status") {
      for (const row of rows) {
        const state = stateFromSnapshot(row);
        const deviceId = safeId(row.deviceId, "dev");
        const locationId = safeId(row.locationId, "loc");
        if (!state || !deviceId || !locationId) continue;
        const device = this.#ensureDevice(deviceId, locationId);
        changed = this.#setState(device, state) || changed;
      }
      return changed;
    }
    for (const row of rows) {
      const deviceId = safeId(row.deviceId, "dev");
      const locationId = safeId(row.locationId, "loc");
      const online = readString(row.state)?.toUpperCase() === "ONLINE";
      if (!deviceId || !locationId) continue;
      const device = this.#ensureDevice(deviceId, locationId);
      if (device.online !== online) {
        device.online = online;
        changed = true;
      }
    }
    return changed;
  }

  #applyDeviceEvent(input: unknown): void {
    const envelope = asRecord(input);
    const data = asRecord(envelope?.data);
    const event = asRecord(data?.device_event ?? data?.deviceEvent);
    const deviceId = safeId(event?.device_id ?? event?.deviceId, "dev");
    const locationId = safeId(event?.location_id ?? event?.locationId, "loc");
    if (!data || !event || !deviceId || !locationId) {
      return;
    }
    const device = this.#ensureDevice(deviceId, locationId);
    const state = stateFromEvent(event, data, device, this.#normalizeStateToken);
    if (!state) {
      return;
    }
    if (!this.#setState(device, state)) {
      return;
    }
    this.#publish({
      schemaVersion: 1,
      sequence: this.#nextSequence(),
      type: "state",
      deviceId,
      state: cloneState(state)
    });
  }

  #ensureDevice(id: string, locationId: string): MutableDevice {
    const existing = this.#devices.get(id);
    if (existing) {
      if (existing.locationId !== locationId) existing.locationId = locationId;
      return existing;
    }
    const created: MutableDevice = {
      id,
      locationId,
      roomId: null,
      name: `SmartThings device ${id}`,
      type: null,
      online: true,
      states: new Map()
    };
    this.#devices.set(id, created);
    return created;
  }

  #setState(device: MutableDevice, state: BridgeDeviceState): boolean {
    const key = stateKey(state);
    const current = device.states.get(key);
    if (current && isOlderOrUndated(state.updatedAt, current.updatedAt)) {
      return false;
    }
    if (current && JSON.stringify(current) === JSON.stringify(state)) {
      return false;
    }
    device.states.set(key, cloneState(state));
    return true;
  }

  #nextSequence(): number {
    this.#sequence += 1;
    return this.#sequence;
  }

  #publish(event: BridgeDeviceStoreEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // One failed local client must not interrupt browser capture.
      }
    }
  }
}

function snapshotBody(args: unknown[]): unknown {
  return args[0] === null ? args[1] : args;
}

function snapshotRows(value: unknown): Record<string, unknown>[] | null {
  const record = asRecord(value);
  const rows = record && Array.isArray(record.data) ? record.data : value;
  if (!Array.isArray(rows)) return null;
  const records = rows.map(asRecord);
  return records.some((item) => !item) ? null : (records as Record<string, unknown>[]);
}

function stateFromSnapshot(row: Record<string, unknown>): BridgeDeviceState | null {
  return stateFromParts({
    component: row.componentId,
    capability: row.capabilityId,
    attribute: row.attributeName,
    value: row.value,
    unit: row.unit,
    updatedAt: row.timestamp
  });
}

function stateFromEvent(
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  device: MutableDevice,
  normalizeStateToken: StateTokenNormalizer
): BridgeDeviceState | null {
  const capability = normalizeToken(readString(event.capability), normalizeStateToken);
  const attribute = readString(event.attribute);
  const reportedComponent = readString(event.component);
  const normalizedComponent = normalizeToken(reportedComponent ?? "main", normalizeStateToken);
  const component =
    reportedComponent !== null
      ? normalizedComponent
      : hasState(device, normalizedComponent, capability, attribute)
        ? normalizedComponent
        : inferComponent(device, capability, attribute);
  const state = stateFromParts({
    component,
    capability,
    attribute,
    value: event.value,
    unit: event.unit,
    updatedAt: event.event_time ?? event.eventTime ?? data.event_time ?? data.eventTime
  });
  return state?.updatedAt ? state : null;
}

function normalizeToken(
  value: string | null,
  normalizeStateToken: StateTokenNormalizer
): string | null {
  if (!value || !safeToken(value)) return null;
  try {
    const normalized = normalizeStateToken(value);
    return safeToken(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function hasState(
  device: MutableDevice,
  component: string | null,
  capability: string | null,
  attribute: string | null
): boolean {
  return Boolean(
    component &&
      capability &&
      attribute &&
      device.states.has(`${component}\u0000${capability}\u0000${attribute}`)
  );
}

function inferComponent(
  device: MutableDevice,
  capability: string | null,
  attribute: string | null
): string | null {
  if (!capability || !attribute) return null;
  const matches = [...device.states.values()].filter(
    (state) => state.capability === capability && state.attribute === attribute
  );
  return matches.length === 1 ? matches[0]?.component ?? null : null;
}

function stateFromParts(input: Record<string, unknown>): BridgeDeviceState | null {
  const component = readString(input.component);
  const capability = readString(input.capability);
  const attribute = readString(input.attribute);
  const value = jsonValue(input.value);
  if (!safeToken(component) || !safeToken(capability) || !safeToken(attribute) || value === undefined) {
    return null;
  }
  return {
    component,
    capability,
    attribute,
    value,
    unit: readString(input.unit),
    updatedAt: validTimestamp(input.updatedAt)
  };
}

function extractTextFrame(
  record: SanitizedCaptureRecord
): { direction: "sent" | "received"; text: string } | null {
  if (record.source !== "playwright-websocket-frame" && record.source !== "cdp-websocket-frame") {
    return null;
  }
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const direction = payload?.direction;
  if (direction !== "sent" && direction !== "received") return null;
  if (record.source === "playwright-websocket-frame") {
    const frame = asRecord(payload.frame);
    return frame?.truncated !== true && typeof frame?.payload === "string"
      ? { direction, text: frame.payload }
      : null;
  }
  const response = asRecord(asRecord(payload.payload)?.response);
  return response?.truncated !== true && typeof response?.payloadData === "string"
    ? { direction, text: response.payloadData }
    : null;
}

function safeId(value: unknown, prefix: "loc" | "dev" | "identifier"): string | null {
  const text = readString(value);
  return text && text.startsWith(`${prefix}_`) && ID_PATTERN.test(text) ? text : null;
}

function safeName(value: unknown): string | null {
  const text = readString(value)?.trim();
  return text && text.length <= 255 && !text.includes("[REDACTED]") ? text : null;
}

function safeToken(value: string | null): value is string {
  return value !== null && TOKEN_PATTERN.test(value);
}

function validTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const text = readString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function isOlderOrUndated(candidate: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (candidate === null) return true;
  return Date.parse(candidate) <= Date.parse(current);
}

function jsonValue(value: unknown): BridgeJsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16_384) return undefined;
    return JSON.parse(serialized) as BridgeJsonValue;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.map(asRecord).find((value) => value !== undefined);
}

function stateKey(state: BridgeDeviceState): string {
  return `${state.component}\u0000${state.capability}\u0000${state.attribute}`;
}

function setIfChanged<T>(map: Map<string, T>, key: string, value: T): boolean {
  const current = map.get(key);
  if (current && JSON.stringify(current) === JSON.stringify(value)) return false;
  map.set(key, value);
  return true;
}

function cloneState(state: BridgeDeviceState): BridgeDeviceState {
  return { ...state, value: jsonValue(state.value) ?? null };
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function byState(left: BridgeDeviceState, right: BridgeDeviceState): number {
  return stateKey(left).localeCompare(stateKey(right));
}
