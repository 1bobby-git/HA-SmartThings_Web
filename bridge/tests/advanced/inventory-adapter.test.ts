import { describe, expect, test } from "vitest";

import { AdvancedInventoryAdapter } from "../../src/advanced/inventory-adapter.js";
import type {
  AdvancedParser,
  AdvancedRequest,
  AuthenticatedAdvancedSession
} from "../../src/advanced/authenticated-session.js";

class FakeSession implements AuthenticatedAdvancedSession {
  readonly requests: AdvancedRequest[] = [];

  constructor(private readonly responses: Map<string, unknown>) {}

  async request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> {
    this.requests.push(request);
    if (!this.responses.has(request.path)) throw new Error(`missing_fake:${request.path}`);
    return parser(this.responses.get(request.path));
  }
}

describe("AdvancedInventoryAdapter", () => {
  test("loads and merges more than 200 devices using server links first", async () => {
    const firstPath =
      "/advanced/cupcake-api/api/devices?includeAllowedActions=true&includeGroups=true&includeHealth=true&includeRestricted=true&includeStatus=true&includeUserDevices=true";
    const nextPath = "/advanced/cupcake-api/api/devices?cursor=server-next";
    const first = Array.from({ length: 200 }, (_, index) => ({
      deviceId: `device-${index}`,
      locationId: index % 2 === 0 ? "location-a" : "location-b"
    }));
    const second: Array<{ deviceId: string; locationId: string; label?: string }> = Array.from(
      { length: 35 },
      (_, index) => ({
      deviceId: `device-${index + 200}`,
      locationId: "location-b"
      })
    );
    second.push({ deviceId: "device-0", locationId: "location-c", label: "latest" });
    const session = new FakeSession(
      new Map([
        [firstPath, { items: first, links: { next: { href: nextPath } } }],
        [nextPath, { items: second }]
      ])
    );
    const adapter = new AdvancedInventoryAdapter(session, { now: () => 123 });

    const result = await adapter.getDevices();

    expect(result.devices).toHaveLength(235);
    expect(result.devices.find((row) => row.deviceId === "device-0")).toMatchObject({
      label: "latest",
      locationId: "location-c"
    });
    expect(result.pageCount).toBe(2);
    expect(result.fetchedAtMs).toBe(123);
    expect(session.requests.map((request) => request.path)).toEqual([firstPath, nextPath]);
  });

  test("uses the documented page fallback when links are absent", async () => {
    const firstPath =
      "/advanced/cupcake-api/api/devices?includeAllowedActions=true&includeGroups=true&includeHealth=true&includeRestricted=true&includeStatus=true&includeUserDevices=true";
    const nextPath =
      "/advanced/cupcake-api/api/devices?includeAllowedActions=true&includeGroups=true&includeHealth=true&includeStatus=true&includeUserDevices=true&isNext=true&max=200&page=1";
    const session = new FakeSession(
      new Map([
        [
          firstPath,
          {
            items: Array.from({ length: 200 }, (_, index) => ({ deviceId: `device-${index}` })),
            page: 0,
            max: 200,
            hasNext: true
          }
        ],
        [nextPath, { items: [{ deviceId: "device-200" }] }]
      ])
    );

    const result = await new AdvancedInventoryAdapter(session).getDevices();

    expect(result.devices).toHaveLength(201);
    expect(session.requests.at(-1)?.path).toBe(nextPath);
  });

  test("loads all locations and isolates room requests per location", async () => {
    const locationsPath = "/advanced/cupcake-api/api/locations?allowed=true";
    const session = new FakeSession(
      new Map([
        [locationsPath, [{ locationId: "location-a" }, { locationId: "location-b" }]],
        [
          "/advanced/cupcake-api/api/locations/location-a/rooms",
          [{ roomId: "room-a", locationId: "location-a" }]
        ],
        [
          "/advanced/cupcake-api/api/locations/location-b/rooms",
          [{ roomId: "room-b", locationId: "location-b" }]
        ]
      ])
    );
    const adapter = new AdvancedInventoryAdapter(session);

    const locations = await adapter.getLocations();
    const rooms = (
      await Promise.all(locations.map((location) => adapter.getRooms(location.locationId)))
    ).flat();

    expect(locations.map((location) => location.locationId)).toEqual([
      "location-a",
      "location-b"
    ]);
    expect(rooms.map((room) => room.roomId)).toEqual(["room-a", "room-b"]);
  });

  test("exposes endpoint-specific reads through one client", async () => {
    const session = new FakeSession(
      new Map([
        ["/advanced/cupcake-api/api/devices/device-a/status", { components: {} }],
        ["/advanced/cupcake-api/api/devices/device-a/health", { state: "ONLINE" }],
        ["/advanced/cupcake-api/api/devices/device-a/preferences", [{ preferenceId: "p" }]],
        ["/advanced/cupcake-api/api/deviceprofiles/profile-a", { id: "profile-a" }],
        ["/advanced/cupcake-api/api/capabilities/custom.test/2", { id: "custom.test", version: 2 }],
        [
          "/advanced/cupcake-api/api/history/devices?deviceId=device-a&locationId=location-a",
          { items: [] }
        ],
        ["/advanced/cupcake-api/api/rules?locationId=location-a", { items: [] }],
        ["/advanced/cupcake-api/clientv1/rules?locationId=location-a", { items: [] }],
        ["/advanced/cupcake-api/clientv3/scenes?locationId=location-a", { items: [] }],
        ["/advanced/cupcake-api/api/hubdevices/hub-a", { id: "hub-a" }],
        ["/advanced/cupcake-api/api/hubdevices/hub-a/drivers", { items: [] }]
      ])
    );
    const adapter = new AdvancedInventoryAdapter(session);

    await Promise.all([
      adapter.getDeviceStatus("device-a"),
      adapter.getDeviceHealth("device-a"),
      adapter.getDevicePreferences("device-a"),
      adapter.getDeviceProfile("profile-a"),
      adapter.getCapabilityDefinition("custom.test", 2),
      adapter.getDeviceHistory("device-a", "location-a"),
      adapter.getRules("location-a"),
      adapter.getClientRules("location-a"),
      adapter.getScenes("location-a"),
      adapter.getHub("hub-a"),
      adapter.getHubDrivers("hub-a")
    ]);

    expect(session.requests).toHaveLength(11);
  });
});
