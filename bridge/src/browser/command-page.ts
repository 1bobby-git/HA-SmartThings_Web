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
  locator(selector: string): CommandLocatorLike;
  mouse?: {
    move(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
  waitForTimeout?(timeout: number): Promise<unknown>;
}

type CommandPageManagerLike = Pick<KeeperPageManager, "openCommandPage">;

interface WarmPageOptions {
  warmPageTtlMs?: number;
}

interface WarmDevicePage {
  page: CommandPageLike;
  manager: CommandPageManagerLike;
  locationId: string;
  roomName?: string;
  deviceName: string;
  detailUrl: string;
  lastUsedAt: number;
}

const WARM_DETAIL_IDENTITY_TIMEOUT_MS = 500;
const VERIFIED_ROUTE_IDENTITY_TIMEOUT_MS = 5_000;
const VERIFIED_ROUTE_TTL_MS = 24 * 60 * 60_000;
const MAX_VERIFIED_DETAIL_ROUTES = 256;
const WARM_CONTROL_PROBE_TIMEOUT_MS = 1_500;
const FRESH_CONTROL_PROBE_TIMEOUT_MS = 5_000;
const LABELED_SCOPE_POLL_MS = 100;
const LABELED_SCOPE_VISIBLE_PROBE_MS = 25;
const LOCATION_ROUTE_POLL_MS = 100;
const LOCATION_ROUTE_POLL_ATTEMPTS = 30;

export class SmartThingsWebUiCommandExecutor {
  #uiQueue: Promise<void> = Promise.resolve();
  #warmDevicePage: WarmDevicePage | undefined;
  readonly #verifiedDetailRoutes = new Map<string, { detailUrl: string; verifiedAt: number }>();
  readonly #warmPageTtlMs: number;

  constructor(
    private readonly getManager: () => CommandPageManagerLike | undefined,
    private readonly normalizeLocationId?: (rawLocationId: string) => string,
    options?: WarmPageOptions
  ) {
    const ttl = options?.warmPageTtlMs ?? 0;
    this.#warmPageTtlMs = Number.isFinite(ttl) ? Math.max(0, Math.min(300_000, ttl)) : 0;
  }

  hasWarmCommandPage(): boolean {
    const cached = this.#warmDevicePage;
    if (!cached) return false;
    if (
      cached.page.isClosed() ||
      Date.now() - cached.lastUsedAt >= this.#warmPageTtlMs
    ) {
      void this.#invalidateWarmPage();
      return false;
    }
    return true;
  }

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
      | "setFanMode"
      | "setOption"
      | "open"
      | "close"
      | "stop"
      | "pause"
      | "openShade"
      | "closeShade"
      | "setPosition";
    action: string;
    component: string;
    capability: string;
    attribute: string;
    arguments: unknown[];
    controlLabel?: string;
    optionLabel?: string;
    optionCommand?: string;
  }): Promise<void> {
    await this.#runExclusive(() => this.#executeDeviceAction(input));
  }

  async #executeDeviceAction(input: {
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
      | "setFanMode"
      | "setOption"
      | "open"
      | "close"
      | "stop"
      | "pause"
      | "openShade"
      | "closeShade"
      | "setPosition";
    action: string;
    component: string;
    capability: string;
    attribute: string;
    arguments: unknown[];
    controlLabel?: string;
    optionLabel?: string;
    optionCommand?: string;
  }): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      throw new Error("command_browser_unavailable");
    }
    const warmPage = await this.#warmPageFor(manager, input);
    if (warmPage) {
      try {
        await executeDeviceControl(warmPage, input, WARM_CONTROL_PROBE_TIMEOUT_MS);
        if (this.#warmDevicePage) this.#warmDevicePage.lastUsedAt = Date.now();
        return;
      } catch (error) {
        await this.#invalidateWarmPage();
        if (!(error instanceof Error) || error.message !== "command_control_not_found") {
          throw error;
        }
      }
    }
    const routedPage = await this.#openVerifiedDetailPage(manager, input);
    if (routedPage) {
      let keepWarm = false;
      try {
        await executeDeviceControl(routedPage, input, FRESH_CONTROL_PROBE_TIMEOUT_MS);
        this.#rememberSuccessfulDevicePage(routedPage, manager, input);
        keepWarm = this.#warmPageTtlMs > 0;
        return;
      } catch (error) {
        this.#verifiedDetailRoutes.delete(deviceRouteKey(input));
        if (!(error instanceof Error) || error.message !== "command_control_not_found") {
          throw error;
        }
      } finally {
        if (!keepWarm) await routedPage.close().catch(() => undefined);
      }
    }
    const page = (await manager.openCommandPage()) as CommandPageLike;
    let keepWarm = false;
    try {
      if (!isSmartThingsLocation(page.url())) {
        throw new Error("command_login_required");
      }
      await this.ensureLocation(page, input.locationId, input.locationNames);
      await openDeviceDetail(page, input.deviceName, input.roomName, {
        preferRooms: Boolean(input.roomName)
      });
      await executeDeviceControl(page, input, FRESH_CONTROL_PROBE_TIMEOUT_MS);
      this.#rememberSuccessfulDevicePage(page, manager, input);
      keepWarm = this.#warmPageTtlMs > 0;
    } finally {
      if (!keepWarm) await page.close().catch(() => undefined);
    }
  }

  async inspectDeviceDetails(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
    detailSettleMs?: number;
  }): Promise<void> {
    await this.#runExclusive(() => this.#inspectDeviceDetails(input));
  }

  async #inspectDeviceDetails(input: {
    deviceName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    roomName?: string;
    detailSettleMs?: number;
  }): Promise<void> {
    // Navigation only: device state and controls still come from observed Socket.IO data.
    await this.#invalidateWarmPage();
    const page = await this.openLocationPage(input.locationId, input.locationNames);
    try {
      await openDeviceDetail(page, input.deviceName, input.roomName, {
        preferRooms: Boolean(input.roomName)
      });
      await page.waitForTimeout?.(input.detailSettleMs ?? 1_500);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async executeScene(input: {
    sceneName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.#runExclusive(() => this.#executeScene(input));
  }

  async #executeScene(input: {
    sceneName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.#invalidateWarmPage();
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
    await this.#runExclusive(() => this.#executeLocationAction(input));
  }

  async #executeLocationAction(input: {
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    action: "armAway" | "armStay" | "disarm";
  }): Promise<void> {
    await this.#invalidateWarmPage();
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
    if (!this.normalizeLocationId) return;
    if (!routeLocation) throw new Error("command_location_unknown");
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

    if (!(await waitForLocationRoute(page, targetLocationId, this.normalizeLocationId))) {
      throw new Error("command_location_change_failed");
    }
  }

  async #runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#uiQueue;
    let release: () => void = () => undefined;
    this.#uiQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async #warmPageFor(
    manager: CommandPageManagerLike,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): Promise<CommandPageLike | undefined> {
    const cached = this.#warmDevicePage;
    if (
      cached &&
      cached.manager === manager &&
      cached.locationId === input.locationId &&
      cached.deviceName === input.deviceName &&
      cached.roomName === input.roomName &&
      !cached.page.isClosed() &&
      Date.now() - cached.lastUsedAt < this.#warmPageTtlMs &&
      cached.page.url() === cached.detailUrl &&
      isSmartThingsDeviceDetail(cached.page.url()) &&
      (await hasExactVisibleDeviceIdentity(cached.page, input.deviceName))
    ) {
      return cached.page;
    }
    await this.#invalidateWarmPage();
    return undefined;
  }

  async #openVerifiedDetailPage(
    manager: CommandPageManagerLike,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): Promise<CommandPageLike | undefined> {
    const key = deviceRouteKey(input);
    const cached = this.#verifiedDetailRoutes.get(key);
    if (!cached) return undefined;
    if (Date.now() - cached.verifiedAt >= VERIFIED_ROUTE_TTL_MS) {
      this.#verifiedDetailRoutes.delete(key);
      return undefined;
    }
    const page = (await manager.openCommandPage()) as CommandPageLike;
    try {
      await page.goto(cached.detailUrl, { waitUntil: "domcontentloaded" });
      if (
        page.url() !== cached.detailUrl ||
        !isSmartThingsDeviceDetail(page.url()) ||
        !(await hasExactVisibleDeviceIdentity(
          page,
          input.deviceName,
          VERIFIED_ROUTE_IDENTITY_TIMEOUT_MS
        ))
      ) {
        throw new Error("verified_detail_route_invalid");
      }
      cached.verifiedAt = Date.now();
      return page;
    } catch {
      this.#verifiedDetailRoutes.delete(key);
      await page.close().catch(() => undefined);
      return undefined;
    }
  }

  #rememberSuccessfulDevicePage(
    page: CommandPageLike,
    manager: CommandPageManagerLike,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): void {
    const detailUrl = page.url();
    if (isSmartThingsDeviceDetail(detailUrl)) {
      const key = deviceRouteKey(input);
      this.#verifiedDetailRoutes.delete(key);
      this.#verifiedDetailRoutes.set(key, { detailUrl, verifiedAt: Date.now() });
      if (this.#verifiedDetailRoutes.size > MAX_VERIFIED_DETAIL_ROUTES) {
        const oldest = this.#verifiedDetailRoutes.keys().next().value;
        if (oldest) this.#verifiedDetailRoutes.delete(oldest);
      }
    }
    if (this.#warmPageTtlMs > 0) {
      this.#warmDevicePage = {
        page,
        manager,
        locationId: input.locationId,
        ...(input.roomName ? { roomName: input.roomName } : {}),
        deviceName: input.deviceName,
        detailUrl,
        lastUsedAt: Date.now()
      };
    }
  }

  async #invalidateWarmPage(): Promise<void> {
    const cached = this.#warmDevicePage;
    this.#warmDevicePage = undefined;
    if (cached && !cached.page.isClosed()) {
      await cached.page.close().catch(() => undefined);
    }
  }
}

