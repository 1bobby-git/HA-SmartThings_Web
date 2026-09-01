import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";

type VolatileAliasKind = "device" | "identifier";

const DEVICE_ALIAS = /^dev_[0-9A-Za-z_-]{3,64}$/u;
const LOCATION_ALIAS = /^loc_[0-9A-Za-z_-]{3,64}$/u;
const IDENTIFIER_ALIAS = /^identifier_[0-9A-Za-z_-]{3,64}$/u;
const DEVICE_KEYS = new Set(["deviceId", "device_id"]);
const LOCATION_KEYS = new Set(["locationId", "location_id"]);
const COMPONENT_KEYS = new Set(["component", "componentId", "component_id"]);
const CAPABILITY_KEYS = new Set(["capability", "capabilityId", "capability_id"]);
const SEMANTIC_IDENTIFIER_ROLES = new Set([
  "bixby",
  "cooler",
  "curdmaker",
  "cvroom",
  "freezer",
  "hca.main",
  "icemaker",
  "icemaker-02",
  "main",
  "onedoor",
  "pantry-01",
  "pantry-02",
  "refresh",
  "setup",
  "smartthings-findnode",
  "smartthings-hub",
  "speechsynthesis",
  "switch2",
  "switch3",
  "switch4",
  "switch5"
]);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_WALK_DEPTH = 24;
const MAX_WALK_NODES = 100_000;
const MAX_VOLATILE_FRAME_BYTES = 8 * 1024 * 1024;

export class VolatileIdentifierMap {
  readonly #deviceAliases = new Map<string, string>();
  readonly #identifierAliases = new Map<string, string>();
  readonly #locationAliases = new Map<string, string>();
  readonly #rawDevices = new Set<string>();
  readonly #rawIdentifiers = new Set<string>();
  readonly #rawLocations = new Set<string>();

  constructor(
    private readonly alias: (kind: VolatileAliasKind, rawIdentifier: string) => string,
    private readonly aliasLocation?: (rawIdentifier: string) => string
  ) {}

  observeRawWebSocketFrame(_direction: "sent" | "received", raw: string): void {
    const decoded = decodeSocketIoTextFrame(raw, { maxBytes: MAX_VOLATILE_FRAME_BYTES });
    if (decoded.kind === "invalid") return;
    if (decoded.kind === "event" || decoded.kind === "ack" || decoded.kind === "binary_ack") {
      this.#walk(decoded.args);
      return;
    }
    if (decoded.kind === "engine_open" || decoded.kind === "socket_connect") {
      this.#walk(decoded.data);
    }
  }

  observeRawAdvancedDeviceSnapshot(value: unknown): void {
    const root = isRecord(value) ? value : undefined;
    const rows = Array.isArray(value)
      ? value
      : Array.isArray(root?.items)
        ? root.items
        : Array.isArray(root?.devices)
          ? root.devices
          : Array.isArray(root?.data)
            ? root.data
            : [];
    for (const rowValue of rows) {
      if (!isRecord(rowValue)) continue;
      const deviceId = firstString(rowValue.deviceId, rowValue.device_id);
      if (deviceId) this.#remember("device", deviceId);
      const locationId = firstString(rowValue.locationId, rowValue.location_id);
      if (locationId) this.#rememberLocation(locationId);
      if (!Array.isArray(rowValue.components)) continue;
      for (const componentValue of rowValue.components) {
        if (!isRecord(componentValue)) continue;
        const component = firstString(componentValue.id, componentValue.componentId);
        if (component) this.#remember("identifier", component);
        if (!Array.isArray(componentValue.capabilities)) continue;
        for (const capabilityValue of componentValue.capabilities) {
          if (!isRecord(capabilityValue)) continue;
          const capability = firstString(capabilityValue.id, capabilityValue.capabilityId);
          if (capability) this.#remember("identifier", capability);
        }
      }
    }
  }

