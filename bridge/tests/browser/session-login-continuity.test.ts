import { describe, expect, test, vi } from "vitest";
import {
  KEEPER_URL, SAMSUNG_ACCOUNT_URL, KeeperPageManager,
  type BrowserContextLike, type BrowserPageLike, type KeeperPageManagerOptions
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
  async goto(url: string): Promise<void> { this.navigations.push(url); this.onNavigate(url); }
  async evaluate<Result, Argument>(
    _fn: (argument: Argument) => Result | Promise<Result>, argument: Argument
  ): Promise<Result> {
    return (argument === undefined ? this.surface : this.protectedOutcome) as Result;
  }
}
class Context implements BrowserContextLike {
  readonly created: Page[] = [];
  constructor(readonly original: Page, readonly factory: () => Page) {}
  pages(): Page[] { return [this.original, ...this.created]; }
  async newPage(): Promise<Page> {
    const page = this.factory(); this.created.push(page); return page;
  }
}
async function scenario(options: {
  originalSurface?: AuthenticationSurface;
  directUrl?: string;
  candidateSurface?: AuthenticationSurface;
  protectedOutcome?: "ok" | "reauth" | "failed";
  authenticatedBefore?: boolean;
  verifyRefreshCandidate?: KeeperPageManagerOptions["verifyRefreshCandidate"];
  probeApplicationSession?: KeeperPageManagerOptions["probeApplicationSession"];
} = {}) {
  let now = 0;
  let allowed = true;
  const original = new Page(LOCATION);
  original.surface = options.originalSurface ?? "no_visible_auth_input";
  const context = new Context(original, () => {
    const page = new Page();
    page.surface = options.candidateSurface ?? "no_visible_auth_input";
    page.protectedOutcome = options.protectedOutcome ?? "ok";
    page.onNavigate = () => { page.currentUrl = options.directUrl ?? LOGIN; };
    return page;
  });
  const phases: string[] = [];
  const manager = new KeeperPageManager(context, {
    now: () => now, canNavigate: () => allowed,
    sessionReauthRecoveryDelayMs: 0, loginRecoveryDelayMs: 0,
    sessionRecoveryRetryMs: 100, unsettledRecoveryGraceMs: 120_000,
    onRecovery: (phase) => phases.push(phase),
    ...(options.verifyRefreshCandidate ? { verifyRefreshCandidate: options.verifyRefreshCandidate } : {}),
    ...(options.probeApplicationSession ? { probeApplicationSession: options.probeApplicationSession } : {})
  });
  await manager.reconcileRestoredPages();
  if (options.authenticatedBefore !== false) expect(await manager.touchAuthenticatedSession()).toBe("ok");
  original.currentUrl = LOGIN;
  return { original, context, manager, phases,
    at: (value: number) => { now = value; }, allow: (value: boolean) => { allowed = value; } };
}

