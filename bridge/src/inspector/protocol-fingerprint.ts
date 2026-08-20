import { createHash } from "node:crypto";

export function protocolFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(shapeOf(value))).digest("hex");
}

function shapeOf(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => shapeOf(item));
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, shapeOf(nested)])
  );
}
