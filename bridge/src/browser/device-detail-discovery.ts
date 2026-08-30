import type { BridgeDevice, BridgeInventory } from "../state/device-store.js";

interface DeviceDetailInspector {
  inspectDeviceDetails(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
    detailSettleMs?: number;
    cameraImageUrl?: string;
  }): Promise<void>;
}

interface DeviceDetailDiscoveryOptions {
  inventory: () => BridgeInventory;
  inspector: DeviceDetailInspector;
  canInspect: () => boolean;
  resolveCameraImageUrl?: (deviceId: string) => string | undefined;
  maxAttempts?: number;
}

export type DeviceDetailDiscoveryResult =
  | "blocked"
  | "busy"
  | "failed"
  | "idle"
  | "inspected";

export interface DeviceDetailDiscoveryFailure {
  deviceId: string;
  reason: string;
}

export class DeviceDetailDiscovery {
  readonly #attempts = new Map<string, number>();
  readonly #maxAttempts: number;
  #running = false;
  #lastFailure: DeviceDetailDiscoveryFailure | undefined;

  constructor(private readonly options: DeviceDetailDiscoveryOptions) {
    this.#maxAttempts = options.maxAttempts ?? 2;
  }

  reset(): void {
    this.#attempts.clear();
    this.#lastFailure = undefined;
  }

  lastFailure(): DeviceDetailDiscoveryFailure | undefined {
    return this.#lastFailure;
  }

  async runOne(): Promise<DeviceDetailDiscoveryResult> {
    if (this.#running) return "busy";
    if (!this.options.canInspect()) return "blocked";
    const inventory = this.options.inventory();
    const device = inventory.devices
      .filter((candidate) => this.#needsInspection(candidate))
      .sort((a, b) => inspectionPriority(a) - inspectionPriority(b))[0];
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
      const cameraImageUrl = isCameraImageDevice(device)
        ? this.options.resolveCameraImageUrl
          ? this.options.resolveCameraImageUrl(device.id)
          : observedCameraImageUrl(device)
        : undefined;
      await this.options.inspector.inspectDeviceDetails({
        deviceName: device.name,
        locationId: device.locationId,
        locationNames,
        ...(roomName ? { roomName } : {}),
        ...(isCameraImageDevice(device) ? { detailSettleMs: 5_000 } : {}),
        ...(cameraImageUrl ? { cameraImageUrl } : {})
      });
      this.#lastFailure = undefined;
      return "inspected";
    } catch (error) {
      if (error instanceof Error && error.message === "detail_discovery_preempted") {
        const attempts = (this.#attempts.get(device.id) ?? 1) - 1;
        if (attempts > 0) this.#attempts.set(device.id, attempts);
        else this.#attempts.delete(device.id);
        return "blocked";
      }
      this.#lastFailure = {
        deviceId: device.id,
        reason: safeFailureReason(error)
      };
      return "failed";
    } finally {
      this.#running = false;
    }
  }

  #needsInspection(device: BridgeDevice): boolean {
    const attempts = this.#attempts.get(device.id) ?? 0;
    if (attempts >= this.#maxAttempts) return false;
    if (attempts === 0) return true;
    return !discoveryComplete(device) || isCameraImageDevice(device);
  }
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.length <= 80 &&
    /^[a-z0-9_-]+$/u.test(message) &&
    !/(?:authorization|cookie|password|token|secret|csrf|session)/iu.test(message)
  ) {
    return message;
  }
  return "detail_discovery_error";
}

function hasActionableControl(device: BridgeDevice): boolean {
  return (device.controls ?? []).some(
    (control) => control.kind !== "value" && !isRefreshControl(control)
  );
}

function discoveryComplete(device: BridgeDevice): boolean {
  return hasActionableControl(device) && hasExactPrimaryToggle(device);
}

function hasExactPrimaryToggle(device: BridgeDevice): boolean {
  const controls = device.controls ?? [];
  return device.states
    .filter((state) => state.attribute === "switch")
    .every((state) => {
      const matches = controls.filter(
        (control) =>
          control.kind === "toggle" &&
          control.component === state.component &&
          control.capability === state.capability &&
          control.attribute === state.attribute
      );
      const actionMatches = matches.filter((control) => control.id.startsWith("action:"));
      return matches.length === 1 || (matches.length > 1 && actionMatches.length === 1);
    });
}

function isRefreshControl(control: NonNullable<BridgeDevice["controls"]>[number]): boolean {
  return control.command === "refresh" || control.attribute === "refresh";
}

const refreshDetailAttributes = new Set(["battery", "contact", "signalMetrics"]);

function inspectionPriority(device: BridgeDevice): number {
  if (isCameraImageDevice(device)) {
    return -1;
  }
  if (!hasActionableControl(device)) {
    const valuePriority = refreshDetailValuePriority(device);
    if (valuePriority !== undefined) {
      return valuePriority;
    }
    return 3;
  }
  return 5;
}

function refreshDetailValuePriority(device: BridgeDevice): number | undefined {
  const attributes = new Set(device.states.map((state) => state.attribute));
  if (
    attributes.has("contact") &&
    attributes.has("battery") &&
    attributes.has("signalMetrics")
  ) {
    return 0;
  }
  if (attributes.has("signalMetrics")) {
    return 1;
  }
  if ([...attributes].some((attribute) => refreshDetailAttributes.has(attribute))) {
    return 2;
  }
  return undefined;
}

const cameraImageAttributes = new Set([
  "captureTime",
  "clip",
  "image",
  "imageTransferProgress",
  "stream"
]);

function isCameraImageDevice(device: BridgeDevice): boolean {
  const attributes = new Set(device.states.map((state) => state.attribute));
  if (![...attributes].some((attribute) => cameraImageAttributes.has(attribute))) {
    return false;
  }
  const identity = `${device.name} ${device.type ?? ""} ${device.presentation?.assetType ?? ""}`.toLowerCase();
  if (/\b(?:camera|cam|cctv|homecam)\b/u.test(identity) || /(?:보안 카메라|카메라|홈캠)/u.test(identity)) {
    return true;
  }
  return (
    (["clip", "stream"] as const).some((attribute) => attributes.has(attribute)) &&
    (["captureTime", "image"] as const).some((attribute) => attributes.has(attribute))
  );
}

function observedCameraImageUrl(device: BridgeDevice): string | undefined {
  const imageState = device.states.find(
    (state) => state.attribute === "image" && typeof state.value === "string"
  );
  return typeof imageState?.value === "string" ? imageState.value : undefined;
}
