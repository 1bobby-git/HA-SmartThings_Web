import type { SanitizedCaptureRecord } from "./capture-store.js";
import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";
import {
  EventDeduplicator,
  extractDeviceEventIdentity
} from "../inspector/event-deduplicator.js";
import type {
  AdvancedCommandDescriptor,
  AdvancedCommandOmission
} from "../advanced/command-catalog-types.js";
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
  componentRole?: string;
  capabilityRole?: string;
  source?: BridgeStateSource;
}

export type BridgeStateSource =
  | "ADVANCED_SNAPSHOT"
  | "LOCATION_EVENT"
  | "COMMAND_STATUS_RECHECK"
  | "DOM_FALLBACK";

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
  optionLabels?: Record<string, string>;
  optionCommands?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
  transport?: "location_native" | "advanced";
}

export interface BridgeDevicePresentation {
  assetType?: string;
  iconUrl?: string;
  inactiveIconUrl?: string;
  animationUrl?: string;
}

export interface BridgeAdvancedDeviceMetadata {
  ownerId?: string;
  profileId?: string;
  presentationId?: string;
  parentDeviceId?: string;
  childDeviceIds?: string[];
  hubId?: string;
  driverId?: string;
  executionContext?: string;
  restricted?: boolean;
  group?: boolean;
  preferenceKeys?: string[];
}

export interface BridgeDevice {
  id: string;
  locationId: string;
  roomId: string | null;
  name: string;
  type: string | null;
  online: boolean;
  healthUpdatedAt?: string | null;
  presentation?: BridgeDevicePresentation;
  states: BridgeDeviceState[];
  controls?: BridgeDeviceControl[];
  advancedCommands?: AdvancedCommandDescriptor[];
  commandOmissions?: AdvancedCommandOmission[];
  advanced?: BridgeAdvancedDeviceMetadata;
}

export interface BridgeScene {
  id: string;
  locationId: string;
  name: string;
  updatedAt: string | null;
  expectedStates?: BridgeSceneExpectedState[];
}

export interface BridgeSceneExpectedState {
  deviceId: string;
  component: string;
  capability: string;
  attribute: string;
  value: BridgeJsonValue;
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
      eventId?: string;
      eventTime?: string;
      commandId?: string;
    };

type Listener = (event: BridgeDeviceStoreEvent) => void;
type StateTokenNormalizer = (value: string) => string;
type IdentifierRoleResolver = (alias: string) => string | undefined;
type AdvancedAliasKind = "device" | "location" | "identifier";
type AdvancedAliasNormalizer = (kind: AdvancedAliasKind, value: string) => string;
type AdvancedDeviceSnapshotOptions = {
  authoritativeWholeSnapshot?: boolean;
  source?: BridgeStateSource;
};
type AdvancedInventorySnapshotBody = {
  locations?: unknown;
  rooms?: unknown;
  devices?: unknown;
};
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
  healthUpdatedAt: string | null;
  presentation?: BridgeDevicePresentation;
  states: Map<string, BridgeDeviceState>;
  controls: Map<string, BridgeDeviceControl>;
  advancedCommands: AdvancedCommandDescriptor[];
  commandOmissions: AdvancedCommandOmission[];
  capabilityVersions: Map<string, number>;
  componentRoles: Map<string, string>;
  advanced?: BridgeAdvancedDeviceMetadata;
}

export interface BridgeCapabilityBinding {
  component: string;
  componentRole?: string;
  capability: string;
  version: number;
}

