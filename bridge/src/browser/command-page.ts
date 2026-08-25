import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";

interface CommandLocatorLike {
  click(options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  filter(options: { has: CommandLocatorLike }): CommandLocatorLike;
  first(): CommandLocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): CommandLocatorLike;
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
    await this.executeDeviceAction({
      ...input,
      command: "on",
      action: "on",
      component: "main",
      capability: "switch",
      attribute: "switch",
      arguments: []
    });
  }

  async executeDeviceAction(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
    command:
      | "on"
      | "off"
      | "refresh"
      | "press"
      | "setNumber"
      | "setVolume"
      | "play"
      | "pause"
      | "stop"
      | "nextTrack"
      | "previousTrack"
      | "mute"
      | "unmute"
      | "playTrackAndResume"
      | "setFanMode";
    action: string;
    component: string;
    capability: string;
    attribute: string;
    arguments: unknown[];
    controlLabel?: string;
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
      await openDeviceDetail(page, input.deviceName, input.roomName);
      await executeDeviceControl(page, input);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async inspectDeviceDetails(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
  }): Promise<void> {
    // Navigation only: device state and controls still come from observed Socket.IO data.
    const page = await this.openLocationPage(input.locationId, input.locationNames);
    try {
      await openDeviceDetail(page, input.deviceName, input.roomName, {
        preferRooms: Boolean(input.roomName)
      });
      await page.waitForTimeout?.(1_500);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async executeScene(input: {
    sceneName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void> {
    const page = await this.openLocationPage(input.locationId, input.locationNames);
    try {
      let scene = page.getByRole("button", { name: exactName(input.sceneName) });
      if ((await scene.count()) !== 1) {
        scene = page.getByRole("button").filter({
          has: page.getByText(input.sceneName, { exact: true })
        });
      }
      await clickExactlyOne(scene);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async executeLocationAction(input: {
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    action: "armAway" | "armStay" | "disarm";
  }): Promise<void> {
    const page = await this.openLocationPage(input.locationId, input.locationNames);
    try {
      const actionName = locationActionName(input.action);
      let action = page.getByRole("button", { name: actionName });
      if ((await action.count()) !== 1) {
        const monitor = page.getByRole("button", {
          name: /^(?:SmartThings\s+)?Home Monitor$|^홈 모니터$/iu
        });
        await clickExactlyOne(monitor);
        action = page.getByRole("button", { name: actionName });
        try {
          await action.first().waitFor({ state: "visible", timeout: 15_000 });
        } catch {
          throw new Error("command_control_not_found");
        }
      }
      await clickExactlyOne(action);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async openLocationPage(
    locationId: string,
    locationNames?: Readonly<Record<string, string>>
  ): Promise<CommandPageLike> {
    const manager = this.getManager();
    if (!manager) throw new Error("command_browser_unavailable");
    const page = (await manager.openCommandPage()) as CommandPageLike;
    try {
      if (!isSmartThingsLocation(page.url())) throw new Error("command_login_required");
      await this.ensureLocation(page, locationId, locationNames);
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
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

async function openDeviceDetail(
  page: CommandPageLike,
  deviceName: string,
  roomName: string | undefined,
  options?: { preferRooms?: boolean }
): Promise<void> {
  if (options?.preferRooms && roomName) {
    const roomDevice = await findDeviceInRooms(page, deviceName, roomName);
    if ((await roomDevice.count()) !== 1) throw new Error("command_target_ambiguous");
    await roomDevice.click({ timeout: 15_000 });
    return;
  }

  let device = deviceLocator(page, deviceName);
  try {
    await device.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    device = exactTextCardLocator(page, deviceName);
    try {
      await device.first().waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      const scrolled = await scrollForDevice(page, deviceName);
      if (scrolled) {
        device = scrolled;
      } else {
        const roomDevice = await findDeviceInRooms(page, deviceName, roomName).catch(
          () => undefined
        );
        device = roomDevice ?? (await searchForDevice(page, deviceName));
      }
    }
  }
  if ((await device.count()) !== 1) {
    device = await findDeviceInRooms(page, deviceName, roomName).catch(() => device);
  }
  if ((await device.count()) !== 1) throw new Error("command_target_ambiguous");
  await device.click({ timeout: 15_000 });
}

async function executeDeviceControl(
  page: CommandPageLike,
  input: {
    command: string;
    attribute: string;
    arguments: unknown[];
    controlLabel?: string;
  }
): Promise<void> {
  if (input.command === "on" || input.command === "off") {
    await clickRoleControl(page, "switch", /^(?:Power|전원)$/iu);
    return;
  }
  if (input.command === "refresh") {
    await clickRoleControl(page, "button", /^(?:Refresh|새로고침)$/iu);
    return;
  }
  if (input.command === "press") {
    if (!input.controlLabel) throw new Error("command_control_not_found");
    await clickRoleControl(page, "button", exactName(input.controlLabel));
    return;
  }
  if (input.command === "mute" || input.command === "unmute") {
    await clickRoleControl(page, "switch", /^(?:Mute|Muted|음소거)$/iu);
    return;
  }
  if (input.command === "setNumber" || input.command === "setVolume") {
    const value = input.arguments[0];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("command_execution_failed");
    }
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    const slider = await findRoleControl(page, "slider", label ? exactOrLocalized(label) : undefined);
    await slider.fill(String(value), { timeout: 15_000 });
    return;
  }
  if (input.command === "setFanMode") {
    const value = input.arguments[0];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("command_execution_failed");
    }
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    const select = await findRoleControl(page, "combobox", label ? exactOrLocalized(label) : undefined);
    await select.click({ timeout: 15_000 });
    await clickExactlyOne(page.getByRole("option", { name: exactName(value) }));
    return;
  }
  if (input.command === "playTrackAndResume") {
    const value = input.arguments[0];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("command_execution_failed");
    }
    const name = /Play track and resume|트랙.*재생|재생.*재개/iu;
    const textbox = await findRoleControl(page, "textbox", name);
    await textbox.fill(value, { timeout: 15_000 });
    await clickRoleControl(page, "button", name);
    return;
  }
  const name = mediaActionName(input.command);
  if (!name) throw new Error("command_control_not_found");
  await clickRoleControl(page, "button", name);
}

async function findRoleControl(
  page: CommandPageLike,
  role: string,
  preferredName?: RegExp
): Promise<CommandLocatorLike> {
  if (preferredName) {
    const preferred = page.getByRole(role, { name: preferredName });
    if ((await preferred.count()) === 1) {
      try {
        await preferred.first().waitFor({ state: "visible", timeout: 15_000 });
        return preferred;
      } catch {
        // Fall through to the single-role fail-closed fallback.
      }
    }
  }
  const fallback = page.getByRole(role);
  try {
    await fallback.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await fallback.count()) !== 1) throw new Error("command_control_ambiguous");
  return fallback;
}

async function clickRoleControl(
  page: CommandPageLike,
  role: string,
  preferredName?: RegExp
): Promise<void> {
  const control = await findRoleControl(page, role, preferredName);
  await control.click({ timeout: 15_000 });
}

async function clickExactlyOne(control: CommandLocatorLike): Promise<void> {
  try {
    await control.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await control.count()) !== 1) throw new Error("command_control_ambiguous");
  await control.click({ timeout: 15_000 });
}

function mediaActionName(command: string): RegExp | undefined {
  const labels: Record<string, RegExp> = {
    play: /^(?:Play|재생)$/iu,
    pause: /^(?:Pause|일시\s*정지)$/iu,
    stop: /^(?:Stop|정지)$/iu,
    nextTrack: /^(?:Next|Next track|다음|다음 트랙)$/iu,
    previousTrack: /^(?:Previous|Previous track|이전|이전 트랙)$/iu
  };
  return labels[command];
}

function locationActionName(action: "armAway" | "armStay" | "disarm"): RegExp {
  if (action === "armAway") return /^(?:Arm away|Away|외출|외출 모드)$/iu;
  if (action === "armStay") return /^(?:Arm stay|Stay|재실|재실 모드)$/iu;
  return /^(?:Disarm|Disarmed|해제|보안 해제)$/iu;
}

function controlLabelFor(attribute: string): string | undefined {
  const labels: Record<string, string> = {
    detectionFrequency: "Detection frequency|감지 주기",
    volume: "Volume|볼륨",
    fanSpeed: "Fan speed|팬 속도",
    level: "Level|레벨",
    airPurifierMode: "Air purifier mode|공기청정기 모드",
    fanMode: "Fan mode|팬 모드"
  };
  return labels[attribute];
}

function exactOrLocalized(value: string): RegExp {
  return new RegExp(`^(?:${value.split("|").map(escapeRegExp).join("|")})$`, "iu");
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
      const room = heading.locator("..");
      const exactLabel = room.getByText(deviceName, { exact: true });
      if ((await exactLabel.count()) === 1) {
        try {
          await exactLabel.first().waitFor({ state: "visible", timeout: 5_000 });
          return exactLabel;
        } catch {
          // Fall back to the room-scoped accessible card below.
        }
      }
      const scoped = room.getByRole("button", {
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
