export type AdvancedEndpointCategory =
  | "locations"
  | "rooms"
  | "devices"
  | "device_status"
  | "device_health"
  | "device_preferences"
  | "device_profile"
  | "capability"
  | "commands"
  | "history"
  | "rules"
  | "scenes"
  | "hub"
  | "hub_drivers";

export interface AdvancedDeviceRow extends Record<string, unknown> {
  deviceId: string;
  locationId?: string;
  label?: string;
}

export interface AdvancedDevicePage {
  items: AdvancedDeviceRow[];
  next?: string;
}

export interface AdvancedCommandBody {
  commands: Array<{
    component: string;
    capability: string;
    command: string;
    arguments: unknown[];
  }>;
}