interface ComponentChildMapping {
  component: string;
  childDeviceId: string;
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
const INVENTORY_PERSIST_COALESCE_MS = 25;
const INVENTORY_PERSIST_RETRY_MS = 250;
const CAMERA_IMAGE_ATTRIBUTES = new Set([
  "captureTime",
  "clip",
  "image",
  "imageTransferProgress",
  "stream"
]);

export class DeviceStore {
  readonly #locations = new Map<string, BridgeLocation>();
  readonly #rooms = new Map<string, BridgeRoom>();
  readonly #devices = new Map<string, MutableDevice>();
  readonly #scenes = new Map<string, BridgeScene>();
  readonly #pending = new Map<string, PendingSnapshot>();
  readonly #listeners = new Set<Listener>();
  readonly #eventDeduplicator = new EventDeduplicator({
    ttlMs: 5 * 60_000,
    maxEntries: 100_000
  });
  readonly #componentChildMappings = new Map<string, Map<string, string>>();
  readonly #normalizeStateToken: StateTokenNormalizer;
  readonly #normalizeAdvancedAlias: AdvancedAliasNormalizer;
  readonly #identifierRole: IdentifierRoleResolver;
  readonly #db: DatabaseSync | undefined;
  readonly #onPersistenceError: (() => void) | undefined;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #persistPending = false;
  #sequence = 0;
  #sessionPendingDeviceIds: Set<string> | undefined;
  #sessionConsumerDeviceSnapshotSeen = false;
  #sessionWholeAdvancedDeviceSnapshotSeen = false;

  constructor(options: {
    normalizeStateToken?: StateTokenNormalizer;
    normalizeAdvancedAlias?: AdvancedAliasNormalizer;
    identifierRole?: IdentifierRoleResolver;
    sqlitePath?: string;
    onPersistenceError?: () => void;
  } = {}) {
    this.#normalizeStateToken = options.normalizeStateToken ?? ((value) => value);
    this.#normalizeAdvancedAlias = options.normalizeAdvancedAlias ?? ((_kind, value) => value);
    this.#identifierRole = options.identifierRole ?? (() => undefined);
    this.#onPersistenceError = options.onPersistenceError;
    if (options.sqlitePath) {
      mkdirSync(dirname(options.sqlitePath), { recursive: true, mode: 0o700 });
      this.#db = new DatabaseSync(options.sqlitePath);
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS normalized_inventory (
          schema_version INTEGER PRIMARY KEY,
          inventory_json TEXT NOT NULL,
          persisted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS component_child_mappings (
          parent_device_id TEXT PRIMARY KEY,
          mapping_json TEXT NOT NULL,
          persisted_at TEXT NOT NULL
        )
      `);
      this.#loadComponentChildMappings();
      const restored = this.#loadPersistedInventory();
      if (restored) {
        const livenessReconciled = this.#restore(restored);
        // Devices restored from a previous session start as unconfirmed. Keep
        // them through login/reconnect gaps and remove only entries missing
        // from the next complete consumer device snapshot. Partial location,
        // room, scene, and Advanced responses are not authoritative inventory.
        this.#sessionPendingDeviceIds = new Set(restored.devices.map((d) => d.id));
        if (livenessReconciled) this.#schedulePersist();
      }
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
        this.#pending.set(pendingKey(frame.connectionKey, decoded.ackId), { query: "api/device/details" });
      } else if (decoded.ackId !== undefined && decoded.eventName === "get" && query === "api/location") {
        this.#pending.set(pendingKey(frame.connectionKey, decoded.ackId), { query: "api/location" });
      } else if (
          decoded.eventName === "find" &&
          decoded.ackId !== undefined &&
          typeof query === "string" &&
          SNAPSHOT_QUERIES.has(query as SnapshotQuery)
        ) {
        this.#pending.set(pendingKey(frame.connectionKey, decoded.ackId), { query: query as SnapshotQuery });
      }
      return;
    }
    if (frame.direction !== "received") {
      return;
    }
    if (decoded.kind === "ack" && decoded.ackId !== undefined) {
      const key = pendingKey(frame.connectionKey, decoded.ackId);
      const pending = this.#pending.get(key);
      if (!pending) {
        return;
      }
      this.#pending.delete(key);
      const body = snapshotBody(decoded.args);
      const authoritativeDeviceSnapshot =
        pending.query === "api/device" && isCompleteDeviceSnapshot(body);
      const changed = this.#applySnapshot(pending.query, body);
      if (authoritativeDeviceSnapshot) {
        this.#sessionConsumerDeviceSnapshotSeen = true;
        this.#observeConsumerDeviceSnapshotPresence(body);
      }
      const pruned = this.#pruneUnrefreshedDevicesIfReady();
      if (changed || pruned) {
        const sequence = this.#nextSequence();
        this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
        this.#schedulePersist();
      }
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription DEVICE_EVENT") {
      const identity = extractDeviceEventIdentity(decoded.args[0]);
      if (identity && this.#eventDeduplicator.observe(identity).duplicate) {
        return;
      }
      this.#applyDeviceEvent(decoded.args[0]);
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription DEVICE_HEALTH_EVENT") {
      this.#applyDeviceHealthEvent(decoded.args[0]);
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription SECURITY_ARM_STATE_EVENT") {
      this.#applySecurityArmStateEvent(decoded.args[0]);
      return;
    }
    if (decoded.kind === "event" && decoded.eventName === "api/subscription SCENE_LIFECYCLE_EVENT") {
      const sequence = this.#nextSequence();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
      this.#schedulePersist();
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
        ...(device.healthUpdatedAt ? { healthUpdatedAt: device.healthUpdatedAt } : {}),
        ...(device.presentation ? { presentation: { ...device.presentation } } : {}),
        ...(device.advanced ? { advanced: cloneAdvancedMetadata(device.advanced) } : {}),
        states: snapshotDeviceStates(device).sort(byState).map(cloneState),
        ...(device.controls.size > 0
          ? { controls: [...device.controls.values()].sort(byId).map(cloneControl) }
          : {}),
        ...(device.advancedCommands.length > 0
          ? { advancedCommands: device.advancedCommands.map(cloneAdvancedCommandDescriptor) }
          : {}),
        ...(device.advancedCommands.length > 0 || device.commandOmissions.length > 0
          ? { commandOmissions: device.commandOmissions.map(cloneAdvancedCommandOmission) }
          : {})
      })),
      scenes: [...this.#scenes.values()].sort(byId).map(cloneScene)
    };
  }

  currentSequence(): number {
    return this.#sequence;
  }

  capabilityVersion(
    deviceId: string,
    component: string,
    capability: string
  ): number | undefined {
    return this.#devices
      .get(deviceId)
      ?.capabilityVersions.get(`${component}\u0000${capability}`);
  }

  capabilityBindings(deviceId: string): BridgeCapabilityBinding[] {
    const device = this.#devices.get(deviceId);
    if (!device) return [];
    return [...device.capabilityVersions.entries()]
      .map(([key, version]) => {
        const [component, capability] = key.split("\u0000");
        if (!component || !capability) return undefined;
        const componentRole = device.componentRoles.get(component);
        return {
          component,
          ...(componentRole ? { componentRole } : {}),
          capability,
          version
        };
      })
      .filter((binding): binding is BridgeCapabilityBinding => binding !== undefined)
      .sort((left, right) =>
        [
          left.component.localeCompare(right.component),
          left.capability.localeCompare(right.capability),
          left.version - right.version
        ].find((result) => result !== 0) ?? 0
      )
      .map((binding) => ({ ...binding }));
  }

  componentChildMappings(parentDeviceId: string): ReadonlyMap<string, string> | undefined {
    const mappings = this.#componentChildMappings.get(parentDeviceId);
    return mappings ? new Map(mappings) : undefined;
  }

  rememberComponentChildMappings(
    parentDeviceId: string,
    mappings: readonly ComponentChildMapping[]
  ): void {
    const normalized = normalizedComponentChildMappings(parentDeviceId, mappings);
    if (!normalized) return;
    const next = new Map(normalized.map((entry) => [entry.component, entry.childDeviceId]));
    const current = this.#componentChildMappings.get(parentDeviceId);
    if (
      current &&
      JSON.stringify([...current.entries()]) === JSON.stringify([...next.entries()])
    ) {
      return;
    }
    this.#componentChildMappings.set(parentDeviceId, next);
    if (!this.#db) return;
    try {
      this.#db
        .prepare(`
          INSERT INTO component_child_mappings (
            parent_device_id,
            mapping_json,
            persisted_at
          ) VALUES (?, ?, ?)
          ON CONFLICT(parent_device_id) DO UPDATE SET
            mapping_json = excluded.mapping_json,
            persisted_at = excluded.persisted_at
        `)
        .run(parentDeviceId, JSON.stringify(normalized), new Date().toISOString());
    } catch {
      this.#onPersistenceError?.();
    }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  observeOnlineEvidence(deviceId: string, observedAtMs: number): void {
    const device = this.#devices.get(deviceId);
    if (!device || !Number.isFinite(observedAtMs)) return;
    const updatedAt = new Date(observedAtMs).toISOString();
    const wasOnline = device.online;
    if (!this.#setDeviceHealth(device, true, updatedAt)) return;
    if (!wasOnline) {
      const sequence = this.#nextSequence();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
    }
    this.#schedulePersist();
  }

  reset(): void {
    this.#pending.clear();
    this.resetSnapshotSession();
  }

  resetSnapshotSession(): void {
    this.#sessionConsumerDeviceSnapshotSeen = false;
    this.#sessionWholeAdvancedDeviceSnapshotSeen = false;
  }

  observeAdvancedDeviceSnapshot(body: unknown, options: AdvancedDeviceSnapshotOptions = {}): void {
    const authoritativeWholeSnapshot = options.authoritativeWholeSnapshot === true;
    const changed = this.#applyAdvancedDeviceSnapshot(
      body,
      authoritativeWholeSnapshot,
      options.source ?? "ADVANCED_SNAPSHOT"
    );
    if (authoritativeWholeSnapshot && advancedDeviceRows(body)) {
      this.#sessionWholeAdvancedDeviceSnapshotSeen = true;
    }
    const pruned = this.#pruneUnrefreshedDevicesIfReady();
    if (changed || pruned) {
      const sequence = this.#nextSequence();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
      this.#schedulePersist();
    }
  }

  observeAdvancedInventorySnapshot(
    body: AdvancedInventorySnapshotBody,
    options: AdvancedDeviceSnapshotOptions = {}
  ): void {
    const authoritativeWholeSnapshot = options.authoritativeWholeSnapshot === true;
    let changed = this.#applyAdvancedLocations(body.locations);
    changed = this.#applyAdvancedRooms(body.rooms) || changed;
    changed =
      this.#applyAdvancedDeviceSnapshot(
        body.devices,
        authoritativeWholeSnapshot,
        options.source ?? "ADVANCED_SNAPSHOT"
      ) || changed;
    if (authoritativeWholeSnapshot && advancedDeviceRows(body.devices)) {
      this.#sessionWholeAdvancedDeviceSnapshotSeen = true;
    }
    const pruned = this.#pruneUnrefreshedDevicesIfReady();
    if (changed || pruned) {
      const sequence = this.#nextSequence();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
      this.#schedulePersist();
    }
  }

  observeAdvancedCommandCatalog(
    deviceId: string,
    commands: readonly AdvancedCommandDescriptor[],
    omissions: readonly AdvancedCommandOmission[]
  ): void {
    const device = this.#devices.get(deviceId);
    if (!device) return;
    const parsedCommands = parseAdvancedCommandDescriptors(commands);
    const parsedOmissions = parseAdvancedCommandOmissions(omissions);
    if (!parsedCommands || !parsedOmissions) return;
    const nextControls = new Map(
      [...device.controls.entries()].filter(([id]) => !id.startsWith("advanced:"))
    );
    const projected = projectedAdvancedSwitchControls(device, parsedCommands);
    for (const control of projected) nextControls.set(control.id, control);
    if (
      JSON.stringify(device.advancedCommands) === JSON.stringify(parsedCommands) &&
      JSON.stringify(device.commandOmissions) === JSON.stringify(parsedOmissions) &&
      JSON.stringify([...device.controls.entries()]) === JSON.stringify([...nextControls.entries()])
    ) {
      return;
    }
    device.advancedCommands = parsedCommands.map(cloneAdvancedCommandDescriptor);
    device.commandOmissions = parsedOmissions.map(cloneAdvancedCommandOmission);
    device.controls = nextControls;
    const sequence = this.#nextSequence();
    this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
    this.#schedulePersist();
  }

  close(): void {
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
    }
    try {
      this.#flushPersist();
    } catch {
      // Shutdown durability is best-effort when SQLite remains locked; never mask a graceful stop.
      this.#onPersistenceError?.();
    } finally {
      this.#db?.close();
    }
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
        const expectedStates = sceneExpectedStates(row.actions, this.#normalizeStateToken);
        changed =
          setIfChanged(this.#scenes, id, {
            id,
            locationId,
            name,
            updatedAt: validTimestamp(row.updatedAt ?? row.updated_at ?? row.timestamp ?? row.dateUpdated ?? meta?.dateUpdated),
            ...(expectedStates.length > 0 ? { expectedStates: expectedStates.map(cloneSceneExpectedState) } : {})
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
        const presentation = devicePresentation(source);
        const rawType = safeName(typeData?.type);
        const nextType =
          rawType?.toUpperCase() === "NONE" && presentation?.assetType
            ? presentation.assetType
            : rawType;
        if (
          device.name !== nextName ||
          device.roomId !== nextRoomId ||
          device.type !== nextType ||
          JSON.stringify(device.presentation) !== JSON.stringify(presentation)
        ) {
          device.name = nextName;
          device.roomId = nextRoomId;
          device.type = nextType;
          if (presentation) {
            device.presentation = presentation;
          } else {
            delete device.presentation;
          }
          changed = true;
        }
        for (const control of actionControls(source.actions ?? source.action)) {
          changed = setActionControlIfChanged(device.controls, control) || changed;
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
        if (control.kind === "value") {
          const detailState = stateFromParts({
            component: control.component,
            capability: control.capability,
            attribute: control.attribute,
            value: nested?.value ?? nested?.currentValue ?? nested?.displayValue,
            unit: nested?.unit,
            updatedAt: nested?.updatedAt ?? nested?.timestamp
          }, this.#identifierRole);
          if (detailState) changed = this.#setState(device, detailState) || changed;
        }
      }
      return changed;
    }
    if (query === "api/device/status") {
      for (const row of rows) {
        const state = stateFromSnapshot(row, this.#identifierRole);
        const deviceId = safeId(row.deviceId, "dev");
        const locationId = safeId(row.locationId, "loc");
        const controls = actionControls(row.actions ?? row.action);
        if ((!state && controls.length === 0) || !deviceId || !locationId) continue;
        const device = this.#ensureDevice(deviceId, locationId);
        if (state) changed = this.#setState(device, state) || changed;
        for (const control of controls) {
          changed = setActionControlIfChanged(device.controls, control) || changed;
        }
      }
      return changed;
    }
    for (const row of rows) {
      const deviceId = safeId(row.deviceId, "dev");
      const locationId = safeId(row.locationId, "loc");
      const online = healthOnlineState(row.state ?? row.status);
      if (!deviceId || !locationId || online === undefined) continue;
      const device = this.#ensureDevice(deviceId, locationId);
      changed = this.#setDeviceHealth(
        device,
        online,
        validTimestamp(
          row.updatedAt ??
            row.updated_at ??
            row.lastUpdatedDate ??
            row.last_updated_date ??
            row.timestamp ??
            row.eventTime ??
            row.event_time
        )
      ) || changed;
    }
    return changed;
  }

  #applyAdvancedDeviceSnapshot(
    body: unknown,
    observeRestoredPresence = false,
    source: BridgeStateSource = "ADVANCED_SNAPSHOT"
  ): boolean {
    const rows = advancedDeviceRows(body);
    if (!rows) {
      return false;
    }
    let changed = false;
    for (const row of rows) {
      const id = normalizedAdvancedId(
        row.deviceId ?? row.device_id ?? row.id,
        "device",
        this.#normalizeAdvancedAlias
      );
      const locationId = normalizedAdvancedId(
        row.locationId ?? row.location_id,
        "location",
        this.#normalizeAdvancedAlias
      );
      if (!id || !locationId) continue;
      if (observeRestoredPresence) this.#confirmRestoredDevice(id);
      const device = this.#ensureDevice(id, locationId);
      const observedAdvanced = advancedDeviceMetadata(row, this.#normalizeAdvancedAlias);
      const advanced = observeRestoredPresence
        ? observedAdvanced
        : observedAdvanced
          ? { ...device.advanced, ...observedAdvanced }
          : device.advanced;
      if (JSON.stringify(device.advanced) !== JSON.stringify(advanced)) {
        if (advanced) device.advanced = advanced;
        else delete device.advanced;
        changed = true;
      }
      const hasExplicitComponents = Array.isArray(row.components);
      const observedCapabilityVersions = advancedCapabilityVersions(
        row.components,
        this.#normalizeAdvancedAlias
      );
      const observedComponentRoles = advancedComponentRoles(
        row.components,
        this.#normalizeAdvancedAlias
      );
      if (observeRestoredPresence && hasExplicitComponents) {
        if (!mapsEqual(device.capabilityVersions, observedCapabilityVersions)) {
          device.capabilityVersions = observedCapabilityVersions;
          changed = true;
        }
        if (!mapsEqual(device.componentRoles, observedComponentRoles)) {
          device.componentRoles = observedComponentRoles;
          changed = true;
        }
      } else {
        for (const [key, version] of observedCapabilityVersions) {
          device.capabilityVersions.set(key, version);
        }
        for (const [component, role] of observedComponentRoles) {
          device.componentRoles.set(component, role);
        }
      }
      const nextName = safeName(
        row.label ?? row.name ?? row.deviceLabel ?? row.deviceName
      ) ?? device.name;
      const hasRoom =
        Object.prototype.hasOwnProperty.call(row, "roomId") ||
        Object.prototype.hasOwnProperty.call(row, "room_id");
      const nextRoomId = hasRoom
        ? normalizedAdvancedId(
            row.roomId ?? row.room_id,
            "identifier",
            this.#normalizeAdvancedAlias
          )
        : device.roomId;
      const nextType =
        safeName(row.deviceTypeName ?? row.deviceType ?? row.type ?? row.deviceTypeId) ??
        device.type;
      const presentation = advancedDevicePresentation(row) ?? device.presentation;
      if (
        device.name !== nextName ||
        device.roomId !== nextRoomId ||
        device.type !== nextType ||
        JSON.stringify(device.presentation) !== JSON.stringify(presentation)
      ) {
        device.name = nextName;
        device.roomId = nextRoomId;
        device.type = nextType;
        if (presentation) {
          device.presentation = presentation;
        }
        changed = true;
      }
      const online = advancedOnlineState(row);
      const healthUpdatedAt = advancedHealthUpdatedAt(row);
      if (online !== undefined && (online || healthUpdatedAt !== null)) {
        changed = this.#setDeviceHealth(device, online, healthUpdatedAt) || changed;
      }
      for (const state of advancedDeviceStates(
        row,
        this.#identifierRole,
        this.#normalizeStateToken,
        this.#normalizeAdvancedAlias,
        source
      )) {
        changed = this.#mergeStateRoles(device, state) || changed;
        changed = this.#setState(device, state) || changed;
      }
      for (const control of advancedDeviceControls(
        row.components,
        this.#identifierRole,
        this.#normalizeAdvancedAlias
      )) {
        changed = setIfChanged(device.controls, control.id, control) || changed;
      }
    }
    return changed;
  }

  #applyAdvancedLocations(body: unknown): boolean {
    const rows = recordRows(body);
    if (!rows) return false;
    let changed = false;
    for (const row of rows) {
      const id = normalizedAdvancedId(
        row.locationId ?? row.location_id ?? row.id,
        "location",
        this.#normalizeAdvancedAlias
      );
      const name = safeName(row.name ?? row.locationName ?? row.label);
      if (!id || !name) continue;
      changed = setIfChanged(this.#locations, id, { id, name }) || changed;
    }
    return changed;
  }

  #applyAdvancedRooms(body: unknown): boolean {
    const rows = recordRows(body);
    if (!rows) return false;
    let changed = false;
    for (const row of rows) {
      const id = normalizedAdvancedId(
        row.roomId ?? row.room_id ?? row.id,
        "identifier",
        this.#normalizeAdvancedAlias
      );
      const locationId = normalizedAdvancedId(
        row.locationId ?? row.location_id,
        "location",
        this.#normalizeAdvancedAlias
      );
      const name = safeName(row.name ?? row.roomName ?? row.label);
      if (!id || !locationId || !name) continue;
      changed = setIfChanged(this.#rooms, id, { id, locationId, name }) || changed;
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
    const state = stateFromEvent(
      event,
      data,
      device,
      this.#normalizeStateToken,
      this.#identifierRole
    );
    if (!state) {
      return;
    }
    const stateChanged = this.#setState(device, state);
    if (!stateChanged) {
      return;
    }
    const wasOnline = device.online;
    this.#setDeviceHealth(device, true, state.updatedAt);
    if (!wasOnline) {
      const sequence = this.#nextSequence();
      this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
    }
    const sequence = this.#nextSequence();
    const eventId = safeEventMetadata(event.event_id ?? event.eventId ?? data.event_id ?? data.eventId);
    const commandId = safeEventMetadata(
      event.command_id ?? event.commandId ?? data.command_id ?? data.commandId
    );
    this.#publish({
      schemaVersion: 1,
      sequence,
      type: "state",
      deviceId,
      state: cloneState(state),
      ...(eventId ? { eventId } : {}),
      ...(state.updatedAt ? { eventTime: state.updatedAt } : {}),
      ...(commandId ? { commandId } : {})
    });
    this.#schedulePersist();
  }

  #applyDeviceHealthEvent(input: unknown): void {
    const envelope = asRecord(input);
    const data = asRecord(envelope?.data);
    const event = asRecord(data?.deviceHealthEvent ?? data?.device_health_event);
    const deviceId = safeId(event?.device_id ?? event?.deviceId, "dev");
    const locationId = safeId(event?.location_id ?? event?.locationId, "loc");
    const online = healthOnlineState(event?.status ?? event?.state);
    const updatedAt = validTimestamp(
      event?.event_time ?? event?.eventTime ?? event?.updatedAt ?? data?.event_time ?? data?.eventTime
    );
    if (!deviceId || online === undefined || !updatedAt) {
      return;
    }
    const current = this.#devices.get(deviceId);
    if (!current && !locationId) {
      return;
    }
    const device = current ?? this.#ensureDevice(deviceId, locationId as string);
    if (!this.#setDeviceHealth(device, online, updatedAt)) {
      return;
    }
    const sequence = this.#nextSequence();
    this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
    this.#schedulePersist();
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
    this.#publish({ schemaVersion: 1, sequence, type: "inventory" });
    this.#schedulePersist();
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
      healthUpdatedAt: null,
      states: new Map(),
      controls: new Map(),
      advancedCommands: [],
      commandOmissions: [],
      capabilityVersions: new Map(),
      componentRoles: new Map()
    };
    this.#devices.set(id, created);
    return created;
  }

  #setDeviceHealth(device: MutableDevice, online: boolean, updatedAt: string | null): boolean {
    if (isOlderOrUndated(updatedAt, device.healthUpdatedAt)) {
      return false;
    }
    if (device.online === online && device.healthUpdatedAt === updatedAt) {
      return false;
    }
    device.healthUpdatedAt = updatedAt;
    device.online = online;
    return true;
  }

  #setState(device: MutableDevice, state: BridgeDeviceState): boolean {
    const key = stateKey(state);
    const current = device.states.get(key);
    const momentaryEvent = state.attribute === "button";
    if (
      current &&
      (momentaryEvent
        ? isStrictlyOlderOrUndated(state.updatedAt, current.updatedAt)
        : isOlderOrUndated(state.updatedAt, current.updatedAt))
    ) {
      return false;
    }
    if (current && !momentaryEvent && JSON.stringify(current) === JSON.stringify(state)) {
      return false;
    }
    device.states.set(key, cloneState(state));
    return true;
  }

  #mergeStateRoles(device: MutableDevice, state: BridgeDeviceState): boolean {
    const key = stateKey(state);
    const current = device.states.get(key);
    if (!current) return false;
    const componentRole = preferredAdvancedRole(current.componentRole, state.componentRole);
    const capabilityRole = current.capabilityRole ?? state.capabilityRole;
    if (
      componentRole === current.componentRole &&
      capabilityRole === current.capabilityRole
    ) {
      return false;
    }
    device.states.set(key, {
      ...current,
      ...(componentRole ? { componentRole } : {}),
      ...(capabilityRole ? { capabilityRole } : {})
    });
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

  #pruneUnrefreshedDevicesIfReady(): boolean {
    const pending = this.#sessionPendingDeviceIds;
    if (pending === undefined) {
      return false;
    }
    if (!this.#sessionConsumerDeviceSnapshotSeen || !this.#sessionWholeAdvancedDeviceSnapshotSeen) {
      return false;
    }
    this.#sessionPendingDeviceIds = undefined;
    if (pending.size === 0) {
      return false;
    }
    for (const id of pending) {
      this.#devices.delete(id);
    }
    return true;
  }

  #observeConsumerDeviceSnapshotPresence(body: unknown): void {
    const rows = snapshotRows(body);
    if (!rows) return;
    for (const card of rows) {
      const source = firstRecord(card.basic, card.cloud, card.camera);
      const id = safeId(source?.deviceId, "dev");
      if (id) {
        this.#confirmRestoredDevice(id);
      }
    }
  }

  #confirmRestoredDevice(id: string): void {
    this.#sessionPendingDeviceIds?.delete(id);
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

  #loadComponentChildMappings(): void {
    if (!this.#db) return;
    try {
      const rows = this.#db
        .prepare(`
          SELECT parent_device_id AS parentDeviceId, mapping_json AS mappingJson
          FROM component_child_mappings
        `)
        .all() as Array<{ parentDeviceId?: unknown; mappingJson?: unknown }>;
      for (const row of rows) {
        if (typeof row.parentDeviceId !== "string" || typeof row.mappingJson !== "string") {
          continue;
        }
        const parsed = normalizedComponentChildMappings(
          row.parentDeviceId,
          JSON.parse(row.mappingJson) as unknown
        );
        if (!parsed) continue;
        this.#componentChildMappings.set(
          row.parentDeviceId,
          new Map(parsed.map((entry) => [entry.component, entry.childDeviceId]))
        );
      }
    } catch {
      this.#onPersistenceError?.();
    }
  }

  #restore(inventory: BridgeInventory): boolean {
    let livenessReconciled = false;
    this.#sequence = inventory.sequence;
    for (const location of inventory.locations) this.#locations.set(location.id, { ...location });
    for (const room of inventory.rooms) this.#rooms.set(room.id, { ...room });
    for (const scene of inventory.scenes) this.#scenes.set(scene.id, cloneScene(scene));
    for (const device of inventory.devices) {
      const restored: MutableDevice = {
        id: device.id,
        locationId: device.locationId,
        roomId: device.roomId,
        name: device.name,
        type: device.type,
        online: device.online,
        healthUpdatedAt: device.healthUpdatedAt ?? null,
        ...(device.presentation ? { presentation: { ...device.presentation } } : {}),
        states: new Map(device.states.map((state) => [stateKey(state), cloneState(state)])),
        controls: new Map((device.controls ?? []).map((control) => [control.id, cloneControl(control)])),
        advancedCommands: (device.advancedCommands ?? []).map(cloneAdvancedCommandDescriptor),
        commandOmissions: (device.commandOmissions ?? []).map(cloneAdvancedCommandOmission),
        capabilityVersions: new Map(),
        componentRoles: new Map(),
        ...(device.advanced ? { advanced: cloneAdvancedMetadata(device.advanced) } : {})
      };
      const positiveEvidenceAt = latestPersistedPositiveEvidenceAt(restored.states.values());
      if (
        !restored.online &&
        positiveEvidenceAt &&
        !isOlderOrUndated(positiveEvidenceAt, restored.healthUpdatedAt)
      ) {
        restored.online = true;
        restored.healthUpdatedAt = positiveEvidenceAt;
        livenessReconciled = true;
      }
      this.#devices.set(device.id, restored);
    }
    return livenessReconciled;
  }

  #schedulePersist(): void {
    if (!this.#db) return;
    this.#persistPending = true;
    this.#armPersistTimer(INVENTORY_PERSIST_COALESCE_MS);
  }

  #armPersistTimer(delayMs: number): void {
    if (!this.#db) return;
    if (this.#persistTimer !== undefined) return;
    // Keep the push-to-SSE path synchronous and coalesce the large durability snapshot behind it.
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      try {
        this.#flushPersist();
      } catch {
        this.#onPersistenceError?.();
        this.#armPersistTimer(INVENTORY_PERSIST_RETRY_MS);
      }
    }, delayMs);
    this.#persistTimer.unref();
  }

  #flushPersist(): void {
    if (!this.#db || !this.#persistPending) return;
    this.#db
      .prepare(`
        INSERT INTO normalized_inventory (schema_version, inventory_json, persisted_at)
        VALUES (1, ?, ?)
        ON CONFLICT(schema_version) DO UPDATE SET
          inventory_json = excluded.inventory_json,
          persisted_at = excluded.persisted_at
      `)
      .run(JSON.stringify(this.snapshot()), new Date().toISOString());
    this.#persistPending = false;
  }
}

function snapshotDeviceStates(device: MutableDevice): BridgeDeviceState[] {
  const states = [...device.states.values()];
  const attributes = new Set(states.map((state) => state.attribute));
  if (cameraImageIdentity(device)) return states;
  if (
    (["clip", "stream"] as const).some((attribute) => attributes.has(attribute)) &&
    (["captureTime", "image"] as const).some((attribute) => attributes.has(attribute))
  ) {
    return states;
  }
  return states.filter((state) => !CAMERA_IMAGE_ATTRIBUTES.has(state.attribute));
}

function cameraImageIdentity(device: MutableDevice): boolean {
  const identity = `${device.name} ${device.type ?? ""} ${device.presentation?.assetType ?? ""}`.toLowerCase();
  return (
    /\b(?:camera|cam|cctv|homecam)\b/u.test(identity) ||
    /(?:보안 카메라|카메라|홈캠)/u.test(identity)
  );
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
    if (
      armState === null ||
      (item?.updatedAt !== undefined && item.updatedAt !== null && updatedAt === null)
    ) {
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
    const healthUpdatedAt =
      item?.healthUpdatedAt === undefined || item.healthUpdatedAt === null
        ? item?.healthUpdatedAt
        : validTimestamp(item.healthUpdatedAt);
    const presentation = devicePresentation(asRecord(item?.presentation));
    const advanced = parseStoredAdvancedMetadata(item?.advanced);
    if (
      !id ||
      !locationId ||
      roomId === undefined ||
      !name ||
      type === undefined ||
      typeof item?.online !== "boolean" ||
      (item?.healthUpdatedAt !== undefined &&
        item.healthUpdatedAt !== null &&
        healthUpdatedAt === null) ||
      !Array.isArray(item.states)
      || advanced === null
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
    const advancedCommands = parseAdvancedCommandDescriptors(item.advancedCommands ?? []);
    const commandOmissions = parseAdvancedCommandOmissions(item.commandOmissions ?? []);
    if (!advancedCommands || !commandOmissions) return undefined;
    devices.push({
      id,
      locationId,
      roomId,
      name,
      type,
      online: item.online,
      ...(item.healthUpdatedAt !== undefined
        ? { healthUpdatedAt: healthUpdatedAt as string | null }
        : {}),
      ...(presentation ? { presentation } : {}),
      ...(advanced ? { advanced } : {}),
      states,
      ...(controls.length > 0 ? { controls } : {}),
      ...(advancedCommands.length > 0 ? { advancedCommands } : {}),
      ...(advancedCommands.length > 0 || commandOmissions.length > 0
        ? { commandOmissions }
        : {})
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
      const expectedStates = parseStoredSceneExpectedStates(item?.expectedStates);
      if (!id || !locationId || !name || updatedAt === undefined) return undefined;
      scenes.push({
        id,
        locationId,
        name,
        updatedAt,
        ...(expectedStates.length > 0 ? { expectedStates } : {})
      });
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

function isCompleteDeviceSnapshot(value: unknown): boolean {
  const rows = snapshotRows(value);
  if (!rows) return false;
  return rows.every((card) => {
    const source = firstRecord(card.basic, card.cloud, card.camera);
    return Boolean(
      source && safeId(source.deviceId, "dev") && safeId(source.locationId, "loc")
    );
  });
}

function advancedDeviceRows(value: unknown): Record<string, unknown>[] | null {
  const record = asRecord(value);
  const rows =
    record && Array.isArray(record.items)
      ? record.items
      : record && Array.isArray(record.devices)
        ? record.devices
        : record && Array.isArray(record.data)
          ? record.data
          : value;
  if (!Array.isArray(rows)) return null;
  const records = rows.map(asRecord);
  return records.some((item) => !item) ? null : (records as Record<string, unknown>[]);
}

function recordRows(value: unknown): Record<string, unknown>[] | null {
  return advancedDeviceRows(value);
}

function advancedDeviceStates(
  row: Record<string, unknown>,
  identifierRole: IdentifierRoleResolver,
  normalizeStateToken: StateTokenNormalizer,
  normalizeAdvancedAlias: AdvancedAliasNormalizer,
  source: BridgeStateSource
): BridgeDeviceState[] {
  const status = asRecord(row.status);
  const componentRoles = advancedComponentRoles(row.components, normalizeAdvancedAlias);
  const components = asRecord(status?.components);
  if (!components) {
    return advancedArrayDeviceStates(
      row.components,
      identifierRole,
      normalizeAdvancedAlias,
      source
    );
  }
  const result: BridgeDeviceState[] = [];
  for (const [rawComponent, capabilitiesValue] of Object.entries(components)) {
    const component = normalizeToken(rawComponent, normalizeStateToken);
    if (!component) continue;
    const componentRole = componentRoles.get(component) ?? identifierRole(rawComponent);
    const capabilities = asRecord(capabilitiesValue);
    if (!capabilities) continue;
    for (const [rawCapability, attributesValue] of Object.entries(capabilities)) {
      const capabilityRole = identifierRole(rawCapability);
      const capability = normalizeToken(rawCapability, normalizeStateToken);
      if (!capability) continue;
      const attributes = asRecord(attributesValue);
      if (!attributes) continue;
      for (const [attribute, stateValue] of Object.entries(attributes)) {
        if (!safeToken(attribute)) continue;
        const stateRecord = asRecord(stateValue);
        if (!stateRecord || !Object.prototype.hasOwnProperty.call(stateRecord, "value")) {
          continue;
        }
        const state = stateFromParts({
          component,
          capability,
          attribute,
          value: stateRecord.value,
          unit: stateRecord.unit,
          updatedAt: stateRecord.timestamp ?? stateRecord.updatedAt,
          componentRole,
          capabilityRole,
          source
        }, identifierRole);
        if (state) result.push(state);
      }
    }
  }
  return result;
}

function advancedComponentRoles(
  value: unknown,
  normalizeAdvancedAlias: AdvancedAliasNormalizer
): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(value)) return result;
  for (const componentValue of value) {
    const componentRow = asRecord(componentValue);
    if (!componentRow) continue;
    const component = normalizedAdvancedId(
      componentRow.id ?? componentRow.componentId,
      "identifier",
      normalizeAdvancedAlias
    );
    const role = advancedComponentRole(componentRow);
    if (component && role) result.set(component, role);
  }
  return result;
}

function advancedArrayDeviceStates(
  value: unknown,
  identifierRole: IdentifierRoleResolver,
  normalizeAdvancedAlias: AdvancedAliasNormalizer,
  source: BridgeStateSource
): BridgeDeviceState[] {
  if (!Array.isArray(value)) return [];
  const result: BridgeDeviceState[] = [];
  for (const componentValue of value) {
    const componentRow = asRecord(componentValue);
    if (!componentRow) continue;
    const component = normalizedAdvancedId(
      componentRow.id ?? componentRow.componentId,
      "identifier",
      normalizeAdvancedAlias
    );
    if (!component) continue;
    const componentRole = advancedComponentRole(componentRow) ?? identifierRole(component);
    if (!Array.isArray(componentRow.capabilities)) continue;
    for (const capabilityValue of componentRow.capabilities) {
      const capabilityRow = asRecord(capabilityValue);
      if (!capabilityRow) continue;
      const capability = normalizedAdvancedId(
        capabilityRow.id ?? capabilityRow.capabilityId,
        "identifier",
        normalizeAdvancedAlias
      );
      const attributes = asRecord(capabilityRow.status);
      if (!capability || !attributes) continue;
      const capabilityRole = identifierRole(capability);
      for (const [attribute, stateValue] of Object.entries(attributes)) {
        if (!safeToken(attribute)) continue;
        const stateRecord = asRecord(stateValue);
        if (!stateRecord || !Object.prototype.hasOwnProperty.call(stateRecord, "value")) {
          continue;
        }
        const state = stateFromParts({
          component,
          capability,
          attribute,
          value: stateRecord.value,
          unit: stateRecord.unit,
          updatedAt: stateRecord.timestamp ?? stateRecord.updatedAt,
          componentRole,
          capabilityRole,
          source
        }, identifierRole);
        if (state) result.push(state);
      }
    }
  }
  return result;
}

function advancedDeviceControls(
  value: unknown,
  identifierRole: IdentifierRoleResolver,
  normalizeAdvancedAlias: AdvancedAliasNormalizer
): BridgeDeviceControl[] {
  if (!Array.isArray(value)) return [];
  const result: BridgeDeviceControl[] = [];
  for (const componentValue of value) {
    const componentRow = asRecord(componentValue);
    if (!componentRow) continue;
    const component = normalizedAdvancedId(
      componentRow.id ?? componentRow.componentId,
      "identifier",
      normalizeAdvancedAlias
    );
    if (!component || !Array.isArray(componentRow.capabilities)) continue;
    for (const capabilityValue of componentRow.capabilities) {
      const capabilityRow = asRecord(capabilityValue);
      if (!capabilityRow) continue;
      const capability = normalizedAdvancedId(
        capabilityRow.id ?? capabilityRow.capabilityId,
        "identifier",
        normalizeAdvancedAlias
      );
      if (!capability || identifierRole(capability) !== "refresh") continue;
      const control = controlFromParts({
        id: `advanced:refresh:${component}:${capability}`,
        kind: "button",
        label: "Refresh",
        component,
        capability,
        attribute: "refresh",
        command: "refresh",
        commands: ["refresh"]
      });
      if (control) result.push(control);
    }
  }
  return result;
}

function advancedCapabilityVersions(
  value: unknown,
  normalizeAdvancedAlias: AdvancedAliasNormalizer
): Map<string, number> {
  const result = new Map<string, number>();
  if (!Array.isArray(value)) return result;
  for (const componentValue of value) {
    const componentRow = asRecord(componentValue);
    const component = normalizedAdvancedId(
      componentRow?.id ?? componentRow?.componentId,
      "identifier",
      normalizeAdvancedAlias
    );
    if (!component || !Array.isArray(componentRow?.capabilities)) continue;
    for (const capabilityValue of componentRow.capabilities) {
      const capabilityRow = asRecord(capabilityValue);
      const capability = normalizedAdvancedId(
        capabilityRow?.id ?? capabilityRow?.capabilityId,
        "identifier",
        normalizeAdvancedAlias
      );
      const version = capabilityRow?.version;
      if (
        !capability ||
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 0
      ) {
        continue;
      }
      result.set(`${component}\u0000${capability}`, version);
    }
  }
  return result;
}

function advancedDeviceMetadata(
  row: Record<string, unknown>,
  normalizeAdvancedAlias: AdvancedAliasNormalizer
): BridgeAdvancedDeviceMetadata | undefined {
  const ownerId = normalizedAdvancedId(
    row.ownerId ?? row.owner_id,
    "identifier",
    normalizeAdvancedAlias
  ) ?? undefined;
  const profileId = normalizedAdvancedId(
    row.profileId ?? row.deviceProfileId ?? row.profile_id,
    "identifier",
    normalizeAdvancedAlias
  ) ?? undefined;
  const presentationId = normalizedAdvancedId(
    row.presentationId ?? asRecord(row.presentation)?.presentationId,
    "identifier",
    normalizeAdvancedAlias
  ) ?? undefined;
  const parentDeviceId = normalizedAdvancedId(
    row.parentDeviceId ?? row.parent_device_id,
    "device",
    normalizeAdvancedAlias
  ) ?? undefined;
  const hubId = normalizedAdvancedId(
    row.hubId ?? row.hubDeviceId ?? row.hub_id,
    "device",
    normalizeAdvancedAlias
  ) ?? undefined;
  const driverId = normalizedAdvancedId(
    row.driverId ?? row.driver_id,
    "identifier",
    normalizeAdvancedAlias
  ) ?? undefined;
  const childRows = Array.isArray(row.childDevices)
    ? row.childDevices
    : Array.isArray(row.children)
      ? row.children
      : [];
  const childDeviceIds = childRows
    .map((value) => {
      const child = asRecord(value);
      return normalizedAdvancedId(
        child?.deviceId ?? child?.id ?? value,
        "device",
        normalizeAdvancedAlias
      );
    })
    .filter((value): value is string => value !== null)
    .sort();
  const executionContext = safeToken(readString(row.executionContext ?? row.execution_context))
    ? readString(row.executionContext ?? row.execution_context) ?? undefined
    : undefined;
  const restricted =
    typeof row.restricted === "boolean"
      ? row.restricted
      : typeof row.isRestricted === "boolean"
        ? row.isRestricted
        : undefined;
  const rawType = readString(row.deviceType ?? row.type ?? row.deviceTypeName)?.toUpperCase();
  const group =
    typeof row.group === "boolean"
      ? row.group
      : typeof row.isGroup === "boolean"
        ? row.isGroup
        : rawType === "GROUP"
          ? true
          : undefined;
  const preferences = asRecord(row.preferences);
  const preferenceKeys = preferences
    ? Object.keys(preferences).filter((key) => safeToken(key)).sort()
    : [];
  const metadata: BridgeAdvancedDeviceMetadata = {
    ...(ownerId ? { ownerId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(presentationId ? { presentationId } : {}),
    ...(parentDeviceId ? { parentDeviceId } : {}),
    ...(childDeviceIds.length > 0 ? { childDeviceIds } : {}),
    ...(hubId ? { hubId } : {}),
    ...(driverId ? { driverId } : {}),
    ...(executionContext ? { executionContext } : {}),
    ...(restricted === undefined ? {} : { restricted }),
    ...(group === undefined ? {} : { group }),
    ...(preferenceKeys.length > 0 ? { preferenceKeys } : {})
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function cloneAdvancedMetadata(
  value: BridgeAdvancedDeviceMetadata
): BridgeAdvancedDeviceMetadata {
  return {
    ...value,
    ...(value.childDeviceIds ? { childDeviceIds: [...value.childDeviceIds] } : {}),
    ...(value.preferenceKeys ? { preferenceKeys: [...value.preferenceKeys] } : {})
  };
}

function advancedComponentRole(component: Record<string, unknown>): string | undefined {
  const label = safeRole(
    component.componentRole ?? component.role ?? component.label ?? component.name
  );
  if (label?.toLowerCase() !== "main") return label;
  if (!Array.isArray(component.categories)) return label;
  const refrigerator = component.categories.some((value) => {
    const category = asRecord(value);
    const name = readString(category?.name ?? category?.category ?? category?.id);
    return name?.toLowerCase() === "refrigerator";
  });
  return refrigerator ? "refrigerator" : label;
}

function preferredAdvancedRole(
  current: string | undefined,
  advanced: string | undefined
): string | undefined {
  if (!current) return advanced;
  if (current.toLowerCase() === "main" && advanced?.toLowerCase() === "refrigerator") {
    return advanced;
  }
  return current;
}

function normalizedAdvancedId(
  value: unknown,
  kind: AdvancedAliasKind,
  normalize: AdvancedAliasNormalizer
): string | null {
  const raw = readString(value);
  if (!raw) return null;
  try {
    const normalized = normalize(kind, raw);
    return safeId(
      normalized,
      kind === "device" ? "dev" : kind === "location" ? "loc" : "identifier"
    );
  } catch {
    return null;
  }
}

function stateFromSnapshot(
  row: Record<string, unknown>,
  identifierRole: IdentifierRoleResolver = () => undefined
): BridgeDeviceState | null {
  return stateFromParts({
    component: row.componentId,
    capability: row.capabilityId,
    attribute: row.attributeName,
    value: row.value,
    unit: row.unit,
    updatedAt: row.timestamp,
    source: "LOCATION_EVENT"
  }, identifierRole);
}

function stateFromEvent(
  event: Record<string, unknown>,
  data: Record<string, unknown>,
  device: MutableDevice,
  normalizeStateToken: StateTokenNormalizer,
  identifierRole: IdentifierRoleResolver
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
    updatedAt: event.event_time ?? event.eventTime ?? data.event_time ?? data.eventTime,
    source: "LOCATION_EVENT"
  }, identifierRole);
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

function stateFromParts(
  input: Record<string, unknown>,
  identifierRole: IdentifierRoleResolver = () => undefined
): BridgeDeviceState | null {
  const component = readString(input.component);
  const capability = readString(input.capability);
  const attribute = readString(input.attribute);
  const value = jsonValue(input.value);
  if (!safeToken(component) || !safeToken(capability) || !safeToken(attribute) || value === undefined) {
    return null;
  }
  const componentRole = safeRole(input.componentRole) ?? identifierRole(component);
  const capabilityRole = safeRole(input.capabilityRole) ?? identifierRole(capability);
  const source = isBridgeStateSource(input.source) ? input.source : undefined;
  return {
    component,
    capability,
    attribute,
    value,
    unit: readString(input.unit),
    updatedAt: validTimestamp(input.updatedAt),
    ...(componentRole ? { componentRole } : {}),
    ...(capabilityRole ? { capabilityRole } : {}),
    ...(source ? { source } : {})
  };
}

function isBridgeStateSource(value: unknown): value is BridgeStateSource {
  return [
    "ADVANCED_SNAPSHOT",
    "LOCATION_EVENT",
    "COMMAND_STATUS_RECHECK",
    "DOM_FALLBACK"
  ].includes(String(value));
}

function safeEventMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
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
    possibleStates: nested?.possibleStates,
    optionLabels: nested?.optionLabels,
    optionCommands: nested?.optionCommands,
    min: nested?.min ?? nested?.minimum ?? nested?.minValue,
    max: nested?.max ?? nested?.maximum ?? nested?.maxValue,
    step: nested?.step ?? nested?.interval ?? nested?.increment
  });
}

function actionControls(value: unknown): BridgeDeviceControl[] {
  const records = Array.isArray(value) ? value.map(asRecord) : [asRecord(value)];
  const grouped = new Map<string, { input: Record<string, unknown>; commands: string[] }>();
  for (const action of records) {
    if (!action) continue;
    const component = readString(action.componentId ?? action.component);
    const capability = readString(action.capabilityId ?? action.capability);
    const attribute = readString(action.attributeName ?? action.attribute);
    if (attribute !== "switch") continue;
    const commands = [
      readString(action.command),
      ...tokenList(action.commands),
      ...tokenList(action.supportedCommands)
    ].filter((command): command is "on" | "off" => command === "on" || command === "off");
    if (commands.length === 0) continue;
    const key = `${component ?? ""}\u0000${capability ?? ""}\u0000${attribute}`;
    const present = grouped.get(key);
    if (present) {
      for (const command of commands) {
        if (!present.commands.includes(command)) present.commands.push(command);
      }
      continue;
    }
    grouped.set(key, {
      input: {
        id: `action:${component}:${capability}:${attribute}`,
        kind: "toggle",
        label: action.label ?? "Power",
        component,
        capability,
        attribute
      },
      commands
    });
  }
  const controls: BridgeDeviceControl[] = [];
  for (const item of grouped.values()) {
    const commandSet = new Set(item.commands);
    const control = controlFromParts({
      ...item.input,
      commands: ["on", "off"].filter((command) => commandSet.has(command))
    });
    if (control) controls.push(control);
  }
  return controls;
}

function setActionControlIfChanged(
  controls: Map<string, BridgeDeviceControl>,
  control: BridgeDeviceControl
): boolean {
  const current = controls.get(control.id);
  if (!current || !control.id.startsWith("action:")) {
    return setIfChanged(controls, control.id, control);
  }
  const observedCommands = new Set([
    ...(current.commands ?? []),
    ...(control.commands ?? [])
  ]);
  const commands = ["on", "off"].filter((command) => observedCommands.has(command));
  const merged = {
    ...control,
    label:
      control.label === "Power" && current.label !== "Power"
        ? current.label
        : control.label,
    ...(commands.length > 0 ? { commands } : {})
  };
  return setIfChanged(controls, control.id, merged);
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
  const possibleStateOptions = possibleStates(input.possibleStates);
  const options = possibleStateOptions === undefined ? displayStringList(input.options) : possibleStateOptions?.options ?? [];
  const optionLabels = possibleStateOptions === undefined ? safeOptionMap(input.optionLabels, options) : possibleStateOptions?.optionLabels;
  const optionCommands = possibleStateOptions === undefined ? safeOptionMap(input.optionCommands, options, true) : possibleStateOptions?.optionCommands;
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
    ...(optionLabels ? { optionLabels } : {}),
    ...(optionCommands ? { optionCommands } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(input.transport === "advanced" || input.transport === "location_native"
      ? { transport: input.transport }
      : {})
  };
}

function parseAdvancedCommandDescriptors(value: unknown): AdvancedCommandDescriptor[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const result: AdvancedCommandDescriptor[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = asRecord(raw);
    const component = readString(item?.component);
    const componentRole = safeRole(item?.componentRole);
    const capability = readString(item?.capability);
    const capabilityVersion = item?.capabilityVersion;
    const command = readString(item?.command);
    const transport = item?.transport;
    const confirmation = item?.confirmation;
    const label = safeName(item?.label);
    const labelSource = item?.labelSource;
    if (
      !safeToken(component) ||
      (item?.componentRole !== undefined && !componentRole) ||
      !safeToken(capability) ||
      !Number.isSafeInteger(capabilityVersion) ||
      Number(capabilityVersion) < 0 ||
      Number(capabilityVersion) > 10_000 ||
      !safeToken(command) ||
      transport !== "advanced" ||
      (confirmation !== "accepted_receipt" && confirmation !== "state") ||
      !label ||
      !["visible_web", "capability", "role", "fallback"].includes(String(labelSource))
    ) {
      return undefined;
    }
    const args = parseAdvancedArguments(item?.arguments);
    if (!args) return undefined;
    const descriptor: AdvancedCommandDescriptor = {
      component,
      ...(componentRole ? { componentRole } : {}),
      capability,
      capabilityVersion: Number(capabilityVersion),
      command,
      arguments: args,
      transport,
      confirmation,
      label,
      labelSource: labelSource as AdvancedCommandDescriptor["labelSource"]
    };
    const key = `${component}\u0000${capability}\u0000${command}\u0000${JSON.stringify(args)}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    result.push(descriptor);
  }
  return result.sort(compareAdvancedCommandDescriptors).map(cloneAdvancedCommandDescriptor);
}

function parseAdvancedArguments(
  value: unknown
): AdvancedCommandDescriptor["arguments"] | undefined {
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const result: AdvancedCommandDescriptor["arguments"] = [];
  const names = new Set<string>();
  for (const raw of value) {
    const item = asRecord(raw);
    const name = readString(item?.name);
    if (!safeToken(name) || names.has(name)) return undefined;
    names.add(name);
    const required = item?.required;
    const sensitive = item?.sensitive;
    const schema = parseAdvancedSchema(item?.schema);
    if (typeof required !== "boolean" || typeof sensitive !== "boolean" || !schema) {
      return undefined;
    }
    const unit = item?.unit;
    if (unit !== undefined && (typeof unit !== "string" || unit.length > 64)) return undefined;
    result.push({
      name,
      required,
      sensitive,
      ...(unit ? { unit } : {}),
      schema
    });
  }
  return result;
}

function parseAdvancedSchema(value: unknown): AdvancedCommandDescriptor["arguments"][number]["schema"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const copy = jsonValue(record);
  const copyRecord = asRecord(copy);
  if (!copyRecord) return undefined;
  const type = copyRecord.type;
  if (
    type !== undefined &&
    !["array", "boolean", "integer", "number", "object", "string"].includes(String(type))
  ) {
    return undefined;
  }
  const minimum = copyRecord.minimum;
  const maximum = copyRecord.maximum;
  if (
    (minimum !== undefined && (typeof minimum !== "number" || !Number.isFinite(minimum))) ||
    (maximum !== undefined && (typeof maximum !== "number" || !Number.isFinite(maximum))) ||
    (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum)
  ) {
    return undefined;
  }
  if (copyRecord.enum !== undefined) {
    if (!Array.isArray(copyRecord.enum) || copyRecord.enum.length > 128) return undefined;
  }
  return copyRecord as AdvancedCommandDescriptor["arguments"][number]["schema"];
}

function parseAdvancedCommandOmissions(value: unknown): AdvancedCommandOmission[] | undefined {
  if (!Array.isArray(value) || value.length > 512) return undefined;
  const result: AdvancedCommandOmission[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = asRecord(raw);
    const component = readString(item?.component);
    const capability = readString(item?.capability);
    const command = item?.command === undefined ? undefined : readString(item.command);
    const reason = item?.reason;
    if (
      !safeToken(component) ||
      !safeToken(capability) ||
      (item?.command !== undefined && (typeof command !== "string" || !safeToken(command))) ||
      !["definition_unavailable", "dangerous_command", "sensitive_argument", "schema_invalid"].includes(String(reason))
    ) {
      return undefined;
    }
    const omission: AdvancedCommandOmission = {
      component,
      capability,
      ...(command ? { command } : {}),
      reason: reason as AdvancedCommandOmission["reason"]
    };
    const key = `${component}\u0000${capability}\u0000${command ?? ""}\u0000${reason}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    result.push(omission);
  }
  return result.sort(compareAdvancedOmissions).map(cloneAdvancedCommandOmission);
}

function projectedAdvancedSwitchControls(
  device: MutableDevice,
  commands: readonly AdvancedCommandDescriptor[]
): BridgeDeviceControl[] {
  const grouped = new Map<string, AdvancedCommandDescriptor[]>();
  for (const command of commands) {
    if (command.arguments.length !== 0 || (command.command !== "on" && command.command !== "off")) {
      continue;
    }
    const key = `${command.component}\u0000${command.capability}`;
    grouped.set(key, [...(grouped.get(key) ?? []), command]);
  }
  const controls: BridgeDeviceControl[] = [];
  for (const [key, descriptors] of grouped) {
    const [component, capability] = key.split("\u0000");
    if (!component || !capability) continue;
    if (!hasExactSwitchState(device, component, capability)) continue;
    const commandNames = new Set(descriptors.map((descriptor) => descriptor.command));
    if (!commandNames.has("on") || !commandNames.has("off") || descriptors.length !== 2) continue;
    const label = descriptors.find((descriptor) => descriptor.command === "on")?.label ?? capability;
    const control = controlFromParts({
      id: `advanced:${component}:${capability}:switch`,
      kind: "toggle",
      label,
      component,
      capability,
      attribute: "switch",
      commands: ["on", "off"],
      transport: "advanced"
    });
    if (control) controls.push(control);
  }
  return controls.sort(byId);
}

function hasExactSwitchState(device: MutableDevice, component: string, capability: string): boolean {
  const state = device.states.get(`${component}\u0000${capability}\u0000switch`);
  return state?.attribute === "switch" && (state.value === "on" || state.value === "off");
}

function compareAdvancedCommandDescriptors(
  left: AdvancedCommandDescriptor,
  right: AdvancedCommandDescriptor
): number {
  return `${left.component}:${left.capability}:${left.command}`.localeCompare(
    `${right.component}:${right.capability}:${right.command}`
  );
}

function compareAdvancedOmissions(
  left: AdvancedCommandOmission,
  right: AdvancedCommandOmission
): number {
  return `${left.component}:${left.capability}:${left.command ?? ""}:${left.reason}`.localeCompare(
    `${right.component}:${right.capability}:${right.command ?? ""}:${right.reason}`
  );
}

function possibleStates(value: unknown): { options: string[]; optionLabels: Record<string, string>; optionCommands: Record<string, string> } | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: string[] = [];
  const labels = new Set<string>();
  const commands = new Set<string>();
  const optionLabels: Record<string, string> = {};
  const optionCommands: Record<string, string> = {};
  for (const item of value) {
    const record = asRecord(item);
    const status = safeDisplayString(readString(record?.status));
    const label = safeDisplayString(readString(record?.label));
    const command = safeToken(readString(record?.command)) ? readString(record?.command) : null;
    if (
      !status ||
      unsafeOptionKey(status) ||
      !label ||
      !command ||
      options.includes(status) ||
      labels.has(label) ||
      commands.has(command)
    ) {
      return null;
    }
    options.push(status);
    labels.add(label);
    commands.add(command);
    optionLabels[status] = label;
    optionCommands[status] = command;
  }
  return { options, optionLabels, optionCommands };
}

function safeOptionMap(value: unknown, options: string[], requireToken = false): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (!record || options.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const option of options) {
    if (unsafeOptionKey(option)) return undefined;
    const text = readString(record[option]);
    const safe = requireToken
      ? safeToken(text) ? text : null
      : safeDisplayString(text);
    if (!safe) return undefined;
    result[option] = safe;
  }
  return Object.keys(result).length === options.length ? result : undefined;
}

function unsafeOptionKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
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
        : readString(record?.value ?? record?.id ?? record?.label ?? record?.name);
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
): { direction: "sent" | "received"; text: string; connectionKey: string } | null {
  if (record.source !== "playwright-websocket-frame" && record.source !== "cdp-websocket-frame") {
    return null;
  }
  const payload = asRecord(record.payload);
  if (!payload) return null;
  const direction = payload?.direction;
  if (direction !== "sent" && direction !== "received") return null;
  const connectionId = readString(payload.connectionId);
  if (record.source === "playwright-websocket-frame") {
    const frame = asRecord(payload.frame);
    return frame?.truncated !== true && typeof frame?.payload === "string"
      ? { direction, text: frame.payload, connectionKey: connectionKey(record.source, connectionId) }
      : null;
  }
  const cdpPayload = asRecord(payload.payload);
  const response = asRecord(cdpPayload?.response);
  const cdpConnectionId = connectionId ?? readString(cdpPayload?.requestId);
  return response?.truncated !== true && typeof response?.payloadData === "string"
    ? { direction, text: response.payloadData, connectionKey: connectionKey(record.source, cdpConnectionId) }
    : null;
}

function connectionKey(source: SanitizedCaptureRecord["source"], connectionId: string | null): string {
  return connectionId ? `${source}:${connectionId}` : `legacy:${source}`;
}

function pendingKey(connectionKey: string, ackId: number): string {
  return `${connectionKey}\u0000${ackId}`;
}

function safeId(value: unknown, prefix: "loc" | "dev" | "identifier"): string | null {
  const text = readString(value);
  return text && text.startsWith(`${prefix}_`) && ID_PATTERN.test(text) ? text : null;
}

function safeName(value: unknown): string | null {
  const text = readString(value)?.trim();
  return text && text.length <= 255 && !text.includes("[REDACTED]") ? text : null;
}

function devicePresentation(source: Record<string, unknown> | undefined): BridgeDevicePresentation | undefined {
  if (!source) return undefined;
  const lottie = asRecord(source.lottieData);
  const iconUrl = safeDeviceAssetUrl(source.icon ?? source.iconUrl, "icon");
  const inactiveIconUrl = safeDeviceAssetUrl(
    source.inactiveIcon ?? source.inactiveIconUrl,
    "icon"
  );
  const animationUrl = safeDeviceAssetUrl(
    lottie?.icon ?? source.animationUrl,
    "animation"
  );
  const assetType = animationUrl
    ? animationUrl.match(
        /^https:\/\/app-asset\.samsungiotcloud\.com\/assets\/icons\/published\/([a-z0-9_-]{1,80})\/[a-z0-9_-]{1,80}\.json$/u
      )?.[1]
    : safeAssetType(source.assetType);
  if (!iconUrl && !inactiveIconUrl && !animationUrl && !assetType) return undefined;
  return {
    ...(assetType ? { assetType } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(inactiveIconUrl ? { inactiveIconUrl } : {}),
    ...(animationUrl ? { animationUrl } : {})
  };
}

function advancedDevicePresentation(source: Record<string, unknown>): BridgeDevicePresentation | undefined {
  const direct = devicePresentation(source);
  const presentation = asRecord(source.presentation);
  const nested = direct ?? devicePresentation(presentation);
  const presentationId = safeAssetType(source.presentationId ?? presentation?.presentationId);
  if (!presentationId) return nested;
  return {
    ...(nested ?? {}),
    assetType: nested?.assetType ?? presentationId
  };
}

function advancedOnlineState(source: Record<string, unknown>): boolean | undefined {
  const health = asRecord(source.healthState ?? source.health);
  const state = readString(source.state ?? source.status ?? source.healthState);
  const nestedState = readString(health?.state ?? health?.status);
  return healthOnlineState(nestedState ?? state);
}

function advancedHealthUpdatedAt(source: Record<string, unknown>): string | null {
  const health = asRecord(source.healthState ?? source.health);
  return validTimestamp(
    source.healthUpdatedAt ??
      source.health_updated_at ??
      source.lastUpdatedDate ??
      source.last_updated_date ??
      health?.updatedAt ??
      health?.updated_at ??
      health?.lastUpdatedDate ??
      health?.last_updated_date ??
      health?.eventTime
  );
}

function healthOnlineState(value: unknown): boolean | undefined {
  const text = readString(value)?.toUpperCase();
  if (text === "ONLINE") return true;
  if (text === "OFFLINE") return false;
  return undefined;
}

function safeDeviceAssetUrl(value: unknown, kind: "icon" | "animation"): string | undefined {
  const text = readString(value);
  if (!text || text.length > 512) return undefined;
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    if (kind === "icon") {
      return url.hostname === "client.smartthings.com" && url.pathname.startsWith("/icons/")
        ? url.href
        : undefined;
    }
    return url.hostname === "app-asset.samsungiotcloud.com" &&
      /^\/assets\/icons\/published\/[a-z0-9_-]{1,80}\/[a-z0-9_-]{1,80}\.json$/u.test(
        url.pathname
      )
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function safeAssetType(value: unknown): string | undefined {
  const text = readString(value);
  return text && /^[a-z0-9_-]{1,80}$/u.test(text) ? text : undefined;
}

function safeDisplayString(value: string | null): string | null {
  const text = value?.trim();
  if (!text || text.length > 255) return null;
  if (text.includes("[REDACTED]") || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  if (/\b(?:https?|wss?):\/\//iu.test(text)) return null;
  return text;
}

function safeRole(value: unknown): string | undefined {
  const text = readString(value)?.trim();
  if (!text || text.length > 80 || text.startsWith("identifier_")) return undefined;
  return /^[A-Za-z0-9가-힣 ._-]+$/u.test(text) ? text : undefined;
}

function safeToken(value: string | null): value is string {
  return value !== null && TOKEN_PATTERN.test(value);
}

function sceneExpectedStates(
  actions: unknown,
  normalizeStateToken: StateTokenNormalizer
): BridgeSceneExpectedState[] {
  if (!Array.isArray(actions)) return [];
  const found = new Map<string, BridgeSceneExpectedState>();
  const visit = (value: unknown, inheritedDevices: string[] = []): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedDevices);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    const ownDevice = safeId(
      record.deviceId ?? record.device_id ?? record.device ?? record.targetDeviceId,
      "dev"
    );
    const listedDevices = arrayOfDeviceIds(record.devices ?? record.deviceIds);
    const nextDevices = listedDevices.length > 0 ? listedDevices : ownDevice ? [ownDevice] : inheritedDevices;
    const component = normalizeToken(readString(record.component ?? record.componentId), normalizeStateToken);
    const capability = normalizeToken(readString(record.capability ?? record.capabilityId), normalizeStateToken);
    const directAttribute = safeToken(readString(record.attribute ?? record.attributeName))
      ? (readString(record.attribute ?? record.attributeName) as string)
      : undefined;
    const command = safeToken(readString(record.command ?? record.commandName))
      ? (readString(record.command ?? record.commandName) as string)
      : undefined;
    const args = Array.isArray(record.arguments) ? record.arguments : [];
    const directValue =
      record.value !== undefined
        ? record.value
        : record.targetValue !== undefined
          ? record.targetValue
          : undefined;
    const derived = sceneActionState(directAttribute, directValue, command, args);
    if (nextDevices.length > 0 && component && capability && derived) {
      for (const deviceId of nextDevices) {
        const expected = {
          deviceId,
          component,
          capability,
          attribute: derived.attribute,
          value: derived.value
        };
        found.set(
          `${expected.deviceId}\u0000${expected.component}\u0000${expected.capability}\u0000${expected.attribute}`,
          expected
        );
      }
    }
    for (const nested of ["action", "actions", "command", "commands", "if", "then", "else"]) {
      if (record[nested] !== undefined) visit(record[nested], nextDevices);
    }
  };
  visit(actions);
  return [...found.values()].sort((left, right) =>
    `${left.deviceId}:${left.component}:${left.capability}:${left.attribute}`.localeCompare(
      `${right.deviceId}:${right.component}:${right.capability}:${right.attribute}`
    )
  );
}

function sceneActionState(
  attribute: string | undefined,
  value: unknown,
  command: string | undefined,
  args: unknown[]
): { attribute: string; value: BridgeJsonValue } | undefined {
  const unwrappedValue = unwrapSceneTypedValue(value);
  if (attribute && isBridgeJsonValue(unwrappedValue)) return { attribute, value: unwrappedValue };
  if (!command) return undefined;
  if (command === "on" || command === "off") return { attribute: "switch", value: command };
  const first = unwrapSceneTypedValue(args[0]);
  if (command === "setLevel" && isBridgeJsonValue(first)) return { attribute: "level", value: first };
  if (command === "setVolume" && isBridgeJsonValue(first)) return { attribute: "volume", value: first };
  if (command === "setFanMode" && isBridgeJsonValue(first)) return { attribute: "fanMode", value: first };
  if (command === "setThermostatMode" && isBridgeJsonValue(first)) return { attribute: "thermostatMode", value: first };
  if (command === "setCoolingSetpoint" && isBridgeJsonValue(first)) return { attribute: "coolingSetpoint", value: first };
  if (command === "setHeatingSetpoint" && isBridgeJsonValue(first)) return { attribute: "heatingSetpoint", value: first };
  return undefined;
}

function unwrapSceneTypedValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const type = readString(record.type);
  if (type === "integer" || type === "number" || type === "decimal") {
    const raw = record.integer ?? record.number ?? record.decimal ?? record.value;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : value;
  }
  if (type === "string") return typeof record.string === "string" ? record.string : value;
  if (type === "boolean") return typeof record.boolean === "boolean" ? record.boolean : value;
  return value;
}

function arrayOfDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeId(item, "dev")).filter((item): item is string => item !== null);
}

function normalizedComponentChildMappings(
  parentDeviceId: string,
  value: unknown
): ComponentChildMapping[] | undefined {
  if (safeId(parentDeviceId, "dev") !== parentDeviceId || !Array.isArray(value)) {
    return undefined;
  }
  const parsed: ComponentChildMapping[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    const component = readString(row?.component);
    const childDeviceId = safeId(row?.childDeviceId, "dev");
    if (!safeToken(component) || !childDeviceId) return undefined;
    parsed.push({ component, childDeviceId });
  }
  if (parsed.length === 0) return undefined;
  const components = new Set(parsed.map((entry) => entry.component));
  const childDeviceIds = new Set(parsed.map((entry) => entry.childDeviceId));
  if (components.size !== parsed.length || childDeviceIds.size !== parsed.length) {
    return undefined;
  }
  return parsed.sort((left, right) => left.component.localeCompare(right.component));
}

function parseStoredAdvancedMetadata(
  value: unknown
): BridgeAdvancedDeviceMetadata | undefined | null {
  if (value === undefined) return undefined;
  const row = asRecord(value);
  if (!row) return null;
  const optionalId = (
    key: keyof BridgeAdvancedDeviceMetadata,
    prefix: "dev" | "identifier"
  ): string | undefined | null => {
    const candidate = row[key];
    return candidate === undefined ? undefined : safeId(candidate, prefix);
  };
  const ownerId = optionalId("ownerId", "identifier");
  const profileId = optionalId("profileId", "identifier");
  const presentationId = optionalId("presentationId", "identifier");
  const parentDeviceId = optionalId("parentDeviceId", "dev");
  const hubId = optionalId("hubId", "dev");
  const driverId = optionalId("driverId", "identifier");
  if ([ownerId, profileId, presentationId, parentDeviceId, hubId, driverId].includes(null)) {
    return null;
  }
  const executionContext =
    row.executionContext === undefined
      ? undefined
      : safeToken(readString(row.executionContext))
        ? readString(row.executionContext) ?? undefined
        : null;
  if (executionContext === null) return null;
  const restricted = row.restricted;
  const group = row.group;
  if (
    (restricted !== undefined && typeof restricted !== "boolean") ||
    (group !== undefined && typeof group !== "boolean")
  ) {
    return null;
  }
  const childDeviceIds = parseStoredIdArray(row.childDeviceIds, "dev");
  const preferenceKeys = parseStoredTokenArray(row.preferenceKeys);
  if (childDeviceIds === null || preferenceKeys === null) return null;
  return {
    ...(ownerId ? { ownerId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(presentationId ? { presentationId } : {}),
    ...(parentDeviceId ? { parentDeviceId } : {}),
    ...(childDeviceIds ? { childDeviceIds } : {}),
    ...(hubId ? { hubId } : {}),
    ...(driverId ? { driverId } : {}),
    ...(executionContext ? { executionContext } : {}),
    ...(typeof restricted === "boolean" ? { restricted } : {}),
    ...(typeof group === "boolean" ? { group } : {}),
    ...(preferenceKeys ? { preferenceKeys } : {})
  };
}

function parseStoredIdArray(
  value: unknown,
  prefix: "dev" | "identifier"
): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => safeId(entry, prefix));
  return parsed.some((entry) => !entry) ? null : parsed as string[];
}

function parseStoredTokenArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => readString(entry));
  return parsed.some((entry) => !safeToken(entry)) ? null : parsed as string[];
}

function parseStoredSceneExpectedStates(value: unknown): BridgeSceneExpectedState[] {
  if (!Array.isArray(value)) return [];
  const parsed: BridgeSceneExpectedState[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    const deviceId = safeId(item?.deviceId, "dev");
    const component = safeToken(readString(item?.component)) ? (item?.component as string) : undefined;
    const capability = safeId(item?.capability, "identifier");
    const attribute = safeToken(readString(item?.attribute)) ? (item?.attribute as string) : undefined;
    if (!deviceId || !component || !capability || !attribute || !isBridgeJsonValue(item?.value)) {
      return [];
    }
    parsed.push({ deviceId, component, capability, attribute, value: item.value });
  }
  return parsed;
}

function isBridgeJsonValue(value: unknown): value is BridgeJsonValue {
  if (value === null) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean" || typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isBridgeJsonValue);
  const record = asRecord(value);
  return record ? Object.values(record).every(isBridgeJsonValue) : false;
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

function latestPersistedPositiveEvidenceAt(
  states: Iterable<BridgeDeviceState>
): string | null {
  let latest: string | null = null;
  for (const state of states) {
    if (
      !state.updatedAt ||
      (state.source !== "LOCATION_EVENT" && state.source !== "COMMAND_STATUS_RECHECK") ||
      explicitNegativeLivenessState(state)
    ) {
      continue;
    }
    if (latest === null || Date.parse(state.updatedAt) > Date.parse(latest)) {
      latest = state.updatedAt;
    }
  }
  return latest;
}

function explicitNegativeLivenessState(state: BridgeDeviceState): boolean {
  if (typeof state.value !== "string") return false;
  return ["offline", "unavailable", "disconnected", "not connected", "not_connected"].includes(
    state.value.trim().toLowerCase()
  );
}

function isStrictlyOlderOrUndated(candidate: string | null, current: string | null): boolean {
  if (current === null) return false;
  if (candidate === null) return true;
  return Date.parse(candidate) < Date.parse(current);
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

function mapsEqual<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function cloneControl(control: BridgeDeviceControl): BridgeDeviceControl {
  return {
    ...control,
    ...(control.commands ? { commands: [...control.commands] } : {}),
    ...(control.options ? { options: [...control.options] } : {}),
    ...(control.optionLabels ? { optionLabels: { ...control.optionLabels } } : {}),
    ...(control.optionCommands ? { optionCommands: { ...control.optionCommands } } : {})
  };
}

function cloneAdvancedCommandDescriptor(
  descriptor: AdvancedCommandDescriptor
): AdvancedCommandDescriptor {
  return {
    ...descriptor,
    arguments: descriptor.arguments.map((argument) => ({
      ...argument,
      schema: {
        ...argument.schema,
        ...(argument.schema.enum ? { enum: [...argument.schema.enum] } : {})
      }
    }))
  };
}

function cloneAdvancedCommandOmission(
  omission: AdvancedCommandOmission
): AdvancedCommandOmission {
  return { ...omission };
}

function cloneState(state: BridgeDeviceState): BridgeDeviceState {
  return { ...state, value: jsonValue(state.value) ?? null };
}

function cloneScene(scene: BridgeScene): BridgeScene {
  return {
    ...scene,
    ...(scene.expectedStates ? { expectedStates: scene.expectedStates.map(cloneSceneExpectedState) } : {})
  };
}

function cloneSceneExpectedState(expected: BridgeSceneExpectedState): BridgeSceneExpectedState {
  return { ...expected, value: jsonValue(expected.value) ?? null };
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function byState(left: BridgeDeviceState, right: BridgeDeviceState): number {
  return stateKey(left).localeCompare(stateKey(right));
}