function deviceRouteKey(input: {
  deviceName: string;
  locationId: string;
  roomName?: string;
}): string {
  return JSON.stringify([input.locationId, input.roomName ?? "", input.deviceName]);
}

async function hasExactVisibleDeviceIdentity(
  page: CommandPageLike,
  deviceName: string,
  timeoutMs = WARM_DETAIL_IDENTITY_TIMEOUT_MS
): Promise<boolean> {
  const heading = page.getByRole("heading", { name: exactName(deviceName) });
  const headingCount = await heading.count();
  if (headingCount > 1) return false;
  if (headingCount === 1) {
    try {
      await heading.first().waitFor({
        state: "visible",
        timeout: timeoutMs
      });
      return true;
    } catch {
      return false;
    }
  }

  const label = page.getByText(deviceName, { exact: true });
  if ((await label.count()) !== 1) return false;
  try {
    await label.first().waitFor({
      state: "visible",
      timeout: timeoutMs
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForLocationRoute(
  page: CommandPageLike,
  targetLocationId: string,
  normalizeLocationId: (rawLocationId: string) => string
): Promise<boolean> {
  for (let attempt = 0; attempt <= LOCATION_ROUTE_POLL_ATTEMPTS; attempt += 1) {
    const route = locationIdFromUrl(page.url());
    if (route && normalizeLocationId(route) === targetLocationId) return true;
    if (attempt === LOCATION_ROUTE_POLL_ATTEMPTS || !page.waitForTimeout) break;
    await page.waitForTimeout(LOCATION_ROUTE_POLL_MS);
  }
  return false;
}

async function openDeviceDetail(
  page: CommandPageLike,
  deviceName: string,
  roomName: string | undefined,
  options?: { preferRooms?: boolean }
): Promise<void> {
  if (options?.preferRooms && roomName) {
    const overviewDevice = await visibleExactTextCard(page, deviceName, 1_000);
    if (overviewDevice) {
      await overviewDevice.click({ timeout: 15_000 });
      return;
    }
    const roomDevice = await findDeviceInRooms(page, deviceName, roomName);
    if ((await roomDevice.count()) !== 1) throw new Error("command_target_ambiguous");
    await roomDevice.click({ timeout: 15_000 });
    return;
  }

  let device = await visibleExactTextCard(page, deviceName, 15_000);
  if (!device) {
    device = deviceLocator(page, deviceName);
    try {
      await device.first().waitFor({ state: "visible", timeout: 15_000 });
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
  if (!device) throw new Error("command_target_not_found");
  if ((await device.count()) !== 1) {
    device = await findDeviceInRooms(page, deviceName, roomName).catch(() => device);
  }
  if (!device) throw new Error("command_target_not_found");
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
    optionLabel?: string;
    optionCommand?: string;
  },
  probeTimeoutMs: number
): Promise<void> {
  if (input.command === "on" || input.command === "off") {
    if (input.controlLabel) {
      await clickObservedToggleControl(page, input.controlLabel, probeTimeoutMs);
      return;
    }
    const label = controlLabelFor(input.attribute);
    try {
      if (label) {
        await clickRoleOrLabeledControl(page, "switch", /^(?:Power|전원)$/iu, label, probeTimeoutMs);
      } else {
        await clickRoleControl(page, "switch", /^(?:Power|전원)$/iu, probeTimeoutMs);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "command_control_not_found") {
        throw error;
      }
      await clickRoleControl(page, "switch", undefined, probeTimeoutMs);
    }
    return;
  }
  if (input.command === "refresh") {
    await clickRoleControl(page, "button", /^(?:Refresh|새로고침)$/iu, probeTimeoutMs);
    return;
  }
  if (input.command === "press") {
    if (!input.controlLabel) throw new Error("command_control_not_found");
    await clickRoleOrLabeledControl(page, "button", exactName(input.controlLabel), input.controlLabel, probeTimeoutMs);
    return;
  }
  if (input.command === "mute" || input.command === "unmute") {
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    if (label) {
      await clickRoleOrLabeledControl(page, "switch", /^(?:Mute|Muted|음소거)$/iu, label, probeTimeoutMs);
    } else {
      await clickRoleControl(page, "switch", /^(?:Mute|Muted|음소거)$/iu, probeTimeoutMs);
    }
    return;
  }
  if (input.command === "setNumber" || input.command === "setVolume" || input.command === "setPosition") {
    const value = input.arguments[0];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("command_execution_failed");
    }
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    const slider = await findRoleOrLabeledControl(
      page,
      "slider",
      label ? exactOrLocalized(label) : undefined,
      label,
      probeTimeoutMs
    );
    await slider.fill(String(value), { timeout: 15_000 });
    return;
  }
  if (input.command === "setFanMode" || input.command === "setOption") {
    const value = input.arguments[0];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("command_execution_failed");
    }
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    if (
      (input.command === "setOption" || input.command === "setFanMode") &&
      input.optionCommand &&
      label
    ) {
      await clickLabeledSwatchCommand(page, label, input.optionCommand, probeTimeoutMs);
      return;
    }
    try {
      const select = await findRoleControl(
        page,
        "combobox",
        label ? exactOrLocalized(label) : undefined,
        probeTimeoutMs
      );
      await select.click({ timeout: 15_000 });
      await clickExactlyOne(page.getByRole("option", { name: exactName(input.optionLabel ?? value) }));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "command_control_not_found" || !label) {
        throw error;
      }
      await clickLabeledSwatchOption(page, label, input.optionLabel ?? value, probeTimeoutMs);
    }
    return;
  }
  if (isCoverButtonCommand(input.command)) {
    if (!input.controlLabel) throw new Error("command_control_not_found");
    await clickRoleOrLabeledControl(page, "button", exactName(input.controlLabel), input.controlLabel, probeTimeoutMs);
    return;
  }
  if (input.command === "playTrackAndResume") {
    const value = input.arguments[0];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("command_execution_failed");
    }
    const name = /Play track and resume|트랙.*재생|재생.*재개/iu;
    const textbox = await findRoleControl(page, "textbox", name, probeTimeoutMs);
    await textbox.fill(value, { timeout: 15_000 });
    await clickRoleControl(page, "button", name, probeTimeoutMs);
    return;
  }
  const name = mediaActionName(input.command);
  if (!name) throw new Error("command_control_not_found");
  await clickRoleControl(page, "button", name, probeTimeoutMs);
}

async function clickObservedToggleControl(
  page: CommandPageLike,
  label: string,
  probeTimeoutMs: number
): Promise<void> {
  const preferredName = exactOrLocalized(label);
  const named = await uniqueRoleCandidate(page, ["switch", "checkbox"], preferredName);
  if (named) {
    await named.waitFor({ state: "visible", timeout: probeTimeoutMs });
    await named.click({ timeout: 15_000 });
    return;
  }

  const deadline = Date.now() + probeTimeoutMs;
  const scope = await labeledSwatchScope(page, labelVariants(label), probeTimeoutMs);
  if (!scope) throw new Error("command_control_not_found");
  const remainingMs = Math.max(1, deadline - Date.now());
  const scoped = await uniqueRoleCandidate(scope, ["switch", "checkbox"]);
  if (!scoped) throw new Error("command_control_not_found");
  try {
    await scoped.waitFor({ state: "visible", timeout: remainingMs });
  } catch {
    throw new Error("command_control_not_found");
  }
  await scoped.click({ timeout: 15_000 });
}

async function uniqueRoleCandidate(
  scope: Pick<CommandPageLike, "getByRole">,
  roles: readonly string[],
  preferredName?: RegExp
): Promise<CommandLocatorLike | undefined> {
  for (const role of roles) {
    const control = scope.getByRole(role, preferredName ? { name: preferredName } : undefined);
    const count = await control.count();
    if (count > 1) {
      throw new Error("command_control_ambiguous");
    }
    if (count === 1) return control;
  }
  return undefined;
}

async function findRoleControl(
  page: CommandPageLike,
  role: string,
  preferredName: RegExp | undefined,
  probeTimeoutMs: number
): Promise<CommandLocatorLike> {
  if (preferredName) {
    const preferred = page.getByRole(role, { name: preferredName });
    try {
      await preferred.first().waitFor({
        state: "visible",
        timeout: probeTimeoutMs
      });
      if ((await preferred.count()) === 1) {
        return preferred;
      }
      throw new Error("command_control_ambiguous");
    } catch (error) {
      if (error instanceof Error && error.message === "command_control_ambiguous") {
        throw error;
      }
      throw new Error("command_control_not_found");
    }
  }
  const fallback = page.getByRole(role);
  try {
    await fallback.first().waitFor({
      state: "visible",
      timeout: probeTimeoutMs
    });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await fallback.count()) !== 1) throw new Error("command_control_ambiguous");
  return fallback;
}

