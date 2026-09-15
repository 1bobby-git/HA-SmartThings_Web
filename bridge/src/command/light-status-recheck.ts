import type { BridgeDeviceState, DeviceStore } from "../state/device-store.js";

/** Two READs only when a light/switch driver omitted/retained its last timestamp.
 * Never manufacture a device event, request value, or wall-clock device timestamp.
 */
export async function readLightCommandStatus(
  devices: DeviceStore, deviceId: string, locationId: string,
  read: () => Promise<unknown>, component?: string,
  switchTarget?: Pick<BridgeDeviceState, "component" | "capability">
): Promise<BridgeDeviceState[]> {
  const beforeRevision = devices.commandStateRevision(deviceId, locationId);
  const first = await read();
  const firstStates = devices.commandStatusStates(first, deviceId, locationId);
  const switchStates = switchTarget
    ? firstStates.filter((state) => state.component === switchTarget.component &&
      state.capability === switchTarget.capability && state.attribute === "switch")
    : [];
  const proofComponent = component ?? switchTarget?.component;
  // Restrict corroboration to one exact switch. A second capability or another
  // attribute in the same response must not gain exceptional write authority.
  const proofStates = component ? firstStates : switchStates.length === 1 ? switchStates : [];
  if (!proofComponent || !devices.needsLightStatusProof(proofStates, deviceId, locationId, proofComponent)) {
    return devices.observeCommandDeviceStatus(first, deviceId, locationId, undefined, component);
  }
  let second: unknown;
  try { second = await read(); }
  catch { return devices.observeCommandDeviceStatus(first, deviceId, locationId, undefined, component); }
  // The store verifies both reads agree and the device revision did not change.
  // Keep ordinary inventory delivery for switches; only lights use the delta path.
  return devices.observeCommandDeviceStatus(second, deviceId, locationId,
    { component: proofComponent, beforeRevision, corroboratedStates: proofStates }, component);
}
