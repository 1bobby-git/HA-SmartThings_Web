import { afterEach, describe, expect, test, vi } from "vitest";
import { KeeperPageManager, KEEPER_URL, SESSION_TOUCH_AUTH_PATH, waitForSettledKeeperPage, type BrowserPageLike } from "../../src/browser/keeper-page.js";
import { SessionMaintenanceGate } from "../../src/browser/session-maintenance.js";
import { isEmptySessionStorageState } from "../../src/security/session-state.js";
import { readFileSync } from "node:fs";

const login = "https://account.samsung.com/accounts/v1/ST/signInGate";
class Page implements BrowserPageLike {
  address = `${KEEPER_URL}/fixture`;
  closed = false;
  url = () => this.address;
  isClosed = () => this.closed;
  goto = vi.fn(async (url: string) => { this.address = url; });
  close = vi.fn(async () => { this.closed = true; });
  evaluate = vi.fn(async (_fn: any, _arg: any): Promise<any> => "ok");
  waitForURL = vi.fn(async (predicate: (url: URL) => boolean, _options?: { timeout?: number }) => {
    this.address = `${KEEPER_URL}/fixture`;
    expect(predicate(new URL(this.address))).toBe(true);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("session lifecycle regressions", () => {
  test("waits through an intermediate Samsung SSO page without navigating it again", async () => {
    const page = new Page(); page.address = login;
    expect(await waitForSettledKeeperPage(page)).toBe(true);
    expect(page.waitForURL).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
  });
  test("a redirect timeout preserves the sign-in page and is not verified authentication", async () => {
    const page = new Page(); page.address = login;
    page.waitForURL.mockRejectedValue(new Error("synthetic timeout"));
    expect(await waitForSettledKeeperPage(page, Number.POSITIVE_INFINITY)).toBe(false);
    expect(page.waitForURL.mock.calls[0]![1]?.timeout).toBe(20_000);
    expect(page.close).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled();
  });
  test("a closed redirect target is never accepted", async () => {
    const page = new Page(); page.closed = true;
    expect(await waitForSettledKeeperPage(page)).toBe(false);
    expect(page.waitForURL).not.toHaveBeenCalled();
  });
  test("a delayed SSO redirect is verified and promoted instead of closed as login_required", async () => {
    let now = 1_000;
    const original = new Page(), candidate = new Page();
    const pages = [original]; const phases = vi.fn();
    const manager = new KeeperPageManager({ pages: () => pages, newPage: async () => { pages.push(candidate); return candidate; } }, { now: () => now, onRecovery: phases });
    await manager.ensureKeeper(); await manager.touchAuthenticatedSession();
    original.address = login; await manager.ensureKeeper(); now += 30_001;
    candidate.goto.mockImplementation(async () => { candidate.address = login; });
    expect(await manager.ensureKeeper()).toBe(candidate);
    expect(candidate.waitForURL).toHaveBeenCalledOnce();
    expect(candidate.evaluate).toHaveBeenCalledOnce();
    expect(candidate.close).not.toHaveBeenCalled();
    expect(phases).toHaveBeenCalledWith("verified");
    expect(phases).not.toHaveBeenCalledWith("login_required");
  });
  test("proactive refresh waits for SSO and does not replace the healthy keeper", async () => {
    let now = 1_000;
    const original = new Page(), candidate = new Page();
    const manager = new KeeperPageManager({ pages: () => [original], newPage: async () => candidate }, { now: () => now, proactiveRefreshIntervalMs: 10 });
    await manager.ensureKeeper(); await manager.touchAuthenticatedSession(); now += 11;
    candidate.goto.mockImplementation(async () => { candidate.address = login; });
    expect(await manager.refreshAuthenticatedSessionIfDue()).toBe("verified");
    expect(candidate.waitForURL).toHaveBeenCalledOnce();
    expect(manager.currentKeeper()).toBe(original);
    expect(original.close).not.toHaveBeenCalled(); expect(candidate.close).toHaveBeenCalledOnce();
  });
  test("all maintenance stages share one lease and do not build a backlog", async () => {
    const gate = new SessionMaintenanceGate(); let release!: () => void;
    const task = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const first = gate.run(task);
    expect(gate.isRunning()).toBe(true);
    const repeats = Array.from({ length: 100 }, () => gate.run(task));
    expect(repeats.every(value => value === first)).toBe(true);
    await Promise.resolve(); expect(task).toHaveBeenCalledOnce(); release();
    await first; expect(gate.isRunning()).toBe(false);
    await gate.run(async () => undefined); expect(task).toHaveBeenCalledOnce();
  });
  test("a failed maintenance stage releases the lease for the next attempt", async () => {
    const gate = new SessionMaintenanceGate();
    await expect(gate.run(async () => { throw new Error("synthetic"); })).rejects.toThrow("synthetic");
    expect(gate.isRunning()).toBe(false);
    await gate.run(async () => undefined); expect(gate.isRunning()).toBe(false);
  });
  test.each([
    { cookies: [{ name: "rotated", value: "never-overwrite" }], origins: [] },
    { cookies: [], origins: [{ origin: "https://my.smartthings.com", localStorage: [{ name: "auth", value: "current" }] }] },
    { cookies: [], origins: [{ origin: "https://my.smartthings.com", indexedDB: [{ name: "current-db" }] }] },
    { cookies: [], origins: [{ indexedDB: "invalid" }] },
    null,
    {}
  ])("does not replace a nonempty or unknown profile with an old backup", value => {
    expect(isEmptySessionStorageState(value)).toBe(false);
  });
  test("an actually empty profile remains eligible for startup backup recovery", () => {
    expect(isEmptySessionStorageState({ cookies: [], origins: [] })).toBe(true);
  });
  test("live runtime no longer calls the destructive forced backup restore", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).not.toContain("recoverWithPersistedSession");
    expect(runtime).toContain("if (!isEmptySessionStorageState(currentState))");
    expect(runtime).toContain("sessionMaintenance.isRunning()");
  });
  test.each([401, 403, 429, 503])("diagnostics distinguish protected HTTP %i without emitting response data", async status => {
    const page = new Page(); const diagnostic = vi.fn();
    page.evaluate.mockImplementation(async (fn: any, arg: any) => fn(arg));
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify({ secret: "not-for-logs" }), {
      status: path === SESSION_TOUCH_AUTH_PATH ? status : 200,
      headers: { "content-type": "application/json" }
    })));
    const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => page }, { onSessionProbe: diagnostic });
    await manager.ensureKeeper();
    expect(await manager.touchAuthenticatedSession()).toBe(status === 401 ? "reauth" : "failed");
    expect(diagnostic).toHaveBeenCalledWith({ outcome: status === 401 ? "reauth" : "failed", reason: status === 401 ? "http_401" : "http_error", status });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("not-for-logs");
  });
  test("diagnostics distinguish an HTML shell without calling it confirmed server logout", async () => {
    const page = new Page(); const diagnostic = vi.fn();
    page.evaluate.mockImplementation(async (fn: any, arg: any) => fn(arg));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-body", { headers: { "content-type": "text/html" } })));
    const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => page }, { onSessionProbe: diagnostic });
    await manager.ensureKeeper(); expect(await manager.touchAuthenticatedSession()).toBe("failed");
    expect(diagnostic).toHaveBeenCalledWith({ outcome: "failed", reason: "unexpected_content_type", status: 200 });
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-body");
  });
});