async function clickRoleControl(
  page: CommandPageLike,
  role: string,
  preferredName: RegExp | undefined,
  probeTimeoutMs: number
): Promise<void> {
  const control = await findRoleControl(page, role, preferredName, probeTimeoutMs);
  await control.click({ timeout: 15_000 });
}

async function findRoleOrLabeledControl(
  page: CommandPageLike,
  role: string,
  preferredName: RegExp | undefined,
  label: string | undefined,
  probeTimeoutMs: number
): Promise<CommandLocatorLike> {
  if (preferredName) {
    const preferred = page.getByRole(role, { name: preferredName });
    const preferredCount = await preferred.count();
    if (preferredCount > 1) throw new Error("command_control_ambiguous");
    if (preferredCount === 1) {
      try {
        await preferred.first().waitFor({ state: "visible", timeout: probeTimeoutMs });
        return preferred;
      } catch {
        // The observed visible label below is the next authoritative scope.
      }
    }
  }
  if (label) {
    try {
      return await findLabeledSwatchControl(page, label, role, probeTimeoutMs);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "command_control_not_found") {
        throw error;
      }
    }
  }
  return await findRoleControl(page, role, preferredName, probeTimeoutMs);
}

async function clickRoleOrLabeledControl(
  page: CommandPageLike,
  role: string,
  preferredName: RegExp,
  label: string,
  probeTimeoutMs: number
): Promise<void> {
  const control = await findRoleOrLabeledControl(page, role, preferredName, label, probeTimeoutMs);
  await control.click({ timeout: 15_000 });
}

