import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class FakeLocator {
  readonly click = vi.fn(async () => undefined);
  readonly fill = vi.fn(async () => undefined);
  readonly waitFor: ReturnType<typeof vi.fn>;

  constructor(private readonly matches: number, waitFails = false) {
    this.waitFor = vi.fn(async () => {
      if (waitFails) throw new Error("not_visible");
    });
  }

  async count(): Promise<number> {
    return this.matches;
  }

  first(): FakeLocator {
    return this;
  }

  filter(): FakeLocator {
    return this;
  }
}

class FakeCommandPage {
  card = new FakeLocator(1);
  readonly toggle = new FakeLocator(1);
  readonly close = vi.fn(async () => undefined);
  currentUrl = "https://my.smartthings.com/location/loc_001";

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return false;
  }

  async goto(): Promise<void> {}

  getByRole(role: string, options?: { name?: string | RegExp }): FakeLocator {
    if (role === "button") {
      expect(options?.name).toBeInstanceOf(RegExp);
      expect((options?.name as RegExp).test("Safe plug Off")).toBe(true);
      expect((options?.name as RegExp).test("Off Safe plug")).toBe(true);
      return this.card;
    }
    expect(role).toBe("switch");
    return this.toggle;
  }

  getByText(): FakeLocator {
    return new FakeLocator(0);
  }
}

describe("SmartThingsWebUiCommandExecutor", () => {
  test("opens an isolated command page and clicks one accessible device toggle", async () => {
    const page = new FakeCommandPage();
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(manager.openCommandPage).toHaveBeenCalledTimes(1);
    expect(page.card.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: 15_000 });
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(1);
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
    visibleCard.filter = vi.fn(() => visibleCard);
    page.getByRole = vi.fn((role: string, options?: { name?: string | RegExp }) => {
      if (role === "button" && options?.name) return hiddenNamedCard;
      if (role === "button") return visibleCard;
      return page.toggle;
    });
    page.getByText = vi.fn(() => deviceText);
    const executor = new SmartThingsWebUiCommandExecutor(() => ({
      openCommandPage: vi.fn(async () => page)
    }));

    await executor.executeSwitch({ deviceName: "Safe plug", locationId: "loc_001" });

    expect(page.getByText).toHaveBeenCalledWith("Safe plug", { exact: true });
    expect(visibleCard.filter).toHaveBeenCalledWith({ has: deviceText });
    expect(visibleCard.click).toHaveBeenCalledTimes(1);
    expect(page.toggle.click).toHaveBeenCalledTimes(1);
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
});
