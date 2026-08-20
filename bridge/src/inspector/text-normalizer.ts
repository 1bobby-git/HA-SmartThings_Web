import type { Redact } from "./browser-observer.js";

export interface NormalizedText {
  readonly value: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export function normalizeTextForCapture(value: string, limitBytes: number, redact: Redact): NormalizedText {
  const byteLength = Buffer.byteLength(value, "utf8");
  const redacted = redact(value);
  const redactedText = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  return {
    value: truncateUtf8(redactedText, limitBytes),
    byteLength,
    truncated: byteLength > limitBytes
  };
}

function truncateUtf8(value: string, limitBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= limitBytes) {
    return value;
  }
  let used = 0;
  let output = "";
  for (const char of value) {
    const charLength = Buffer.byteLength(char, "utf8");
    if (used + charLength > limitBytes) {
      break;
    }
    output += char;
    used += charLength;
  }
  return output;
}
