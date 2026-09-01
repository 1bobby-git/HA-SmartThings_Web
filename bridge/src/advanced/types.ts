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

export interface AdvancedCapabilitySchema extends Record<string, unknown> {
  type?: "array" | "boolean" | "integer" | "number" | "object" | "string";
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface AdvancedCapabilityArgumentDefinition {
  name: string;
  required: boolean;
  sensitive: boolean;
  unit?: string;
  schema: AdvancedCapabilitySchema;
}

export interface AdvancedCapabilityCommandDefinition {
  name: string;
  arguments: AdvancedCapabilityArgumentDefinition[];
}

export interface AdvancedCapabilityDefinition {
  id: string;
  version: number;
  attributes: Record<string, unknown>;
  commands: Record<string, AdvancedCapabilityCommandDefinition>;
}