async function clickLabeledSwatchOption(
  page: CommandPageLike,
  label: string,
  option: string,
  probeTimeoutMs: number
): Promise<void> {
  const scope = await labeledSwatchScope(page, labelVariants(label), probeTimeoutMs);
  if (!scope) throw new Error("command_control_not_found");
  const control = scope.getByRole("button", { name: exactName(option) });
  try {
    await control.first().waitFor({
      state: "visible",
      timeout: probeTimeoutMs
    });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await control.count()) !== 1) throw new Error("command_control_ambiguous");
  await control.click({ timeout: 15_000 });
}

async function clickLabeledSwatchCommand(
  page: CommandPageLike,
  label: string,
  command: string,
  probeTimeoutMs: number
): Promise<void> {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(command)) {
    throw new Error("command_control_not_found");
  }
  const scope = await labeledSwatchScope(page, labelVariants(label), probeTimeoutMs);
  if (!scope) throw new Error("command_control_not_found");
  const control = scope.locator(`[data-command="${command}"]`);
  try {
    await control.first().waitFor({
      state: "visible",
      timeout: probeTimeoutMs
    });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await control.count()) !== 1) throw new Error("command_control_ambiguous");
  await control.click({ timeout: 15_000 });
}

async function findLabeledSwatchControl(
  page: CommandPageLike,
  label: string,
  role: string,
  probeTimeoutMs: number
): Promise<CommandLocatorLike> {
  const scope = await labeledSwatchScope(page, labelVariants(label), probeTimeoutMs);
  if (!scope) throw new Error("command_control_not_found");
  const control = scope.getByRole(role);
  try {
    await control.first().waitFor({
      state: "visible",
      timeout: probeTimeoutMs
    });
  } catch {
    throw new Error("command_control_not_found");
  }
  if ((await control.count()) !== 1) throw new Error("command_control_ambiguous");
  return control;
}

