import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";

interface CommandLocatorLike {
  click(options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  filter(options: { has: CommandLocatorLike }): CommandLocatorLike;
  first(): CommandLocatorLike;
  waitFor(options: { state: "visible"; timeout: number }): Promise<unknown>;
}

interface CommandPageLike extends BrowserPageLike {
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): CommandLocatorLike;
}

type CommandPageManagerLike = Pick<KeeperPageManager, "openCommandPage">;

export class SmartThingsWebUiCommandExecutor {
  constructor(private readonly getManager: () => CommandPageManagerLike | undefined) {}

  async executeSwitch(input: { deviceName: string }): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      throw new Error("command_browser_unavailable");
    }
    const page = (await manager.openCommandPage()) as CommandPageLike;
    try {
      if (!isSmartThingsLocation(page.url())) {
        throw new Error("command_login_required");
      }

      let device = deviceLocator(page, input.deviceName);
      try {
        await device.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        device = exactTextCardLocator(page, input.deviceName);
        try {
          await device.first().waitFor({ state: "visible", timeout: 5_000 });
        } catch {
          device = await searchForDevice(page, input.deviceName);
        }
      }
      if ((await device.count()) !== 1) {
        throw new Error("command_target_ambiguous");
      }
      await device.click({ timeout: 15_000 });

      const toggle = page.getByRole("switch");
      try {
        await toggle.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        throw new Error("command_control_not_found");
      }
      if ((await toggle.count()) !== 1) {
        throw new Error("command_control_ambiguous");
      }
      await toggle.click({ timeout: 15_000 });
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

async function searchForDevice(
  page: CommandPageLike,
  deviceName: string
): Promise<CommandLocatorLike> {
  const search = page.getByRole("textbox");
  const searchCount = await search.count();
  if (searchCount === 0) throw new Error("command_search_not_found");
  if (searchCount !== 1) throw new Error("command_search_ambiguous");
  try {
    await search.fill(deviceName, { timeout: 15_000 });
    let device = deviceLocator(page, deviceName);
    try {
      await device.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      device = exactTextCardLocator(page, deviceName);
      await device.first().waitFor({ state: "visible", timeout: 5_000 });
    }
    return device;
  } catch {
    throw new Error("command_target_not_found");
  }
}

function deviceLocator(page: CommandPageLike, deviceName: string): CommandLocatorLike {
  return page.getByRole("button", {
    name: new RegExp(escapeRegExp(deviceName), "u")
  });
}

function exactTextCardLocator(page: CommandPageLike, deviceName: string): CommandLocatorLike {
  return page.getByRole("button").filter({
    has: page.getByText(deviceName, { exact: true })
  });
}

function isSmartThingsLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      /^\/location(?:\/[^/]+)?\/?$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
