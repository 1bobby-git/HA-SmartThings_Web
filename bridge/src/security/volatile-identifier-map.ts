import { decodeSocketIoTextFrame } from "../inspector/socketio-decoder.js";

type VolatileAliasKind = "device" | "identifier";

const DEVICE_ALIAS = /^dev_[0-9A-Za-z_-]{3,64}$/u;
const IDENTIFIER_ALIAS = /^identifier_[0-9A-Za-z_-]{3,64}$/u;
const DEVICE_KEYS = new Set(["deviceId", "device_id"]);
const COMPONENT_KEYS = new Set(["component", "componentId", "component_id"]);
const CAPABILITY_KEYS = new Set(["capability", "capabilityId", "capability_id"]);
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_WALK_DEPTH = 24;
const MAX_WALK_NODES = 100_000;

export class VolatileIdentifierMap {
  readonly #deviceAliases = new Map<string, string>();
  readonly #identifierAliases = new Map<string, string>();
  readonly #rawDevices = new Set<string>();
  readonly #rawIdentifiers = new Set<string>();

  constructor(
    private readonly alias: (kind: VolatileAliasKind, rawIdentifier: string) => string
  ) {}

  observeRawWebSocketFrame(_direction: "sent" | "received", raw: string): void {
    const decoded = decodeSocketIoTextFrame(raw);
    if (decoded.kind === "invalid") return;
    if (decoded.kind === "event" || decoded.kind === "ack" || decoded.kind === "binary_ack") {
      this.#walk(decoded.args);
      return;
    }
    if (decoded.kind === "engine_open" || decoded.kind === "socket_connect") {
      this.#walk(decoded.data);
    }
  }

  rawDeviceId(alias: string): string | undefined {
    return DEVICE_ALIAS.test(alias) ? this.#deviceAliases.get(alias) : undefined;
  }

  rawIdentifier(alias: string): string | undefined {
    return IDENTIFIER_ALIAS.test(alias) ? this.#identifierAliases.get(alias) : undefined;
  }

  reset(): void {
    this.#deviceAliases.clear();
    this.#identifierAliases.clear();
    this.#rawDevices.clear();
    this.#rawIdentifiers.clear();
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
      if (kind === "identifier") {
        let normalizedAlias = alias;
        // Sanitized component/capability ids can be normalized twice again by DeviceStore.
        // Retain every in-process alias generation needed to reverse that exact pipeline.
        for (let generation = 0; generation < 2; generation += 1) {
          normalizedAlias = this.alias("identifier", normalizedAlias);
          if (!IDENTIFIER_ALIAS.test(normalizedAlias)) break;
          target.set(normalizedAlias, raw);
        }
      }
      rawValues.add(raw);
    } catch {
      // Raw identifiers remain optional, in-memory acceleration hints only.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
