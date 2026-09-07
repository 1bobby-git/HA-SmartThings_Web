import type { AdvancedCapabilitySchema } from "./types.js";

const FIELDS = ["hue", "saturation"] as const;
const ANNOTATIONS = new Set(["title", "description"]);

/** Deliberately support only the flat numeric setColor contract, not arbitrary JSON Schema. */
export function parseColorArgumentSchema(value: unknown): AdvancedCapabilitySchema | undefined {
  if (!record(value) || value.type !== "object" || !record(value.properties)) return undefined;
  const allowed = new Set(["type", "properties", "required", "additionalProperties"]);
  if (!Object.entries(value).every(([key, entry]) => allowed.has(key) ||
      (ANNOTATIONS.has(key) && typeof entry === "string"))) return undefined;
  if (Object.keys(value.properties).length !== 2 || !FIELDS.every((key) => record(value.properties[key]))) return undefined;
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
    const low = raw.minimum, high = raw.maximum;
    if (typeof low !== "number" || typeof high !== "number" || !Number.isFinite(low) ||
        !Number.isFinite(high) || low < 0 || high > 100 || low >= high) return undefined;
    properties[key] = { type: raw.type, minimum: low, maximum: high };
  }
  // A stricter public contract cannot bypass an upstream constraint. Always send
  // both named values, never extra keys, even when the definition permits them.
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
