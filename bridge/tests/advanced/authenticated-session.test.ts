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
});
