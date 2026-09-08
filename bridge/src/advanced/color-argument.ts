import type { AdvancedCapabilitySchema } from "./types.js";

const FIELDS = ["hue", "saturation"] as const;
// Optional fields in SmartThings ColorMap. We never send these fields through
// the HA hue/saturation route, but their presence does not make it invalid.
const OPTIONAL_FIELDS = new Set(["hex", "level", "switch"]);
const ANNOTATIONS = new Set(["title", "description"]);

/** Deliberately support only the flat numeric setColor contract, not arbitrary JSON Schema. */
export function parseColorArgumentSchema(value: unknown): AdvancedCapabilitySchema | undefined {
  if (!record(value) || value.type !== "object" || !record(value.properties)) return undefined;
  const allowed = new Set(["type", "properties", "required", "additionalProperties"]);
  if (!Object.entries(value).every(([key, entry]) => allowed.has(key) ||
      (ANNOTATIONS.has(key) && typeof entry === "string"))) return undefined;
  if (!FIELDS.every((key) => record(value.properties[key])) ||
      !Object.entries(value.properties).every(([key, entry]) =>
        (FIELDS.includes(key as typeof FIELDS[number]) || OPTIONAL_FIELDS.has(key)) && record(entry))) return undefined;
  if (value.required !== undefined && (!Array.isArray(value.required) ||
      new Set(value.required).size !== value.required.length ||
      !value.required.every((key) => FIELDS.includes(key as typeof FIELDS[number])))) return undefined;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") return undefined;
  const properties: Record<string, AdvancedCapabilitySchema> = {};
  for (const key of FIELDS) {
    const raw = value.properties[key] as Record<string, unknown>;
    if (!Object.entries(raw).every(([name, entry]) => ["type", "minimum", "maximum"].includes(name) ||
        (ANNOTATIONS.has(name) && typeof entry === "string"))) return undefined;
    if (raw.type !== "number" && raw.type !== "integer") return undefined;
    // JSON Schema bounds are optional. Intersect the declared interval with
    // the percent domain; do not invent a required upstream bound or widen it.
    if ((raw.minimum !== undefined && (typeof raw.minimum !== "number" || !Number.isFinite(raw.minimum))) ||
        (raw.maximum !== undefined && (typeof raw.maximum !== "number" || !Number.isFinite(raw.maximum)))) return undefined;
    const low = Math.max(0, raw.minimum ?? 0), high = Math.min(100, raw.maximum ?? 100);
    if (low >= high || (raw.type === "integer" && Math.ceil(low) > Math.floor(high))) return undefined;
    properties[key] = { type: raw.type, minimum: low, maximum: high };
  }
  // A stricter public contract cannot bypass an upstream constraint. Always send
  // both named values, never extra keys, even when the definition permits them.
  // Dropping OPTIONAL property declarations cannot weaken a constraint on the
  // sent object; required extra fields and unknown cross-field constraints are
  // rejected above rather than ignored.
  return { type: "object", properties, required: [...FIELDS], additionalProperties: false };
}

export function validColorArgument(schema: AdvancedCapabilitySchema, value: unknown): boolean {
  const parsed = parseColorArgumentSchema(schema);
  if (!parsed || !record(value) || Object.keys(value).length !== 2) return false;
  const properties = parsed.properties as Record<string, AdvancedCapabilitySchema>;
  return FIELDS.every((key) => {
    const number = value[key], bounds = properties[key]!;
    return typeof number === "number" && Number.isFinite(number) &&
      (bounds.type !== "integer" || Number.isSafeInteger(number)) &&
      number >= bounds.minimum! && number <= bounds.maximum!;
  });
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
