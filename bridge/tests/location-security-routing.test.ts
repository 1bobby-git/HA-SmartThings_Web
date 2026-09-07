import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { AdvancedFirstCommandExecutor } from "../src/command/advanced-first-executor.js";
import { LocationSecurityCommandExecutor } from "../src/browser/location-security-command.js";

const request = { action: "armStay" as const, locationId: "loc_001" };
describe("Home Monitor direct-only route", () => {
  test("uses the dedicated location executor rather than device Advanced or markup", async () => {
    const execute = vi.fn(async () => "location_native" as const);
    const dom = vi.fn(async () => undefined);
    const device = vi.fn(async () => { throw new Error("wrong target type"); });
    const router = new AdvancedFirstCommandExecutor({ name: "advanced", execute: device },
      { executeDeviceAction: dom, executeLocationAction: dom }, { locationExecutor: { executeLocationAction: execute } });
    expect(await router.executeLocationAction(request)).toBe("location_native");
    expect(execute).toHaveBeenCalledExactlyOnceWith(request);
    expect(dom).not.toHaveBeenCalled(); expect(device).not.toHaveBeenCalled();
  });
  test("never falls back to markup after a configured security transport fails", async () => {
    const failure = new Error("command_security_dispatch_uncertain");
    const execute = vi.fn(async () => { throw failure; });
    const dom = vi.fn(async () => undefined);
    const router = new AdvancedFirstCommandExecutor({ name: "advanced", execute: vi.fn() },
      { executeDeviceAction: dom, executeLocationAction: dom }, { locationExecutor: { executeLocationAction: execute } });
    await expect(router.executeLocationAction(request)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(1); expect(dom).not.toHaveBeenCalled();
  });
  test("does not accept an invalid raw location identity or create a browser page", async () => {
    const getManager = vi.fn();
    const executor = new LocationSecurityCommandExecutor({ getManager, resolveRawLocationId: () => "../other" });
    await expect(executor.executeLocationAction(request)).rejects.toThrow("command_location_unknown");
    expect(getManager).not.toHaveBeenCalled();
  });
  test("fails clearly before dispatch without a running browser manager", async () => {
    const executor = new LocationSecurityCommandExecutor({ getManager: () => undefined, resolveRawLocationId: () => "synthetic-office" });
    await expect(executor.executeLocationAction(request)).rejects.toThrow("command_browser_unavailable");
  });
  test("runtime installs direct-only routing and preserves the legacy device executor", () => {
    const source = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(source).toContain("locationExecutor: locationSecurityExecutor");
    expect(source).toContain("new LocationSecurityCommandExecutor(");
    expect(source).toContain("const legacyCommandExecutor = new SmartThingsWebUiCommandExecutor(");
  });
});
