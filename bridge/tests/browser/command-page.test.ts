import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class FakeLocator {
  readonly click = vi.fn(async () => undefined);
  readonly fill = vi.fn(async () => undefined);
  readonly waitFor: ReturnType<typeof vi.fn>;

  private waited = false;

  constructor(
    private readonly matches: number,
    waitFails = false,
    private readonly matchesAfterWait?: number
  ) {
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
  detailHeading = new FakeLocator(1);
  readonly toggle = new FakeLocator(1);
  readonly close = vi.fn(async () => undefined);
  waitForTimeout?: ReturnType<typeof vi.fn>;
  currentUrl = "https://my.smartthings.com/location/loc_001";

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return false;
  }

  async goto(_url: string): Promise<void> {}

  getByRole(role: string, options?: { name?: string | RegExp }): FakeLocator {
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
    return new FakeLocator(0);
  }

  locator(selector: string): FakeLocator {
    expect(selector).toBe("[data-testid='device']:visible");
    return new FakeLocator(0, true);
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
    expect(page.detailHeading.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 500 });
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
    stalePage.detailHeading = new FakeLocator(0, true);
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

  test("opens only the exact overview card opener when another named button is visible", async () => {
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
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(exactOpener.click).toHaveBeenCalledTimes(1);
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
    const roomCard = new FakeLocator(1);
    const missingExactWrappers = new FakeLocator(0, true);
    const roomWrapper = new FakeLocator(1);
    const roomText = new FakeLocator(1);
    const container = new FakeLocator(1);
    container.filter = vi.fn(() => page.card);
    roomWrapper.filter = vi.fn(() => roomWrapper);
    page.card = overviewCard;
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name instanceof RegExp) return page.card;
      if (role === "button") return roomWrapper;
      return page.toggle;
    });
    page.getByText = vi.fn((text?: string) => (text === "Kitchen" ? roomText : new FakeLocator(0)));
    page.locator = vi.fn(() => missingExactWrappers);
    page.goto = vi.fn(async (url: string) => {
      page.currentUrl = url;
      page.card = roomCard;
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
    expect(roomWrapper.click).toHaveBeenCalledTimes(1);
    expect(roomCard.click).toHaveBeenCalledTimes(1);
    expect(missingExactWrappers.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
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
    const deviceCards = new FakeLocator(0, true);
    let roomActive = false;
    roomButton.click.mockImplementation(async () => {
      roomActive = true;
    });
    roomButtons.filter = vi.fn(() => roomButton);
    deviceCards.filter = vi.fn(() => (roomActive ? visibleDevice : hiddenDevice));
    page.card = hiddenDevice;
    page.getByText = vi.fn((text?: string) => (text === "Kitchen" ? roomText : deviceText));
    page.locator = vi.fn((selector: string) => {
      expect(selector).toBe("[data-testid='device']:visible");
      if (!roomActive) throw new Error("device_cards_queried_before_room_activation");
      return deviceCards;
    });
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hiddenDevice;
      if (role === "button") return roomButtons;
      if (role === "textbox") return new FakeLocator(0);
      return page.toggle;
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

    expect(roomButtons.filter).toHaveBeenCalledWith({ has: roomText });
    expect(roomButton.click).toHaveBeenCalledTimes(1);
    expect(visibleDevice.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("activates a heading-backed room surface when Cake exposes no room button", async () => {
    const page = new FakeCommandPage();
    const missingButtons = new FakeLocator(0);
    const heading = new FakeLocator(1);
    const roomSurface = new FakeLocator(1);
    const visibleDevice = new FakeLocator(1);
    const deviceCards = new FakeLocator(1);
    let roomActive = false;
    roomSurface.click.mockImplementation(async () => {
      roomActive = true;
    });
    heading.locator = vi.fn(() => roomSurface);
    missingButtons.filter = vi.fn(() => missingButtons);
    deviceCards.filter = vi.fn(() => visibleDevice);
    page.getByRole = vi.fn((role: string) => {
      if (role === "heading") return heading;
      if (role === "button") return missingButtons;
      return page.toggle;
    });
    page.getByText = vi.fn(() => new FakeLocator(1));
    page.locator = vi.fn((selector: string) => {
      expect(selector).toBe("[data-testid='device']:visible");
      if (!roomActive) throw new Error("device_cards_queried_before_room_activation");
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
    expect(roomSurface.click).toHaveBeenCalledTimes(1);
    expect(visibleDevice.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
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

  test("clicks the unique exact-name opener when one device card contains multiple buttons", async () => {
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
    expect(exactWrapper.getByRole).toHaveBeenCalledWith("button");
    expect(descendantButtons.filter).toHaveBeenCalledWith({ has: deviceText });
    expect(exactNameOpener.click).toHaveBeenCalledTimes(1);
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

    expect(opener.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("fails closed inside an exact wrapper when no scoped opener exists", async () => {
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

    await expect(
      executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" })
    ).rejects.toThrow("command_target_not_found");

    expect(pageLevelTarget.click).not.toHaveBeenCalled();
    expect(page.toggle.click).not.toHaveBeenCalled();
  });

  test("uses a scoped accessible-name opener inside the exact wrapper", async () => {
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

    expect(scopedNamedOpener.click).toHaveBeenCalledTimes(1);
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

  test("uses one exact device label inside its exact room when card buttons are ambiguous", async () => {
    const page = new FakeCommandPage();
    const ambiguousCards = new FakeLocator(2);
    ambiguousCards.filter = vi.fn(() => new FakeLocator(0, true));
    const roomButtons = new FakeLocator(2);
    const exactRoomButton = new FakeLocator(1);
    const roomText = new FakeLocator(1);
    roomButtons.filter = vi.fn(() => exactRoomButton);
    const heading = new FakeLocator(1);
    const room = new FakeLocator(1);
    const exactDeviceLabel = new FakeLocator(1);
    heading.locator = vi.fn(() => room);
    room.getByText = vi.fn(() => exactDeviceLabel);
    page.card = ambiguousCards;
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "heading") return heading;
      if (role === "button" && options?.name) return ambiguousCards;
      if (role === "button") return roomButtons;
      return page.toggle;
    });
    page.getByText = vi.fn((text?: string) => (text === "Kitchen" ? roomText : new FakeLocator(0)));
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

    expect(exactRoomButton.click).toHaveBeenCalledTimes(1);
    expect(room.getByText).toHaveBeenCalledWith("Safe plug", { exact: true });
    expect(exactDeviceLabel.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
  });

  test("targets a device refresh button by its exact localized accessible name", async () => {
    const page = new FakeCommandPage();
    const card = new FakeLocator(1);
    const refresh = new FakeLocator(1);
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
      if (role === "button" && options?.name instanceof RegExp && options.name.test("Air purifier")) {
        return card;
      }
      if (role === "button") return card;
      if (role === "slider") return missingNamedSlider;
      return new FakeLocator(0, true);
    });
    page.getByText = vi.fn((text?: string) =>
      text === "팬 속도" ? lateLabel : new FakeLocator(0, true)
    );
    page.waitForTimeout = vi.fn(async () => {
      labelVisible = true;
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

  test("serializes detail discovery and command pages in one browser context", async () => {
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
    await vi.waitFor(() => {
      expect(discoveryPage.waitForTimeout).toHaveBeenCalledTimes(1);
    });

    const command = executor.executeSwitch({
      deviceName: "Safe plug",
      locationId: "loc_001"
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(commandPage.card.click).not.toHaveBeenCalled();

    settle.resolve();
    await Promise.all([discovery, command]);

    expect(manager.openCommandPage).toHaveBeenCalledTimes(2);
    expect(commandPage.card.click).toHaveBeenCalledTimes(1);
    expect(commandPage.toggle.click).toHaveBeenCalledTimes(1);
  });
});
