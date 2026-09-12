import { inspectAuthenticationPage } from "./session-application-proof.js";

export const KEEPER_URL = "https://my.smartthings.com/location";
export const ADVANCED_URL = "https://my.smartthings.com/advanced";
export const SAMSUNG_ACCOUNT_URL = "https://account.samsung.com/";
const SESSION_TOUCH_PATH = "/location";
export const SESSION_TOUCH_AUTH_PATH =
  "/advanced/cupcake-api/api/locations?allowed=true";
const SESSION_TOUCH_TIMEOUT_MS = 12_000;
const SESSION_REAUTH_RECOVERY_DELAY_MS = 30_000;
const LOGIN_RECOVERY_DELAY_MS = 15 * 60_000;
const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;
const SESSION_RECOVERY_MAX_RETRY_MS = 30 * 60_000;
const SESSION_PROACTIVE_REFRESH_INTERVAL_MS = 15 * 60_000;
const SESSION_PROACTIVE_REFRESH_RETRY_MS = 2 * 60_000;
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
  waitForURL?(url: (url: URL) => boolean, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
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
export type ProactiveSessionRefreshOutcome =
  | "verified"
  | "login_required"
  | "failed"
  | "stale"
  | "skipped";

export interface SessionProbeDiagnostic {
  outcome: SessionTouchOutcome;
  reason: string;
  status?: number;
}

export interface KeeperPageManagerOptions {
  verifyRefreshCandidate?: (page: BrowserPageLike, expectedUrl: string) => Promise<boolean>;
  onLoginPage?: (page: BrowserPageLike, stage: "refresh" | "recovery" | "sso") => Promise<void>;
  onSessionProbe?: (diagnostic: SessionProbeDiagnostic) => void;
  now?: () => number;
  canNavigate?: () => boolean;
  sessionReauthRecoveryDelayMs?: number;
  loginRecoveryDelayMs?: number;
  sessionRecoveryRetryMs?: number;
  proactiveRefreshIntervalMs?: number;
  proactiveRefreshRetryMs?: number;
  onRecovery?: (phase:
    | "attempt"
    | "verified"
    | "login_required"
    | "login_page_unsettled"
    | "sso_page_unsettled"
    | "failed"
    | "stale"
    | "refresh_attempt"
    | "refresh_verified"
    | "refresh_handoff_verified"
    | "refresh_login_required"
    | "refresh_failed"
    | "refresh_stale"
    | "sso_attempt"
    | "sso_verified"
    | "sso_login_required"
    | "sso_failed"
    | "sso_stale"
  ) => void;
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
  #consecutiveRecoveryFailures = 0;
  #sessionRecoveryInFlight: Promise<void> | undefined;
  readonly #proactiveRefreshIntervalMs: number;
  readonly #proactiveRefreshRetryMs: number;
  #lastProactiveRefreshAtMs: number | undefined;
  #lastProactiveRefreshAttemptAtMs: number | undefined;
  #proactiveRefreshInFlight: Promise<ProactiveSessionRefreshOutcome> | undefined;
  #touchInFlight: { page: BrowserPageLike; url: string; result: Promise<SessionTouchOutcome> } | undefined;
  readonly #canNavigate: () => boolean;
  readonly #onRecovery: KeeperPageManagerOptions["onRecovery"];
  readonly #onSessionProbe: KeeperPageManagerOptions["onSessionProbe"];
  readonly #verifyRefreshCandidate: KeeperPageManagerOptions["verifyRefreshCandidate"];
  readonly #onLoginPage: KeeperPageManagerOptions["onLoginPage"];
  #authenticatedOnce = false;
  #touchGeneration = 0;

  constructor(
    private readonly context: BrowserContextLike,
    options: KeeperPageManagerOptions = {}
  ) {
    this.#now = options.now ?? Date.now;
    this.#onRecovery = options.onRecovery;
    this.#onSessionProbe = options.onSessionProbe;
    this.#verifyRefreshCandidate = options.verifyRefreshCandidate;
    this.#onLoginPage = options.onLoginPage;
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
    this.#proactiveRefreshIntervalMs = validDelay(
      options.proactiveRefreshIntervalMs,
      SESSION_PROACTIVE_REFRESH_INTERVAL_MS
    );
    this.#proactiveRefreshRetryMs = validDelay(
      options.proactiveRefreshRetryMs,
      SESSION_PROACTIVE_REFRESH_RETRY_MS
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

  private async recordLoginPage(page: BrowserPageLike, stage: "refresh" | "recovery" | "sso"): Promise<void> {
    try { await this.#onLoginPage?.(page, stage); } catch { /* Diagnostic only. */ }
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
    if (this.#proactiveRefreshInFlight || this.#sessionRecoveryInFlight ||
        !this.#canNavigate() || (current && isSamsungLoginUrl(current.url()))) {
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

  private reportProbe(outcome: SessionTouchOutcome, value?: unknown): void {
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown> : undefined;
    // Only fixed categories and an HTTP status are allowed into diagnostics.
    const reasons = ["verified", "http_401", "auth_redirect", "http_error",
      "unexpected_content_type", "invalid_json", "invalid_collection",
      "network_or_timeout", "evaluation_failed", "renderer_timeout", "adapter_result"];
    const reason = typeof record?.reason === "string" && reasons.includes(record.reason)
      ? record.reason : "adapter_result";
    const status = typeof record?.status === "number" && Number.isInteger(record.status) &&
      record.status >= 100 && record.status <= 599 ? record.status : undefined;
    try {
      this.#onSessionProbe?.({ outcome, reason, ...(status === undefined ? {} : { status }) });
    } catch { /* Diagnostics cannot change authentication. */ }
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
    // Keep the evaluate lease after a renderer timeout until it actually settles.
    const operation = Promise.resolve().then(() => keeper.evaluate!<
      SessionProbeDiagnostic | SessionTouchOutcome, { path: string; authPath: string; timeout: number }
    >(
      async ({ path, authPath, timeout }) => {
        const request = async (target: string, budget: number, verify: boolean): Promise<SessionProbeDiagnostic> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), budget);
          try {
            // api-free-audit: authenticated-page-same-origin-read-only-session-touch
            const response = await fetch(target, {
              cache: "no-store", credentials: "same-origin", method: "GET",
              redirect: "manual", signal: controller.signal
            });
            const status = response.status;
            if (status === 401) return { outcome: "reauth", reason: "http_401", status };
            if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
              return { outcome: "reauth", reason: "auth_redirect", status };
            }
            if (!response.ok) return { outcome: "failed", reason: "http_error", status };
            if (!verify) {
              await response.body?.cancel().catch(() => undefined);
              return { outcome: "ok", reason: "verified", status };
            }
            if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
              await response.body?.cancel().catch(() => undefined);
              return { outcome: "failed", reason: "unexpected_content_type", status };
            }
            let value: unknown;
            try { value = await response.json(); }
            catch { return { outcome: "failed", reason: "invalid_json", status }; }
            const record = typeof value === "object" && value !== null && !Array.isArray(value)
              ? value as Record<string, unknown> : undefined;
            const rows = Array.isArray(value) ? value :
              ["items", "locations", "data", "results"].map((key) => record?.[key]).find(Array.isArray);
            if (!Array.isArray(rows) || (record && (record.error || record.errors))) {
              return { outcome: "failed", reason: "invalid_collection", status };
            }
            const valid = rows.every((row: unknown) => {
              if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
              const item = row as Record<string, unknown>;
              const id = item.locationId ?? item.id;
              return typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id);
            });
            return { outcome: valid ? "ok" : "failed", reason: valid ? "verified" : "invalid_collection", status };
          } catch { return { outcome: "failed", reason: "network_or_timeout" }; }
          finally { controller.abort(); clearTimeout(timer); }
        };
        const pageBudget = Math.max(1, Math.min(3_000, Math.floor(timeout / 4)));
        await request(path, pageBudget, false);
        return request(authPath, Math.max(1, timeout - pageBudget), true);
      }, { path: SESSION_TOUCH_PATH, authPath: SESSION_TOUCH_AUTH_PATH, timeout }
    )).catch(() => ({ outcome: "failed", reason: "evaluation_failed" } as const)).finally(() => {
      if (this.#touchInFlight === flight) this.#touchInFlight = undefined;
    });
    flight.result = Promise.race([
      operation,
      new Promise<SessionProbeDiagnostic>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "failed", reason: "renderer_timeout" }), timeout + 1_000);
        timer.unref?.();
      })
    ]).then((value) => {
      if (generation !== this.#touchGeneration || this.currentKeeper() !== keeper || keeper.isClosed() || keeper.url() !== url) return "stale";
      const outcome = typeof value === "string" ? value : value?.outcome;
      const result: SessionTouchOutcome = outcome === "ok" || outcome === "reauth" ? outcome : "failed";
      this.reportProbe(result, value);
      this.observeSessionTouchOutcome(result, url);
      return result;
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    return flight.result;
  }

  async refreshAuthenticatedSessionIfDue(): Promise<ProactiveSessionRefreshOutcome> {
    const keeper = this.currentKeeper();
    if (
      !keeper ||
      !this.#authenticatedOnce ||
      this.authenticationRecoveryPending() ||
      !this.#canNavigate() ||
      !isKeeperSettledUrl(keeper.url())
    ) {
      return "skipped";
    }

    const now = this.#now();
    this.#lastProactiveRefreshAtMs ??= now;
    if (now - this.#lastProactiveRefreshAtMs < this.#proactiveRefreshIntervalMs) {
      return "skipped";
    }
    if (
      this.#lastProactiveRefreshAttemptAtMs !== undefined &&
      now - this.#lastProactiveRefreshAttemptAtMs < this.#proactiveRefreshRetryMs
    ) {
      return "skipped";
    }
    if (this.#proactiveRefreshInFlight) return this.#proactiveRefreshInFlight;

    this.#lastProactiveRefreshAttemptAtMs = now;
    const expectedKeeper = keeper;
    const expectedUrl = keeper.url();
    const operation = this.refreshAuthenticatedSessionProbe(expectedKeeper, expectedUrl);
    this.#proactiveRefreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#proactiveRefreshInFlight === operation) {
        this.#proactiveRefreshInFlight = undefined;
      }
    }
  }

  private async refreshAuthenticatedSessionProbe(
    expectedKeeper: BrowserPageLike,
    expectedUrl: string
  ): Promise<ProactiveSessionRefreshOutcome> {
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("refresh_attempt");
    try {
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      const target = this.#verifyRefreshCandidate && isConcreteLocationUrl(expectedUrl) ? expectedUrl : KEEPER_URL;
      await probe.goto(target, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitForSettledKeeperPage(probe);
      if (isSamsungLoginUrl(probe.url())) {
        await this.recordLoginPage(probe, "refresh");
        this.recoveryDiagnostic("refresh_login_required");
        return "login_required";
      }
      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic("refresh_failed");
        return "failed";
      }

      const candidate = probe;
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false, onSessionProbe: (diagnostic) => this.#onSessionProbe?.(diagnostic) }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(
          outcome === "reauth" ? "refresh_login_required" : "refresh_failed"
        );
        return outcome === "reauth" ? "login_required" : "failed";
      }
      if (
        !this.#canNavigate() ||
        this.currentKeeper() !== expectedKeeper ||
        expectedKeeper.isClosed() ||
        expectedKeeper.url() !== expectedUrl
      ) {
        this.recoveryDiagnostic("refresh_stale");
        return "stale";
      }

      if (this.#verifyRefreshCandidate) {
        // The fresh app has its own in-memory auth lifecycle. Verify its native
        // Location connection, then keep THAT document running instead of
        // discarding it and leaving the old keeper's stale timers/client alive.
        if (!(await this.#verifyRefreshCandidate(candidate, expectedUrl))) {
          this.recoveryDiagnostic("refresh_failed");
          return "failed";
        }
        if (!this.#canNavigate() || this.currentKeeper() !== expectedKeeper ||
            expectedKeeper.isClosed() || expectedKeeper.url() !== expectedUrl ||
            candidate.isClosed() || !isKeeperSettledUrl(candidate.url())) {
          this.recoveryDiagnostic("refresh_stale");
          return "stale";
        }
        if (!(await this.promoteVerifiedKeeper(candidate))) {
          this.recoveryDiagnostic("refresh_stale");
          return "stale";
        }
        probe = undefined;
        this.recoveryDiagnostic("refresh_handoff_verified");
      }
      this.#lastProactiveRefreshAtMs = this.#now();
      this.#lastProactiveRefreshAttemptAtMs = undefined;
      this.recoveryDiagnostic("refresh_verified");
      return "verified";
    } catch {
      this.recoveryDiagnostic("refresh_failed");
      return "failed";
    } finally {
      if (probe) {
        this.#commandPages.delete(probe);
        await probe.close().catch(() => undefined);
      }
    }
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
    // A failed, unchanged Samsung page must not create an endless fixed-rate
    // SSO loop. Keep the first retry compatible, then back off to 30 minutes.
    const retryDelayMs = Math.min(
      this.#sessionRecoveryRetryMs * 2 ** Math.min(6, Math.max(0, this.#consecutiveRecoveryFailures - 1)),
      Math.max(this.#sessionRecoveryRetryMs, SESSION_RECOVERY_MAX_RETRY_MS)
    );
    if (
      this.#lastRecoveryAttemptAtMs !== undefined &&
      now - this.#lastRecoveryAttemptAtMs < retryDelayMs
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
        if (
          outcome !== "ok" &&
          this.#authenticatedOnce &&
          this.authenticationRecoveryPending()
        ) {
          await this.recoverViaSamsungSsoInSeparatePage(keeper);
        }
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
        if (this.authenticationRecoveryPending()) {
          this.#consecutiveRecoveryFailures = Math.min(7, this.#consecutiveRecoveryFailures + 1);
        }
        this.#sessionRecoveryInFlight = undefined;
      }
    }
  }

  /** Re-enter the ordinary Samsung Account -> SmartThings SSO chain when a
   * stale SmartThings application shell cannot renew its protected session.
   * This never fills credentials, changes cookie expiry, bypasses MFA, or replays
   * a device command. If Samsung requires interaction, the real login page is
   * surfaced as the keeper instead of repeatedly reloading a dead app shell.
   */
  private async recoverViaSamsungSsoInSeparatePage(original: BrowserPageLike): Promise<void> {
    const originalUrl = original.url();
    const originalIsCurrent = () => this.#canNavigate() && this.currentKeeper() === original &&
      !original.isClosed() && original.url() === originalUrl;
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("sso_attempt");
    try {
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      await probe.goto(SAMSUNG_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      // Let Samsung's ordinary redirect/cookie bootstrap finish before leaving
      // its document. All waits are bounded and the user's tab stays untouched.
      await waitForSettledKeeperPage(probe, 5_000);
      if (!originalIsCurrent()) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }

      if (!isKeeperSettledUrl(probe.url())) {
        await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
        await waitForSettledKeeperPage(probe);
      }
      if (isSamsungLoginUrl(probe.url())) {
        await this.recordLoginPage(probe, "sso");
        const diagnostic = await inspectAuthenticationPage(probe);
        if (!originalIsCurrent()) {
          this.recoveryDiagnostic("sso_stale");
          return;
        }
        if (!hasVisibleAuthenticationInput(diagnostic.surface)) {
          // A blank/iframe/custom/loading page is unknown, not proof of an MFA
          // requirement. Never replace a recoverable keeper with that page.
          this.recoveryDiagnostic("sso_page_unsettled");
          return;
        }
        if (isSamsungLoginUrl(originalUrl)) {
          // The user's existing sign-in/MFA tab is the interaction surface.
          this.recoveryDiagnostic("sso_login_required");
          return;
        }
        this.invalidateTouch();
        this.#keeper = probe;
        this.#commandPages.delete(probe);
        this.#sessionReauthObservedAtMs = undefined;
        this.#loginObservedAtMs = this.#now();
        probe = undefined;
        await original.close().catch(() => undefined);
        this.recoveryDiagnostic("sso_login_required");
        return;
      }
      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic("sso_failed");
        return;
      }

      const candidate = probe;
      const candidateUrl = candidate.url();
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false, onSessionProbe: (diagnostic) => this.#onSessionProbe?.(diagnostic) }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(outcome === "reauth" ? "sso_login_required" : "sso_failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }
      if (!(await this.verifyRecoveredApplication(candidate))) {
        this.recoveryDiagnostic("sso_failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl ||
          !(await this.promoteVerifiedKeeper(candidate))) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }
      probe = undefined;
      // Unlike the former app-only SSO caller, login recovery may retain a form.
      // Close it only AFTER a fully verified replacement has become the keeper.
      if (isSamsungLoginUrl(originalUrl)) await original.close().catch(() => undefined);
      this.recoveryDiagnostic("sso_verified");
    } catch {
      this.recoveryDiagnostic("sso_failed");
    } finally {
      if (probe) this.#commandPages.delete(probe);
      await probe?.close().catch(() => undefined);
    }
  }

  private async verifyRecoveredApplication(candidate: BrowserPageLike): Promise<boolean> {
    if (!this.#verifyRefreshCandidate) return true;
    const target = candidate.url();
    // Reuse the runtime's existing read-only native Location proof. Advanced
    // HTTP success alone must not promote a disconnected application shell.
    return isConcreteLocationUrl(target) && await this.#verifyRefreshCandidate(candidate, target);
  }

  /** Use the existing profile's ordinary SSO redirect chain without touching the
   * user's sign-in/MFA form. Promote only after protected and native reads pass.
   */
  private async recoverLoginInSeparatePage(original: BrowserPageLike): Promise<void> {
    const originalUrl = original.url();
    const originalIsCurrent = () => this.#canNavigate() && this.currentKeeper() === original &&
      !original.isClosed() && original.url() === originalUrl;
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("attempt");
    try {
      const originalDiagnostic = await inspectAuthenticationPage(original);
      if (!originalIsCurrent()) {
        this.recoveryDiagnostic("stale");
        return;
      }
      if (hasVisibleAuthenticationInput(originalDiagnostic.surface)) {
        this.recoveryDiagnostic("login_required");
        return;
      }
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitForSettledKeeperPage(probe);
      if (!isKeeperSettledUrl(probe.url())) {
        await this.recordLoginPage(probe, "recovery");
        const diagnostic = await inspectAuthenticationPage(probe);
        if (!originalIsCurrent()) {
          this.recoveryDiagnostic("stale");
          return;
        }
        const samsungLogin = isSamsungLoginUrl(probe.url());
        if (samsungLogin && !hasVisibleAuthenticationInput(diagnostic.surface)) {
          this.recoveryDiagnostic("login_page_unsettled");
          // This route was previously missing once the keeper itself reached
          // Samsung Account: every retry just repeated the same failed URL.
          // Absence of inputs is NOT proof that no challenge exists; use only
          // ordinary navigation in a separate tab, never credential injection.
          if (this.#authenticatedOnce) await this.recoverViaSamsungSsoInSeparatePage(original);
        } else {
          this.recoveryDiagnostic(samsungLogin ? "login_required" : "failed");
        }
        return;
      }
      const candidate = probe;
      const candidateUrl = candidate.url();
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false, onSessionProbe: (diagnostic) => this.#onSessionProbe?.(diagnostic) }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(outcome === "reauth" ? "login_required" : "failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl) {
        this.recoveryDiagnostic("stale");
        return;
      }
      if (!(await this.verifyRecoveredApplication(candidate))) {
        this.recoveryDiagnostic("failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl ||
          !isKeeperSettledUrl(candidate.url())) {
        this.recoveryDiagnostic("stale");
        return;
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
      if (probe) this.#commandPages.delete(probe);
      await probe?.close().catch(() => undefined);
    }
  }

  private observeSessionTouchOutcome(outcome: SessionTouchOutcome, url: string): void {
    if (outcome === "ok") {
      this.#authenticatedOnce = true;
      this.#lastProactiveRefreshAtMs ??= this.#now();
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
    this.#consecutiveRecoveryFailures = 0;
  }
}

/** A DOMContentLoaded on Samsung Account can be an intermediate SSO page.
 * Wait for the final SmartThings URL; never submit or replace a sign-in form.
 * A timeout is not evidence of server-enforced expiry or an MFA requirement.
 */
export async function waitForSettledKeeperPage(
  page: BrowserPageLike,
  timeoutMs = 20_000
): Promise<boolean> {
  if (page.isClosed()) return false;
  if (isKeeperSettledUrl(page.url())) return true;
  if (!page.waitForURL) return false;
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(20_000, timeoutMs)) : 20_000;
  try {
    await page.waitForURL((url) => isKeeperSettledUrl(url.toString()), {
      waitUntil: "domcontentloaded", timeout
    });
  } catch { /* Preserve the current page for recovery or user interaction. */ }
  return !page.isClosed() && isKeeperSettledUrl(page.url());
}

function hasVisibleAuthenticationInput(surface: string): boolean {
  return surface === "password_input" || surface === "otp_input" || surface === "email_input";
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
