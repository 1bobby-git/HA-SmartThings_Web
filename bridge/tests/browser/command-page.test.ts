import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class FakeLocator {
  readonly click = vi.fn(async () => undefined);
  readonly dispatchEvent = vi.fn(async () => undefined);
  readonly fill = vi.fn(async () => undefined);
  readonly isVisible: ReturnType<typeof vi.fn>;
  readonly waitFor: ReturnType<typeof vi.fn>;

  private waited = false;

  constructor(
    private readonly matches: number,
    waitFails = false,
    private readonly matchesAfterWait?: number
  ) {
    this.isVisible = vi.fn(async () => !waitFails && matches > 0);
    this.waitFor = vi.fn(async () => {
      if (waitFails) throw new Error("not_visible");
      this.waited = true;
    });
  }

  async count(): Promise<number> {
    return this.waited && this.matchesAfterWait !== undefined ? this.matchesAfterWait : this.matches;
  }

  first(): FakeLocator {
    return this;
  }

  filter(): FakeLocator {
    return this;
  }

  getByRole(_role?: string, _options?: { name?: string | RegExp }): FakeLocator {
    return this;
  }

  getByText(_text?: string, _options?: { exact?: boolean }): FakeLocator {
    return this;
  }

  locator(_selector?: string): FakeLocator {
    return this;
  }
}

class FakeCommandPage {
  card = new FakeLocator(1);
  detailDialog = new FakeLocator(1);
  detailHeading = new FakeLocator(1);
  readonly toggle = new FakeLocator(1);
  readonly close = vi.fn(async () => undefined);
  waitForTimeout?: ReturnType<typeof vi.fn>;
  currentUrl = "https://my.smartthings.com/location/loc_001";

  constructor() {
    this.detailDialog.getByRole = (role, options) => this.getByRole(role!, options);
    this.detailDialog.getByText = (text, options) => this.getByText(text!, options);
    this.detailDialog.locator = (selector) => this.locator(selector!);
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return false;
  }

  async goto(_url: string): Promise<void> {}

  getByRole(role: string, options?: { name?: string | RegExp }): FakeLocator {
    if (role === "dialog") return this.detailDialog;
    if (role === "heading") return this.detailHeading;
    if (role === "button") {
      if (options?.name) {
        expect(options.name).toBeInstanceOf(RegExp);
        expect((options.name as RegExp).test("Safe plug Off")).toBe(true);
        expect((options.name as RegExp).test("Off Safe plug")).toBe(true);
      }
      return this.card;
    }
    expect(role).toBe("switch");
    return this.toggle;
  }

  getByText(_text?: string, _options?: { exact?: boolean }): FakeLocator {
    return new FakeLocator(1);
  }

