import type { BrowserPageLike, KeeperPageManager } from "./keeper-page.js";

interface CommandLocatorLike {
  click(options?: { timeout?: number }): Promise<unknown>;
  count(): Promise<number>;
  dispatchEvent(type: string): Promise<unknown>;
  fill(value: string, options?: { timeout?: number }): Promise<unknown>;
  filter(options: { has: CommandLocatorLike }): CommandLocatorLike;
  first(): CommandLocatorLike;
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): CommandLocatorLike;
  locator(selector: string): CommandLocatorLike;
  waitFor(options: { state: "visible"; timeout: number }): Promise<unknown>;
}

interface CommandControlSurface {
  getByRole(role: string, options?: { name?: string | RegExp }): CommandLocatorLike;
  getByText(text: string, options?: { exact?: boolean }): CommandLocatorLike;
  locator(selector: string): CommandLocatorLike;
  waitForTimeout?(timeout: number): Promise<unknown>;
}

interface CommandPageLike extends BrowserPageLike, CommandControlSurface {
  mouse?: {
    move(x: number, y: number): Promise<unknown>;
    wheel(deltaX: number, deltaY: number): Promise<unknown>;
  };
  waitForTimeout?(timeout: number): Promise<unknown>;
}

type CommandPageManagerLike = Pick<KeeperPageManager, "openCommandPage">;

type CommandDiagnosticStage =
  | "foreground_requested"
  | "foreground_ready"
  | "warm_missing"
  | "warm_context_mismatch"
  | "warm_closed"
  | "warm_expired"
  | "warm_route_invalid"
  | "warm_dialog_missing"
  | "warm_recovery_start"
  | "warm_recovery_ready"
  | "warm_recovery_failed"
  | "warm_ready"
  | "verified_route_missing"
  | "verified_route_expired"
  | "verified_route_opened"
  | "verified_route_ready"
  | "verified_route_invalid"
  | "fresh_page_opened"
  | "fresh_location_ready"
  | "fresh_navigation"
  | "fresh_overview_probe"
  | "fresh_overview_missing"
  | "fresh_overview_ready"
  | "fresh_rooms_opened"
  | "fresh_room_selected"
  | "fresh_room_device_ready"
  | "fresh_device_ready"
  | "fresh_device_clicked"
  | "fresh_detail_wait"
  | "fresh_detail_ready"
  | "fresh_control_probe"
  | "toggle_named_control_found"
  | "toggle_named_control_missing"
  | "toggle_labeled_scope_found"
  | "toggle_labeled_scope_missing"
  | "toggle_click_start"
  | "toggle_click_done"
  | `toggle_scoped_${"switch" | "checkbox" | "button"}_${"0" | "1" | "many"}`;

interface CommandExecutorOptions {
  warmPageTtlMs?: number;
  onDiagnostic?: (stage: CommandDiagnosticStage) => void;
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

interface BackgroundPreemption {
  readonly promise: Promise<void>;
  readonly requested: boolean;
  request(): void;
}

const WARM_DETAIL_IDENTITY_TIMEOUT_MS = 500;
const VERIFIED_ROUTE_IDENTITY_TIMEOUT_MS = 1_500;
const VERIFIED_ROUTE_TTL_MS = 24 * 60 * 60_000;
const MAX_VERIFIED_DETAIL_ROUTES = 256;
const WARM_CONTROL_PROBE_TIMEOUT_MS = 1_500;
const FRESH_CONTROL_PROBE_TIMEOUT_MS = 5_000;
const FRESH_OBSERVED_TOGGLE_PROBE_TIMEOUT_MS = 15_000;
const ROOM_DEVICE_CARD_TIMEOUT_MS = 3_000;
const ROOM_SELECTION_TIMEOUT_MS = 1_500;
const LABELED_SCOPE_POLL_MS = 100;
const LABELED_SCOPE_VISIBLE_PROBE_MS = 25;
const LOCATION_ROUTE_POLL_MS = 100;
const LOCATION_ROUTE_POLL_ATTEMPTS = 30;
const DETAIL_ROUTE_POLL_MS = 100;
const DETAIL_ROUTE_POLL_ATTEMPTS = 50;
const DETAIL_IDENTITY_PROBE_MS = 50;

export class SmartThingsWebUiCommandExecutor {
  #uiQueue: Promise<void> = Promise.resolve();
  #warmDevicePage: WarmDevicePage | undefined;
  #backgroundInspectionPage: CommandPageLike | undefined;
  #backgroundPreemption: BackgroundPreemption | undefined;
  #foregroundOperationCount = 0;
  readonly #verifiedDetailRoutes = new Map<string, { detailUrl: string; verifiedAt: number }>();
  readonly #warmPageTtlMs: number;
  readonly #onDiagnostic: ((stage: CommandDiagnosticStage) => void) | undefined;

