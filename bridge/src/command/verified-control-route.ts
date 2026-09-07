import { safeAdvancedCommandReason } from "../advanced/safe-command-policy.js";
import type { DeviceActionExecutionInput } from "./command-service.js";
import type { BridgeDevice } from "../state/device-store.js";

/** Prefer Advanced only for an exact, current safe power/scalar catalog command. */
export function verifiedAdvancedControl(device: BridgeDevice | undefined, input: DeviceActionExecutionInput): boolean {
  if (!device?.online || device.id !== input.deviceId || device.locationId !== input.locationId) return false;
  const command = input.nativeCommand ?? input.optionCommand ?? input.command;
  const setters: Record<string, string[]> = { switch: ["on", "off"], level: ["setLevel"],
    hue: ["setHue"], saturation: ["setSaturation"], colorTemperature: ["setColorTemperature"] };
  if (!setters[input.attribute]?.includes(command) || input.capabilityVersion === undefined) return false;
  if ((device.commandOmissions ?? []).some((item) => item.component === input.component &&
      item.capability === input.capability && (item.command === undefined || item.command === command))) return false;
  const matches = (device.advancedCommands ?? []).filter((item) => item.component === input.component &&
    item.capability === input.capability && item.capabilityVersion === input.capabilityVersion && item.command === command);
  const candidate = matches.length === 1 ? matches[0] : undefined;
  return !!candidate && candidate.confirmation === "state" && !safeAdvancedCommandReason(candidate);
}
