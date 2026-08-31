import { describe, expect, test } from "vitest";

import {
  ADVANCED_DEVICES_FIRST_PAGE_QUERY,
  ADVANCED_DEVICES_NEXT_PAGE_QUERY,
  advancedEndpoints
} from "../../src/advanced/endpoints.js";

describe("advancedEndpoints", () => {
  test("builds every supported same-origin Advanced path without embedding an origin", () => {
    expect(advancedEndpoints.locations()).toBe(
      "/advanced/cupcake-api/api/locations?allowed=true"
    );
    expect(advancedEndpoints.rooms("location/a")).toBe(
      "/advanced/cupcake-api/api/locations/location%2Fa/rooms"
    );
    expect(advancedEndpoints.deviceStatus("device/a")).toBe(
      "/advanced/cupcake-api/api/devices/device%2Fa/status"
    );
    expect(advancedEndpoints.deviceHealth("device/a")).toBe(
      "/advanced/cupcake-api/api/devices/device%2Fa/health"
    );
    expect(advancedEndpoints.devicePreferences("device/a")).toBe(
      "/advanced/cupcake-api/api/devices/device%2Fa/preferences"
    );
    expect(advancedEndpoints.deviceCommands("device/a")).toBe(
      "/advanced/cupcake-api/api/devices/device%2Fa/commands"
    );
    expect(advancedEndpoints.deviceProfile("profile/a")).toBe(
      "/advanced/cupcake-api/api/deviceprofiles/profile%2Fa"
    );
    expect(advancedEndpoints.capability("custom/a", 12)).toBe(
      "/advanced/cupcake-api/api/capabilities/custom%2Fa/12"
    );
    expect(advancedEndpoints.deviceHistory()).toBe(
      "/advanced/cupcake-api/api/history/devices"
    );
    expect(advancedEndpoints.rules()).toBe("/advanced/cupcake-api/api/rules");
    expect(advancedEndpoints.clientRules()).toBe(
      "/advanced/cupcake-api/clientv1/rules"
    );
    expect(advancedEndpoints.scenes()).toBe("/advanced/cupcake-api/clientv3/scenes");
    expect(advancedEndpoints.hub("hub/a")).toBe(
      "/advanced/cupcake-api/api/hubdevices/hub%2Fa"
    );
    expect(advancedEndpoints.hubDrivers("hub/a")).toBe(
      "/advanced/cupcake-api/api/hubdevices/hub%2Fa/drivers"
    );
  });

  test("builds the exact whole-inventory first and fallback next-page queries", () => {
    const first = new URL(advancedEndpoints.devices(ADVANCED_DEVICES_FIRST_PAGE_QUERY), "https://my.smartthings.com");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      includeAllowedActions: "true",
      includeGroups: "true",
      includeHealth: "true",
      includeRestricted: "true",
      includeStatus: "true",
      includeUserDevices: "true"
    });

    const next = new URL(
      advancedEndpoints.devices(ADVANCED_DEVICES_NEXT_PAGE_QUERY(3)),
      "https://my.smartthings.com"
    );
    expect(Object.fromEntries(next.searchParams)).toEqual({
      includeAllowedActions: "true",
      includeGroups: "true",
      includeHealth: "true",
      includeStatus: "true",
      includeUserDevices: "true",
      isNext: "true",
      max: "200",
      page: "3"
    });
  });

  test("rejects unsafe numeric path parameters", () => {
    expect(() => advancedEndpoints.capability("switch", -1)).toThrowError(
      "invalid_capability_version"
    );
  });
});