async function labeledSwatchScope(
  page: CommandPageLike,
  labels: string[],
  probeTimeoutMs: number
): Promise<CommandLocatorLike | undefined> {
  const deadline = Date.now() + probeTimeoutMs;
  const maxAttempts = Math.ceil(probeTimeoutMs / LABELED_SCOPE_POLL_MS) + 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const label of labels) {
      const labelLocator = page.getByText(label, { exact: true });
      const count = await labelLocator.count();
      if (count > 1) throw new Error("command_control_ambiguous");
      if (count === 0) continue;
      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        await labelLocator.first().waitFor({
          state: "visible",
          timeout: Math.min(LABELED_SCOPE_VISIBLE_PROBE_MS, remainingMs)
        });
        return labelLocator.locator("..");
      } catch {
        // Keep checking every exact localized variant until the shared deadline.
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || attempt === maxAttempts - 1 || !page.waitForTimeout) break;
    await page.waitForTimeout(Math.min(LABELED_SCOPE_POLL_MS, remainingMs));
  }
  return undefined;
}

function labelVariants(label: string): string[] {
  const localized: Record<string, string[]> = {
    "air purifier mode": ["Air purifier mode", "공기청정기 모드"],
    "detection frequency": ["Detection frequency", "감지 주기"],
    "fan mode": ["Fan mode", "팬 모드"],
    "fan speed": ["Fan speed", "팬 속도"],
    level: ["Level", "레벨"],
    mute: ["Mute", "Muted", "음소거"],
    muted: ["Mute", "Muted", "음소거"],
    power: ["Power", "전원"],
    refresh: ["Refresh", "새로고침"],
    volume: ["Volume", "볼륨"]
  };
  const variants = label.split("|").filter((value) => value.length > 0);
  for (const value of [...variants]) {
    variants.push(...(localized[value.trim().toLowerCase()] ?? []));
  }
  return [...new Set(variants)];
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
    percent: "Fan speed|팬 속도|Percent|퍼센트",
    level: "Level|레벨",
    airPurifierMode: "Air purifier mode|공기청정기 모드",
    fanMode: "Fan mode|팬 모드"
  };
  return labels[attribute];
}

