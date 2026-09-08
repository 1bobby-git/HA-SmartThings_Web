import { afterEach, describe, expect, test, vi } from "vitest";

import { AuthenticatedSmartThingsSession } from "../../src/advanced/authenticated-session.js";
import type { BrowserPageLike } from "../../src/browser/keeper-page.js";

class FakePage implements BrowserPageLike {
  readonly close = vi.fn(async () => {
    this.closed = true;
  });
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  readonly evaluateCalls = vi.fn();

  constructor(
    public currentUrl: string,
    readonly result: unknown,
    public closed = false,
    private readonly executeFunction = false
  ) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    this.evaluateCalls();
    if (this.executeFunction) {
      return await pageFunction(argument);
    }
    return this.result as Result;
  }
}

describe("AuthenticatedSmartThingsSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("uses the authenticated location keeper without opening an Advanced page", async () => {
    const calls: string[] = [];
    const keeper = new FakePage("https://my.smartthings.com/location", {
      ok: true,
      status: 200,
      value: { items: [] }
    });
    keeper.evaluateCalls.mockImplementation(() => calls.push("keeper-fetch"));
    const openAdvancedPage = vi.fn(async () => {
      calls.push("advanced-page");
      return new FakePage("https://my.smartthings.com/advanced", keeper.result);
    });

    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => keeper,
      openAdvancedPage
    });

    await expect(
      session.request(
        { endpoint: "devices", method: "GET", path: "/advanced/cupcake-api/api/devices" },
        (value) => value
      )
    ).resolves.toEqual({ items: [] });
    expect(calls).toEqual(["keeper-fetch"]);
    expect(openAdvancedPage).not.toHaveBeenCalled();
  });

  test("falls back to a short-lived Advanced page and always closes it", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", {
      ok: false,
      status: 403,
      error: "origin_rejected"
    });
    const advanced = new FakePage("https://my.smartthings.com/advanced", {
      ok: true,
      status: 200,
      value: { items: [{ deviceId: "device-a" }] }
    });
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => keeper,
      openAdvancedPage: vi.fn(async () => advanced)
    });

    await expect(
      session.request(
        { endpoint: "devices", method: "GET", path: "/advanced/cupcake-api/api/devices" },
        (value) => value
      )
    ).resolves.toEqual({ items: [{ deviceId: "device-a" }] });
    expect(advanced.close).toHaveBeenCalledOnce();
  });

  test("rejects cross-origin and non-Advanced request paths before browser execution", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", {});
    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => keeper,
      openAdvancedPage: vi.fn()
    });

    await expect(
      session.request(
        { endpoint: "devices", method: "GET", path: "https://api.smartthings.com/devices" },
        (value) => value
      )
    ).rejects.toThrowError("advanced_request_path_invalid");
    expect(keeper.evaluateCalls).not.toHaveBeenCalled();
  });

  test("adds the SmartThings page CSRF token to Advanced POST requests without returning it", async () => {
    const csrfToken = "csrf-token-123";
    const keeper = new FakePage("https://my.smartthings.com/location", undefined, false, true);
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        type: "basic",
        json: async () => ({ accepted: true })
      };
    });
    vi.stubGlobal("window", { _app: { csrfToken } });
    vi.stubGlobal("fetch", fetchMock);

    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => keeper,
      openAdvancedPage: vi.fn()
    });

    const result = await session.request(
      {
        endpoint: "commands",
        method: "POST",
        path: "/advanced/cupcake-api/api/devices/device-a/commands",
        body: { commands: [{ command: "speak" }] }
      },
      (value) => value
    );

    expect(result).toEqual({ accepted: true });
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.credentials).toBe("same-origin");
    expect(capturedInit?.headers).toEqual({
      "content-type": "application/json",
      "x-csrf-token": csrfToken
    });
    expect(capturedInit?.body).toBe(JSON.stringify({ commands: [{ command: "speak" }] }));
    expect(JSON.stringify(result)).not.toContain(csrfToken);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("does not add a CSRF header or request body to Advanced GET requests", async () => {
    const csrfToken = "csrf-token-123";
    const keeper = new FakePage("https://my.smartthings.com/location", undefined, false, true);
    const fetchMock = vi.fn(async (_path: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeUndefined();
      return {
        ok: true,
        status: 200,
        type: "basic",
        json: async () => ({ items: [] })
      };
    });
    vi.stubGlobal("window", { _app: { csrfToken } });
    vi.stubGlobal("fetch", fetchMock);

    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => keeper,
      openAdvancedPage: vi.fn()
    });

    await expect(
      session.request(
        { endpoint: "devices", method: "GET", path: "/advanced/cupcake-api/api/devices" },
        (value) => value
      )
    ).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("fails Advanced POST safely when the page CSRF token is unavailable", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", undefined, false, true);
    const fetchMock = vi.fn();
    vi.stubGlobal("window", { _app: {} });
    vi.stubGlobal("fetch", fetchMock);

    const session = new AuthenticatedSmartThingsSession({
      currentKeeper: () => undefined,
      openAdvancedPage: vi.fn(async () => keeper)
    });

    await expect(
      session.request(
        {
          endpoint: "commands",
          method: "POST",
          path: "/advanced/cupcake-api/api/devices/device-a/commands",
          body: { commands: [{ command: "on" }] }
        },
        (value) => value
      )
    ).rejects.toThrowError("advanced_request_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([{status:0,error:"request_timeout"}, {status:0,error:"request_failed"},
    {status:403,error:"origin_rejected"}, {status:401,error:"login_required"},
    {status:200,error:"response_invalid"}])("never replays an attempted POST after %j", async (failure) => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok:false, ...failure });
    const context = vi.fn(), open = vi.fn();
    const session = new AuthenticatedSmartThingsSession({currentKeeper:()=>keeper, requestJson:context, openAdvancedPage:open});
    await expect(session.request({endpoint:"commands",method:"POST",path:"/advanced/cupcake-api/api/devices/fixture/commands",
      body:{commands:[]}}, value=>value)).rejects.toThrow();
    expect(keeper.evaluateCalls).toHaveBeenCalledOnce();
    expect(context).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  test("permits a fallback only when the POST was not sent because CSRF was missing", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", {ok:false,status:0,error:"csrf_token_unavailable"});
    const context = vi.fn(async()=>({ok:true,status:200,value:{results:[{status:"ACCEPTED"}]}})), open = vi.fn();
    const session = new AuthenticatedSmartThingsSession({currentKeeper:()=>keeper, requestJson:context, openAdvancedPage:open});
    await expect(session.request({endpoint:"commands",method:"POST",path:"/advanced/cupcake-api/api/devices/fixture/commands",
      body:{commands:[]}}, value=>value)).resolves.toEqual({results:[{status:"ACCEPTED"}]});
    expect(context).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });

  test("a failed context POST cannot be replayed on an auxiliary page", async () => {
    const open = vi.fn(), context = vi.fn(async()=>({ok:false,status:0,error:"request_timeout"}));
    const session = new AuthenticatedSmartThingsSession({currentKeeper:()=>undefined, requestJson:context, openAdvancedPage:open});
    await expect(session.request({endpoint:"commands",method:"POST",path:"/advanced/cupcake-api/api/devices/fixture/commands"}, v=>v)).rejects.toThrow();
    expect(context).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
  });

});