  rawDeviceId(alias: string): string | undefined {
    return DEVICE_ALIAS.test(alias) ? this.#deviceAliases.get(alias) : undefined;
  }

  rawIdentifier(alias: string): string | undefined {
    return IDENTIFIER_ALIAS.test(alias) ? this.#identifierAliases.get(alias) : undefined;
  }

  rawLocationId(alias: string): string | undefined {
    return LOCATION_ALIAS.test(alias) ? this.#locationAliases.get(alias) : undefined;
  }

  semanticIdentifierRole(alias: string): string | undefined {
    const raw = this.rawIdentifier(alias) ?? alias;
    if (!raw) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (!SEMANTIC_IDENTIFIER_ROLES.has(normalized)) return undefined;
    return normalized;
  }

  reset(): void {
    this.#deviceAliases.clear();
    this.#identifierAliases.clear();
    this.#locationAliases.clear();
    this.#rawDevices.clear();
    this.#rawIdentifiers.clear();
    this.#rawLocations.clear();
  }

  #walk(root: unknown): void {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_WALK_NODES) {
      const current = stack.pop();
      if (!current || current.depth > MAX_WALK_DEPTH) continue;
      visited += 1;
      if (Array.isArray(current.value)) {
        for (const value of current.value) {
          stack.push({ value, depth: current.depth + 1 });
        }
        continue;
      }
      if (!isRecord(current.value)) continue;
      for (const [key, value] of Object.entries(current.value)) {
        if (typeof value === "string") {
          if (DEVICE_KEYS.has(key)) this.#remember("device", value);
          if (LOCATION_KEYS.has(key)) this.#rememberLocation(value);
          if (COMPONENT_KEYS.has(key) || CAPABILITY_KEYS.has(key)) {
            this.#remember("identifier", value);
          }
        }
        if (typeof value === "object" && value !== null) {
          stack.push({ value, depth: current.depth + 1 });
        }
      }
    }
  }

  #remember(kind: VolatileAliasKind, raw: string): void {
    if (raw.length === 0 || raw.length > MAX_IDENTIFIER_LENGTH || /[\u0000-\u001f\u007f]/u.test(raw)) {
      return;
    }
    const target = kind === "device" ? this.#deviceAliases : this.#identifierAliases;
    const rawValues = kind === "device" ? this.#rawDevices : this.#rawIdentifiers;
    if (rawValues.has(raw)) return;
    try {
      const alias = this.alias(kind, raw);
      const pattern = kind === "device" ? DEVICE_ALIAS : IDENTIFIER_ALIAS;
      if (!pattern.test(alias)) return;
      target.set(alias, raw);
      let normalizedAlias = alias;
      // Websocket text is sanitized once while it is bounded and once when the
      // capture record is created. DeviceStore then normalizes pushed component
      // and capability tokens twice more. Retain only those exact in-process
      // generations so every safe public alias can resolve back to the raw value.
      const additionalGenerations = kind === "device" ? 1 : 3;
      for (let generation = 0; generation < additionalGenerations; generation += 1) {
        normalizedAlias = this.alias(kind, normalizedAlias);
        if (!pattern.test(normalizedAlias)) break;
        target.set(normalizedAlias, raw);
      }
      rawValues.add(raw);
    } catch {
      // Raw identifiers remain optional, in-memory acceleration hints only.
    }
  }

  #rememberLocation(raw: string): void {
    if (
      !this.aliasLocation ||
      raw.length === 0 ||
      raw.length > MAX_IDENTIFIER_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(raw) ||
      this.#rawLocations.has(raw)
    ) {
      return;
    }
    try {
      let alias = this.aliasLocation(raw);
      for (let generation = 0; generation < 3; generation += 1) {
        if (!LOCATION_ALIAS.test(alias)) break;
        this.#locationAliases.set(alias, raw);
        alias = this.aliasLocation(alias);
      }
      this.#rawLocations.add(raw);
    } catch {
      // Location identifiers remain optional in-memory hints only.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}