  constructor(
    private readonly getManager: () => CommandPageManagerLike | undefined,
    private readonly normalizeLocationId?: (rawLocationId: string) => string,
    options?: CommandExecutorOptions
  ) {
    const ttl = options?.warmPageTtlMs ?? 0;
    this.#warmPageTtlMs = Number.isFinite(ttl) ? Math.max(0, Math.min(300_000, ttl)) : 0;
    this.#onDiagnostic = options?.onDiagnostic;
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
    this.#diagnostic("foreground_requested");
    await this.#runForeground(() => {
      this.#diagnostic("foreground_ready");
      return this.#executeDeviceAction(input);
    });
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
        await executeDeviceControl(
          warmPage,
          input,
          WARM_CONTROL_PROBE_TIMEOUT_MS,
          (stage) => this.#diagnostic(stage)
        );
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
        await executeDeviceControl(
          routedPage,
          input,
          FRESH_CONTROL_PROBE_TIMEOUT_MS,
          (stage) => this.#diagnostic(stage),
          FRESH_OBSERVED_TOGGLE_PROBE_TIMEOUT_MS
        );
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
    let page: CommandPageLike | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = (await manager.openCommandPage()) as CommandPageLike;
      this.#diagnostic("fresh_page_opened");
      try {
        if (!isSmartThingsLocation(candidate.url())) {
          throw new Error("command_login_required");
        }
        await this.ensureLocation(candidate, input.locationId, input.locationNames);
        this.#diagnostic("fresh_location_ready");
        this.#diagnostic("fresh_navigation");
        await openDeviceDetail(candidate, input.deviceName, input.roomName, {
          preferRooms: Boolean(input.roomName),
          diagnostic: (stage) => this.#diagnostic(stage)
        });
        this.#diagnostic("fresh_detail_wait");
        await waitForOpenedDeviceDetail(candidate, input.deviceName, input.roomName);
        page = candidate;
        break;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        if (attempt === 0 && isRetryableFreshNavigationError(error)) continue;
        throw error;
      }
    }
    if (!page) throw new Error("command_target_not_found");
    let keepWarm = false;
    try {
      this.#diagnostic("fresh_detail_ready");
      this.#diagnostic("fresh_control_probe");
      await executeDeviceControl(
        page,
        input,
        FRESH_CONTROL_PROBE_TIMEOUT_MS,
        (stage) => this.#diagnostic(stage),
        FRESH_OBSERVED_TOGGLE_PROBE_TIMEOUT_MS
      );
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
    if (this.#foregroundOperationCount > 0) throw new Error("detail_discovery_preempted");
    const preemption = createBackgroundPreemption();
    this.#backgroundPreemption = preemption;
    try {
      await this.#runExclusive(async () => {
        if (this.#foregroundOperationCount > 0 || preemption.requested) {
          throw new Error("detail_discovery_preempted");
        }
        const inspection = this.#inspectDeviceDetails(input);
        const outcome = await Promise.race([
          inspection.then(
            () => ({ type: "completed" as const }),
            (error: unknown) => ({ type: "failed" as const, error })
          ),
          preemption.promise.then(() => ({ type: "preempted" as const }))
        ]);
        if (outcome.type === "preempted") {
          void inspection.catch(() => undefined);
          throw new Error("detail_discovery_preempted");
        }
        if (outcome.type === "failed") throw outcome.error;
      });
    } catch (error) {
      if (this.#foregroundOperationCount > 0) throw new Error("detail_discovery_preempted");
      throw error;
    } finally {
      if (this.#backgroundPreemption === preemption) this.#backgroundPreemption = undefined;
    }
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
    this.#backgroundInspectionPage = page;
    try {
      if (this.#foregroundOperationCount > 0) throw new Error("detail_discovery_preempted");
      await openDeviceDetail(page, input.deviceName, input.roomName, {
        preferRooms: Boolean(input.roomName)
      });
      if (this.#foregroundOperationCount > 0) throw new Error("detail_discovery_preempted");
      await page.waitForTimeout?.(input.detailSettleMs ?? 1_500);
      if (this.#foregroundOperationCount > 0) throw new Error("detail_discovery_preempted");
    } finally {
      if (this.#backgroundInspectionPage === page) this.#backgroundInspectionPage = undefined;
      await page.close().catch(() => undefined);
    }
  }

  async executeScene(input: {
    sceneName: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void> {
    await this.#runForeground(() => this.#executeScene(input));
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
    await this.#runForeground(() => this.#executeLocationAction(input));
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

  async #runForeground<T>(work: () => Promise<T>): Promise<T> {
    this.#foregroundOperationCount += 1;
    try {
      this.#backgroundPreemption?.request();
      const backgroundPage = this.#backgroundInspectionPage;
      if (backgroundPage && !backgroundPage.isClosed()) {
        await backgroundPage.close().catch(() => undefined);
      }
      return await this.#runExclusive(work);
    } finally {
      this.#foregroundOperationCount -= 1;
    }
  }

  async #warmPageFor(
    manager: CommandPageManagerLike,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): Promise<CommandPageLike | undefined> {
    const cached = this.#warmDevicePage;
    if (!cached) {
      this.#diagnostic("warm_missing");
      return undefined;
    }
    if (
      cached.manager !== manager ||
      cached.locationId !== input.locationId ||
      cached.deviceName !== input.deviceName ||
      cached.roomName !== input.roomName
    ) {
      this.#diagnostic("warm_context_mismatch");
      await this.#invalidateWarmPage();
      return undefined;
    }
    if (cached.page.isClosed()) {
      this.#diagnostic("warm_closed");
      await this.#invalidateWarmPage();
      return undefined;
    }
    if (Date.now() - cached.lastUsedAt >= this.#warmPageTtlMs) {
      this.#diagnostic("warm_expired");
      await this.#invalidateWarmPage();
      return undefined;
    }
    if (cached.page.url() !== cached.detailUrl || !isSmartThingsDeviceDetail(cached.page.url())) {
      this.#diagnostic("warm_route_invalid");
      await this.#invalidateWarmPage();
      return undefined;
    }
    if (!(await hasExactVisibleDeviceDialog(cached.page, input.deviceName, input.roomName))) {
      this.#diagnostic("warm_dialog_missing");
      return this.#recoverWarmPage(cached, input);
    }
    this.#diagnostic("warm_ready");
    return cached.page;
  }

  async #recoverWarmPage(
    cached: WarmDevicePage,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): Promise<CommandPageLike | undefined> {
    this.#diagnostic("warm_recovery_start");
    try {
      const device = await findDeviceInRooms(cached.page, input.deviceName, input.roomName);
      await device.click({ timeout: 15_000 });
      await waitForOpenedDeviceDetail(cached.page, input.deviceName, input.roomName);
      if (
        !isSmartThingsDeviceDetail(cached.page.url()) ||
        !(await hasExactVisibleDeviceDialog(cached.page, input.deviceName, input.roomName))
      ) {
        throw new Error("command_target_not_found");
      }
      this.#rememberSuccessfulDevicePage(cached.page, cached.manager, input);
      this.#diagnostic("warm_recovery_ready");
      return cached.page;
    } catch {
      this.#diagnostic("warm_recovery_failed");
      this.#verifiedDetailRoutes.delete(deviceRouteKey(input));
      await this.#invalidateWarmPage();
      return undefined;
    }
  }

  async #openVerifiedDetailPage(
    manager: CommandPageManagerLike,
    input: { deviceName: string; locationId: string; roomName?: string }
  ): Promise<CommandPageLike | undefined> {
    const key = deviceRouteKey(input);
    const cached = this.#verifiedDetailRoutes.get(key);
    if (!cached) {
      this.#diagnostic("verified_route_missing");
      return undefined;
    }
    if (Date.now() - cached.verifiedAt >= VERIFIED_ROUTE_TTL_MS) {
      this.#diagnostic("verified_route_expired");
      this.#verifiedDetailRoutes.delete(key);
      return undefined;
    }
    const page = (await manager.openCommandPage()) as CommandPageLike;
    this.#diagnostic("verified_route_opened");
    try {
      await page.goto(cached.detailUrl, { waitUntil: "domcontentloaded" });
      if (
        page.url() !== cached.detailUrl ||
        !isSmartThingsDeviceDetail(page.url()) ||
        !(await hasExactVisibleDeviceDialog(
          page,
          input.deviceName,
          input.roomName,
          VERIFIED_ROUTE_IDENTITY_TIMEOUT_MS
        ))
      ) {
        throw new Error("verified_detail_route_invalid");
      }
      cached.verifiedAt = Date.now();
      this.#diagnostic("verified_route_ready");
      return page;
    } catch {
      this.#diagnostic("verified_route_invalid");
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

  #diagnostic(stage: CommandDiagnosticStage): void {
    try {
      this.#onDiagnostic?.(stage);
    } catch {
      // Diagnostics must never change command behavior.
    }
  }
}

function createBackgroundPreemption(): BackgroundPreemption {
  let requested = false;
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    get requested() {
      return requested;
    },
    request: () => {
      if (requested) return;
      requested = true;
      resolvePromise();
    }
  };
}

function deviceRouteKey(input: {
  deviceName: string;
  locationId: string;
  roomName?: string;
}): string {
  return JSON.stringify([input.locationId, input.roomName ?? "", input.deviceName]);
}

async function hasExactVisibleDeviceDialog(
  page: CommandPageLike,
  deviceName: string,
  roomName?: string,
  timeoutMs = WARM_DETAIL_IDENTITY_TIMEOUT_MS
): Promise<boolean> {
  return Boolean(await exactVisibleDeviceDialog(page, deviceName, roomName, timeoutMs));
}

async function exactVisibleDeviceDialog(
  page: CommandPageLike,
  deviceName: string,
  roomName: string | undefined,
  timeoutMs: number
): Promise<CommandLocatorLike | undefined> {
  const headingName = roomName
    ? exactName(`${deviceName} ${roomName}`)
    : exactName(deviceName);
  const dialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: headingName })
  });
  try {
    await dialog.first().waitFor({
      state: "visible",
      timeout: timeoutMs
    });
  } catch {
    return undefined;
  }
  return (await dialog.count()) === 1 ? dialog.first() : undefined;
}

