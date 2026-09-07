import type { BridgeDevice, BridgeDeviceState, BridgeJsonValue } from "../state/device-store.js";
import type { AdvancedCommandDescriptor } from "../advanced/command-catalog-types.js";
import type { SafeCommandRequest } from "./command-service.js";
import type { RoutedCommandRequest } from "./command-router.js";
import { validColorArgument } from "../advanced/color-argument.js";

export class LightPlanError extends Error {
  constructor(readonly code: "invalid_arguments" | "capability_not_found" | "unsupported_command") {
    super(code);
    this.name = "LightPlanError";
  }
}

export interface LightExpectedState {
  component: string;
  capability: string;
  attribute: string;
  value: string | number;
}
export interface VerifiedLightPlan {
  actions: RoutedCommandRequest[];
  expected: LightExpectedState[];
}
const SETTERS: Record<string, string> = {
  switch: "on", level: "setLevel", hue: "setHue", saturation: "setSaturation",
  colorTemperature: "setColorTemperature", color: "setColor"
};

/** Validate the entire same-component light operation BEFORE any command is sent. */
export function buildLightPlan(
  device: BridgeDevice,
  request: SafeCommandRequest,
  resolve: (request: SafeCommandRequest) => AdvancedCommandDescriptor | undefined
): VerifiedLightPlan {
  const invalid = (): never => { throw new LightPlanError("invalid_arguments"); };
  if (request.requireAdvanced !== true || request.confirm !== true || !request.component ||
      request.attribute !== "switch" || !request.capability || request.controlId || request.controlLabel ||
      request.arguments.length < 2 || request.arguments.length > 4) invalid();
  const component = request.component!;
  const actions: RoutedCommandRequest[] = [], expected: LightExpectedState[] = [];
  const seen = new Set<string>();
  const addExpected = (capability: string, attribute: string, value: string | number) => {
    if (seen.has(attribute)) invalid();
    const states = device.states.filter((state) => state.component === component && state.attribute === attribute);
    if (states.length !== 1 || states[0]!.capability !== capability) throw new LightPlanError("capability_not_found");
    seen.add(attribute); expected.push({ component, capability, attribute, value });
  };
  for (const [index, item] of request.arguments.entries()) {
    if (!record(item) || Object.keys(item).sort().join() !== "arguments,attribute,capability,command" ||
        typeof item.attribute !== "string" || typeof item.capability !== "string" ||
        typeof item.command !== "string" || !Array.isArray(item.arguments) ||
        SETTERS[item.attribute] !== item.command || (index === 0) !== (item.attribute === "switch")) invalid();
    const entry = item as { attribute: string; capability: string; command: string; arguments: BridgeJsonValue[] };
    if (index === 0 && (entry.capability !== request.capability || entry.arguments.length !== 0)) invalid();
    const descriptor = resolve({ ...request, component, capability: entry.capability,
      attribute: entry.attribute, command: entry.command, arguments: entry.arguments });
    if (!descriptor || descriptor.confirmation !== "state") throw new LightPlanError("unsupported_command");
    if (entry.attribute === "switch") {
      addExpected(entry.capability, "switch", "on");
    } else if (entry.attribute === "color") {
      if (descriptor.arguments.length !== 1 || !validColorArgument(descriptor.arguments[0]!.schema, entry.arguments[0])) invalid();
      const color = entry.arguments[0] as { hue: number; saturation: number };
      addExpected(entry.capability, "hue", color.hue);
      addExpected(entry.capability, "saturation", color.saturation);
    } else {
      const value = entry.arguments[0];
      if (entry.arguments.length !== 1 || typeof value !== "number" || !Number.isFinite(value) ||
          value < (entry.attribute === "level" || entry.attribute === "colorTemperature" ? 1 : 0) ||
          value > (entry.attribute === "colorTemperature" ? 30_000 : 100)) invalid();
      addExpected(entry.capability, entry.attribute, value as number);
    }
    actions.push({ deviceId: device.id, component, capability: entry.capability,
      capabilityVersion: descriptor.capabilityVersion, command: entry.command, arguments: entry.arguments });
  }
  if (!seen.has("switch") || (seen.has("hue") !== seen.has("saturation")) ||
      (seen.has("hue") && seen.has("colorTemperature"))) invalid();
  return { actions, expected };
}

/** UI color resolution only. Generic controls/security retain their exact comparisons. */
export function lightValueMatches(attribute: string, actual: unknown, desired: string | number): boolean {
  if (attribute === "switch") return typeof actual === "string" && actual.trim().toLowerCase() === desired;
  if (typeof actual !== "number" || !Number.isFinite(actual) || typeof desired !== "number") return false;
  if (attribute === "colorTemperature") {
    // White-temperature drivers commonly round reciprocal megakelvins (mired).
    return actual >= 1 && actual <= 30_000 && Math.abs(1e6 / actual - 1e6 / desired) <= 1;
  }
  if (actual < 0 || actual > 100) return false;
  const distance = Math.abs(actual - desired);
  return (attribute === "hue" ? Math.min(distance, 100 - distance) : distance) <= 0.5;
}

export function lightPlanMatches(states: readonly BridgeDeviceState[], expected: readonly LightExpectedState[]): boolean {
  return expected.every((target) => {
    const matches = states.filter((state) => state.component === target.component &&
      state.capability === target.capability && state.attribute === target.attribute);
    if (matches.length !== 1) return false;
    if (target.attribute === "hue" && expected.some((item) => item.attribute === "saturation" && item.value === 0)) {
      const hue = matches[0]!.value;
      if (typeof hue !== "number" || !Number.isFinite(hue) || hue < 0 || hue > 100) return false;
      const saturation = expected.find((item) => item.attribute === "saturation")!;
      return states.some((state) => state.component === saturation.component &&
        state.capability === saturation.capability && state.attribute === "saturation" && state.value === 0);
    }
    return lightValueMatches(target.attribute, matches[0]!.value, target.value);
  });
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
