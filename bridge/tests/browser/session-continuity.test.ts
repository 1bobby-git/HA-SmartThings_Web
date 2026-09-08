import { afterEach, describe, expect, test, vi } from "vitest";
import { KeeperPageManager, KEEPER_URL, SESSION_TOUCH_AUTH_PATH, type BrowserPageLike } from "../../src/browser/keeper-page.js";

class Page implements BrowserPageLike {
  address = `${KEEPER_URL}/test-home`;
  closed = false;
  url = () => this.address;
  isClosed = () => this.closed;
  goto = vi.fn(async (url: string) => { this.address = url; });
  close = vi.fn(async () => { this.closed = true; });
  evaluate = vi.fn(async (fn: (value: any) => any, value: any) => fn(value));
}
const setup = async (options = {}) => {
  const page = new Page();
  const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => new Page() }, options);
  await manager.ensureKeeper();
  return { page, manager };
};
const json = (value: unknown = { items: [{ locationId: "test-home" }] }, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("authenticated session continuity", () => {
  test.each([
    ["HTML login shell", () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } })],
    ["JSON error envelope", () => json({ error: "unavailable" })],
    ["invalid JSON", () => new Response("invalid", { headers: { "content-type": "application/json" } })],
    ["wrong collection", () => json({ devices: [] })],
    ["invalid location", () => json({ items: [{}] })],
    ["ambiguous error and collection", () => json({ items: [], error: "denied" })]
  ])("does not claim renewed auth from HTTP 200 %s", async (_name, response) => {
    const fetch = vi.fn(async (path: string) => path === SESSION_TOUCH_AUTH_PATH ? response() : json());
    vi.stubGlobal("fetch", fetch);
    const { page, manager } = await setup();
    expect(await manager.touchAuthenticatedSession()).toBe("failed");
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(page.goto).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["/location", SESSION_TOUCH_AUTH_PATH]);
  });

  test.each([{ items: [] }, { locations: [{ id: "test-home" }] }, [{ locationId: "test-home" }]])(
    "validates an authenticated collection without returning its identifiers", async (payload) => {
      vi.stubGlobal("fetch", vi.fn(async () => json(payload)));
      const { manager } = await setup();
      expect(await manager.touchAuthenticatedSession()).toBe("ok");
    }
  );

  test("a hung location page GET cannot use up the authenticated probe budget", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((path: string, options: RequestInit) => path === SESSION_TOUCH_AUTH_PATH ? Promise.resolve(json()) :
      new Promise<Response>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    vi.stubGlobal("fetch", fetch);
    const { manager } = await setup();
    const touch = manager.touchAuthenticatedSession();
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await touch).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([401, 403, 429, 500, 503])("distinguishes actual 401 from transient/permission status %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path === SESSION_TOUCH_AUTH_PATH ? json({}, status) : json()));
    const { manager } = await setup();
    expect(await manager.touchAuthenticatedSession()).toBe(status === 401 ? "reauth" : "failed");
    expect(manager.authenticationRecoveryPending()).toBe(status === 401);
  });

  test("coalesces overlapping keepalive requests", async () => {
    const { page, manager } = await setup();
    let resolve!: (outcome: string) => void;
    page.evaluate.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = manager.touchAuthenticatedSession();
    const second = manager.touchAuthenticatedSession();
    await Promise.resolve(); resolve("ok");
    expect(await Promise.all([first, second])).toEqual(["ok", "ok"]);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test("renderer stalls are bounded without accumulating more evaluations", async () => {
    vi.useFakeTimers();
    const { page, manager } = await setup();
    let resolve!: (outcome: string) => void;
    page.evaluate.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = manager.touchAuthenticatedSession();
    await vi.advanceTimersByTimeAsync(13_001);
    expect(await first).toBe("failed");
    expect(await manager.touchAuthenticatedSession()).toBe("failed");
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    resolve("reauth"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("discards a stale auth failure after navigation instead of expiring a new login", async () => {
    const { page, manager } = await setup();
    let resolve!: (outcome: string) => void;
    page.evaluate.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = manager.touchAuthenticatedSession();
    await Promise.resolve(); page.address = `${KEEPER_URL}/another-home`; resolve("reauth");
    expect(await pending).toBe("stale");
    expect(manager.authenticationRecoveryPending()).toBe(false);
  });

  test("defers remembered-session navigation during foreground commands", async () => {
    let now = 1_000; let allowed = false;
    const { page, manager } = await setup({ now: () => now, canNavigate: () => allowed });
    page.evaluate.mockResolvedValue("reauth");
    await manager.touchAuthenticatedSession(); now += 30_001;
    await manager.ensureKeeper(); expect(page.goto).not.toHaveBeenCalled();
    allowed = true; page.evaluate.mockResolvedValue("ok");
    await manager.ensureKeeper(); expect(page.goto).toHaveBeenCalledTimes(1);
    expect(manager.authenticationRecoveryPending()).toBe(false);
  });

  test("a returned location shell alone cannot clear authentication recovery", async () => {
    let now = 1_000;
    const { page, manager } = await setup({ now: () => now });
    page.evaluate.mockResolvedValue("reauth");
    await manager.touchAuthenticatedSession(); now += 30_001;
    await manager.ensureKeeper();
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(manager.authenticationRecoveryPending()).toBe(true);
    page.evaluate.mockResolvedValue("ok");
    expect(await manager.touchAuthenticatedSession()).toBe("ok");
    expect(manager.authenticationRecoveryPending()).toBe(false);
  });

  test("socket recovery never navigates an active Samsung sign-in form", async () => {
    const { page, manager } = await setup();
    page.address = "https://account.samsung.com/accounts/v1/ST/signInGate";
    await expect(manager.recoverKeeper()).rejects.toThrow("keeper_recovery_deferred");
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });
});