function dialogControlSurface(
  dialog: CommandLocatorLike,
  page: CommandPageLike
): CommandControlSurface {
  return {
    getByRole: (role, options) => dialog.getByRole(role, options),
    getByText: (text, options) => dialog.getByText(text, options),
    locator: (selector) => dialog.locator(selector),
    ...(page.waitForTimeout
      ? { waitForTimeout: (timeout: number) => page.waitForTimeout!(timeout) }
      : {})
  };
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
  options?: {
    preferRooms?: boolean;
    diagnostic?: (stage: CommandDiagnosticStage) => void;
  }
): Promise<void> {
  const diagnostic = options?.diagnostic ?? (() => undefined);
  if (options?.preferRooms && roomName) {
    diagnostic("fresh_overview_probe");
    const overviewDevice = await visibleExactTextCard(page, deviceName, 1_000);
    if (overviewDevice) {
      diagnostic("fresh_overview_ready");
      await overviewDevice.click({ timeout: 15_000 });
      diagnostic("fresh_device_clicked");
      return;
    }
    diagnostic("fresh_overview_missing");
    const roomDevice = await findDeviceInRooms(page, deviceName, roomName, diagnostic);
    if ((await roomDevice.count()) !== 1) throw new Error("command_target_ambiguous");
    await roomDevice.click({ timeout: 15_000 });
    diagnostic("fresh_device_clicked");
    return;
  }

  let device = await visibleExactTextCard(page, deviceName, 15_000);
  if (!device) {
    device = await scrollForDevice(page, deviceName);
  }
  if (!device) {
    device = await findDeviceInRooms(page, deviceName, roomName).catch(() => undefined);
  }
  if (!device) {
    device = await searchForDevice(page, deviceName);
  }
  if (!device) throw new Error("command_target_not_found");
  if ((await device.count()) !== 1) throw new Error("command_target_ambiguous");
  diagnostic("fresh_device_ready");
  await device.click({ timeout: 15_000 });
  diagnostic("fresh_device_clicked");
}