  locator(selector: string): FakeLocator {
    expect(selector).toBe("[data-testid='device']:visible");
    return this.card;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SmartThingsWebUiCommandExecutor", () => {
  test("opens an isolated command page and clicks one accessible device toggle", async () => {
    const page = new FakeCommandPage();
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 5_000 });
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("waits for the SmartThings detail route before probing its controls", async () => {
    const page = new FakeCommandPage();
    const events: string[] = [];
    page.card.click.mockImplementation(async () => {
      events.push("card");
    });
    page.waitForTimeout = vi.fn(async () => {
      events.push("wait");
      page.currentUrl = "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    });
    page.toggle.click.mockImplementation(async () => {
      events.push("toggle");
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(events).toEqual(["card", "wait", "toggle"]);
  });

  test("fails closed without probing controls when a clicked card never opens its detail", async () => {
    const page = new FakeCommandPage();
    page.waitForTimeout = vi.fn(async () => undefined);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_target_not_found");

    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("does not mistake the background device card for an opened detail dialog", async () => {
    const page = new FakeCommandPage();
    page.detailDialog = new FakeLocator(0, true);
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    });
    page.waitForTimeout = vi.fn(async () => undefined);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_target_not_found");

    await expect(page.getByText("Safe plug", { exact: true }).count()).resolves.toBe(1);
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("identifies the exact detail dialog by its device and room heading", async () => {
    const page = new FakeCommandPage();
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    });
    page.waitForTimeout = vi.fn(async () => undefined);
    const getByRole = vi.spyOn(page, "getByRole");
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Living room",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(getByRole).toHaveBeenCalledWith("heading", {
      name: expect.any(RegExp)
    });
    const headingCall = getByRole.mock.calls.find(([role]) => role === "heading");
    const headingName = headingCall?.[1]?.name;
    expect(headingName).toBeInstanceOf(RegExp);
    expect((headingName as RegExp).test("Safe plug Living room")).toBe(true);
    expect((headingName as RegExp).test("Unsafe plug Living room")).toBe(false);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("rejects a prefix-matching detail heading when the room is unknown", async () => {
    const page = new FakeCommandPage();
    const wrongHeading = new FakeLocator(1);
    const missingHeading = new FakeLocator(0, true);
    page.detailDialog.filter = vi.fn((options?: { has?: FakeLocator }) =>
      options?.has === wrongHeading ? page.detailDialog : missingHeading
    );
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    });
    page.waitForTimeout = vi.fn(async () => undefined);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "dialog") return page.detailDialog;
      if (role === "heading") {
        const name = options?.name;
        const matches =
          name instanceof RegExp
            ? name.test("Safe plug 2")
            : name === "Safe plug 2";
        return matches ? wrongHeading : missingHeading;
      }
      if (role === "button") return page.card;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_target_not_found");

    expect(page.toggle.waitFor).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("uses the exact detail dialog's unique switch when its observed Power label is not addressable", async () => {
    const page = new FakeCommandPage();
    const missing = new FakeLocator(0, true);
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    });
    page.waitForTimeout = vi.fn(async () => undefined);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "dialog") return page.detailDialog;
      if (role === "heading") return page.detailHeading;
      if (role === "button") return page.card;
      if (options?.name) return missing;
      if (role === "switch") return page.toggle;
      return missing;
    });
    page.getByText = vi.fn(() => missing);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: [],
      controlLabel: "Power"
    });

    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("never falls back to a background switch outside the exact detail dialog", async () => {
    const page = new FakeCommandPage();
    const missing = new FakeLocator(0, true);
    const backgroundSwitch = new FakeLocator(1);
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    });
    page.waitForTimeout = vi.fn(async () => undefined);
    page.getByRole = vi.fn((role: string) => {
      if (role === "dialog") return page.detailDialog;
      if (role === "heading") return page.detailHeading;
      if (role === "button") return page.card;
      if (role === "switch") return backgroundSwitch;
      return missing;
    });
    page.detailDialog.getByRole = vi.fn(() => missing);
    page.detailDialog.getByText = vi.fn(() => missing);
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await expect(executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: [],
      controlLabel: "Power"
    })).rejects.toThrow("command_control_not_found");

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(backgroundSwitch.click).not.toHaveBeenCalled();
  });

  test("reports only fixed command stages while navigating to a fresh detail", async () => {
    const page = new FakeCommandPage();
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    });
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      undefined,
      { onDiagnostic: (stage) => diagnostics.push(stage) }
    );

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(diagnostics).toEqual([
      "foreground_requested",
      "foreground_ready",
      "warm_missing",
      "verified_route_missing",
      "fresh_page_opened",
      "fresh_location_ready",
      "fresh_navigation",
      "fresh_device_ready",
      "fresh_device_clicked",
      "fresh_detail_wait",
      "fresh_detail_ready",
      "fresh_control_probe"
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/Safe plug|loc_001|device_raw_001|https?:/u);
  });

  test("reuses one verified detail page for consecutive commands on the same device", async () => {
    const page = new FakeCommandPage();
    page.card.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    });
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      { warmPageTtlMs: 30_000 }
    );

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });
    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(2);
    expect(page.toggle.waitFor).toHaveBeenNthCalledWith(1, {
      state: "visible",
      timeout: 5_000
    });
    expect(page.toggle.waitFor).toHaveBeenNthCalledWith(2, {
      state: "visible",
      timeout: 1_500
    });
    expect(page.close).not.toHaveBeenCalled();
    expect(executor.hasWarmCommandPage()).toBe(true);
    expect(page.detailDialog.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 500 });
  });

  test("recovers a dismissed warm detail on the same exact room and device page", async () => {
    const page = new FakeCommandPage();
    const room = new FakeLocator(1);
    const roomHeading = new FakeLocator(1);
    roomHeading.locator = vi.fn(() => room);
    const diagnostics: string[] = [];
    const detailUrl =
      "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const defaultGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) =>
      role === "heading" && options?.name
        ? roomHeading
        : role === "button" && !options?.name
          ? room
          : defaultGetByRole(role, options)
    );
    page.card.click.mockImplementation(async () => {
      page.currentUrl = detailUrl;
      if (page.card.click.mock.calls.length === 2) {
        const recoveredDialog = new FakeLocator(1);
        recoveredDialog.getByRole = (role, options) => page.getByRole(role!, options);
        recoveredDialog.getByText = (text, options) => page.getByText(text!, options);
        recoveredDialog.locator = (selector) => page.locator(selector!);
        page.detailDialog = recoveredDialog;
      }
    });
    const manager = {
      openCommandPage: vi.fn(async () => {
        if (manager.openCommandPage.mock.calls.length > 1) {
          throw new Error("unexpected_new_page");
        }
        return page;
      })
    };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      {
        warmPageTtlMs: 30_000,
        onDiagnostic: (stage) => diagnostics.push(stage)
      }
    );

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Entry"
    });
    page.detailDialog = new FakeLocator(0, true);

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Entry",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(
      "https://my.smartthings.com/location/loc_001/rooms",
      { waitUntil: "domcontentloaded" }
    );
    expect(page.card.click).toHaveBeenCalledTimes(2);
    expect(room.dispatchEvent).toHaveBeenCalledWith("click");
    expect(room.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(2);
    expect(page.close).not.toHaveBeenCalled();
    expect(diagnostics).toContain("warm_dialog_missing");
    expect(diagnostics).toContain("warm_recovery_start");
    expect(diagnostics).toContain("warm_recovery_ready");
  });

  test("invalidates a warm page whose visible detail identity drifted", async () => {
    const stalePage = new FakeCommandPage();
    const freshPage = new FakeCommandPage();
    const pages = [stalePage, freshPage];
    const manager = { openCommandPage: vi.fn(async () => pages.shift()!) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      { warmPageTtlMs: 30_000 }
    );

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });
    stalePage.detailDialog = new FakeLocator(0, true);
    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
    expect(stalePage.close).toHaveBeenCalledTimes(1);
    expect(stalePage.toggle.click).toHaveBeenCalledTimes(1);
    expect(freshPage.card.click).toHaveBeenCalledTimes(1);
    expect(freshPage.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("revalidates the verified route after warm recovery fails", async () => {
    const warmPage = new FakeCommandPage();
    const routedPage = new FakeCommandPage();
    const room = new FakeLocator(1);
    const detailUrl =
      "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    warmPage.card.click.mockImplementation(async () => {
      warmPage.currentUrl = detailUrl;
    });
    warmPage.goto = vi.fn(async (url: string) => {
      warmPage.currentUrl = url;
    });
    const warmGetByRole = warmPage.getByRole.bind(warmPage);
    warmPage.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) =>
      role === "button" && !options?.name ? room : warmGetByRole(role, options)
    );
    routedPage.goto = vi.fn(async (url: string) => {
      routedPage.currentUrl = url;
    });
    const pages = [warmPage, routedPage];
    const manager = {
      openCommandPage: vi.fn(async () => {
        const page = pages.shift();
        if (!page) throw new Error("unexpected_new_page");
        return page;
      })
    };
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      {
        warmPageTtlMs: 30_000,
        onDiagnostic: (stage) => diagnostics.push(stage)
      }
    );

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Entry"
    });
    warmPage.detailDialog = new FakeLocator(0, true);

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Entry",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
    expect(warmPage.close).toHaveBeenCalledTimes(1);
    expect(routedPage.goto).toHaveBeenCalledWith(detailUrl, { waitUntil: "domcontentloaded" });
    expect(routedPage.card.click).not.toHaveBeenCalled();
    expect(routedPage.toggle.click).toHaveBeenCalledTimes(1);
    expect(diagnostics.indexOf("warm_recovery_failed")).toBeLessThan(
      diagnostics.indexOf("verified_route_opened")
    );
    expect(diagnostics.indexOf("verified_route_opened")).toBeLessThan(
      diagnostics.indexOf("verified_route_ready")
    );
    expect(diagnostics.filter((stage) => stage === "fresh_page_opened")).toHaveLength(1);
  });

  test("falls back to fresh navigation only after verified route validation fails", async () => {
    const warmPage = new FakeCommandPage();
    const routedPage = new FakeCommandPage();
    const freshPage = new FakeCommandPage();
    const detailUrl =
      "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    warmPage.card.click.mockImplementation(async () => {
      warmPage.currentUrl = detailUrl;
    });
    routedPage.detailDialog = new FakeLocator(0, true);
    routedPage.goto = vi.fn(async (url: string) => {
      routedPage.currentUrl = url;
    });
    freshPage.card.click.mockImplementation(async () => {
      freshPage.currentUrl = detailUrl;
    });
    const pages = [warmPage, routedPage, freshPage];
    const manager = {
      openCommandPage: vi.fn(async () => {
        const page = pages.shift();
        if (!page) throw new Error("unexpected_new_page");
        return page;
      })
    };
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      {
        warmPageTtlMs: 30_000,
        onDiagnostic: (stage) => diagnostics.push(stage)
      }
    );

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });
    warmPage.detailDialog = new FakeLocator(0, true);

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(3);
    expect(routedPage.goto).toHaveBeenCalledWith(detailUrl, { waitUntil: "domcontentloaded" });
    expect(routedPage.toggle.click).not.toHaveBeenCalled();
    expect(routedPage.close).toHaveBeenCalledTimes(1);
    expect(freshPage.card.click).toHaveBeenCalledTimes(1);
    expect(freshPage.toggle.click).toHaveBeenCalledTimes(1);
    expect(diagnostics.indexOf("verified_route_invalid")).toBeLessThan(
      diagnostics.lastIndexOf("fresh_page_opened")
    );
  });

  test("closes an expired warm command page before background discovery resumes", async () => {
    let now = 100;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const page = new FakeCommandPage();
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      undefined,
      { warmPageTtlMs: 1_000 }
    );
    try {
      await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });
      expect(executor.hasWarmCommandPage()).toBe(true);

      now = 1_101;
      expect(executor.hasWarmCommandPage()).toBe(false);
      await vi.waitFor(() => expect(page.close).toHaveBeenCalledTimes(1));
    } finally {
      clock.mockRestore();
    }
  });

  test("reopens a previously verified detail route after the warm page expires", async () => {
    let now = 100;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const firstPage = new FakeCommandPage();
    const routedPage = new FakeCommandPage();
    const detailUrl =
      "https://my.smartthings.com/location/loc_001/rooms/device/device_raw_001";
    firstPage.card.click.mockImplementation(async () => {
      firstPage.currentUrl = detailUrl;
    });
    routedPage.goto = vi.fn(async (url: string) => {
      routedPage.currentUrl = url;
    });
    const pages = [firstPage, routedPage];
    const manager = { openCommandPage: vi.fn(async () => pages.shift()!) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      undefined,
      { warmPageTtlMs: 1_000 }
    );
    try {
      await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

      now = 1_101;
      await executor.executeDeviceAction({
        deviceName: "Safe plug",
        locationId: "loc_001",
        command: "off",
        action: "off",
        component: "main",
        capability: "switch",
        attribute: "switch",
        arguments: []
      });

      expect(firstPage.close).toHaveBeenCalledTimes(1);
      expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
      expect(routedPage.goto).toHaveBeenCalledWith(detailUrl, {
        waitUntil: "domcontentloaded"
      });
      expect(routedPage.detailDialog.waitFor).toHaveBeenCalledWith({
        state: "visible",
        timeout: 1_500
      });
      expect(routedPage.card.click).not.toHaveBeenCalled();
      expect(routedPage.toggle.click).toHaveBeenCalledTimes(1);
      expect(routedPage.close).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("uses the only visible switch when the power control has no accessible Power name", async () => {
    const page = new FakeCommandPage();
    const missingNamedSwitch = new FakeLocator(0, true);
    const uniqueSwitch = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button") return page.card;
      if (role === "switch" && options?.name) return missingNamedSwitch;
      if (role === "switch") return uniqueSwitch;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(missingNamedSwitch.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 5_000
    });
    expect(missingNamedSwitch.click).not.toHaveBeenCalled();
    expect(uniqueSwitch.click).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("clicks the exact device wrapper instead of any descendant inline control", async () => {
    const page = new FakeCommandPage();
    const unsafeNamedButton = new FakeLocator(1);
    const deviceText = new FakeLocator(1);
    const visibleWrappers = new FakeLocator(1);
    const exactWrapper = new FakeLocator(1);
    const exactOpener = new FakeLocator(1);
    visibleWrappers.filter = vi.fn(() => exactWrapper);
    exactWrapper.getByRole = vi.fn(() => exactOpener);
    exactOpener.filter = vi.fn(() => exactOpener);
    page.getByText = vi.fn((text: string) =>
      text === "Safe plug" ? deviceText : new FakeLocator(0, true)
    );
    page.locator = vi.fn(() => visibleWrappers);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return unsafeNamedButton;
      if (role === "button") return unsafeNamedButton;
      return page.toggle;
    });
    page.goto = vi.fn(async () => undefined);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Living room",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(exactWrapper.click).toHaveBeenCalledTimes(1);
    expect(exactOpener.click).not.toHaveBeenCalled();
    expect(unsafeNamedButton.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("targets an observed switch label instead of a different generic power toggle", async () => {
    const page = new FakeCommandPage();
    const genericPower = new FakeLocator(1);
    const secondaryOutlet = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button") return page.card;
      if (role === "switch" && options?.name instanceof RegExp) {
        return options.name.test("Secondary outlet") ? secondaryOutlet : genericPower;
      }
      if (role === "checkbox") return new FakeLocator(0);
      return new FakeLocator(2);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "identifier_switch",
      attribute: "switch",
      controlLabel: "Secondary outlet",
      arguments: []
    });

    expect(secondaryOutlet.click).toHaveBeenCalledTimes(1);
    expect(genericPower.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("matches the Korean Power label for an English observed control", async () => {
    const page = new FakeCommandPage();
    const power = new FakeLocator(1);
    const missing = new FakeLocator(0, true);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button") return page.card;
      if (role === "switch" && options?.name instanceof RegExp) {
        return options.name.test("전원") ? power : missing;
      }
      return missing;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      controlLabel: "Power",
      arguments: []
    });

    expect(power.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(missing.waitFor).not.toHaveBeenCalled();
  });

  test("opens a device detail only to trigger the web app detail snapshot", async () => {
    const page = new FakeCommandPage();
    page.waitForTimeout = vi.fn(async () => undefined);
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.inspectDeviceDetails({
      deviceName: "Safe plug",
      locationId: "loc_001"
    });

    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).toHaveBeenCalledWith(1_500);
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("keeps camera detail pages open for the requested thumbnail settle window", async () => {
    const page = new FakeCommandPage();
    page.waitForTimeout = vi.fn(async () => undefined);
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.inspectDeviceDetails({
      deviceName: "Safe plug",
      locationId: "loc_001",
      detailSettleMs: 5_000
    });

    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).toHaveBeenCalledWith(5_000);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("uses the exact room route without probing a page-wide overview button", async () => {
    const page = new FakeCommandPage();
    const overviewCard = new FakeLocator(1, true);
    const missingExactWrappers = new FakeLocator(0, true);
    const roomDeviceScope = new FakeLocator(1);
    const roomButton = new FakeLocator(1);
    const roomHeading = new FakeLocator(1);
    const roomDeviceWrapper = new FakeLocator(1);
    const roomText = new FakeLocator(1);
    let inRooms = false;
    page.card = overviewCard;
    roomHeading.locator = vi.fn(() => roomButton);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "heading") return roomHeading;
      if (role === "button" && options?.name instanceof RegExp) return page.card;
      if (role === "button") return roomButton;
      return page.toggle;
    });
    page.getByText = vi.fn((text?: string) =>
      text === "Kitchen" ? roomText : new FakeLocator(inRooms ? 1 : 0)
    );
    roomDeviceScope.filter = vi.fn(() => (inRooms ? roomDeviceWrapper : missingExactWrappers));
    page.locator = vi.fn(() => roomDeviceScope);
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
      inRooms = true;
    });
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.inspectDeviceDetails({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Kitchen"
    });

    expect(page.goto).toHaveBeenCalledWith("https://my.smartthings.com/location/loc_001/rooms", {
      waitUntil: "domcontentloaded"
    });
    expect(overviewCard.waitFor).not.toHaveBeenCalled();
    expect(roomButton.dispatchEvent).toHaveBeenCalledWith("click");
    expect(roomButton.click).not.toHaveBeenCalled();
    expect(roomDeviceWrapper.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 3_000
    });
    expect(roomDeviceWrapper.click).toHaveBeenCalledTimes(1);
    expect(missingExactWrappers.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 1_000 });
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("activates the exact room before waiting for its lazily rendered device cards", async () => {
    const page = new FakeCommandPage();
    const hiddenDevice = new FakeLocator(0, true);
    const visibleDevice = new FakeLocator(1);
    const roomText = new FakeLocator(1);
    const deviceText = new FakeLocator(1);
    const roomButtons = new FakeLocator(1);
    const roomButton = new FakeLocator(1);
    const roomHeading = new FakeLocator(1);
    const deviceCards = new FakeLocator(0, true);
    let roomActive = false;
    roomButton.dispatchEvent.mockImplementation(async () => {
      roomActive = true;
    });
    roomHeading.locator = vi.fn(() => roomButton);
    roomButtons.filter = vi.fn(() => roomButton);
    deviceCards.filter = vi.fn(() => (roomActive ? visibleDevice : hiddenDevice));
    page.card = hiddenDevice;
    page.getByText = vi.fn((text?: string) => (text === "Kitchen" ? roomText : deviceText));
    page.locator = vi.fn((selector: string) => {
      expect(selector).toBe("[data-testid='device']:visible");
      return deviceCards;
    });
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "heading") return roomHeading;
      if (role === "button" && options?.name) return hiddenDevice;
      if (role === "button") return roomButtons;
      if (role === "textbox") return new FakeLocator(0);
      return page.toggle;
    });
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      undefined,
      { onDiagnostic: (stage) => diagnostics.push(stage) }
    );

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Kitchen"
    });

    expect(roomHeading.locator).toHaveBeenCalledWith("..");
    expect(roomButtons.filter).not.toHaveBeenCalled();
    expect(roomButton.isVisible).toHaveBeenCalledTimes(1);
    expect(roomButton.waitFor).not.toHaveBeenCalled();
    expect(roomButton.dispatchEvent).toHaveBeenCalledWith("click");
    expect(roomButton.click).not.toHaveBeenCalled();
    expect(visibleDevice.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([
      "foreground_requested",
      "foreground_ready",
      "warm_missing",
      "verified_route_missing",
      "fresh_page_opened",
      "fresh_location_ready",
      "fresh_navigation",
      "fresh_overview_probe",
      "fresh_overview_missing",
      "fresh_rooms_opened",
      "fresh_room_selected",
      "fresh_room_device_ready",
      "fresh_device_clicked",
      "fresh_detail_wait",
      "fresh_detail_ready",
      "fresh_control_probe"
    ]);
  });

  test("retries one fresh page when cold room navigation fails before control probing", async () => {
    const coldPage = new FakeCommandPage();
    const readyPage = new FakeCommandPage();
    const missing = new FakeLocator(0, true);
    coldPage.card = missing;
    coldPage.getByRole = vi.fn(() => missing);
    coldPage.getByText = vi.fn(() => missing);
    coldPage.locator = vi.fn(() => missing);
    coldPage.goto = vi.fn(async (url: string) => {
      coldPage.currentUrl = url;
    });
    const manager = {
      openCommandPage: vi
        .fn()
        .mockResolvedValueOnce(coldPage)
        .mockResolvedValueOnce(readyPage)
    };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Kitchen"
    });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
    expect(coldPage.toggle.click).not.toHaveBeenCalled();
    expect(coldPage.close).toHaveBeenCalledTimes(1);
    expect(readyPage.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("prefers the exact room heading parent before scanning page-wide buttons", async () => {
    const page = new FakeCommandPage();
    const heading = new FakeLocator(1);
    const roomSurface = new FakeLocator(1);
    const hiddenDevice = new FakeLocator(0, true);
    const visibleDevice = new FakeLocator(1);
    const deviceCards = new FakeLocator(1);
    let roomActive = false;
    roomSurface.dispatchEvent.mockImplementation(async () => {
      roomActive = true;
    });
    heading.locator = vi.fn(() => roomSurface);
    deviceCards.filter = vi.fn(() => (roomActive ? visibleDevice : hiddenDevice));
    const pageGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string) => {
      if (role === "heading") return heading;
      if (role === "button") throw new Error("page_wide_button_scan");
      return pageGetByRole(role);
    });
    page.getByText = vi.fn(() => new FakeLocator(1));
    page.locator = vi.fn((selector: string) => {
      expect(selector).toBe("[data-testid='device']:visible");
      return deviceCards;
    });
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Kitchen"
    });

    expect(heading.locator).toHaveBeenCalledWith("..");
    expect(page.getByRole).not.toHaveBeenCalledWith("button");
    expect(roomSurface.dispatchEvent).toHaveBeenCalledWith("click");
    expect(roomSurface.click).not.toHaveBeenCalled();
    expect(visibleDevice.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("fails closed when the exact room heading is ambiguous", async () => {
    const page = new FakeCommandPage();
    page.card = new FakeLocator(0, true);
    const duplicateHeadings = new FakeLocator(2);
    const pageGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string) =>
      role === "heading" ? duplicateHeadings : pageGetByRole(role)
    );
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.inspectDeviceDetails({
        deviceName: "Safe plug",
        locationId: "loc_001",
        roomName: "Kitchen"
      })
    ).rejects.toThrow("command_room_not_found");

    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("fails closed when the exact room heading parent is hidden", async () => {
    const page = new FakeCommandPage();
    page.card = new FakeLocator(0, true);
    const heading = new FakeLocator(1);
    const hiddenRoom = new FakeLocator(1, true);
    heading.locator = vi.fn(() => hiddenRoom);
    const pageGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string) =>
      role === "heading" ? heading : pageGetByRole(role)
    );
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.inspectDeviceDetails({
        deviceName: "Safe plug",
        locationId: "loc_001",
        roomName: "Kitchen"
      })
    ).rejects.toThrow("command_room_not_found");

    expect(hiddenRoom.dispatchEvent).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("fails closed when the accessible device target is ambiguous", async () => {
    const page = new FakeCommandPage();
    page.card = new FakeLocator(2);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })).rejects.toThrow(
      "command_target_ambiguous"
    );
    expect(page.toggle.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("rejects login drift without interacting with the page", async () => {
    const page = new FakeCommandPage();
    page.currentUrl = "https://account.samsung.com/accounts/v1/ST/signInGate";
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })).rejects.toThrow(
      "command_login_required"
    );
    expect(page.card.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("uses the accessible search box when the target card is not initially rendered", async () => {
    const page = new FakeCommandPage();
    const hiddenCard = new FakeLocator(1, true);
    const visibleCard = new FakeLocator(1);
    const deviceScope = new FakeLocator(1);
    const deviceText = new FakeLocator(1);
    const search = new FakeLocator(1);
    let searched = false;
    search.fill.mockImplementation(async () => {
      searched = true;
    });
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "textbox") return search;
      if (role === "button" && options?.name instanceof RegExp) {
        return searched ? visibleCard : hiddenCard;
      }
      if (role === "button") return hiddenCard;
      return page.toggle;
    });
    deviceScope.filter = vi.fn(() => (searched ? visibleCard : hiddenCard));
    page.getByText = vi.fn(() => deviceText);
    page.locator = vi.fn(() => deviceScope);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(search.fill).toHaveBeenCalledWith("Safe plug", { timeout: 15_000 });
    expect(visibleCard.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("reports when no accessible search fallback exists", async () => {
    const page = new FakeCommandPage();
    const hiddenCard = new FakeLocator(1, true);
    page.card = hiddenCard;
    page.getByRole = vi.fn((role: string) => {
      if (role === "button") return hiddenCard;
      if (role === "textbox") return new FakeLocator(0);
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })).rejects.toThrow(
      "command_search_not_found"
    );
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("refuses a page-wide named button when no exact device wrapper exists", async () => {
    const page = new FakeCommandPage();
    const pageWideNamedButton = new FakeLocator(1);
    page.card = new FakeLocator(0, true);
    page.getByRole = vi.fn((role: string) => {
      if (role === "button") return pageWideNamedButton;
      if (role === "textbox") return new FakeLocator(0);
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })).rejects.toThrow(
      "command_search_not_found"
    );
    expect(pageWideNamedButton.click).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("finds a device card by exact visible name within an accessible button", async () => {
    const page = new FakeCommandPage();
    const hiddenNamedCard = new FakeLocator(1, true);
    const visibleCard = new FakeLocator(1);
    const deviceText = new FakeLocator(1);
    const deviceScope = new FakeLocator(1);
    deviceScope.filter = vi.fn(() => visibleCard);
    page.locator = vi.fn(() => deviceScope);
    page.getByText = vi.fn(() => deviceText);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hiddenNamedCard;
      if (role === "button") return visibleCard;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(page.locator).toHaveBeenCalledWith("[data-testid='device']:visible");
    expect(page.getByText).toHaveBeenCalledWith("Safe plug", { exact: true });
    expect(deviceScope.filter).toHaveBeenCalledWith({ has: deviceText });
    expect(visibleCard.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("clicks the exact wrapper when one device card contains multiple inline buttons", async () => {
    const page = new FakeCommandPage();
    const hiddenNamedCard = new FakeLocator(1, true);
    const deviceText = new FakeLocator(1);
    const deviceScope = new FakeLocator(1);
    const exactWrapper = new FakeLocator(1);
    const descendantButtons = new FakeLocator(2);
    const exactNameOpener = new FakeLocator(1);
    deviceScope.filter = vi.fn(() => exactWrapper);
    exactWrapper.getByRole = vi.fn((role: string) =>
      role === "button" ? descendantButtons : new FakeLocator(0, true)
    );
    descendantButtons.filter = vi.fn(() => exactNameOpener);
    page.locator = vi.fn(() => deviceScope);
    page.getByText = vi.fn(() => deviceText);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hiddenNamedCard;
      if (role === "button") return descendantButtons;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(deviceScope.filter).toHaveBeenCalledWith({ has: deviceText });
    expect(exactWrapper.click).toHaveBeenCalledTimes(1);
    expect(exactWrapper.getByRole).not.toHaveBeenCalled();
    expect(descendantButtons.filter).not.toHaveBeenCalled();
    expect(exactNameOpener.click).not.toHaveBeenCalled();
    expect(descendantButtons.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("scopes exact device-card lookup to visible wrappers", async () => {
    const page = new FakeCommandPage();
    const hiddenNamedCard = new FakeLocator(1, true);
    const deviceText = new FakeLocator(1);
    const visibleDeviceScope = new FakeLocator(1);
    const exactWrapper = new FakeLocator(1);
    const opener = new FakeLocator(1);
    visibleDeviceScope.filter = vi.fn(() => exactWrapper);
    exactWrapper.getByRole = vi.fn(() => opener);
    opener.filter = vi.fn(() => opener);
    page.locator = vi.fn((selector: string) => {
      expect(selector).toBe("[data-testid='device']:visible");
      return visibleDeviceScope;
    });
    page.getByText = vi.fn(() => deviceText);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hiddenNamedCard;
      if (role === "button") return opener;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(exactWrapper.click).toHaveBeenCalledTimes(1);
    expect(opener.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("clicks the exact wrapper when it has no descendant opener", async () => {
    const page = new FakeCommandPage();
    const deviceText = new FakeLocator(1);
    const visibleDeviceScope = new FakeLocator(1);
    const exactWrapper = new FakeLocator(1);
    const missingScopedOpener = new FakeLocator(0, true);
    const pageLevelTarget = new FakeLocator(1);
    visibleDeviceScope.filter = vi.fn(() => exactWrapper);
    exactWrapper.getByRole = vi.fn(() => missingScopedOpener);
    page.locator = vi.fn(() => visibleDeviceScope);
    page.getByText = vi.fn(() => deviceText);
    page.getByRole = vi.fn((role: string) => {
      if (role === "button") return pageLevelTarget;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(exactWrapper.click).toHaveBeenCalledTimes(1);
    expect(missingScopedOpener.click).not.toHaveBeenCalled();
    expect(pageLevelTarget.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("does not use a descendant accessible-name control when the exact wrapper exists", async () => {
    const page = new FakeCommandPage();
    const deviceText = new FakeLocator(1);
    const visibleDeviceScope = new FakeLocator(1);
    const exactWrapper = new FakeLocator(1);
    const missingTextOpener = new FakeLocator(0);
    const scopedNamedOpener = new FakeLocator(1);
    const pageLevelTarget = new FakeLocator(1);
    visibleDeviceScope.filter = vi.fn(() => exactWrapper);
    exactWrapper.getByRole = vi.fn(
      (_role: string, options?: { name?: string | RegExp }) =>
        options?.name ? scopedNamedOpener : missingTextOpener
    );
    missingTextOpener.filter = vi.fn(() => missingTextOpener);
    page.locator = vi.fn(() => visibleDeviceScope);
    page.getByText = vi.fn(() => deviceText);
    page.getByRole = vi.fn((role: string) => {
      if (role === "button") return pageLevelTarget;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(exactWrapper.click).toHaveBeenCalledTimes(1);
    expect(scopedNamedOpener.click).not.toHaveBeenCalled();
    expect(pageLevelTarget.click).not.toHaveBeenCalled();
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("prefers one exact device name over multiple partial-name cards", async () => {
    const page = new FakeCommandPage();
    const partialCards = new FakeLocator(5);
    const roomWrapperButtons = new FakeLocator(2);
    const deviceScope = new FakeLocator(4);
    const exactCard = new FakeLocator(1);
    const exactText = new FakeLocator(1);
    deviceScope.filter = vi.fn(() => exactCard);
    page.locator = vi.fn(() => deviceScope);
    page.getByText = vi.fn(() => exactText);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) return partialCards;
      if (role === "button") return roomWrapperButtons;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "거실",
      locationId: "loc_001",
      command: "setVolume",
      action: "setVolume",
      component: "main",
      capability: "audioVolume",
      attribute: "volume",
      arguments: [45]
    });

    expect(page.locator).toHaveBeenCalledWith("[data-testid='device']:visible");
    expect(page.getByText).toHaveBeenCalledWith("거실", { exact: true });
    expect(deviceScope.filter).toHaveBeenCalledWith({ has: exactText });
    expect(exactCard.click).toHaveBeenCalledTimes(1);
    expect(partialCards.click).not.toHaveBeenCalled();
    expect(roomWrapperButtons.click).not.toHaveBeenCalled();
    expect(page.toggle.fill).toHaveBeenCalledWith("45", { timeout: 15_000 });
  });

  test("waits for a late exact device-name card before falling back to partial ambiguity", async () => {
    const page = new FakeCommandPage();
    const partialCards = new FakeLocator(5);
    const roomWrapperButtons = new FakeLocator(2);
    const deviceScope = new FakeLocator(4);
    const lateExactCard = new FakeLocator(0, false, 1);
    page.getByText = vi.fn(() => new FakeLocator(0, false, 1));
    deviceScope.filter = vi.fn(() => lateExactCard);
    page.locator = vi.fn(() => deviceScope);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) return partialCards;
      if (role === "button") return roomWrapperButtons;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "거실",
      locationId: "loc_001",
      command: "setVolume",
      action: "setVolume",
      component: "main",
      capability: "audioVolume",
      attribute: "volume",
      arguments: [45]
    });

    expect(lateExactCard.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
    expect(lateExactCard.click).toHaveBeenCalledTimes(1);
    expect(partialCards.click).not.toHaveBeenCalled();
    expect(roomWrapperButtons.click).not.toHaveBeenCalled();
    expect(page.toggle.fill).toHaveBeenCalledWith("45", { timeout: 15_000 });
  });

  test("keeps ambiguity when multiple exact device-name cards exist", async () => {
    const page = new FakeCommandPage();
    const partialCards = new FakeLocator(5);
    const roomWrapperButtons = new FakeLocator(2);
    const deviceScope = new FakeLocator(4);
    const duplicateExactCards = new FakeLocator(2);
    page.getByText = vi.fn(() => new FakeLocator(2));
    deviceScope.filter = vi.fn(() => duplicateExactCards);
    page.locator = vi.fn(() => deviceScope);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) return partialCards;
      if (role === "button") return roomWrapperButtons;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeSwitch({ deviceName: "거실", locationId: "loc_001" })).rejects.toThrow(
      "command_target_ambiguous"
    );

    expect(duplicateExactCards.click).not.toHaveBeenCalled();
    expect(partialCards.click).not.toHaveBeenCalled();
    expect(roomWrapperButtons.click).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("waits for a preferred Refresh button before falling back to ambiguous buttons", async () => {
    const page = new FakeCommandPage();
    const refresh = new FakeLocator(0, false, 1);
    const ambiguousButtons = new FakeLocator(2);
    ambiguousButtons.filter = vi.fn(() => new FakeLocator(0, true));
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Safe plug Off")) {
        return page.card;
      }
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Refresh")) {
        return refresh;
      }
      if (role === "button") return ambiguousButtons;
      return page.toggle;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "refresh",
      action: "refresh",
      component: "main",
      capability: "refresh",
      attribute: "refresh",
      arguments: []
    });

    expect(refresh.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 5_000 });
    expect(refresh.click).toHaveBeenCalledTimes(1);
    expect(ambiguousButtons.click).not.toHaveBeenCalled();
  });

  test("fails closed when the command page is on a different location", async () => {
    const page = new FakeCommandPage();
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      () => "loc_999"
    );

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_location_unknown");
    expect(page.card.click).not.toHaveBeenCalled();
  });

  test("fails closed when a normalized command page has no concrete location route", async () => {
    const page = new FakeCommandPage();
    page.currentUrl = "https://my.smartthings.com/location";
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      (raw) => raw
    );

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_location_unknown");
    expect(page.card.click).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("changes location through the accessible picker before targeting the device", async () => {
    const page = new FakeCommandPage();
    page.currentUrl = "https://my.smartthings.com/location/raw-current";
    const picker = new FakeLocator(1);
    const target = new FakeLocator(1);
    target.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/raw-target";
    });
    const originalGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Other home")) {
        return picker;
      }
      if (role === "link") return target;
      return originalGetByRole(role, options);
    });
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      (raw) => (raw === "raw-current" ? "loc_999" : "loc_001")
    );

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      locationNames: { loc_001: "Target home", loc_999: "Other home" }
    });

    expect(picker.click).toHaveBeenCalledTimes(1);
    expect(target.click).toHaveBeenCalledTimes(1);
    expect(page.card.click).toHaveBeenCalledTimes(1);
  });

  test("waits for an asynchronous SPA location route before targeting the device", async () => {
    const page = new FakeCommandPage();
    page.currentUrl = "https://my.smartthings.com/location/raw-current";
    const picker = new FakeLocator(1);
    const target = new FakeLocator(1);
    target.click.mockImplementation(async () => undefined);
    page.waitForTimeout = vi.fn(async () => {
      page.currentUrl = page.card.click.mock.calls.length > 0
        ? "https://my.smartthings.com/location/raw-target/device/device_raw_001"
        : "https://my.smartthings.com/location/raw-target";
    });
    const originalGetByRole = page.getByRole.bind(page);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Other home")) {
        return picker;
      }
      if (role === "link") return target;
      return originalGetByRole(role, options);
    });
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      (raw) => (raw === "raw-current" ? "loc_999" : "loc_001")
    );

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      locationNames: { loc_001: "Target home", loc_999: "Other home" }
    });

    expect(page.waitForTimeout).toHaveBeenCalled();
    expect(page.card.click).toHaveBeenCalledTimes(1);
  });

  test("scrolls the location page until a virtualized accessible card is rendered", async () => {
    const page = new FakeCommandPage() as FakeCommandPage & {
      mouse: { move: ReturnType<typeof vi.fn>; wheel: ReturnType<typeof vi.fn> };
      waitForTimeout: ReturnType<typeof vi.fn>;
    };
    let scrolls = 0;
    const hidden = new FakeLocator(0, true);
    const visible = new FakeLocator(1);
    visible.click.mockImplementation(async () => {
      page.currentUrl = "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    });
    const container = new FakeLocator(1);
    container.filter = vi.fn(() => (scrolls >= 2 ? visible : hidden));
    page.locator = vi.fn(() => container);
    page.card = hidden;
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hidden;
      if (role === "button") return container;
      if (role === "textbox") return new FakeLocator(0);
      return page.toggle;
    });
    page.mouse = {
      move: vi.fn(async () => undefined),
      wheel: vi.fn(async () => {
        scrolls += 1;
      })
    };
    page.waitForTimeout = vi.fn(async () => undefined);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(page.mouse.wheel).toHaveBeenCalledTimes(2);
    expect(visible.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("uses one exact device wrapper inside its exact room when page-wide buttons are ambiguous", async () => {
    const page = new FakeCommandPage();
    const missingOverviewWrapper = new FakeLocator(0, true);
    const deviceScope = new FakeLocator(1);
    const exactDeviceWrapper = new FakeLocator(1);
    const roomButtons = new FakeLocator(2);
    const exactRoomButton = new FakeLocator(1);
    const roomHeading = new FakeLocator(1);
    const roomText = new FakeLocator(1);
    roomButtons.filter = vi.fn(() => exactRoomButton);
    let roomActive = false;
    exactRoomButton.dispatchEvent.mockImplementation(async () => {
      roomActive = true;
    });
    roomHeading.locator = vi.fn(() => exactRoomButton);
    deviceScope.filter = vi.fn(() => (roomActive ? exactDeviceWrapper : missingOverviewWrapper));
    page.card = missingOverviewWrapper;
    page.locator = vi.fn(() => deviceScope);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "heading") return roomHeading;
      if (role === "button" && options?.name) return new FakeLocator(2);
      if (role === "button") return roomButtons;
      return page.toggle;
    });
    page.getByText = vi.fn((text?: string) => (text === "Kitchen" ? roomText : new FakeLocator(1)));
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001",
      roomName: "Kitchen"
    });

    expect(exactRoomButton.dispatchEvent).toHaveBeenCalledWith("click");
    expect(exactRoomButton.click).not.toHaveBeenCalled();
    expect(exactDeviceWrapper.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("targets a device refresh button by its exact localized accessible name", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const refresh = new FakeLocator(1);
    page.card = card;
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) {
        if (options.name.test("Safe sensor")) return card;
        if (options.name.test("새로고침")) return refresh;
      }
      if (role === "button") return card;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe sensor",
      locationId: "loc_001",
      command: "refresh",
      action: "refresh",
      component: "main",
      capability: "refresh",
      attribute: "refresh",
      arguments: []
    });

    expect(card.click).toHaveBeenCalledTimes(1);
    expect(refresh.click).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("fills the single observed numeric slider without optimistic state mutation", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const slider = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Motion sensor")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "slider") return slider;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Motion sensor",
      locationId: "loc_001",
      command: "setNumber",
      action: "setNumber",
      component: "main",
      capability: "detectionFrequency",
      attribute: "detectionFrequency",
      arguments: [60]
    });

    expect(slider.fill).toHaveBeenCalledWith("60", { timeout: 15_000 });
  });

  test("fills a range input scoped by the visible swatch label when the slider name is generic", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingNamedSlider = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const rangeInput = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) => (role === "slider" ? rangeInput : new FakeLocator(0, true)));
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Speaker")) return card;
      if (role === "button") return card;
      if (role === "slider") return missingNamedSlider;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) => (text === "Volume" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Speaker",
      locationId: "loc_001",
      command: "setVolume",
      action: "setVolume",
      component: "main",
      capability: "audioVolume",
      attribute: "volume",
      controlLabel: "Volume",
      arguments: [45]
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(swatch.getByRole).toHaveBeenCalledWith("slider");
    expect(rangeInput.fill).toHaveBeenCalledWith("45", { timeout: 15_000 });
  });

  test("maps an Air Purifier percent state to the localized fan-speed slider", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingNamedSlider = new FakeLocator(0, true);
    const missingEnglishLabel = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const rangeInput = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "slider" ? rangeInput : new FakeLocator(0, true)
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "dialog") return page.detailDialog;
      if (role === "heading") return page.detailHeading;
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "slider") return missingNamedSlider;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) =>
      text === "팬 속도" ? label : missingEnglishLabel
    );
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setNumber",
      action: "setNumber",
      component: "main",
      capability: "fanSpeedPercent",
      attribute: "percent",
      arguments: [55]
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(missingEnglishLabel.waitFor).not.toHaveBeenCalled();
    expect(rangeInput.waitFor).toHaveBeenCalledWith({
      state: "visible",
      timeout: 5_000
    });
    expect(rangeInput.fill).toHaveBeenCalledWith("55", { timeout: 15_000 });
  });

  test("waits for a late-rendered exact swatch label before rejecting the control", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingNamedSlider = new FakeLocator(0, true);
    const detailIdentity = new FakeLocator(1);
    let labelVisible = false;
    const lateLabel = new FakeLocator(0);
    lateLabel.count = vi.fn(async () => (labelVisible ? 1 : 0));
    const swatch = new FakeLocator(1);
    const rangeInput = new FakeLocator(1);
    lateLabel.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "slider" ? rangeInput : new FakeLocator(0, true)
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "dialog") return page.detailDialog;
      if (role === "heading") return page.detailHeading;
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "slider") return missingNamedSlider;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) => {
      if (text === "팬 속도") return lateLabel;
      if (text === "Air purifier") return detailIdentity;
      return new FakeLocator(0, true);
    });
    page.waitForTimeout = vi.fn(async () => {
      labelVisible = true;
      page.currentUrl = "https://my.smartthings.com/location/loc_001/device/device_raw_001";
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setNumber",
      action: "setNumber",
      component: "main",
      capability: "fanSpeedPercent",
      attribute: "percent",
      arguments: [60]
    });

    expect(page.waitForTimeout).toHaveBeenCalled();
    expect(lateLabel.waitFor).toHaveBeenCalled();
    expect(rangeInput.fill).toHaveBeenCalledWith("60", { timeout: 15_000 });
  });

  test("clicks a generic toggle scoped by its visible swatch label", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingNamedSwitch = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const toggle = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) => (role === "switch" ? toggle : new FakeLocator(0, true)));
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Speaker")) return card;
      if (role === "button") return card;
      if (role === "switch") return missingNamedSwitch;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text: string) => (text === "Power" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Speaker",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      controlLabel: "Power",
      arguments: []
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(toggle.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(missingNamedSwitch.waitFor).not.toHaveBeenCalled();
  });

  test("clicks a checkbox toggle only inside its observed exact swatch label", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingSwitch = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const checkbox = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) => {
      if (role === "checkbox") return checkbox;
      return missingSwitch;
    });
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Safe plug")) {
        return card;
      }
      if (role === "button") return card;
      return missingSwitch;
    });
    page.getByText = vi.fn((text: string) => (text === "Power" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "off",
      action: "off",
      component: "main",
      capability: "switch",
      attribute: "switch",
      controlLabel: "Power",
      arguments: []
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(checkbox.click).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  test("clicks a button toggle only inside its observed exact swatch label", async () => {
    const nowValues = [1_000, 1_000, 15_999, 15_999];
    const now = vi.spyOn(Date, "now").mockImplementation(
      () => nowValues.shift() ?? 15_999
    );
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingToggle = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const button = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "button" ? button : missingToggle
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Safe plug")) {
        return card;
      }
      if (role === "button") return card;
      return missingToggle;
    });
    page.getByText = vi.fn((text: string) => (text === "Power" ? label : missingToggle));
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page) }),
      undefined,
      { onDiagnostic: (stage) => diagnostics.push(stage) }
    );

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      controlLabel: "Power",
      arguments: []
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(button.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
    expect(button.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(card.click).not.toHaveBeenCalled();
    expect(diagnostics).toEqual([
      "foreground_requested",
      "foreground_ready",
      "warm_missing",
      "verified_route_missing",
      "fresh_page_opened",
      "fresh_location_ready",
      "fresh_navigation",
      "fresh_device_ready",
      "fresh_device_clicked",
      "fresh_detail_wait",
      "fresh_detail_ready",
      "fresh_control_probe",
      "toggle_named_control_missing",
      "toggle_labeled_scope_found",
      "toggle_scoped_switch_0",
      "toggle_scoped_checkbox_0",
      "toggle_scoped_button_1",
      "toggle_click_start",
      "toggle_click_done"
    ]);
    now.mockRestore();
  });

  test("prefers one accessible switch when the same observed toggle also exposes a checkbox", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingNamed = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const accessibleSwitch = new FakeLocator(1);
    const underlyingCheckbox = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "switch" ? accessibleSwitch : underlyingCheckbox
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button") return card;
      if (options?.name) return missingNamed;
      return missingNamed;
    });
    page.getByText = vi.fn((text: string) =>
      text === "Power" ? label : new FakeLocator(0, true)
    );
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Safe plug",
      locationId: "loc_001",
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      controlLabel: "Power",
      arguments: []
    });

    expect(accessibleSwitch.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(underlyingCheckbox.click).not.toHaveBeenCalled();
  });

  test("fails closed when an observed label contains multiple accessible switches", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missing = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const ambiguousSwitches = new FakeLocator(2);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "switch" ? ambiguousSwitches : missing
    );
    page.getByRole = vi.fn((role: string) => (role === "button" ? card : missing));
    page.getByText = vi.fn((text: string) => (text === "Power" ? label : missing));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.executeDeviceAction({
        deviceName: "Safe plug",
        locationId: "loc_001",
        command: "on",
        action: "on",
        component: "main",
        capability: "switch",
        attribute: "switch",
        controlLabel: "Power",
        arguments: []
      })
    ).rejects.toThrow("command_control_ambiguous");

    expect(ambiguousSwitches.click).not.toHaveBeenCalled();
  });

  test("fails closed when an observed label contains multiple button toggles", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missing = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const ambiguousButtons = new FakeLocator(2);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn((role: string) =>
      role === "button" ? ambiguousButtons : missing
    );
    page.getByRole = vi.fn((role: string) => (role === "button" ? card : missing));
    page.getByText = vi.fn((text: string) => (text === "Power" ? label : missing));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(
      executor.executeDeviceAction({
        deviceName: "Safe plug",
        locationId: "loc_001",
        command: "on",
        action: "on",
        component: "main",
        capability: "switch",
        attribute: "switch",
        controlLabel: "Power",
        arguments: []
      })
    ).rejects.toThrow("command_control_ambiguous");

    expect(ambiguousButtons.click).not.toHaveBeenCalled();
  });

  test("selects an observed option from its exact enumerated control", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const combo = new FakeLocator(1);
    const option = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "combobox" && options?.name instanceof RegExp && options.name.test("Mode")) {
        return combo;
      }
      if (role === "option" && options?.name instanceof RegExp && options.name.test("eco")) return option;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setOption",
      action: "setOption",
      component: "main",
      capability: "customMode",
      attribute: "mode",
      controlLabel: "Mode",
      arguments: ["eco"]
    });

    expect(combo.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(option.click).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  test("clicks the observed enum data-command inside the labeled swatch when no combobox exists", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingCombo = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const option = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn(() => new FakeLocator(0, true));
    swatch.locator = vi.fn((selector: string) =>
      selector === '[data-command="setEco"]' ? option : new FakeLocator(0, true)
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "combobox") return missingCombo;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) => (text === "Mode" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setOption",
      action: "setOption",
      component: "main",
      capability: "customMode",
      attribute: "mode",
      controlLabel: "Mode",
      optionCommand: "setEco",
      arguments: ["eco"]
    });

    expect(label.locator).toHaveBeenCalledWith("..");
    expect(swatch.locator).toHaveBeenCalledWith('[data-command="setEco"]');
    expect(option.click).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  test("clicks the observed fan-mode data-command inside the labeled swatch", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    const option = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.locator = vi.fn((selector: string) =>
      selector === '[data-command="setSleep"]' ? option : new FakeLocator(0, true)
    );
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) => (text === "Fan mode" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setFanMode",
      action: "setFanMode",
      component: "main",
      capability: "fanMode",
      attribute: "fanMode",
      controlLabel: "Fan mode",
      optionCommand: "setSleep",
      arguments: ["sleep"]
    });

    expect(swatch.locator).toHaveBeenCalledWith('[data-command="setSleep"]');
    expect(option.click).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  test("does not guess enum option labels when observed option text is not rendered", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const missingCombo = new FakeLocator(0, true);
    const label = new FakeLocator(1);
    const swatch = new FakeLocator(1);
    label.locator = vi.fn(() => swatch);
    swatch.getByRole = vi.fn(() => new FakeLocator(0, true));
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "combobox") return missingCombo;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) => (text === "Mode" ? label : new FakeLocator(0, true)));
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setOption",
      action: "setOption",
      component: "main",
      capability: "customMode",
      attribute: "mode",
      controlLabel: "Mode",
      arguments: ["eco"]
    })).rejects.toThrow("command_control_not_found");
  });

  test("never falls back to an unrelated single control when the observed name is missing", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const unrelatedCombo = new FakeLocator(1);
    page.card = card;
    page.getByText = vi.fn(() => new FakeLocator(0, true));
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "combobox" && options?.name !== undefined) return new FakeLocator(0, true);
      if (role === "combobox") return unrelatedCombo;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await expect(executor.executeDeviceAction({
      deviceName: "Air purifier",
      locationId: "loc_001",
      command: "setOption",
      action: "setOption",
      component: "main",
      capability: "customMode",
      attribute: "mode",
      controlLabel: "Mode",
      arguments: ["eco"]
    })).rejects.toThrowError("command_control_not_found");

    expect(unrelatedCombo.click).not.toHaveBeenCalled();
  });

  test("uses observed cover button labels and position sliders", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const open = new FakeLocator(1);
    const slider = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Shade")) return card;
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Open shade")) return open;
      if (role === "button") return card;
      if (role === "slider") return slider;
      return new FakeLocator(0, true);
    });
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeDeviceAction({
      deviceName: "Shade",
      locationId: "loc_001",
      command: "openShade",
      action: "openShade",
      component: "main",
      capability: "windowShade",
      attribute: "windowShade",
      controlLabel: "Open shade",
      arguments: []
    });
    await executor.executeDeviceAction({
      deviceName: "Shade",
      locationId: "loc_001",
      command: "setPosition",
      action: "setPosition",
      component: "main",
      capability: "windowShadeLevel",
      attribute: "shadeLevel",
      controlLabel: "Shade level",
      arguments: [45]
    });

    expect(open.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(slider.fill).toHaveBeenCalledWith("45", { timeout: 15_000 });
  });

  test("executes one exact scene card and one Home Monitor action", async () => {
    const page = new FakeCommandPage();
    const scene = new FakeLocator(1);
    const disarm = new FakeLocator(1);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) {
        if (options.name.test("Evening")) return scene;
        if (options.name.test("Disarm")) return disarm;
      }
      return new FakeLocator(0, true);
    });
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.executeScene({ sceneName: "Evening", locationId: "loc_001" });
    await executor.executeLocationAction({ locationId: "loc_001", action: "disarm" });

    expect(scene.click).toHaveBeenCalledTimes(1);
    expect(disarm.click).toHaveBeenCalledTimes(1);
    expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
  });

  test("preempts background detail discovery when a foreground command arrives", async () => {
    const discoveryPage = new FakeCommandPage();
    const commandPage = new FakeCommandPage();
    const settle = deferred();
    discoveryPage.waitForTimeout = vi.fn(async () => settle.promise);
    const manager = {
      openCommandPage: vi.fn(async () =>
        manager.openCommandPage.mock.calls.length === 1 ? discoveryPage : commandPage
      )
    };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    const discovery = executor.inspectDeviceDetails({
      deviceName: "Safe plug",
      locationId: "loc_001"
    });
    const discoveryResult = discovery.then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.waitFor(() => {
      expect(discoveryPage.waitForTimeout).toHaveBeenCalledTimes(1);
    });

    const command = executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001"
    });
    try {
      await vi.waitFor(() => expect(discoveryPage.close).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(commandPage.toggle.click).toHaveBeenCalledTimes(1), {
        timeout: 500
      });
      await expect(discoveryResult).resolves.toMatchObject({
        message: "detail_discovery_preempted"
      });
      await command;

      expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
      expect(commandPage.card.click).toHaveBeenCalledTimes(1);
      expect(commandPage.toggle.click).toHaveBeenCalledTimes(1);
    } finally {
      settle.resolve();
      await Promise.allSettled([discovery, command]);
    }
  });
});
