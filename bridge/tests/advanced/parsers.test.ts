import { describe, expect, test } from "vitest";

import {
  AdvancedParseError,
  mergeDevicePages,
  parseDevicePage,
  parseRows
} from "../../src/advanced/parsers.js";

describe("Advanced response parsers", () => {
  test("prefers an explicit response link for pagination", () => {
    expect(
      parseDevicePage({
        items: [{ deviceId: "device-a", locationId: "location-a" }],
        links: { next: { href: "/advanced/cupcake-api/api/devices?page=1" } }
      })
    ).toEqual({
      items: [{ deviceId: "device-a", locationId: "location-a" }],
      next: "/advanced/cupcake-api/api/devices?page=1"
    });
  });

  test("falls back to page metadata only when no link is present", () => {
    expect(
      parseDevicePage({
        items: Array.from({ length: 200 }, (_, index) => ({ deviceId: `device-${index}` })),
        page: 0,
        max: 200,
        hasNext: true
      }).next
    ).toBe("fallback:1");
  });

  test("merges pages by deviceId with the latest response winning", () => {
    expect(
      mergeDevicePages([
        parseDevicePage({
          items: [
            { deviceId: "device-a", label: "old", locationId: "location-a" },
            { deviceId: "device-b", label: "second", locationId: "location-b" }
          ]
        }),
        parseDevicePage({
          items: [{ deviceId: "device-a", label: "latest", locationId: "location-c" }]
        })
      ])
    ).toEqual([
      { deviceId: "device-a", label: "latest", locationId: "location-c" },
      { deviceId: "device-b", label: "second", locationId: "location-b" }
    ]);
  });

  test("preserves devices from multiple locations", () => {
    expect(
      new Set(
        mergeDevicePages([
          parseDevicePage({
            items: [
              { deviceId: "device-a", locationId: "location-a" },
              { deviceId: "device-b", locationId: "location-b" }
            ]
          })
        ]).map((row) => row.locationId)
      )
    ).toEqual(new Set(["location-a", "location-b"]));
  });

  test("isolates malformed endpoint payloads with an endpoint category", () => {
    expect(() => parseRows("locations", { value: "not-an-array" })).toThrowError(
      new AdvancedParseError("locations", "missing_rows")
    );
    expect(() => parseDevicePage({ items: [{ label: "missing id" }] })).toThrowError(
      new AdvancedParseError("devices", "invalid_device_row")
    );
  });
});
