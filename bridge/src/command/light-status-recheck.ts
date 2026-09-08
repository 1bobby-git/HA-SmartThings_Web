import type { BridgeDeviceState, DeviceStore } from "../state/device-store.js";

/** Two READs only when a light driver omitted/retained its last timestamp.
 * Never manufacture a device event, request value, or wall-clock device timestamp.
 */
export async function readLightCommandStatus(
  devices: DeviceStore, deviceId: string, locationId: string,
  read: () => Promise<unknown>, component?: string
): Promise<BridgeDeviceState[]> {
  const beforeRevision = devices.commandStateRevision(deviceId, locationId);
  const first = await read();
  const firstStates = devices.commandStatusStates(first, deviceId, locationId);
  if (!component || !devices.needsLightStatusProof(firstStates, deviceId, locationId, component)) {
    return devices.observeCommandDeviceStatus(first, deviceId, locationId);
  }
  let second: unknown;
  try { second = await read(); }
  catch { return devices.observeCommandDeviceStatus(first, deviceId, locationId); }
  return devices.observeCommandDeviceStatus(second, deviceId, locationId,
    { component, beforeRevision, corroboratedStates: firstStates });
}
