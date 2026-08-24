import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";

interface CommandLocatorLike {
  click(options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  first(): CommandLocatorLike;
  waitFor(options: { state: "visible"; timeout: number }): Promise<unknown>;
}

interface CommandPageLike extends BrowserPageLike {
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
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

      const device = page.getByRole("button", {
        name: new RegExp(escapeRegExp(input.deviceName), "u")
      });
      try {
        await device.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        throw new Error("command_target_not_found");
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
