import { createHash } from "node:crypto";

interface TraceTarget {
  targetId: string;
  clientRequestId: string;
  component?: string;
  capability?: string;
  attribute?: string;
  command: string;
}

export type DeviceCommandPhase = "dispatch" | "accepted" | "status_read" | "status_read_failed" |
  "confirmed" | "failed";

const commands = new Set(["on", "off", "setNumber", "setLevel", "setHue", "setSaturation",
  "setColorTemperature", "setFanMode", "setOption", "setVolume", "refresh"]);
const attributes = new Set(["switch", "level", "hue", "saturation", "colorTemperature",
  "fanSpeed", "fanMode", "airPurifierMode", "percent", "volume"]);

/** Never log names, raw IDs, argument values, session data, or arbitrary errors. */
export function deviceCommandTrace(
  request: TraceTarget, phase: DeviceCommandPhase,
  counts: Readonly<Record<string, number>> = {}
): string {
  const alias = (value: string | undefined) =>
    value !== undefined && /^(?:dev_[0-9]{3,}|identifier_[a-f0-9]{12})$/.test(value)
      ? value : "redacted";
  const token = (value: string | undefined, allowed: ReadonlySet<string>) =>
    value !== undefined && allowed.has(value) ? value : "other";
  const numeric = Object.entries(counts).filter(([key, value]) =>
    /^[a-z_]{1,32}$/.test(key) && Number.isSafeInteger(value) && value >= 0
  ).map(([key, value]) => `${key}_${value}`);
  return [
    `op_${createHash("sha256").update(request.clientRequestId).digest("hex").slice(0, 10)}`,
    `device_${alias(request.targetId)}`,
    `component_${request.component === "main" ? "main" : alias(request.component)}`,
    `capability_${alias(request.capability)}`,
    `command_${token(request.command, commands)}`,
    `attribute_${token(request.attribute, attributes)}`,
    phase, ...numeric
  ].join(":");
}
