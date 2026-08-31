const ADVANCED_API = "/advanced/cupcake-api/api";
const ADVANCED_CLIENT_V1 = "/advanced/cupcake-api/clientv1";
const ADVANCED_CLIENT_V3 = "/advanced/cupcake-api/clientv3";

export const ADVANCED_DEVICES_FIRST_PAGE_QUERY = new URLSearchParams({
  includeAllowedActions: "true",
  includeGroups: "true",
  includeHealth: "true",
  includeRestricted: "true",
  includeStatus: "true",
  includeUserDevices: "true"
});

export function ADVANCED_DEVICES_NEXT_PAGE_QUERY(page: number): URLSearchParams {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error("invalid_device_page");
  return new URLSearchParams({
    includeAllowedActions: "true",
    includeGroups: "true",
    includeHealth: "true",
    includeStatus: "true",
    includeUserDevices: "true",
    isNext: "true",
    max: "200",
    page: String(page)
  });
}

export const advancedEndpoints = {
  locations: (): string => `${ADVANCED_API}/locations?allowed=true`,
  rooms: (locationId: string): string =>
    `${ADVANCED_API}/locations/${pathToken(locationId, "invalid_location_id")}/rooms`,
  devices: (query: URLSearchParams): string => `${ADVANCED_API}/devices?${query.toString()}`,
  deviceStatus: (deviceId: string): string => `${deviceBase(deviceId)}/status`,
  deviceHealth: (deviceId: string): string => `${deviceBase(deviceId)}/health`,
  devicePreferences: (deviceId: string): string => `${deviceBase(deviceId)}/preferences`,
  deviceCommands: (deviceId: string): string => `${deviceBase(deviceId)}/commands`,
  deviceProfile: (profileId: string): string =>
    `${ADVANCED_API}/deviceprofiles/${pathToken(profileId, "invalid_profile_id")}`,
  capability: (capabilityId: string, version: number): string => {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error("invalid_capability_version");
    }
    return `${ADVANCED_API}/capabilities/${pathToken(
      capabilityId,
      "invalid_capability_id"
    )}/${version}`;
  },
  deviceHistory: (): string => `${ADVANCED_API}/history/devices`,
  rules: (): string => `${ADVANCED_API}/rules`,
  clientRules: (): string => `${ADVANCED_CLIENT_V1}/rules`,
  scenes: (): string => `${ADVANCED_CLIENT_V3}/scenes`,
  hub: (hubId: string): string =>
    `${ADVANCED_API}/hubdevices/${pathToken(hubId, "invalid_hub_id")}`,
  hubDrivers: (hubId: string): string =>
    `${ADVANCED_API}/hubdevices/${pathToken(hubId, "invalid_hub_id")}/drivers`
} as const;

function deviceBase(deviceId: string): string {
  return `${ADVANCED_API}/devices/${pathToken(deviceId, "invalid_device_id")}`;
}

function pathToken(value: string, error: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(error);
  }
  return encodeURIComponent(value);
}
