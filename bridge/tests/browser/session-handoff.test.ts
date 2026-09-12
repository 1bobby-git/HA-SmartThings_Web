import { afterEach, describe, expect, test, vi } from "vitest";
import { KeeperPageManager, KEEPER_URL, type BrowserPageLike } from "../../src/browser/keeper-page.js";
import { verifyLocationApplicationSession, inspectAuthenticationPage } from "../../src/browser/session-application-proof.js";
import { readFileSync } from "node:fs";

const home = `${KEEPER_URL}/fixture-home`;
class Page implements BrowserPageLike {
  address = home;
  closed = false;
  url = () => this.address;
  isClosed = () => this.closed;
  goto = vi.fn(async (url: string) => { this.address = url; });
  close = vi.fn(async () => { this.closed = true; });
  evaluate = vi.fn(async (_fn: any, _arg: any): Promise<any> => "ok");
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const fixture = async (verify = vi.fn(async (_page: BrowserPageLike, _target: string) => true), canNavigate = () => true) => {
  let now = 1_000;
  const original = new Page(), candidate = new Page(), phases = vi.fn(), login = vi.fn();
  const pages = [original];
  const manager = new KeeperPageManager({ pages: () => pages, newPage: async () => { pages.push(candidate); return candidate; } }, {
    now: () => now, canNavigate, proactiveRefreshIntervalMs: 100, verifyRefreshCandidate: verify,
    onRecovery: phases, onLoginPage: login
  });
  await manager.ensureKeeper(); await manager.touchAuthenticatedSession(); now += 101;
  return { manager, original, candidate, verify, phases, login };
};

describe("verified running-document handoff", () => {
  test("retains the verified fresh document instead of discarding its in-memory session", async () => {
    const f = await fixture();
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("verified");
    expect(f.candidate.goto).toHaveBeenCalledWith(home, expect.any(Object));
    expect(f.verify).toHaveBeenCalledWith(f.candidate, home);
    expect(f.manager.currentKeeper()).toBe(f.candidate);
    expect(f.original.close).toHaveBeenCalledOnce();
    expect(f.original.goto).not.toHaveBeenCalled();
    expect(f.candidate.close).not.toHaveBeenCalled();
    expect(f.phases).toHaveBeenCalledWith("refresh_handoff_verified");
    expect(f.phases).toHaveBeenCalledWith("refresh_verified");
  });
  test("Advanced HTTP success without native Location proof cannot replace the keeper", async () => {
    const f = await fixture(vi.fn(async () => false));
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("failed");
    expect(f.manager.currentKeeper()).toBe(f.original);
    expect(f.original.close).not.toHaveBeenCalled(); expect(f.candidate.close).toHaveBeenCalledOnce();
    expect(f.phases).not.toHaveBeenCalledWith("refresh_verified");
  });
  test("a command starting during native verification cancels the handoff", async () => {
    let allowed = true;
    const f = await fixture(vi.fn(async () => { allowed = false; return true; }), () => allowed);
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("stale");
    expect(f.original.close).not.toHaveBeenCalled(); expect(f.manager.currentKeeper()).toBe(f.original);
    expect(f.candidate.close).toHaveBeenCalledOnce();
  });
  test("a user navigation during verification is never closed by a stale handoff", async () => {
    const f = await fixture();
    f.verify.mockImplementation(async () => { f.original.address = `${KEEPER_URL}/other-home`; return true; });
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("stale");
    expect(f.original.close).not.toHaveBeenCalled(); expect(f.candidate.close).toHaveBeenCalledOnce();
  });
  test("native proof exceptions preserve the healthy original document", async () => {
    const f = await fixture(vi.fn(async () => { throw new Error("synthetic"); }));
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("failed");
    expect(f.original.close).not.toHaveBeenCalled(); expect(f.candidate.close).toHaveBeenCalledOnce();
  });
  test("an actual login destination is inspected without replacing or submitting the original", async () => {
    const f = await fixture();
    f.candidate.goto.mockImplementation(async () => { f.candidate.address = "https://account.samsung.com/accounts/v1/ST/signInGate"; });
    expect(await f.manager.refreshAuthenticatedSessionIfDue()).toBe("login_required");
    expect(f.login).toHaveBeenCalledWith(f.candidate, "refresh");
    expect(f.verify).not.toHaveBeenCalled(); expect(f.original.close).not.toHaveBeenCalled();
  });
  test("production runtime supplies native proof and bounded login-surface diagnostics", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("verifyRefreshCandidate:");
    expect(runtime).toContain("verifyLocationApplicationSession(candidate, target)");
    expect(runtime).toContain("session_login_page:");
  });
});

