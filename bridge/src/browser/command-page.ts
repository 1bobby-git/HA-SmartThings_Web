import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";

interface CommandLocatorLike {
  click(options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  filter(options: { has: CommandLocatorLike }): CommandLocatorLike;
  first(): CommandLocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  locator(selector: string): CommandLocatorLike;
  waitFor(options: { state: "visible"; timeout: number }): Promise<unknown>;
}

interface CommandPageLike extends BrowserPageLike {
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): CommandLocatorLike;
  mouse?: {
    move(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
  waitForTimeout?(timeout: number): Promise<unknown>;
}

type CommandPageManagerLike = Pick<KeeperPageManager, "openCommandPage">;

export class SmartThingsWebUiCommandExecutor {
  constructor(
    private readonly getManager: () => CommandPageManagerLike | undefined,
    private readonly normalizeLocationId?: (rawLocationId: string) => string
  ) {}

  async executeSwitch(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
  }): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      throw new Error("command_browser_unavailable");
    }
    const page = (await manager.openCommandPage()) as CommandPageLike;
    try {
      if (!isSmartThingsLocation(page.url())) {
        throw new Error("command_login_required");
      }
      await this.ensureLocation(page, input.locationId, input.locationNames);

      let device: CommandLocatorLike | undefined = deviceLocator(page, input.deviceName);
      try {
        await device.first().waitFor({ state: "visible", timeout: 15_000 });
      } catch {
        device = exactTextCardLocator(page, input.deviceName);
        try {
          await device.first().waitFor({ state: "visible", timeout: 5_000 });
        } catch {
          device = await scrollForDevice(page, input.deviceName);
          if (!device) {
            device = await findDeviceInRooms(
              page,
              input.deviceName,
              input.roomName
            ).catch(
              () => undefined
            );
          }
          device ??= await searchForDevice(page, input.deviceName);
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

  private async ensureLocation(
    page: CommandPageLike,
    targetLocationId: string,
    locationNames: Readonly<Record<string, string>> | undefined
  ): Promise<void> {
    const routeLocation = locationIdFromUrl(page.url());
    if (!routeLocation || !this.normalizeLocationId) return;
    const currentLocationId = this.normalizeLocationId(routeLocation);
    if (currentLocationId === targetLocationId) return;
    const currentName = locationNames?.[currentLocationId];
    const targetName = locationNames?.[targetLocationId];
    if (!currentName || !targetName) throw new Error("command_location_unknown");

    let picker = page.getByRole("button", { name: new RegExp(escapeRegExp(currentName), "u") });
    if ((await picker.count()) !== 1) {
      picker = page.getByRole("button").filter({
        has: page.getByText(currentName, { exact: true })
      });
    }
    if ((await picker.count()) !== 1) throw new Error("command_location_picker_not_found");
    await picker.click({ timeout: 15_000 });
    const target = page.getByRole("link", { name: exactName(targetName) });
    try {
      await target.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      throw new Error("command_location_target_not_found");
    }
    if ((await target.count()) !== 1) throw new Error("command_location_target_not_found");
    await target.click({ timeout: 15_000 });

    const changedRoute = locationIdFromUrl(page.url());
    if (
      !changedRoute ||
      this.normalizeLocationId(changedRoute) !== targetLocationId
    ) {
      throw new Error("command_location_change_failed");
    }
  }
}

async function findDeviceInRooms(
  page: CommandPageLike,
  deviceName: string,
  roomName: string | undefined
): Promise<CommandLocatorLike> {
  const url = new URL(page.url());
  const route = url.pathname.match(/^(\/location\/[^/]+)(?:\/.*)?$/u)?.[1];
  if (!route) throw new Error("command_room_not_found");
  await page.goto(`${url.origin}${route}/rooms`, { waitUntil: "domcontentloaded" });
  let device = deviceLocator(page, deviceName);
  try {
    await device.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    device = exactTextCardLocator(page, deviceName);
    try {
      await device.first().waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      const scrolled = await scrollForDevice(page, deviceName);
      if (!scrolled) throw new Error("command_target_not_found");
      device = scrolled;
    }
  }
  if ((await device.count()) !== 1 && roomName) {
    const heading = page.getByRole("heading", { name: exactName(roomName) });
    if ((await heading.count()) === 1) {
      const scoped = heading.locator("..").getByRole("button", {
        name: new RegExp(escapeRegExp(deviceName), "u")
      });
      try {
        await scoped.first().waitFor({ state: "visible", timeout: 5_000 });
        device = scoped;
      } catch {
        // The caller retains the fail-closed ambiguity check.
      }
    }
  }
  return device;
}

async function scrollForDevice(
  page: CommandPageLike,
  deviceName: string
): Promise<CommandLocatorLike | undefined> {
  if (!page.mouse || !page.waitForTimeout) return undefined;
  await page.mouse.move(960, 540);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(250);
    const device = exactTextCardLocator(page, deviceName);
    if ((await device.count()) > 0) return device;
  }
  return undefined;
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

function exactName(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, "u");
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

function locationIdFromUrl(value: string): string | undefined {
  try {
    const match = new URL(value).pathname.match(/^\/location\/([^/]+)\/?$/u);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
