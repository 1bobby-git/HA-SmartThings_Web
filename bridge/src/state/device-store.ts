import type { SanitizedCaptureRecord } from "./capture-store.js";
import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type BridgeJsonValue = null | boolean | number | string | BridgeJsonValue[] | {
  [key: string]: BridgeJsonValue;
};

export interface BridgeLocation {
  id: string;
  name: string;
  armState?: string;
  updatedAt?: string | null;
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

export interface BridgeDeviceControl {
  id: string;
  kind: "button" | "color" | "enumerated" | "slider" | "toggle" | "value";
  label: string;
  component: string;
  capability: string;
  attribute: string;
  command?: string;
  commands?: string[];
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export interface BridgeDevice {
  id: string;
  locationId: string;
  roomId: string | null;
  name: string;
  type: string | null;
  online: boolean;
  states: BridgeDeviceState[];
  controls?: BridgeDeviceControl[];
}

export interface BridgeScene {
  id: string;
  locationId: string;
  name: string;
  updatedAt: string | null;
}

export interface BridgeInventory {
  schemaVersion: 1;
  sequence: number;
  locations: BridgeLocation[];
  rooms: BridgeRoom[];
  devices: BridgeDevice[];
  scenes: BridgeScene[];
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
  | "api/scene"
  | "api/device/details"
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
  controls: Map<string, BridgeDeviceControl>;
}

const SNAPSHOT_QUERIES = new Set<SnapshotQuery>([
  "api/location",
  "api/scene",
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
  readonly #scenes = new Map<string, BridgeScene>();
  readonly #pending = new Map<number, PendingSnapshot>();
  readonly #listeners = new Set<Listener>();
  readonly #normalizeStateToken: StateTokenNormalizer;
  readonly #db: DatabaseSync | undefined;
  #sequence = 0;

  constructor(options: {
    normalizeStateToken?: StateTokenNormalizer;
    sqlitePath?: string;
  } = {}) {
    this.#normalizeStateToken = options.normalizeStateToken ?? ((value) => value);
    if (options.sqlitePath) {
      mkdirSync(dirname(options.sqlitePath), { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(options.sqlitePath);
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS normalized_inventory (
          schema_version INTEGER PRIMARY KEY,
          inventory_json TEXT NOT NULL,
          persisted_at TEXT NOT NULL
        )
      `);
      const restored = this.#loadPersistedInventory();
      if (restored) this.#restore(restored);
    }
  }

  observe(record: SanitizedCaptureRecord): void {
    const frame = extractTextFrame(record);
    if (!frame) {
      return;
    }
    const decoded = decodeSocketIoTextFrame(frame.text);
    if (frame.direction === "sent" && decoded.kind === "event") {
      const query = decoded.args[0];
      if (decoded.ackId !== undefined && decoded.eventName === "get" && query === "api/device") {
        this.#pending.set(decoded.ackId, { query: "api/device/details" });
      } else if (decoded.ackId !== undefined && decoded.eventName === "get" && query === "api/location") {
        this.#pending.set(decoded.ackId, { query: "api/location" });
      } else if (
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
        const sequence = this.#nextSequence();
        this.#persist();
        this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
      }
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription DEVICE_EVENT") {
      this.#applyDeviceEvent(decoded.args[0]);
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription SECURITY_ARM_STATE_EVENT") {
      this.#applySecurityArmStateEvent(decoded.args[0]);
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription SCENE_LIFECYCLE_EVENT") {
      const sequence = this.#nextSequence();
      this.#persist();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
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
        states: [...device.states.values()].sort(byState).map(cloneState),
        ...(device.controls.size > 0
          ? { controls: [...device.controls.values()].sort(byId).map((value) => ({ ...value })) }
          : {})
      })),
      scenes: [...this.#scenes.values()].sort(byId).map((value) => ({ ...value }))
    };
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  reset(): void {
    this.#pending.clear();
  }

  close(): void {
    this.#db?.close();
  }

  #applySnapshot(query: SnapshotQuery, body: unknown): boolean {
    const rows = snapshotRows(body);
    if (!rows) {
      return false;
    }
    let changed = false;
    if (query === "api/location") {
      for (const row of rows) {
        const id = safeId(row.locationId ?? row.location_id ?? row.id, "loc");
        const name = safeName(row.name);
        if (!id || !name) continue;
        const armState = safeToken(readString(row.armState ?? row.arm_state))
          ? (readString(row.armState ?? row.arm_state) as string)
          : undefined;
        const updatedAt = validTimestamp(row.updatedAt ?? row.updated_at ?? row.timestamp);
        changed =
          setIfChanged(this.#locations, id, {
            id,
            name,
            ...(armState ? { armState } : {}),
            ...(armState || updatedAt ? { updatedAt } : {})
          }) || changed;
      }
      return changed;
    }
    if (query === "api/scene") {
      for (const row of rows) {
        const meta = asRecord(row.meta);
        const id = safeId(row.sceneId ?? row.scene_id ?? row.id, "identifier");
        const locationId = safeId(row.locationId ?? row.location_id ?? meta?.locationId, "loc");
        const name = safeName(row.name ?? row.sceneName ?? row.scene_name);
        if (!id || !locationId || !name) continue;
        changed =
          setIfChanged(this.#scenes, id, {
            id,
            locationId,
            name,
            updatedAt: validTimestamp(row.updatedAt ?? row.updated_at ?? row.timestamp ?? row.dateUpdated ?? meta?.dateUpdated)
          }) || changed;
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
    if (query === "api/device/details") {
      for (const row of rows) {
        const control = controlFromSwatch(row);
        if (!control) continue;
        const nested = asRecord(row[control.kind]);
        const deviceId = safeId(nested?.deviceId ?? nested?.device_id, "dev");
        const locationId = safeId(nested?.locationId ?? nested?.location_id, "loc");
        if (!deviceId || !locationId) continue;
        const device = this.#ensureDevice(deviceId, locationId);
        changed = setIfChanged(device.controls, control.id, control) || changed;
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
    const sequence = this.#nextSequence();
    this.#persist();
    this.#publish({
      schemaVersion: 1,
      sequence,
      type: "state",
      deviceId,
      state: cloneState(state)
    });
  }

  #applySecurityArmStateEvent(input: unknown): void {
    const envelope = asRecord(input);
    const data = asRecord(envelope?.data) ?? envelope;
    const event =
      asRecord(data?.securityArmStateEvent) ??
      asRecord(data?.security_arm_state_event) ??
      asRecord(data?.security_event ?? data?.securityEvent) ??
      data;
    const locationId = safeId(event?.location_id ?? event?.locationId, "loc");
    const armState = readString(event?.arm_state ?? event?.armState ?? event?.state);
    const updatedAt = validTimestamp(
      event?.event_time ?? event?.eventTime ?? event?.updatedAt ?? data?.event_time ?? data?.eventTime
    );
    if (!locationId || !armState || !safeToken(armState) || !updatedAt) {
      return;
    }
    const current = this.#locations.get(locationId);
    if (current?.updatedAt && isOlderOrUndated(updatedAt, current.updatedAt)) {
      return;
    }
    const next = {
      id: locationId,
      name: current?.name ?? `SmartThings location ${locationId}`,
      armState,
      updatedAt
    };
    if (!setIfChanged(this.#locations, locationId, next)) {
      return;
    }
    const sequence = this.#nextSequence();
    this.#persist();
    this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
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
      states: new Map(),
      controls: new Map()
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

  #loadPersistedInventory(): BridgeInventory | undefined {
    const row = this.#db
      ?.prepare("SELECT inventory_json AS inventoryJson FROM normalized_inventory WHERE schema_version = 1")
      .get() as { inventoryJson?: unknown } | undefined;
    if (typeof row?.inventoryJson !== "string") return undefined;
    try {
      return parsePersistedInventory(JSON.parse(row.inventoryJson));
    } catch {
      return undefined;
    }
  }

  #restore(inventory: BridgeInventory): void {
    this.#sequence = inventory.sequence;
    for (const location of inventory.locations) this.#locations.set(location.id, { ...location });
    for (const room of inventory.rooms) this.#rooms.set(room.id, { ...room });
    for (const scene of inventory.scenes) this.#scenes.set(scene.id, { ...scene });
    for (const device of inventory.devices) {
      this.#devices.set(device.id, {
        id: device.id,
        locationId: device.locationId,
        roomId: device.roomId,
        name: device.name,
        type: device.type,
        online: device.online,
        states: new Map(device.states.map((state) => [stateKey(state), cloneState(state)])),
        controls: new Map((device.controls ?? []).map((control) => [control.id, { ...control }]))
      });
    }
  }

  #persist(): void {
    if (!this.#db) return;
    this.#db
      .prepare(`
        INSERT INTO normalized_inventory (schema_version, inventory_json, persisted_at)
        VALUES (1, ?, ?)
        ON CONFLICT(schema_version) DO UPDATE SET
          inventory_json = excluded.inventory_json,
          persisted_at = excluded.persisted_at
      `)
      .run(JSON.stringify(this.snapshot()), new Date().toISOString());
  }
}

function parsePersistedInventory(value: unknown): BridgeInventory | undefined {
  const root = asRecord(value);
  if (
    root?.schemaVersion !== 1 ||
    !Number.isInteger(root.sequence) ||
    (root.sequence as number) < 0 ||
    !Array.isArray(root.locations) ||
    !Array.isArray(root.rooms) ||
    !Array.isArray(root.devices)
  ) {
    return undefined;
  }
  const locations: BridgeLocation[] = [];
  for (const raw of root.locations) {
    const item = asRecord(raw);
    const id = safeId(item?.id, "loc");
    const name = safeName(item?.name);
    if (!id || !name) return undefined;
    const armState =
      item?.armState === undefined
        ? undefined
        : safeToken(readString(item.armState))
          ? (item.armState as string)
          : null;
    const updatedAt =
      item?.updatedAt === undefined || item?.updatedAt === null
        ? item?.updatedAt
        : validTimestamp(item.updatedAt);
    if (armState === null || (item?.updatedAt !== undefined && updatedAt === null)) {
      return undefined;
    }
    locations.push({
      id,
      name,
      ...(armState ? { armState } : {}),
      ...(item?.updatedAt !== undefined ? { updatedAt: updatedAt as string | null } : {})
    });
  }
  const rooms: BridgeRoom[] = [];
  for (const raw of root.rooms) {
    const item = asRecord(raw);
    const id = safeId(item?.id, "identifier");
    const locationId = safeId(item?.locationId, "loc");
    const name = safeName(item?.name);
    if (!id || !locationId || !name) return undefined;
    rooms.push({ id, locationId, name });
  }
  const devices: BridgeDevice[] = [];
  for (const raw of root.devices) {
    const item = asRecord(raw);
    const id = safeId(item?.id, "dev");
    const locationId = safeId(item?.locationId, "loc");
    const roomId = item?.roomId === null ? null : safeId(item?.roomId, "identifier");
    const name = safeName(item?.name);
    const type = item?.type === null ? null : safeName(item?.type);
    if (
      !id ||
      !locationId ||
      roomId === undefined ||
      !name ||
      type === undefined ||
      typeof item?.online !== "boolean" ||
      !Array.isArray(item.states)
    ) {
      return undefined;
    }
    const states: BridgeDeviceState[] = [];
    for (const rawState of item.states) {
      const state = asRecord(rawState);
      const parsed = state ? stateFromParts(state) : null;
      if (!parsed) return undefined;
      states.push(parsed);
    }
    const controls: BridgeDeviceControl[] = [];
    if (item.controls !== undefined) {
      if (!Array.isArray(item.controls)) return undefined;
      for (const rawControl of item.controls) {
        const control = controlFromParts(asRecord(rawControl));
        if (!control) return undefined;
        controls.push(control);
      }
    }
    devices.push({
      id,
      locationId,
      roomId,
      name,
      type,
      online: item.online,
      states,
      ...(controls.length > 0 ? { controls } : {})
    });
  }
  const scenes: BridgeScene[] = [];
  if (root.scenes !== undefined) {
    if (!Array.isArray(root.scenes)) return undefined;
    for (const raw of root.scenes) {
      const item = asRecord(raw);
      const id = safeId(item?.id, "identifier");
      const locationId = safeId(item?.locationId, "loc");
      const name = safeName(item?.name);
      const updatedAt = item?.updatedAt === null ? null : validTimestamp(item?.updatedAt);
      if (!id || !locationId || !name || updatedAt === undefined) return undefined;
      scenes.push({ id, locationId, name, updatedAt });
    }
  }
  return {
    schemaVersion: 1,
    sequence: root.sequence as number,
    locations,
    rooms,
    devices,
    scenes
  };
}

function snapshotBody(args: unknown[]): unknown {
  return args[0] === null ? args[1] : args;
}

function snapshotRows(value: unknown): Record<string, unknown>[] | null {
  const record = asRecord(value);
  const rows = record && Array.isArray(record.data) ? record.data : value;
  if (record && record.data !== undefined && !Array.isArray(record.data)) {
    const row = asRecord(record.data);
    return row ? [row] : null;
  }
  if (record && record.data === undefined) {
    return [record];
  }
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

function controlFromSwatch(row: Record<string, unknown>): BridgeDeviceControl | null {
  const rawType = readString(row.type);
  const type = rawType ? rawType.toLowerCase() : null;
  if (!isControlKind(type)) return null;
  const nested = asRecord(row[type]);
  return controlFromParts({
    id: nested?.swatchId,
    kind: type,
    label: nested?.label ?? nested?.name,
    component: nested?.componentId,
    capability: nested?.capabilityId,
    attribute: nested?.attributeName,
    command: nested?.command,
    commands: nested?.commands ?? nested?.supportedCommands ?? toggleCommands(nested),
    options: nested?.options ?? nested?.values ?? nested?.supportedValues,
    min: nested?.min ?? nested?.minimum ?? nested?.minValue,
    max: nested?.max ?? nested?.maximum ?? nested?.maxValue,
    step: nested?.step ?? nested?.interval ?? nested?.increment
  });
}

function controlFromParts(input: Record<string, unknown> | undefined): BridgeDeviceControl | null {
  if (!input) return null;
  const kind = readString(input.kind);
  const swatchId = safeToken(readString(input.id)) ? readString(input.id) : null;
  const component = readString(input.component);
  const capability = readString(input.capability);
  const attribute = readString(input.attribute);
  const label = safeName(input.label);
  if (
    !isControlKind(kind) ||
    !safeToken(component) ||
    !safeToken(capability) ||
    !safeToken(attribute) ||
    !label
  ) {
    return null;
  }
  const command = safeToken(readString(input.command)) ? readString(input.command) : undefined;
  const commands = tokenList(input.commands);
  const options = displayStringList(input.options);
  const min = finiteNumber(input.min);
  const max = finiteNumber(input.max);
  const step = finiteNumber(input.step);
  const id = swatchId ?? `${kind}:${component}:${capability}:${attribute}`;
  return {
    id,
    kind,
    label,
    component,
    capability,
    attribute,
    ...(command ? { command } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {})
  };
}

function isControlKind(value: string | null): value is BridgeDeviceControl["kind"] {
  return (
    value === "button" ||
    value === "color" ||
    value === "enumerated" ||
    value === "slider" ||
    value === "toggle" ||
    value === "value"
  );
}

function tokenList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text =
      typeof item === "string"
        ? item
        : readString(asRecord(item)?.value ?? asRecord(item)?.id ?? asRecord(item)?.name);
    if (safeToken(text) && !result.includes(text)) result.push(text);
  }
  return result;
}

function displayStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const text =
      typeof item === "string"
        ? item
        : readString(record?.label ?? record?.name ?? record?.value ?? record?.id);
    const display = safeDisplayString(text);
    if (display && !result.includes(display)) result.push(display);
  }
  return result;
}

function toggleCommands(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  return [
    readString(asRecord(value.onState)?.command),
    readString(asRecord(value.offState)?.command)
  ].filter((item): item is string => safeToken(item));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && !Number.isNaN(value)
    ? value
    : undefined;
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

function safeDisplayString(value: string | null): string | null {
  const text = value?.trim();
  if (!text || text.length > 255) return null;
  if (text.includes("[REDACTED]") || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  if (/\b(?:https?|wss?):\/\//iu.test(text)) return null;
  return text;
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
  return text && /(?:Z|[+-]\d{2}:\d{2})$/u.test(text) && Number.isFinite(Date.parse(text))
    ? text
    : null;
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