function isCoverButtonCommand(command: string): boolean {
  return ["open", "close", "stop", "pause", "openShade", "closeShade"].includes(command);
}

function exactOrLocalized(value: string): RegExp {
  return new RegExp(`^(?:${labelVariants(value).map(escapeRegExp).join("|")})$`, "iu");
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
  if (roomName) {
    const roomText = page.getByText(roomName, { exact: true });
    let room = page.getByRole("button").filter({
      has: roomText
    });
    if ((await room.count()) !== 1) {
      const namedRoom = page.getByRole("button", { name: exactName(roomName) });
      if ((await namedRoom.count()) === 1) {
        room = namedRoom;
      } else {
        const heading = page.getByRole("heading", { name: exactName(roomName) });
        if ((await heading.count()) !== 1) throw new Error("command_room_not_found");
        room = heading.locator("..");
        if ((await room.count()) !== 1) throw new Error("command_room_not_found");
      }
    }
    await room.click({ timeout: 15_000 });
  }
  let device = await visibleExactTextCard(page, deviceName, 15_000);
  if (!device) {
    device = deviceLocator(page, deviceName);
    try {
      await device.first().waitFor({ state: "visible", timeout: 15_000 });
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
    const exact = await visibleExactTextCard(page, deviceName, 15_000);
    if (exact) return exact;
    const device = deviceLocator(page, deviceName);
    await device.first().waitFor({ state: "visible", timeout: 15_000 });
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

function exactTextDeviceCardLocators(
  page: CommandPageLike,
  deviceName: string
): { wrappers: CommandLocatorLike; opener: CommandLocatorLike } {
  const exactText = page.getByText(deviceName, { exact: true });
  const wrappers = page.locator("[data-testid='device']:visible").filter({
    has: exactText
  });
  return {
    wrappers,
    opener: wrappers.getByRole("button").filter({ has: exactText })
  };
}

function exactTextCardLocator(page: CommandPageLike, deviceName: string): CommandLocatorLike {
  return exactTextDeviceCardLocators(page, deviceName).opener;
}

async function visibleExactTextCard(
  page: CommandPageLike,
  deviceName: string,
  timeout: number
): Promise<CommandLocatorLike | undefined> {
  const { wrappers, opener } = exactTextDeviceCardLocators(page, deviceName);
  try {
    await wrappers.first().waitFor({ state: "visible", timeout });
  } catch {
    return undefined;
  }
  const wrapperCount = await wrappers.count();
  if (wrapperCount === 0) return undefined;
  if (wrapperCount !== 1) throw new Error("command_target_ambiguous");
  const openerCount = await opener.count();
  if (openerCount > 1) throw new Error("command_target_ambiguous");
  if (openerCount === 1) {
    try {
      await opener.first().waitFor({ state: "visible", timeout });
      return opener;
    } catch {
      // The exact wrapper is authoritative; try only another wrapper-scoped opener.
    }
  }

  const scopedNamedOpener = wrappers.getByRole("button", {
    name: new RegExp(escapeRegExp(deviceName), "u")
  });
  const scopedNamedCount = await scopedNamedOpener.count();
  if (scopedNamedCount > 1) throw new Error("command_target_ambiguous");
  if (scopedNamedCount === 1) {
    try {
      await scopedNamedOpener.first().waitFor({ state: "visible", timeout });
      return scopedNamedOpener;
    } catch {
      // An exact visible wrapper must never fall through to a page-wide target.
    }
  }
  throw new Error("command_target_not_found");
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

function isSmartThingsDeviceDetail(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      /^\/location\/[^/]+\/device\/[^/]+\/?$/u.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
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