const nativeFixture = () => {
  const page = new Page(); page.evaluate.mockImplementation(async (fn: any, arg: any) => fn(arg));
  const get = vi.fn(async (_id: string): Promise<unknown> => ({ locationId: "fixture-home" }));
  const service = vi.fn(() => ({ get }));
  vi.stubGlobal("window", { [Symbol.for("smartthings_web_bridge.cake_client")]: { service } });
  return { page, get, service };
};

describe("native Location authentication proof", () => {
  test("uses one existing api/location GET and returns no identifiers", async () => {
    const f = nativeFixture();
    expect(await verifyLocationApplicationSession(f.page, home)).toEqual({ outcome: "ok", reason: "verified" });
    expect(f.service).toHaveBeenCalledWith("api/location"); expect(f.get).toHaveBeenCalledExactlyOnceWith("fixture-home");
  });
  test.each([{}, { locationId: "foreign-home" }, { data: { locationId: "fixture-home" }, error: "private" }])("rejects invalid or unrelated native response %j", async value => {
    const f = nativeFixture(); f.get.mockResolvedValue(value);
    expect(await verifyLocationApplicationSession(f.page, home)).toEqual({ outcome: "failed", reason: "wrong_location" });
  });
  test.each([401, 403, 503])("categorizes native rejection %i without exposing its message", async code => {
    const f = nativeFixture(); f.get.mockRejectedValue({ code, message: "private-token" });
    const proof = await verifyLocationApplicationSession(f.page, home);
    expect(proof).toEqual({ outcome: code === 401 ? "reauth" : "failed", reason: code === 401 ? "http_401" : code === 403 ? "http_403" : "read_failed" });
    expect(JSON.stringify(proof)).not.toContain("private");
  });
  test("a pending native request is bounded and is never retried", async () => {
    const f = nativeFixture(); f.get.mockImplementation(() => new Promise(() => undefined));
    expect(await verifyLocationApplicationSession(f.page, home, 5)).toEqual({ outcome: "failed", reason: "read_timeout" });
    expect(f.get).toHaveBeenCalledOnce();
  });
  test("missing client is not mistaken for authentication success", async () => {
    const f = nativeFixture(); vi.stubGlobal("window", {});
    expect(await verifyLocationApplicationSession(f.page, home, 5)).toEqual({ outcome: "failed", reason: "client_unavailable" });
    expect(f.get).not.toHaveBeenCalled();
  });
  test("changed navigation invalidates an otherwise successful native read", async () => {
    const f = nativeFixture(); f.get.mockImplementation(async () => { f.page.address = `${KEEPER_URL}/other`; return { locationId: "fixture-home" }; });
    expect(await verifyLocationApplicationSession(f.page, home)).toEqual({ outcome: "failed", reason: "navigation_changed" });
  });
  test.each([KEEPER_URL, "https://attacker.example/location/fixture-home", home + "?token=private", home + "#private"])("does not run a native request for invalid target %s", async target => {
    const f = nativeFixture();
    expect((await verifyLocationApplicationSession(f.page, target)).reason).toBe("invalid_target");
    expect(f.get).not.toHaveBeenCalled();
  });
  test("login-surface inspection cannot log URL parameters or arbitrary page output", async () => {
    const page = new Page(); page.address = "https://account.samsung.com/signin?token=private";
    page.evaluate.mockResolvedValue({ token: "private" });
    expect(await inspectAuthenticationPage(page)).toEqual({ page: "samsung_account", surface: "unavailable" });
    page.evaluate.mockResolvedValue("password_input");
    expect(await inspectAuthenticationPage(page)).toEqual({ page: "samsung_account", surface: "password_input" });
  });
});
