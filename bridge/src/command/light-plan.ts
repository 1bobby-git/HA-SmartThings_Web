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
      request.arguments.length < 1 || request.arguments.length > 4) invalid();
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
        (SETTERS[item.attribute] !== item.command && !(item.attribute === "switch" && item.command === "off")) ||
        (index === 0) !== (item.attribute === "switch")) invalid();
    const entry = item as { attribute: string; capability: string; command: string; arguments: BridgeJsonValue[] };
    if (index === 0 && (entry.capability !== request.capability || entry.arguments.length !== 0)) invalid();
    const descriptor = resolve({ ...request, component, capability: entry.capability,
      attribute: entry.attribute, command: entry.command, arguments: entry.arguments });
    if (!descriptor || descriptor.confirmation !== "state") throw new LightPlanError("unsupported_command");
    if (entry.attribute === "switch") {
      if (entry.command === "off" && request.arguments.length !== 1) invalid();
      addExpected(entry.capability, "switch", entry.command);
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

/** A light plan may keep power, level or one color channel unchanged. Require
 * fresh evidence for the changed members, plus a fresh observation of the
 * requested color mode. A cache-only no-op still needs an exact post-command GET.
 */
export function lightPlanHasFreshEvidence(
  before: readonly BridgeDeviceState[],
  current: readonly BridgeDeviceState[],
  expected: readonly LightExpectedState[]
): boolean {
  const stateFor = (states: readonly BridgeDeviceState[], target: LightExpectedState) =>
    states.find((state) => state.component === target.component &&
      state.capability === target.capability && state.attribute === target.attribute);
  const relevant = expected.filter((target) => target.attribute !== "hue" ||
    !expected.some((item) => item.component === target.component &&
      item.capability === target.capability && item.attribute === "saturation" && item.value === 0));
  const fresh = (target: LightExpectedState) => {
    const old = stateFor(before, target), now = stateFor(current, target);
    return now !== undefined && (!old || JSON.stringify(now.value) !== JSON.stringify(old.value) ||
      (now.updatedAt !== null && (old.updatedAt === null || Date.parse(now.updatedAt) > Date.parse(old.updatedAt))));
  };
  const mode = relevant.filter((target) => ["hue", "saturation", "colorTemperature"].includes(target.attribute));
  const modeChanged = mode.length > 0 && current.some((state) => state.component === expected[0]?.component &&
    state.attribute === "colorMode" && lightReportedMode(state.value) !== undefined &&
    fresh({ component: state.component, capability: state.capability,
      attribute: state.attribute, value: String(state.value) }));
  if (!relevant.some(fresh) && !modeChanged) return false;
  if (!relevant.every((target) => {
    const old = stateFor(before, target);
    return (old !== undefined && lightValueMatches(target.attribute, old.value, target.value)) || fresh(target);
  })) return false;
  // Brightness/power alone must not prove a same-value color-mode change.
  if (mode.length === 0 || mode.some(fresh)) return true;
  // Some lamps report only colorMode when switching to the same numeric value.
  return modeChanged;
}

function lightReportedMode(value: unknown): "color" | "temperature" | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase().replaceAll("_", "")) {
    case "color": case "hs": case "rgb": return "color";
    case "colortemperature": case "temperature": case "ct": return "temperature";
    default: return undefined;
  }
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
  const requestedMode = expected.some((target) => target.attribute === "colorTemperature") ? "temperature" :
    expected.some((target) => target.attribute === "hue" || target.attribute === "saturation") ? "color" : undefined;
  if (requestedMode && states.some((state) => state.component === expected[0]?.component &&
      state.attribute === "colorMode" && lightReportedMode(state.value) !== undefined &&
      lightReportedMode(state.value) !== requestedMode)) return false;
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