async function waitForOpenedDeviceDetail(
  page: CommandPageLike,
  deviceName: string,
  roomName?: string
): Promise<void> {
  // Production Playwright pages always provide waitForTimeout. Keeping the
  // single-pass fallback preserves compatibility with minimal page adapters.
  if (!page.waitForTimeout) return;

  for (let attempt = 0; attempt <= DETAIL_ROUTE_POLL_ATTEMPTS; attempt += 1) {
    if (
      isSmartThingsDeviceDetail(page.url()) &&
      (await hasExactVisibleDeviceDialog(page, deviceName, roomName, DETAIL_IDENTITY_PROBE_MS))
    ) {
      return;
    }
    if (attempt === DETAIL_ROUTE_POLL_ATTEMPTS) break;
    await page.waitForTimeout(DETAIL_ROUTE_POLL_MS);
  }
  throw new Error("command_target_not_found");
}

async function executeDeviceControl(
  page: CommandPageLike,
  input: {
    deviceName: string;
    roomName?: string;
    command: string;
    attribute: string;
    arguments: unknown[];
    controlLabel?: string;
    optionLabel?: string;
    optionCommand?: string;
  },
  probeTimeoutMs: number,
  diagnostic: (stage: CommandDiagnosticStage) => void = () => undefined,
  observedToggleProbeTimeoutMs = probeTimeoutMs
): Promise<void> {
  const dialog = page.waitForTimeout
    ? await exactVisibleDeviceDialog(page, input.deviceName, input.roomName, probeTimeoutMs)
    : undefined;
  if (page.waitForTimeout && !dialog) throw new Error("command_target_not_found");
  const scope = dialog ? dialogControlSurface(dialog, page) : page;
  if (input.command === "on" || input.command === "off") {
    if (input.controlLabel) {
      await clickObservedToggleControl(
        scope,
        input.controlLabel,
        observedToggleProbeTimeoutMs,
        diagnostic
      );
      return;
    }
    const label = controlLabelFor(input.attribute);
    try {
      if (label) {
        await clickRoleOrLabeledControl(scope, "switch", /^(?:Power|전원)$/iu, label, probeTimeoutMs);
      } else {
        await clickRoleControl(scope, "switch", /^(?:Power|전원)$/iu, probeTimeoutMs);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "command_control_not_found") {
        throw error;
      }
      await clickRoleControl(scope, "switch", undefined, probeTimeoutMs);
    }
    return;
  }
  if (input.command === "refresh") {
    await clickRoleControl(scope, "button", /^(?:Refresh|새로고침)$/iu, probeTimeoutMs);
    return;
  }
  if (input.command === "press") {
    if (!input.controlLabel) throw new Error("command_control_not_found");
    await clickRoleOrLabeledControl(scope, "button", exactName(input.controlLabel), input.controlLabel, probeTimeoutMs);
    return;
  }
  if (input.command === "mute" || input.command === "unmute") {
    const label = input.controlLabel ?? controlLabelFor(input.attribute);
    if (label) {
      await clickRoleOrLabeledControl(scope, "switch", /^(?:Mute|Muted|음소거)$/iu, label, probeTimeoutMs);
    } else {
      await clickRoleControl(scope, "switch", /^(?:Mute|Muted|음소거)$/iu, probeTimeoutMs);
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
      scope,
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
      await clickLabeledSwatchCommand(scope, label, input.optionCommand, probeTimeoutMs);
      return;
    }
    try {
      const select = await findRoleControl(
        scope,
        "combobox",
        label ? exactOrLocalized(label) : undefined,
        probeTimeoutMs
      );
      await select.click({ timeout: 15_000 });
      await clickExactlyOne(scope.getByRole("option", { name: exactName(input.optionLabel ?? value) }));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "command_control_not_found" || !label) {
        throw error;
      }
      await clickLabeledSwatchOption(scope, label, input.optionLabel ?? value, probeTimeoutMs);
    }
    return;
  }
  if (isCoverButtonCommand(input.command)) {
    if (!input.controlLabel) throw new Error("command_control_not_found");
    await clickRoleOrLabeledControl(scope, "button", exactName(input.controlLabel), input.controlLabel, probeTimeoutMs);
    return;
  }
  if (input.command === "playTrackAndResume") {
    const value = input.arguments[0];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error("command_execution_failed");
    }
    const name = /Play track and resume|트랙.*재생|재생.*재개/iu;
    const textbox = await findRoleControl(scope, "textbox", name, probeTimeoutMs);
    await textbox.fill(value, { timeout: 15_000 });
    await clickRoleControl(scope, "button", name, probeTimeoutMs);
    return;
  }
  const name = mediaActionName(input.command);
  if (!name) throw new Error("command_control_not_found");
  await clickRoleControl(scope, "button", name, probeTimeoutMs);
}

