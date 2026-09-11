import { afterEach, describe, expect, test, vi } from "vitest";
import { KeeperPageManager, KEEPER_URL, type BrowserPageLike } from "../../src/browser/keeper-page.js";
import { AuthenticatedSmartThingsSession } from "../../src/advanced/authenticated-session.js";

class Page implements BrowserPageLike {
  address = `${KEEPER_URL}/fixture-home`;
  closed = false;
  url = () => this.address;
  isClosed = () => this.closed;
  goto = vi.fn(async (url: string) => { this.address = url; });
  close = vi.fn(async () => { this.closed = true; });
  evaluate = vi.fn(async (_fn: any, _arg: any): Promise<any> => "ok");
}
const loginUrl = "https://account.samsung.com/accounts/v1/ST/signInGate";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const setup = async (allowed: () => boolean = () => true) => {
  let now = 10_000;
  const original = new Page(), probe = new Page(), pages = [original];
  const create = vi.fn(async () => { pages.push(probe); return probe; });
  const recovery = vi.fn();
  const manager = new KeeperPageManager({ pages: () => pages, newPage: create }, {
    now: () => now, canNavigate: allowed, onRecovery: recovery
  });
  await manager.ensureKeeper();
  return { original, probe, create, recovery, manager, advance: (ms: number) => { now += ms; } };
};

