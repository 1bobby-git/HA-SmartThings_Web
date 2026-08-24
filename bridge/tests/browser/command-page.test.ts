import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class FakeLocator {
  readonly click = vi.fn(async () => undefined);
  readonly waitFor = vi.fn(async () => undefined);

  constructor(private readonly matches: number) {}

  async count(): Promise<number> {
    return this.matches;
  }

  first(): FakeLocator {
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
      return this.card;
    }
    expect(role).toBe("switch");
    return this.toggle;
  }
}

describe("SmartThingsWebUiCommandExecutor", () => {
  test("opens an isolated command page and clicks one accessible device toggle", async () => {
    const page = new FakeCommandPage();
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(() => manager);

    await executor.executeSwitch({ deviceName: "Safe plug" });

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

    await expect(executor.executeSwitch({ deviceName: "Safe plug" })).rejects.toThrow(
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

    await expect(executor.executeSwitch({ deviceName: "Safe plug" })).rejects.toThrow(
      "command_login_required"
    );
    expect(page.card.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});