async function clickObservedToggleControl(
  scope: CommandControlSurface,
  label: string,
  probeTimeoutMs: number,
  diagnostic: (stage: CommandDiagnosticStage) => void
): Promise<void> {
  const preferredName = exactOrLocalized(label);
  const named = await uniqueRoleCandidate(scope, ["switch", "checkbox"], preferredName);
  if (named) {
    diagnostic("toggle_named_control_found");
    await named.waitFor({ state: "visible", timeout: probeTimeoutMs });
    diagnostic("toggle_click_start");
    await named.click({ timeout: 15_000 });
    diagnostic("toggle_click_done");
    return;
  }
  diagnostic("toggle_named_control_missing");

  const labeledScope = await labeledSwatchScope(scope, labelVariants(label), probeTimeoutMs);
  diagnostic(labeledScope ? "toggle_labeled_scope_found" : "toggle_labeled_scope_missing");
  const candidateScope = labeledScope ?? scope;
  let scoped: CommandLocatorLike | undefined;
  const roles = labeledScope
    ? (["switch", "checkbox", "button"] as const)
    : (["switch", "checkbox"] as const);
  for (const role of roles) {
    const candidate = candidateScope.getByRole(role);
    const count = await candidate.count();
    diagnostic(`toggle_scoped_${role}_${countBucket(count)}`);
    if (count > 1) throw new Error("command_control_ambiguous");
    if (count === 1) {
      scoped = candidate;
      break;
    }
  }
  if (!scoped) throw new Error("command_control_not_found");
  try {
    await scoped.waitFor({ state: "visible", timeout: probeTimeoutMs });
  } catch {
    throw new Error("command_control_not_found");
  }
  diagnostic("toggle_click_start");
  await scoped.click({ timeout: 15_000 });
  diagnostic("toggle_click_done");
}

