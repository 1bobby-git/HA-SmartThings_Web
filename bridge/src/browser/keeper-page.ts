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

export type SessionTouchOutcome = "ok" | "reauth" | "failed" | "stale";

export interface KeeperPageManagerOptions {
  now?: () => number;
  canNavigate?: () => boolean;
  sessionReauthRecoveryDelayMs?: number;
  loginRecoveryDelayMs?: number;
  sessionRecoveryRetryMs?: number;
  onRecovery?: (phase: "attempt" | "verified" | "login_required" | "failed" | "stale") => void;
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
  #restoreInFlight: Promise<BrowserPageLike | undefined> | undefined;
  #ensureInFlight: Promise<BrowserPageLike> | undefined;
  readonly #commandPages = new WeakSet<BrowserPageLike>();
  readonly #now: () => number;
  readonly #sessionReauthRecoveryDelayMs: number;
  readonly #loginRecoveryDelayMs: number;
  readonly #sessionRecoveryRetryMs: number;
  #sessionReauthObservedAtMs: number | undefined;
  #loginObservedAtMs: number | undefined;
  #lastRecoveryAttemptAtMs: number | undefined;
  #sessionRecoveryInFlight: Promise<void> | undefined;
  #touchInFlight: { page: BrowserPageLike; url: string; result: Promise<SessionTouchOutcome> } | undefined;
  readonly #canNavigate: () => boolean;
  readonly #onRecovery: KeeperPageManagerOptions["onRecovery"];
  #authenticatedOnce = false;
  #touchGeneration = 0;

