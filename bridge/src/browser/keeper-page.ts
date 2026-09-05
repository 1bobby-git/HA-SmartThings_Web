export const KEEPER_URL = "https://my.smartthings.com/location";
export const ADVANCED_URL = "https://my.smartthings.com/advanced";
const SESSION_TOUCH_PATH = "/location";
export const SESSION_TOUCH_AUTH_PATH =
  "/advanced/cupcake-api/api/locations?allowed=true";
const SESSION_TOUCH_TIMEOUT_MS = 12_000;
const SESSION_REAUTH_RECOVERY_DELAY_MS = 30_000;
const LOGIN_RECOVERY_DELAY_MS = 15 * 60_000;
const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;
export const ADVANCED_DEVICE_SNAPSHOT_URLS = [
  "/advanced/cupcake-api/api/devices?type=HUB",
  "/advanced/cupcake-api/api/devices?includeHealth=true&includeStatus=true&includeGroups=true&includeUserDevices=true&includeAllowedActions=true&includeRestricted=true",
  "/advanced/cupcake-api/api/devices?max=200&page=1&includeStatus=true&includeUserDevices=true&includeHealth=true&includeGroups=true&includeAllowedActions=true&isNext=true"
] as const;

export interface BrowserPageLike {
  url(): string;
  isClosed(): boolean;
  evaluate?<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
  bringToFront?(): Promise<unknown>;
  goto(url: string, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface BrowserContextLike {
  pages(): BrowserPageLike[];
  newPage(): Promise<BrowserPageLike>;
}

export interface AdvancedDeviceSnapshotEntry {
  url: string;
  snapshot: unknown;
}

export type SessionTouchOutcome = "ok" | "reauth" | "failed";

export interface KeeperPageManagerOptions {
  now?: () => number;
  sessionReauthRecoveryDelayMs?: number;
  loginRecoveryDelayMs?: number;
  sessionRecoveryRetryMs?: number;
}

export async function fetchAdvancedDeviceSnapshots(
  page: BrowserPageLike,
  urls: readonly string[] = ADVANCED_DEVICE_SNAPSHOT_URLS
): Promise<unknown[]> {
  const entries = await fetchAdvancedDeviceSnapshotEntries(page, urls);
  return entries.map((entry) => entry.snapshot);
}

export async function fetchAdvancedDeviceSnapshotEntries(
  page: BrowserPageLike,
  urls: readonly string[] = ADVANCED_DEVICE_SNAPSHOT_URLS
): Promise<AdvancedDeviceSnapshotEntry[]> {
  if (!page.evaluate) return [];
  try {
    const entries = await page.evaluate(
      async (urls) => {
        const result: { url: string; snapshot: unknown }[] = [];
        for (const url of urls) {
          // api-free-audit: authenticated-page-same-origin-read-only-get
          const response = await fetch(url, {
            credentials: "same-origin",
            method: "GET",
            cache: "no-store"
          });
          if (!response.ok) continue;
          result.push({
            url: new URL(url, location.origin).toString(),
            snapshot: await response.json()
          });
        }
        return result;
      },
      [...urls]
    );
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry, index) => {
        const record =
          typeof entry === "object" && entry !== null
            ? entry as Record<string, unknown>
            : undefined;
        return typeof record?.url === "string" && "snapshot" in record
          ? { url: record.url, snapshot: record.snapshot }
          : typeof urls[index] === "string"
            ? {
                url: new URL(urls[index], "https://my.smartthings.com").toString(),
                snapshot: entry
              }
            : undefined;
      })
      .filter((entry): entry is AdvancedDeviceSnapshotEntry => entry !== undefined);
  } catch {
    return [];
  }
}

export class KeeperPageManager {
  #keeper: BrowserPageLike | undefined;
  #restoredPagesReconciled = false;
  readonly #commandPages = new WeakSet<BrowserPageLike>();
  readonly #now: () => number;
  readonly #sessionReauthRecoveryDelayMs: number;
  readonly #loginRecoveryDelayMs: number;
  readonly #sessionRecoveryRetryMs: number;
  #sessionReauthObservedAtMs: number | undefined;
  #loginObservedAtMs: number | undefined;
  #lastRecoveryAttemptAtMs: number | undefined;
  #sessionRecoveryInFlight: Promise<void> | undefined;