describe("Optional light preflight never opens a fallback page", () => {
  test.each([undefined, { ok: false, status: 0, error: "timeout" }, { ok: false, status: 403, error: "http_403" }])(
    "no keeper/failed keeper returns without fallback: %j", async (result) => {
      const openAdvancedPage = vi.fn(), requestJson = vi.fn();
      const session = new AuthenticatedSmartThingsSession({
        currentKeeper: () => result ? new FakePage("https://my.smartthings.com/location", result) : undefined,
        openAdvancedPage, requestJson
      });
      await expect(session.request({ endpoint: "device_status", method: "GET",
        path: "/advanced/cupcake-api/api/devices/fixture/status", timeoutMs: 200, keeperOnly: true }, (x) => x)).rejects.toThrow();
      expect(openAdvancedPage).not.toHaveBeenCalled(); expect(requestJson).not.toHaveBeenCalled();
    });
  test("keeperOnly cannot change POST fallback or retry policy", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok: true, status: 200, value: {} });
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper, openAdvancedPage: vi.fn() });
    await expect(session.request({ endpoint: "commands", method: "POST",
      path: "/advanced/cupcake-api/api/devices/fixture/commands", keeperOnly: true }, (x) => x)).rejects.toThrow("advanced_request_path_invalid");
    expect(keeper.evaluateCalls).not.toHaveBeenCalled();
  });
  test("keeperOnly still executes the ordinary authenticated GET", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok: true, status: 200, value: { components: {} } });
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper, openAdvancedPage: vi.fn() });
    expect(await session.request({ endpoint: "device_status", method: "GET",
      path: "/advanced/cupcake-api/api/devices/fixture/status", keeperOnly: true, timeoutMs: 200 }, (x) => x)).toEqual({ components: {} });
  });
});

