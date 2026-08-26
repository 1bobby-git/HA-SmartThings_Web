import type { BridgeDevice, BridgeInventory } from "../state/device-store.js";

interface DeviceDetailInspector {
  inspectDeviceDetails(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
    detailSettleMs?: number;
  }): Promise<void>;
}

interface DeviceDetailDiscoveryOptions {
  inventory: () => BridgeInventory;
  inspector: DeviceDetailInspector;
  canInspect: () => boolean;
  maxAttempts?: number;
}

export type DeviceDetailDiscoveryResult =
  | "blocked"
  | "busy"
  | "failed"
  | "idle"
  | "inspected";

export class DeviceDetailDiscovery {
  readonly #attempts = new Map<string, number>();
  readonly #maxAttempts: number;
  #running = false;

  constructor(private readonly options: DeviceDetailDiscoveryOptions) {
    this.#maxAttempts = options.maxAttempts ?? 2;
  }

  reset(): void {
    this.#attempts.clear();
  }

  async runOne(): Promise<DeviceDetailDiscoveryResult> {
    if (this.#running) return "busy";
    if (!this.options.canInspect()) return "blocked";
    const inventory = this.options.inventory();
    const device = inventory.devices.find((candidate) => this.#needsInspection(candidate));
    if (!device) return "idle";
    this.#attempts.set(device.id, (this.#attempts.get(device.id) ?? 0) + 1);
    this.#running = true;
    try {
      const locationNames = Object.fromEntries(
        inventory.locations.map((location) => [location.id, location.name])
      );
      const roomName = device.roomId
        ? inventory.rooms.find((room) => room.id === device.roomId)?.name
        : undefined;
      await this.options.inspector.inspectDeviceDetails({
        deviceName: device.name,
        locationId: device.locationId,
        locationNames,
        ...(roomName ? { roomName } : {}),
        ...(isCameraImageDevice(device) ? { detailSettleMs: 5_000 } : {})
      });
      return "inspected";
    } catch (error) {
      if (error instanceof Error && error.message === "detail_discovery_preempted") {
        const attempts = (this.#attempts.get(device.id) ?? 1) - 1;
        if (attempts > 0) this.#attempts.set(device.id, attempts);
        else this.#attempts.delete(device.id);
        return "blocked";
      }
      return "failed";
    } finally {
      this.#running = false;
    }
  }

  #needsInspection(device: BridgeDevice): boolean {
    return (
      (device.controls?.length ?? 0) === 0 &&
      (this.#attempts.get(device.id) ?? 0) < this.#maxAttempts
    );
  }
}

const cameraImageAttributes = new Set([
  "captureTime",
  "clip",
  "image",
  "imageTransferProgress",
  "stream"
]);

function isCameraImageDevice(device: BridgeDevice): boolean {
  if (device.states.some((state) => cameraImageAttributes.has(state.attribute))) {
    return true;
  }
  const identity = `${device.name} ${device.type ?? ""}`.toLowerCase();
  return /\b(?:camera|cam)\b/u.test(identity) || /카메라/u.test(identity);
}
