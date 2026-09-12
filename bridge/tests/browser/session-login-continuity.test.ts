import { describe, expect, test, vi } from "vitest";

import {
  KEEPER_URL,
  SAMSUNG_ACCOUNT_URL,
  KeeperPageManager,
  type BrowserContextLike,
  type BrowserPageLike,
  type KeeperPageManagerOptions
} from "../../src/browser/keeper-page.js";
import type { AuthenticationSurface } from "../../src/browser/session-application-proof.js";

const LOCATION = `${KEEPER_URL}/test-location`;
const LOGIN = "https://account.samsung.com/accounts/v1/signIn";

class Page implements BrowserPageLike {
  closed = false;
  surface: AuthenticationSurface = "no_visible_auth_input";
  protectedOutcome: "ok" | "reauth" | "failed" = "ok";
  readonly navigations: string[] = [];
  onNavigate: (url: string) => void = (url) => { this.currentUrl = url; };

  constructor(public currentUrl = "about:blank") {}
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.closed; }
  async close(): Promise<void> { this.closed = true; }
  async goto(url: string): Promise<void> {
    this.navigations.push(url);
    this.onNavigate(url);
  }
  async evaluate<Result, Argument>(
    _fn: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    // The production inspector never reads values; protected probes use an argument.
    return (argument === undefined ? this.surface : this.protectedOutcome) as Result;
  }
}

class Context implements BrowserContextLike {
  readonly created: Page[] = [];
  constructor(readonly original: Page, readonly factory: (index: number) => Page) {}
  pages(): Page[] { return [this.original, ...this.created]; }
  async newPage(): Promise<Page> {
    const page = this.factory(this.created.length);
    this.created.push(page);
    return page;
  }
}

interface ScenarioOptions {
  originalSurface?: AuthenticationSurface;
  directUrl?: string;
  fallbackUrl?: string;
  fallbackSurface?: AuthenticationSurface;
  protectedOutcome?: "ok" | "reauth" | "failed";
  authenticatedBefore?: boolean;
  verifyRefreshCandidate?: KeeperPageManagerOptions["verifyRefreshCandidate"];
}

async function scenario(options: ScenarioOptions = {}) {
  let now = 0;
  const original = new Page(LOCATION);
  original.surface = options.originalSurface ?? "no_visible_auth_input";
  const context = new Context(original, (index) => {
    const page = new Page();
    const fallback = index % 2 === 1;
    page.surface = fallback
      ? options.fallbackSurface ?? "no_visible_auth_input"
      : "no_visible_auth_input";
    page.protectedOutcome = options.protectedOutcome ?? "ok";
    page.onNavigate = (url) => {
      page.currentUrl = url === SAMSUNG_ACCOUNT_URL
        ? LOGIN
        : fallback ? options.fallbackUrl ?? LOCATION : options.directUrl ?? LOGIN;
    };
    return page;
  });
  const phases: string[] = [];
  const manager = new KeeperPageManager(context, {
    now: () => now,
    sessionReauthRecoveryDelayMs: 0,
    loginRecoveryDelayMs: 0,
    sessionRecoveryRetryMs: 100,
    onRecovery: (phase) => phases.push(phase),
    ...(options.verifyRefreshCandidate ? { verifyRefreshCandidate: options.verifyRefreshCandidate } : {})
  });
  await manager.reconcileRestoredPages();
  if (options.authenticatedBefore !== false) {
    expect(await manager.touchAuthenticatedSession()).toBe("ok");
  }
  original.currentUrl = LOGIN;
  return { original, context, manager, phases, at: (value: number) => { now = value; } };
}

