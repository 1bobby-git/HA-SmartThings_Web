export interface SafeDeviceEventSummary {
  deviceAlias: string;
  component: string;
  capability: string;
  attribute: string;
  valueType: "null" | "boolean" | "number" | "string" | "array" | "object";
  unitPresent: boolean;
  stateChange: boolean | null;
  sourceEventAtMs?: number;
}

export interface DeviceEventSummary {
  safe: Readonly<SafeDeviceEventSummary>;
  matchesExpectedValue(expected: string): boolean;
}

const DEVICE_ALIAS_PATTERN = /^dev_[0-9]{3,32}$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;
const RFC3339_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

export function extractDeviceEventSummary(input: unknown): DeviceEventSummary | null {
  const envelope = asRecord(input);
  const data = asRecord(envelope?.["data"]);
  if (!data) {
    return null;
  }
  if (readString(data, "event_type", "eventType") !== "DEVICE_EVENT") {
    return null;
  }

  const event = asRecord(data?.["device_event"] ?? data?.["deviceEvent"]);
  if (!event) {
    return null;
  }

  const deviceAlias = readString(event, "device_id", "deviceId");
  const component = readString(event, "component");
  const capability = readString(event, "capability");
  const attribute = readString(event, "attribute");
  if (!deviceAlias || !DEVICE_ALIAS_PATTERN.test(deviceAlias)) {
    return null;
  }
  if (!isSafeToken(component) || !isSafeToken(capability) || !isSafeToken(attribute)) {
    return null;
  }

  const rawValue = event["value"];
  if (!Object.hasOwn(event, "value") || !isJsonCompatibleTopLevelValue(rawValue)) {
    return null;
  }

  const safe: SafeDeviceEventSummary = {
    deviceAlias,
    component,
    capability,
    attribute,
    valueType: valueTypeOf(rawValue),
    unitPresent: event["unit"] !== null && event["unit"] !== undefined,
    stateChange: readBoolean(event, "state_change", "stateChange")
  };

  const eventAtMs = readEventTimeMs(event, data);
  if (eventAtMs !== undefined) {
    safe.sourceEventAtMs = eventAtMs;
  }

  const frozenSafe = Object.freeze(safe);
  const summary: DeviceEventSummary = {
    safe: frozenSafe,
    matchesExpectedValue: (expected: string) => typeof rawValue === "string" && rawValue === expected
  };
  return Object.freeze(summary);
}

function valueTypeOf(value: unknown): SafeDeviceEventSummary["valueType"] {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") {
    return type;
  }
  return "object";
}

function isJsonCompatibleTopLevelValue(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return true;
  }
  return isPlainObject(value);
}

function readEventTimeMs(
  event: Record<string, unknown>,
  data: Record<string, unknown>
): number | undefined {
  const value = readString(event, "event_time", "eventTime") ?? readString(data, "event_time", "eventTime");
  if (!value) {
    return undefined;
  }
  if (!RFC3339_TIMESTAMP_PATTERN.test(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeToken(value: string | null): value is string {
  return value !== null && SAFE_TOKEN_PATTERN.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function readBoolean(value: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }
  return null;
}