describe("Samsung login session continuity", () => {
  test("keeps one authorization document alive across retries, without competing Account-root SSO", async () => {
    const verify = vi.fn(async () => true);
    const s = await scenario({ verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(1);
    const candidate = s.context.created[0]!;
    expect(candidate.navigations).toEqual([LOCATION]);
    expect(candidate.navigations).not.toContain(SAMSUNG_ACCOUNT_URL);
    expect(candidate.closed).toBe(false);
    expect(s.manager.authenticationRecoveryPending()).toBe(true);
    for (const time of [100, 1_000, 30_000, 90_000]) {
      s.at(time); await s.manager.ensureKeeper();
      expect(s.context.created).toHaveLength(1);
      expect(candidate.closed).toBe(false);
      expect(s.original.closed).toBe(false);
    }
    candidate.currentUrl = LOCATION; // Same document finally completes asynchronous SSO.
    await s.manager.ensureKeeper();
    expect(verify).toHaveBeenCalledWith(candidate, LOCATION);
    expect(s.manager.currentKeeper()).toBe(candidate);
    expect(s.manager.authenticationRecoveryPending()).toBe(false);
    expect(s.original.closed).toBe(true);
    expect(s.phases).toContain("login_page_pending");
    expect(s.phases).toContain("verified");
    expect(s.phases).not.toContain("sso_attempt");
  });

  test.each(["password_input", "otp_input", "email_input", "embedded_auth_input", "auth_action", "captcha"] as const)(
    "never navigates or replaces the user's visible %s challenge", async surface => {
      const s = await scenario({ originalSurface: surface });
      await s.manager.ensureKeeper();
      expect(s.context.created).toHaveLength(0);
      expect(s.original.navigations).toEqual([]);
      expect(s.original.closed).toBe(false);
      expect(s.manager.currentKeeper()).toBe(s.original);
      expect(s.phases).toContain("login_required");
    }
  );

  test("surfaces a still-unsettled page after a bounded grace without declaring login success or repeating SSO", async () => {
    const s = await scenario();
    await s.manager.ensureKeeper();
    const candidate = s.context.created[0]!;
    s.at(120_001); await s.manager.ensureKeeper();
    expect(s.manager.currentKeeper()).toBe(candidate);
    expect(candidate.closed).toBe(false);
    expect(s.original.closed).toBe(true);
    expect(s.manager.authenticationRecoveryPending()).toBe(true);
    expect(s.phases).toContain("login_page_stalled");
    expect(s.phases).not.toContain("verified");
    s.at(4_000_000); await s.manager.ensureKeeper();
    expect(s.context.created).toHaveLength(1);
    expect(candidate.navigations).toEqual([LOCATION]);
  });

  test("retains newly revealed candidate MFA for manual completion", async () => {
    const s = await scenario({ candidateSurface: "otp_input" });
    await s.manager.ensureKeeper();
    const candidate = s.context.created[0]!;
    expect(candidate.closed).toBe(false);
    await s.manager.ensureKeeper();
    expect(s.manager.currentKeeper()).toBe(candidate);
    expect(candidate.closed).toBe(false);
    expect(s.manager.authenticationRecoveryPending()).toBe(true);
  });

  test("preserves original MFA if it becomes visible while a redirect is pending", async () => {
    const s = await scenario(); await s.manager.ensureKeeper();
    s.original.surface = "otp_input";
    s.context.created[0]!.currentUrl = LOCATION;
    await s.manager.ensureKeeper();
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created[0]!.closed).toBe(true);
  });

  test.each([false, true])("requires native proof in addition to Advanced 200 (delayed=%s)", async delayed => {
    const verify = vi.fn(async () => false);
    const s = await scenario({ directUrl: delayed ? LOGIN : LOCATION, verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper();
    if (delayed) { s.context.created[0]!.currentUrl = LOCATION; await s.manager.ensureKeeper(); }
    expect(verify).toHaveBeenCalledWith(s.context.created[0], LOCATION);
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created[0]!.closed).toBe(true);
    expect(s.phases).not.toContain("verified");
  });

  test("does not promote a delayed candidate with a rejected protected read", async () => {
    const verify = vi.fn(async () => true);
    const s = await scenario({ protectedOutcome: "reauth", verifyRefreshCandidate: verify });
    await s.manager.ensureKeeper(); s.context.created[0]!.currentUrl = LOCATION;
    await s.manager.ensureKeeper();
    expect(verify).not.toHaveBeenCalled();
    expect(s.phases).toContain("login_required");
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
  });

  test("backs off genuine failures instead of opening an authorization flow each heartbeat", async () => {
    const s = await scenario({ directUrl: LOCATION, protectedOutcome: "failed" });
    await s.manager.ensureKeeper(); expect(s.context.created).toHaveLength(1);
    s.at(99); await s.manager.ensureKeeper(); expect(s.context.created).toHaveLength(1);
    s.at(100); await s.manager.ensureKeeper(); expect(s.context.created).toHaveLength(2);
    s.at(299); await s.manager.ensureKeeper(); expect(s.context.created).toHaveLength(2);
    s.at(300); await s.manager.ensureKeeper(); expect(s.context.created).toHaveLength(3);
  });

  test("shares concurrent recovery requests and defers adoption during a foreground command", async () => {
    const s = await scenario();
    await Promise.all([s.manager.ensureKeeper(), s.manager.ensureKeeper(), s.manager.ensureKeeper()]);
    expect(s.context.created).toHaveLength(1);
    s.context.created[0]!.currentUrl = LOCATION; s.allow(false);
    await s.manager.ensureKeeper(); expect(s.manager.currentKeeper()).toBe(s.original);
    s.allow(true); await s.manager.ensureKeeper(); expect(s.manager.currentKeeper()).toBe(s.context.created[0]);
  });

  test("rejects a stale candidate when the user finishes login while native proof is pending", async () => {
    let original: Page | undefined;
    const s = await scenario({ directUrl: LOCATION, verifyRefreshCandidate: async () => {
      original!.currentUrl = `${KEEPER_URL}/user-selected-location`; return true;
    } });
    original = s.original; await s.manager.ensureKeeper();
    expect(s.manager.currentKeeper()).toBe(s.original);
    expect(s.original.closed).toBe(false);
    expect(s.context.created[0]!.closed).toBe(true);
    expect(s.phases).toContain("stale");
  });

  test("preserves a newly shown original challenge during native verification", async () => {
    let original: Page | undefined;
    const s = await scenario({ verifyRefreshCandidate: async () => { original!.surface = "otp_input"; return true; } });
    original = s.original; await s.manager.ensureKeeper();
    s.context.created[0]!.currentUrl = LOCATION; await s.manager.ensureKeeper();
    expect(s.manager.currentKeeper()).toBe(s.original); expect(s.original.closed).toBe(false);
  });

  test.each([false, true])("rejects unrelated redirects (delayed=%s)", async delayed => {
    const s = await scenario({ directUrl: delayed ? LOGIN : "https://example.invalid/unavailable" });
    await s.manager.ensureKeeper();
    if (delayed) { s.context.created[0]!.currentUrl = "https://example.invalid/unavailable"; await s.manager.ensureKeeper(); }
    expect(s.context.created).toHaveLength(1);
    expect(s.context.created[0]!.closed).toBe(true);
    expect(s.phases).not.toContain("sso_attempt"); expect(s.original.closed).toBe(false);
  });

  test("never infers remembered authentication from an input-less first login", async () => {
    const s = await scenario({ authenticatedBefore: false }); await s.manager.ensureKeeper();
    expect(s.context.created[0]!.navigations).toEqual([KEEPER_URL]);
    expect(s.manager.authenticationRecoveryPending()).toBe(true);
    expect(s.phases).not.toContain("verified"); expect(s.original.closed).toBe(false);
  });
});