describe("Bounded request timing without changing transport semantics", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  test("separates page scheduling, response-header wait and JSON-body time on an actual page function", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const events: unknown[] = [];
    const keeper = new FakePage("https://my.smartthings.com/location", undefined, false, true);
    const evaluate = keeper.evaluate.bind(keeper);
    keeper.evaluate = async (fn, argument) => { await sleep(30); return evaluate(fn, argument); };
    vi.stubGlobal("window", { _app: { csrfToken: "fixture-csrf-not-for-output" } });
    const send = vi.fn(async () => { await sleep(80); return { ok: true, status: 200, type: "basic",
      json: async () => { await sleep(20); return { accepted: true }; } }; });
    vi.stubGlobal("fetch", send);
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper,
      openAdvancedPage: vi.fn(), onRequestTiming: (event) => events.push(event) });
    const work = session.request({ endpoint: "commands", method: "POST",
      path: "/advanced/cupcake-api/api/devices/private-device/commands", body: { private: "not-for-output" } }, (v) => v);
    await vi.advanceTimersByTimeAsync(130);
    expect(await work).toEqual({ accepted: true });
    expect(events).toEqual([{ endpoint: "commands", method: "POST", route: "keeper", totalMs: 130,
      status: 200, browserMs: 100, fetchMs: 80, bodyMs: 20, bridgeOverheadMs: 30 }]);
    expect(JSON.stringify(events)).not.toMatch(/private|csrf|not-for-output/);
    expect(send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  test("faulty diagnostic consumer does not fail or retry a successful command", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok: true, status: 200, value: { accepted: true } });
    const open = vi.fn();
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper, openAdvancedPage: open,
      onRequestTiming: () => { throw new Error("observer failure"); } });
    await expect(session.request({ endpoint: "commands", method: "POST", path: "/advanced/cupcake-api/api/devices/a/commands" }, (v) => v))
      .resolves.toEqual({ accepted: true });
    expect(open).not.toHaveBeenCalled(); expect(keeper.evaluateCalls).toHaveBeenCalledOnce();
  });
  test.each([NaN, Infinity, -1, "secret", 1e9])("rejects invalid browser timing %s without logging arbitrary fields", async (bad) => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok: true, status: 200, value: {},
      timing: { browserMs: bad, fetchMs: 1, bodyMs: 0, secret: "sensitive" } });
    const events: unknown[] = [];
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper, openAdvancedPage: vi.fn(), onRequestTiming: (e) => events.push(e) });
    await session.request({ endpoint: "commands", method: "POST", path: "/advanced/cupcake-api/api/devices/a/commands" }, (v) => v);
    expect(events).toEqual([{ endpoint: "commands", method: "POST", route: "keeper", totalMs: expect.any(Number), status: 200 }]);
  });
  test("ordinary background reads do not add high-volume timing logs", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location", { ok: true, status: 200, value: {} }), timing = vi.fn();
    const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => keeper, openAdvancedPage: vi.fn(), onRequestTiming: timing });
    await session.request({ endpoint: "devices", method: "GET", path: "/advanced/cupcake-api/api/devices" }, (v) => v);
    expect(timing).not.toHaveBeenCalled();
  });
});