function countBucket(count: number): "0" | "1" | "many" {
  if (count === 0) return "0";
  if (count === 1) return "1";
  return "many";
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
  page: CommandControlSurface,
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
  page: CommandControlSurface,
  role: string,
  preferredName: RegExp | undefined,
  probeTimeoutMs: number
): Promise<void> {
  const control = await findRoleControl(page, role, preferredName, probeTimeoutMs);
  await control.click({ timeout: 15_000 });
}

async function findRoleOrLabeledControl(
  page: CommandControlSurface,
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
  page: CommandControlSurface,
  role: string,
  preferredName: RegExp,
  label: string,
  probeTimeoutMs: number
): Promise<void> {
  const control = await findRoleOrLabeledControl(page, role, preferredName, label, probeTimeoutMs);
  await control.click({ timeout: 15_000 });
}

async function clickLabeledSwatchOption(
  page: CommandControlSurface,
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
  page: CommandControlSurface,
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
  page: CommandControlSurface,
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
  page: CommandControlSurface,
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
  roomName: string | undefined,
  diagnostic: (stage: CommandDiagnosticStage) => void = () => undefined
): Promise<CommandLocatorLike> {
  const url = new URL(page.url());
  const route = url.pathname.match(/^(\/location\/[^/]+)(?:\/.*)?$/u)?.[1];
  if (!route) throw new Error("command_room_not_found");
  await page.goto(`${url.origin}${route}/rooms`, { waitUntil: "domcontentloaded" });
  diagnostic("fresh_rooms_opened");
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
    try {
      await room.waitFor({ state: "visible", timeout: ROOM_SELECTION_TIMEOUT_MS });
    } catch {
      throw new Error("command_room_not_found");
    }
    await room.dispatchEvent("click");
    diagnostic("fresh_room_selected");
  }
  let device = await visibleExactTextCard(page, deviceName, ROOM_DEVICE_CARD_TIMEOUT_MS);
  if (!device) {
    device = await scrollForDevice(page, deviceName);
  }
  if (!device) throw new Error("command_target_not_found");
  if ((await device.count()) !== 1) throw new Error("command_target_ambiguous");
  diagnostic("fresh_room_device_ready");
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
    const scrolled = await scrollForDevice(page, deviceName);
    if (scrolled) return scrolled;
    throw new Error("command_target_not_found");
  } catch {
    throw new Error("command_target_not_found");
  }
}

function exactTextDeviceCardLocators(
  page: CommandPageLike,
  deviceName: string
): CommandLocatorLike {
  const exactText = page.getByText(deviceName, { exact: true });
  return page.locator("[data-testid='device']:visible").filter({
    has: exactText
  });
}

function exactTextCardLocator(page: CommandPageLike, deviceName: string): CommandLocatorLike {
  return exactTextDeviceCardLocators(page, deviceName);
}

async function visibleExactTextCard(
  page: CommandPageLike,
  deviceName: string,
  timeout: number
): Promise<CommandLocatorLike | undefined> {
  const wrappers = exactTextDeviceCardLocators(page, deviceName);
  try {
    await wrappers.first().waitFor({ state: "visible", timeout });
  } catch {
    return undefined;
  }
  const wrapperCount = await wrappers.count();
  if (wrapperCount === 0) return undefined;
  if (wrapperCount !== 1) throw new Error("command_target_ambiguous");
  return wrappers;
}

function exactName(value: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`, "u");
}

function isRetryableFreshNavigationError(error: unknown): boolean {
  return error instanceof Error && error.message === "command_room_not_found";
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
      /^\/location\/[^/]+\/(?:rooms\/)?device\/[^/]+\/?$/u.test(url.pathname) &&
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