  constructor(
    private readonly context: BrowserContextLike,
    options: KeeperPageManagerOptions = {}
  ) {
    this.#now = options.now ?? Date.now;
    this.#onRecovery = options.onRecovery;
    this.#canNavigate = options.canNavigate ?? (() => true);
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

  /** A definitive rejection of THIS page's protected request. No request is replayed. */
  reportAuthenticationFailure(page: BrowserPageLike, url: string): boolean {
    if (this.currentKeeper() !== page || page.isClosed() || page.url() !== url || !isKeeperSettledUrl(url)) return false;
    this.observeSessionTouchOutcome("reauth", url);
    return true;
  }

  private invalidateTouch(): void {
    this.#touchGeneration++;
    this.#touchInFlight = undefined;
  }

  private recoveryDiagnostic(phase: Parameters<NonNullable<KeeperPageManagerOptions["onRecovery"]>>[0]): void {
    try { this.#onRecovery?.(phase); } catch { /* Observers cannot break recovery. */ }
  }

  authenticationRecoveryPending(): boolean {
    return (
      this.#sessionReauthObservedAtMs !== undefined ||
      this.#loginObservedAtMs !== undefined
    );
  }

  reconcileRestoredPages(): Promise<BrowserPageLike | undefined> {
    if (!this.#restoreInFlight) {
      const pending = this.reconcileRestoredPagesOnce().finally(() => {
        if (this.#restoreInFlight === pending) this.#restoreInFlight = undefined;
      });
      this.#restoreInFlight = pending;
    }
    return this.#restoreInFlight;
  }

  private async reconcileRestoredPagesOnce(): Promise<BrowserPageLike | undefined> {
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

  ensureKeeper(): Promise<BrowserPageLike> {
    if (!this.#ensureInFlight) {
      // Heartbeats and recovery may overlap while newPage/goto/close is pending.
      // Share only the current operation, never cache a completed page promise.
      const pending = this.ensureKeeperOnce().finally(() => {
        if (this.#ensureInFlight === pending) this.#ensureInFlight = undefined;
      });
      this.#ensureInFlight = pending;
    }
    return this.#ensureInFlight;
  }

  private async ensureKeeperOnce(): Promise<BrowserPageLike> {
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

    const previousKeeper = this.currentKeeper();
    // Samsung SSO may complete in a new tab while its original login tab stays open.
    const completedLogin = previousKeeper && isSamsungLoginUrl(previousKeeper.url())
      ? candidates.find((page) => isKeeperSettledUrl(page.url()))
      : undefined;
    let keeper = completedLogin ?? previousKeeper ?? candidates[0] ?? loginPage ??
      this.findReusableBlankPage() ?? (await this.createKeeperPage());
    this.#keeper = keeper;
    if (completedLogin) {
      this.clearRecoveryState();
      await previousKeeper?.close().catch(() => undefined);
    }

    for (const duplicate of candidates.filter((candidate) => candidate !== keeper)) {
      await duplicate.close();
    }

    await this.recoverRememberedSessionIfDue(keeper);
    keeper = this.currentKeeper() ?? keeper;
    const currentUrl = keeper.url();
    if (isKeeperSettledUrl(currentUrl)) {
      this.#loginObservedAtMs = undefined;
    } else if (isSamsungLoginUrl(currentUrl)) {
      this.#loginObservedAtMs ??= this.#now();
    } else {
      this.invalidateTouch();
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
    const current = this.currentKeeper();
    if (!this.#canNavigate() || (current && isSamsungLoginUrl(current.url()))) {
      throw new Error("keeper_recovery_deferred");
    }
    const keeper = await this.ensureKeeper();
    if (!this.#canNavigate() || isSamsungLoginUrl(keeper.url())) throw new Error("keeper_recovery_deferred");
    const target = isConcreteLocationUrl(keeper.url()) ? keeper.url() : KEEPER_URL;
    this.invalidateTouch();
    await keeper.goto(target, { waitUntil: "domcontentloaded" });
    if (isKeeperSettledUrl(keeper.url())) {
      if (this.authenticationRecoveryPending()) await this.touchAuthenticatedSession();
      else this.clearRecoveryState();
    } else if (isSamsungLoginUrl(keeper.url())) {
      this.#loginObservedAtMs ??= this.#now();
    }
    return keeper;
  }

  async promoteVerifiedKeeper(candidate: BrowserPageLike): Promise<boolean> {
    if (!this.#canNavigate() || candidate.isClosed() || !isKeeperSettledUrl(candidate.url())) {
      return false;
    }
    const current = this.currentKeeper();
    if (current === candidate) {
      this.#authenticatedOnce = true;
      this.clearRecoveryState();
      return true;
    }
    this.invalidateTouch();
    this.#keeper = candidate;
    this.#commandPages.delete(candidate);
    this.#authenticatedOnce = true;
    this.clearRecoveryState();
    if (current && !current.isClosed() && !isSamsungLoginUrl(current.url())) {
      await current.close().catch(() => undefined);
    }
    this.recoveryDiagnostic("verified");
    return true;
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
    const running = this.#touchInFlight;
    if (running?.page === keeper && running.url === url) return running.result;
    const timeout = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(SESSION_TOUCH_TIMEOUT_MS, Math.floor(timeoutMs))) : SESSION_TOUCH_TIMEOUT_MS;
    const generation = this.#touchGeneration;
    const flight = { page: keeper, url, result: Promise.resolve("failed" as SessionTouchOutcome) };
    this.#touchInFlight = flight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep the underlying evaluate lease until it settles. A renderer timeout
    // must not create an unbounded pile of hidden requests on later heartbeats.
    const operation = Promise.resolve().then(() => keeper.evaluate!<
      SessionTouchOutcome, { path: string; authPath: string; timeout: number }
    >(
      async ({ path, authPath, timeout }) => {
        const request = async (target: string, budget: number, verify: boolean): Promise<SessionTouchOutcome> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), budget);
          try {
            // api-free-audit: authenticated-page-same-origin-read-only-session-touch
            const response = await fetch(target, {
              cache: "no-store", credentials: "same-origin", method: "GET",
              redirect: "manual", signal: controller.signal
            });
            if (response.type === "opaqueredirect" || response.status === 401 ||
                (response.status >= 300 && response.status < 400)) return "reauth";
            if (!response.ok) return "failed";
            if (!verify) {
              await response.body?.cancel().catch(() => undefined);
              return "ok";
            }
            // HTTP 200 alone can be an HTML sign-in shell or an error envelope.
            if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
              await response.body?.cancel().catch(() => undefined);
              return "failed";
            }
            const value: unknown = await response.json();
            const record = typeof value === "object" && value !== null && !Array.isArray(value)
              ? value as Record<string, unknown> : undefined;
            const rows = Array.isArray(value) ? value :
              ["items", "locations", "data", "results"].map((key) => record?.[key]).find(Array.isArray);
            if (!Array.isArray(rows) || (record && (record.error || record.errors))) return "failed";
            return rows.every((row: unknown) => {
              if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
              const item = row as Record<string, unknown>;
              const id = item.locationId ?? item.id;
              return typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id);
            }) ? "ok" : "failed";
          } catch { return "failed"; }
          finally { controller.abort(); clearTimeout(timer); }
        };
        // Separate budgets: a slow optional page GET cannot starve the actual
        // authenticated check. Neither request navigates or changes devices.
        const pageBudget = Math.max(1, Math.min(3_000, Math.floor(timeout / 4)));
        await request(path, pageBudget, false);
        return request(authPath, Math.max(1, timeout - pageBudget), true);
      }, { path: SESSION_TOUCH_PATH, authPath: SESSION_TOUCH_AUTH_PATH, timeout }
    )).catch(() => "failed" as const).finally(() => {
      if (this.#touchInFlight === flight) this.#touchInFlight = undefined;
    });
    flight.result = Promise.race([
      operation,
      new Promise<SessionTouchOutcome>((resolve) => {
        timer = setTimeout(() => resolve("failed"), timeout + 1_000);
        timer.unref?.();
      })
    ]).then((outcome) => {
      if (generation !== this.#touchGeneration || this.currentKeeper() !== keeper || keeper.isClosed() || keeper.url() !== url) return "stale";
      const result = ["ok", "reauth", "failed"].includes(outcome) ? outcome : "failed";
      this.observeSessionTouchOutcome(result as SessionTouchOutcome, url);
      return result as SessionTouchOutcome;
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    return flight.result;
  }

  async openAdvancedPage(
    beforeGoto?: (page: BrowserPageLike) => Promise<void>
  ): Promise<BrowserPageLike> {
    const page = await this.context.newPage();
    try {
      await beforeGoto?.(page);
      await page.goto(ADVANCED_URL, { waitUntil: "domcontentloaded" });
      return page;
    } catch (error) {
      // The caller cannot close a page that was never returned to it.
      await page.close().catch(() => undefined);
      throw error;
    }
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
    try {
      await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private findReusableBlankPage(): BrowserPageLike | undefined {
    return this.context.pages().find((page) => !page.isClosed() && page.url() === "about:blank");
  }

  private async recoverRememberedSessionIfDue(keeper: BrowserPageLike): Promise<void> {
    if (!this.#canNavigate()) return;
    const now = this.#now();
    const loginPage = isSamsungLoginUrl(keeper.url());
    if (loginPage) {
      this.#loginObservedAtMs ??= now;
    }
    const observedAt = this.#sessionReauthObservedAtMs ?? this.#loginObservedAtMs;
    if (observedAt === undefined) return;
    const recoveryDelay = this.#sessionReauthObservedAtMs === undefined && !this.#authenticatedOnce
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
      if (loginPage) {
        await this.recoverLoginInSeparatePage(keeper);
        return;
      }
      this.recoveryDiagnostic("attempt");
      try {
        this.invalidateTouch();
        await keeper.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
      } catch {
        return;
      }
      if (isKeeperSettledUrl(keeper.url())) {
        // A loaded application shell does not prove an authenticated session.
        // Preserve the pending state until the protected read succeeds.
        const outcome = await this.touchAuthenticatedSession();
        this.recoveryDiagnostic(outcome === "ok" ? "verified" : outcome === "reauth" ? "login_required" : "failed");
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

  /** Use the existing profile's ordinary SSO redirect chain without touching the
   * user's sign-in/MFA form. Promote only after an actual protected read succeeds.
   */
  private async recoverLoginInSeparatePage(original: BrowserPageLike): Promise<void> {
    const originalUrl = original.url();
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("attempt");
    try {
      probe = await this.context.newPage();
      // Exclude this managed tab from concurrent keeper/command page adoption.
      this.#commandPages.add(probe);
      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic(isSamsungLoginUrl(probe.url()) ? "login_required" : "failed");
        return;
      }
      const candidate = probe;
      const verifier = new KeeperPageManager({ pages: () => [candidate], newPage: async () => candidate });
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(outcome === "reauth" ? "login_required" : "failed");
        return;
      }
      if (!this.#canNavigate() || this.currentKeeper() !== original || original.url() !== originalUrl ||
          candidate.isClosed() || !isKeeperSettledUrl(candidate.url())) {
        this.recoveryDiagnostic("stale"); return;
      }
      this.invalidateTouch();
      this.#keeper = candidate;
      this.#commandPages.delete(candidate);
      this.#authenticatedOnce = true;
      this.clearRecoveryState();
      probe = undefined;
      await original.close().catch(() => undefined);
      this.recoveryDiagnostic("verified");
    } catch {
      this.recoveryDiagnostic("failed");
    } finally {
      await probe?.close().catch(() => undefined);
    }
  }

  private observeSessionTouchOutcome(outcome: SessionTouchOutcome, url: string): void {
    if (outcome === "ok") {
      this.#authenticatedOnce = true;
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