describe("Samsung login session continuity", () => {
  test("re-enters ordinary Samsung SSO when a previously authenticated keeper stalls without inputs", async () => {
    const verify = vi.fn(async () => true);
    const s = await scenario({ verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(2);
    expect(s.context.created[0]?.closed).toBe(true);
    expect(s.context.created[1]?.navigations).toEqual([SAMSUNG_ACCOUNT_URL, KEEPER_URL]);
    expect(verify).toHaveBeenCalledWith(s.context.created[1], LOCATION);
    expect(s.manager.currentKeeper()).toBe(s.context.created[1]);
    expect(s.manager.authenticationRecoveryPending()).toBe(false);
    expect(s.original.closed).toBe(true);
    expect(s.phases).toContain("login_page_unsettled");
    expect(s.phases).toContain("sso_verified");
    expect(s.phases).not.toContain("login_required");
  });

  test.each(["password_input", "otp_input", "email_input"] as const)(
    "does not navigate or replace the user's visible %s form", async (surface) => {
      const s = await scenario({ originalSurface: surface });
      await s.manager.ensureKeeper();
      expect(s.context.created).toHaveLength(0);
      expect(s.original.navigations).toEqual([]);
      expect(s.original.closed).toBe(false);
      expect(s.manager.currentKeeper()).toBe(s.original);
      expect(s.phases).toContain("login_required");
    }
  );

  test("does not label an input-less SSO page as confirmed interactive login or replace the original", async () => {
    const s = await scenario({ fallbackUrl: LOGIN });
    await s.manager.ensureKeeper();
    expect(s.phases).toContain("sso_page_unsettled");
    expect(s.phases).not.toContain("sso_login_required");
    expect(s.original.closed).toBe(false);
    expect(s.original.navigations).toEqual([]);
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.context.created.every(page => page.closed)).toBe(true);
  });

  test("preserves the existing login tab when the fallback itself presents MFA", async () => {
    const s = await scenario({ fallbackUrl: LOGIN, fallbackSurface: "otp_input" });
    await s.manager.ensureKeeper();
    expect(s.phases).toContain("sso_login_required");
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created.every(page => page.closed)).toBe(true);
  });

  test("requires native Location proof as well as the successful protected HTTP read", async () => {
    const verify = vi.fn(async () => false);
    const s = await scenario({ verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(s.phases).toContain("sso_failed");
    expect(s.phases).not.toContain("sso_verified");
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created.every(page => page.closed)).toBe(true);
  });

  test("also requires native proof when the first recovery page returns to SmartThings", async () => {
    const verify = vi.fn(async () => false);
    const s = await scenario({ directUrl: LOCATION, verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    expect(verify).toHaveBeenCalledWith(s.context.created[0], LOCATION);
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created).toHaveLength(1);
    expect(s.context.created[0]?.closed).toBe(true);
  });

  test("does not promote a candidate with a rejected protected read", async () => {
    const verify = vi.fn(async () => true);
    const s = await scenario({ protectedOutcome: "reauth", verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    expect(verify).not.toHaveBeenCalled();
    expect(s.phases).toContain("sso_login_required");
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
  });

  test("backs off repeated failures instead of retrying at every base interval", async () => {
    const s = await scenario({ fallbackUrl: LOGIN });
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(2);
    s.at(99);
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(2);
    s.at(100);
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(4);
    s.at(299);
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(4);
    s.at(300);
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(6);
  });

  test("shares concurrent recovery requests rather than opening parallel SSO flows", async () => {
    const s = await scenario();
    await Promise.all([s.manager.ensureKeeper(), s.manager.ensureKeeper(), s.manager.ensureKeeper()]);
    expect(s.context.created).toHaveLength(2);
    expect(s.phases.filter(phase => phase === "sso_attempt")).toHaveLength(1);
  });

  test("rejects a stale candidate if the user finishes login while native proof is pending", async () => {
    let original: Page | undefined;
    const s = await scenario({ verifyRefreshCandidate: async () => {
      original!.currentUrl = `${KEEPER_URL}/user-selected-location`;
      return true;
    } });
    original = s.original;
    await s.manager.ensureKeeper();
    expect(s.phases).toContain("sso_stale");
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created.every(page => page.closed)).toBe(true);
  });

  test("does not try remembered SSO on an unrelated redirect", async () => {
    const s = await scenario({ directUrl: "https://example.invalid/unavailable" });
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(1);
    expect(s.phases).not.toContain("sso_attempt");
    expect(s.original.closed).toBe(false);
  });

  test("does not assume a never-authenticated profile contains a renewable session", async () => {
    const s = await scenario({ authenticatedBefore: false });
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(1);
    expect(s.phases).not.toContain("sso_attempt");
    expect(s.original.closed).toBe(false);
  });
});
