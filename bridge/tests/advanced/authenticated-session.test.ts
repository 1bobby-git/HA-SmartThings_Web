import { describe, expect, test, vi } from "vitest";

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
    public closed = false
  ) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async evaluate<Result, Argument>(
    _pageFunction: (argument: Argument) => Result | Promise<Result>,
    _argument: Argument
  ): Promise<Result> {
    this.evaluateCalls();
    return this.result as Result;
  }
}

describe("AuthenticatedSmartThingsSession", () => {
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
});