describe("session rejection and non-destructive SSO recovery", () => {
  test("a definitive command 401 reaches the keeper immediately and never replays the POST", async () => {
    const f = await setup();
    f.original.evaluate.mockResolvedValue({ ok: false, status: 401, error: "redirect" });
    const fallback = vi.fn(async () => f.probe);
    const onAuthenticationFailure = vi.fn((page: BrowserPageLike, url: string) => { f.manager.reportAuthenticationFailure(page, url); });
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => f.manager.currentKeeper(), openAdvancedPage: fallback, onAuthenticationFailure });
    await expect(session.request({ endpoint: "commands", method: "POST", path: "/advanced/cupcake-api/api/devices/fixture/commands", body: { commands: [] } }, v => v)).rejects.toThrow("advanced_authentication_failed");
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
    expect(onAuthenticationFailure).toHaveBeenCalledOnce();
    expect(f.original.evaluate).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
  });
  test.each([403, 429, 503, 0])("status %i is not treated as expired authentication", async status => {
    const f = await setup(); f.original.evaluate.mockResolvedValue({ ok: false, status, error: "network" });
    const notice = vi.fn();
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => f.original, openAdvancedPage: async () => f.probe, onAuthenticationFailure: notice });
    await expect(session.request({ endpoint: "commands", method: "POST", path: "/advanced/cupcake-api/api/devices/fixture/commands", body: {} }, v => v)).rejects.toThrow();
    expect(notice).not.toHaveBeenCalled(); expect(f.manager.authenticationRecoveryPending()).toBe(false);
  });
  test("a late 401 from an obsolete keeper URL cannot revoke a new login", async () => {
    const f = await setup(); const oldUrl = f.original.url();
    f.original.address = `${KEEPER_URL}/another-home`;
    expect(f.manager.reportAuthenticationFailure(f.original, oldUrl)).toBe(false);
    expect(f.manager.reportAuthenticationFailure(f.probe, f.probe.url())).toBe(false);
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
  });
  test("a stale app shell escalates through Samsung Account SSO and promotes a verified tab", async () => {
    const f = await setup();
    await f.manager.touchAuthenticatedSession();
    expect(f.manager.reportAuthenticationFailure(f.original, f.original.url())).toBe(true);
    f.original.evaluate.mockResolvedValue("failed");
    f.advance(30_001);
    f.probe.goto.mockImplementation(async (url: string) => {
      f.probe.address = url === KEEPER_URL ? `${KEEPER_URL}/sso-home` : url;
    });
    f.probe.evaluate.mockResolvedValue("ok");

    expect(await f.manager.ensureKeeper()).toBe(f.probe);
    expect(f.probe.goto.mock.calls.map(([url]) => url)).toEqual([
      "https://account.samsung.com/", KEEPER_URL
    ]);
    expect(f.manager.currentKeeper()).toBe(f.probe);
    expect(f.original.close).toHaveBeenCalledOnce();
    expect(f.recovery).toHaveBeenCalledWith("sso_attempt");
    expect(f.recovery).toHaveBeenCalledWith("sso_verified");
  });

  test("an expired Samsung SSO session surfaces the real login page instead of looping the stale shell", async () => {
    const f = await setup();
    await f.manager.touchAuthenticatedSession();
    expect(f.manager.reportAuthenticationFailure(f.original, f.original.url())).toBe(true);
    f.original.evaluate.mockResolvedValue("failed");
    f.advance(30_001);
    f.probe.goto.mockImplementation(async (url: string) => {
      f.probe.address = url === KEEPER_URL ? loginUrl : url;
    });

    expect(await f.manager.ensureKeeper()).toBe(f.probe);
    expect(f.manager.currentKeeper()).toBe(f.probe);
    expect(f.probe.url()).toBe(loginUrl);
    expect(f.probe.close).not.toHaveBeenCalled();
    expect(f.original.close).toHaveBeenCalledOnce();
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
    expect(f.recovery).toHaveBeenCalledWith("sso_login_required");
  });

  test("a formerly authenticated login page recovers in a separate tab after 30 seconds", async () => {
    const f = await setup(); await f.manager.touchAuthenticatedSession();
    f.original.address = loginUrl; await f.manager.ensureKeeper();
    f.advance(30_001);
    const selected = await f.manager.ensureKeeper();
    expect(f.original.goto).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledOnce(); expect(selected).toBe(f.probe);
    expect(f.manager.currentKeeper()).toBe(f.probe);
    expect(f.original.close).toHaveBeenCalledOnce(); expect(f.probe.close).not.toHaveBeenCalled();
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
    expect(f.recovery).toHaveBeenCalledWith("verified");
  });
  test("when SSO still needs MFA, the original sign-in form is never navigated or closed", async () => {
    const f = await setup(); await f.manager.touchAuthenticatedSession();
    f.original.address = loginUrl; await f.manager.ensureKeeper(); f.advance(30_001);
    f.probe.goto.mockImplementation(async () => { f.probe.address = loginUrl; });
    expect(await f.manager.ensureKeeper()).toBe(f.original);
    expect(f.original.goto).not.toHaveBeenCalled(); expect(f.original.close).not.toHaveBeenCalled();
    expect(f.probe.close).toHaveBeenCalledOnce();
    expect(f.recovery).toHaveBeenCalledWith("login_required");
    f.advance(30_001); await f.manager.ensureKeeper(); expect(f.create).toHaveBeenCalledOnce();
  });
  test.each(["reauth", "failed"])("a returned app shell with protected read %s never becomes authenticated", async result => {
    const f = await setup(); await f.manager.touchAuthenticatedSession();
    f.original.address = loginUrl; await f.manager.ensureKeeper(); f.advance(30_001);
    f.probe.evaluate.mockResolvedValue(result);
    expect(await f.manager.ensureKeeper()).toBe(f.original);
    expect(f.manager.authenticationRecoveryPending()).toBe(true); expect(f.probe.close).toHaveBeenCalledOnce();
  });
  test("foreground activity defers recovery without creating a probe", async () => {
    let allowed = true; const f = await setup(() => allowed); await f.manager.touchAuthenticatedSession();
    f.original.address = loginUrl; await f.manager.ensureKeeper(); f.advance(30_001); allowed = false;
    await f.manager.ensureKeeper(); expect(f.create).not.toHaveBeenCalled();
  });
  test("a user completing login while a probe is pending retains the original page", async () => {
    const f = await setup(); await f.manager.touchAuthenticatedSession();
    f.original.address = loginUrl; await f.manager.ensureKeeper(); f.advance(30_001);
    f.probe.evaluate.mockImplementation(async () => { f.original.address = `${KEEPER_URL}/new-home`; return "ok"; });
    expect(await f.manager.ensureKeeper()).toBe(f.original);
    expect(f.original.close).not.toHaveBeenCalled(); expect(f.probe.close).toHaveBeenCalledOnce();
    expect(f.recovery).toHaveBeenCalledWith("stale");
  });
  test("same-URL managed reload invalidates an old stuck auth check and permits a new check", async () => {
    vi.useFakeTimers(); const f = await setup(); let finish!: (value: string) => void;
    f.original.evaluate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = f.manager.touchAuthenticatedSession(); await Promise.resolve();
    await f.manager.recoverKeeper();
    expect(await f.manager.touchAuthenticatedSession()).toBe("ok");
    finish("reauth"); expect(await old).toBe("stale");
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
  });
  test("socket reload of a pending session cannot clear rejection from just a location URL", async () => {
    const f = await setup(); f.manager.reportAuthenticationFailure(f.original, f.original.url());
    f.original.evaluate.mockResolvedValue("reauth"); await f.manager.recoverKeeper();
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
  });
  test("promotes a verified backup tab without closing an active login form", async () => {
    const f = await setup();
    const settledUrl = f.original.url();
    f.manager.reportAuthenticationFailure(f.original, settledUrl);
    f.original.address = loginUrl;
    const candidate = new Page();

    expect(await f.manager.promoteVerifiedKeeper(candidate)).toBe(true);
    expect(f.manager.currentKeeper()).toBe(candidate);
    expect(f.original.close).not.toHaveBeenCalled();
    expect(candidate.close).not.toHaveBeenCalled();
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
  });
});