  constructor(
    private readonly context: BrowserContextLike,
    options: KeeperPageManagerOptions = {}
  ) {
    this.#now = options.now ?? Date.now;
    this.#sessionReauthRecoveryDelayMs = validDelay(
      options.sessionReauthRecoveryDelayMs,
      SESSION_REAUTH_RECOVERY_DELAY_MS
    );
    this.#loginRecoveryDelayMs = validDelay(
      options.loginRecoveryDelayMs,
      LOGIN_RECOVERY_DELAY_MS
    );
    this.#sessionRecoveryRetryMs = validDelay(
      options.sessionRecoveryRetryMs,
      SESSION_RECOVERY_RETRY_MS
    );
  }

  currentKeeper(): BrowserPageLike | undefined {
    return this.#keeper && !this.#keeper.isClosed() ? this.#keeper : undefined;
  }

  authenticationRecoveryPending(): boolean {
    return (
      this.#sessionReauthObservedAtMs !== undefined ||
      this.#loginObservedAtMs !== undefined
    );
  }

  async reconcileRestoredPages(): Promise<BrowserPageLike | undefined> {
    if (this.#restoredPagesReconciled) return this.currentKeeper();
    const pages = this.context.pages().filter((page) => !page.isClosed());
    const keeper =
      this.currentKeeper() ??
      pages.find((page) => isConcreteLocationUrl(page.url())) ??
      pages.find((page) => isCleanGenericLocationUrl(page.url())) ??
      pages.find((page) => isKeeperCandidateUrl(page.url())) ??
      pages.find((page) => isSamsungLoginUrl(page.url())) ??
      pages.find((page) => page.url() === "about:blank");
    this.#keeper = keeper;
    if (keeper && isSamsungLoginUrl(keeper.url())) {
      this.#loginObservedAtMs ??= this.#now();
    }
    for (const page of pages) {
      if (page === keeper) continue;
      await page.close().catch(() => undefined);
      if (!page.isClosed()) throw new Error("restored_page_close_failed");
    }
    this.#restoredPagesReconciled = true;
    return keeper;
  }

  async ensureKeeper(): Promise<BrowserPageLike> {
    await this.reconcileRestoredPages();
    const candidates = this.context
      .pages()
      .filter(
        (page) =>
          !page.isClosed() &&
          !this.#commandPages.has(page) &&
          isKeeperCandidateUrl(page.url())
      );
    const loginPage = this.context
      .pages()
      .find((page) => !page.isClosed() && isSamsungLoginUrl(page.url()));

    const keeper =
      this.#keeper && !this.#keeper.isClosed()
        ? this.#keeper
        : candidates[0] ?? loginPage ?? this.findReusableBlankPage() ?? (await this.createKeeperPage());
    this.#keeper = keeper;

    for (const duplicate of candidates.filter((candidate) => candidate !== keeper)) {
      await duplicate.close();
    }

    await this.recoverRememberedSessionIfDue(keeper);
    const currentUrl = keeper.url();
    if (isKeeperSettledUrl(currentUrl)) {
      this.#loginObservedAtMs = undefined;
    } else if (isSamsungLoginUrl(currentUrl)) {
      this.#loginObservedAtMs ??= this.#now();
    } else {
      await keeper.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
      if (isKeeperSettledUrl(keeper.url())) {
        this.clearRecoveryState();
      } else if (isSamsungLoginUrl(keeper.url())) {
        this.#loginObservedAtMs ??= this.#now();
      }
    }

    return keeper;
  }

  async recoverKeeper(): Promise<BrowserPageLike> {
    const keeper = await this.ensureKeeper();
    const target = isConcreteLocationUrl(keeper.url()) ? keeper.url() : KEEPER_URL;
    await keeper.goto(target, { waitUntil: "domcontentloaded" });
    if (isKeeperSettledUrl(keeper.url())) {
      this.clearRecoveryState();
    } else if (isSamsungLoginUrl(keeper.url())) {
      this.#loginObservedAtMs ??= this.#now();
    }
    return keeper;
  }

  async touchAuthenticatedSession(
    timeoutMs = SESSION_TOUCH_TIMEOUT_MS
  ): Promise<SessionTouchOutcome> {
    const keeper = this.currentKeeper() ?? await this.reconcileRestoredPages();
    if (!keeper) return "failed";
    const url = keeper.url();
    if (isSamsungLoginUrl(url)) {
      this.observeSessionTouchOutcome("reauth", url);
      return "reauth";
    }
    if (!isKeeperSettledUrl(url) || !keeper.evaluate) return "failed";
    try {
      const outcome = await keeper.evaluate<
        SessionTouchOutcome,
        { path: string; authPath: string; timeout: number }
      >(
        async ({ path, authPath, timeout }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const request = async (target: string): Promise<SessionTouchOutcome> => {
            // api-free-audit: authenticated-page-same-origin-read-only-session-touch
            const response = await fetch(target, {
              cache: "no-store",
              credentials: "same-origin",
              method: "GET",
              redirect: "manual",
              signal: controller.signal
            });
            if (
              response.type === "opaqueredirect" ||
              response.status === 401 ||
              response.status === 403 ||
              (response.status >= 300 && response.status < 400)
            ) {
              return "reauth";
            }
            return response.ok ? "ok" : "failed";
          };
          try {
            const locationOutcome = await request(path);
            if (locationOutcome === "reauth") return "reauth";
            const authenticatedOutcome = await request(authPath);
            if (authenticatedOutcome === "reauth") return "reauth";
            return authenticatedOutcome === "ok" ? "ok" : "failed";
          } catch {
            return "failed";
          } finally {
            clearTimeout(timer);
          }
        },
        {
          path: SESSION_TOUCH_PATH,
          authPath: SESSION_TOUCH_AUTH_PATH,
          timeout: Math.max(1, Math.min(SESSION_TOUCH_TIMEOUT_MS, timeoutMs))
        }
      );
      this.observeSessionTouchOutcome(outcome, keeper.url());
      return outcome;
    } catch {
      return "failed";
    }
  }

  async openAdvancedPage(
    beforeGoto?: (page: BrowserPageLike) => Promise<void>
  ): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    await beforeGoto?.(page);
    await page.goto(ADVANCED_URL, { waitUntil: "domcontentloaded" });
    return page;
  }

  async openCommandPage(rawLocationId?: string): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    this.#commandPages.add(page);
    try {
      await page.bringToFront?.();
      const keeperUrl = this.currentKeeper()?.url();
      const target = rawLocationId
        ? `${KEEPER_URL}/${encodeURIComponent(rawLocationId)}`
        : keeperUrl && isKeeperSettledUrl(keeperUrl) ? keeperUrl : KEEPER_URL;
      await page.goto(target, { waitUntil: "domcontentloaded",
        ...(rawLocationId ? { timeout: 10_000 } : {}) });
      return page;
    } catch (error) {
      this.#commandPages.delete(page);
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private async createKeeperPage(): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
    return page;
  }

  private findReusableBlankPage(): BrowserPageLike | undefined {
    return this.context.pages().find((page) => !page.isClosed() && page.url() === "about:blank");
  }

  private async recoverRememberedSessionIfDue(keeper: BrowserPageLike): Promise<void> {
    const now = this.#now();
    const loginPage = isSamsungLoginUrl(keeper.url());
    if (loginPage) {
      this.#loginObservedAtMs ??= now;
    }
    const observedAt = this.#sessionReauthObservedAtMs ?? this.#loginObservedAtMs;
    if (observedAt === undefined) return;
    const recoveryDelay = this.#sessionReauthObservedAtMs === undefined
      ? this.#loginRecoveryDelayMs
      : this.#sessionReauthRecoveryDelayMs;
    if (now - observedAt < recoveryDelay) return;
    if (
      this.#lastRecoveryAttemptAtMs !== undefined &&
      now - this.#lastRecoveryAttemptAtMs < this.#sessionRecoveryRetryMs
    ) {
      return;
    }
    if (this.#sessionRecoveryInFlight) {
      await this.#sessionRecoveryInFlight;
      return;
    }

    this.#lastRecoveryAttemptAtMs = now;
    const recovery = (async () => {
      try {
        await keeper.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
      } catch {
        return;
      }
      if (isKeeperSettledUrl(keeper.url())) {
        this.clearRecoveryState();
      } else if (isSamsungLoginUrl(keeper.url())) {
        this.#sessionReauthObservedAtMs = undefined;
        this.#loginObservedAtMs = this.#now();
      }
    })();
    this.#sessionRecoveryInFlight = recovery;
    try {
      await recovery;
    } finally {
      if (this.#sessionRecoveryInFlight === recovery) {
        this.#sessionRecoveryInFlight = undefined;
      }
    }
  }

  private observeSessionTouchOutcome(outcome: SessionTouchOutcome, url: string): void {
    if (outcome === "ok") {
      this.clearRecoveryState();
      return;
    }
    if (outcome !== "reauth") return;
    const now = this.#now();
    this.#sessionReauthObservedAtMs ??= now;
    if (isSamsungLoginUrl(url)) {
      this.#loginObservedAtMs ??= now;
    }
  }

  private clearRecoveryState(): void {
    this.#sessionReauthObservedAtMs = undefined;
    this.#loginObservedAtMs = undefined;
    this.#lastRecoveryAttemptAtMs = undefined;
  }
}

function validDelay(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value >= 0 ? value : fallback;
}

function isKeeperCandidateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://my.smartthings.com" && isLocationPath(url.pathname);
  } catch {
    return false;
  }
}

function isKeeperSettledUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      isLocationPath(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isConcreteLocationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      /^\/location\/[^/]+\/?$/u.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isCleanGenericLocationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://my.smartthings.com" &&
      /^\/location\/?$/u.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function isLocationPath(pathname: string): boolean {
  return /^\/location(?:\/[^/]+)?\/?$/.test(pathname);
}

function isSamsungLoginUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "account.samsung.com";
  } catch {
    return false;
  }
}
