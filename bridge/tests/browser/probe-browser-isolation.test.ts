import { describe, expect, test, vi } from "vitest";

import { isProbeBrowserIsolated } from "../../src/browser/probe-browser-isolation.js";
import { KEEPER_URL, KeeperPageManager, type BrowserContextLike, type BrowserPageLike } from "../../src/browser/keeper-page.js";

class FakePage implements BrowserPageLike {
  readonly close = vi.fn(async () => {
    this.closed = true;
  });
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });

  constructor(public currentUrl: string, public closed = false) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

class FakeContext implements BrowserContextLike {
  created: FakePage[] = [];

  constructor(public existing: FakePage[]) {}

  pages(): FakePage[] {
    return [...this.existing, ...this.created];
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage("about:blank");
    this.created.push(page);
    return page;
  }
}

describe("isProbeBrowserIsolated", () => {
  test("returns true only when the single open page is the settled current keeper", async () => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();

    expect(isProbeBrowserIsolated(context, manager)).toBe(true);
    expect(JSON.stringify(isProbeBrowserIsolated(context, manager))).toBe("true");
  });

  test.each([
    ["missing context", undefined, undefined],
    ["missing manager", new FakeContext([new FakePage(KEEPER_URL)]), undefined],
    ["missing keeper", new FakeContext([new FakePage(KEEPER_URL)]), new KeeperPageManager(new FakeContext([]))]
  ])("returns false for %s", (_name, context, manager) => {
    expect(isProbeBrowserIsolated(context, manager)).toBe(false);
    expect(JSON.stringify(isProbeBrowserIsolated(context, manager))).toBe("false");
  });

  test("returns false when the current keeper is closed", async () => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();
    keeper.closed = true;

    expect(isProbeBrowserIsolated(context, manager)).toBe(false);
  });

  test("returns false when there are zero open pages", async () => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();
    context.existing = [];

    expect(isProbeBrowserIsolated(context, manager)).toBe(false);
  });

  test("returns false when the keeper is not the exact page object in the context", async () => {
    const keeperContext = new FakeContext([new FakePage(KEEPER_URL)]);
    const manager = new KeeperPageManager(keeperContext);
    await manager.ensureKeeper();

    const differentLocationPage = new FakePage(KEEPER_URL);
    const probeContext = new FakeContext([differentLocationPage]);

    expect(isProbeBrowserIsolated(probeContext, manager)).toBe(false);
  });

  test.each([
    ["advanced", "https://my.smartthings.com/advanced"],
    ["login", "https://account.samsung.com/accounts/v1/ST/signInGate"],
    ["blank", "about:blank"],
    ["device detail", "https://my.smartthings.com/location/loc-1/device/device-1"],
    ["arbitrary origin", "https://example.test/location"],
    ["another location", "https://my.smartthings.com/location/loc-2"]
  ])("returns false when an extra open %s page exists", async (_name, extraUrl) => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();
    context.existing.push(new FakePage(extraUrl));

    expect(isProbeBrowserIsolated(context, manager)).toBe(false);
  });

  test.each([
    ["advanced", "https://my.smartthings.com/advanced"],
    ["login", "https://account.samsung.com/accounts/v1/ST/signInGate"],
    ["blank", "about:blank"],
    ["device detail", "https://my.smartthings.com/location/loc-1/device/device-1"],
    ["arbitrary origin", "https://example.test/location"],
    ["query", "https://my.smartthings.com/location?source=probe"],
    ["hash", "https://my.smartthings.com/location#probe"],
    ["two path segments", "https://my.smartthings.com/location/loc-1/extra"]
  ])("returns false when the keeper is on %s", async (_name, keeperUrl) => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();
    keeper.currentUrl = keeperUrl;

    expect(isProbeBrowserIsolated(context, manager)).toBe(false);
  });

  test("accepts a single location id segment with optional trailing slash", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location/location-id/");
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();

    expect(isProbeBrowserIsolated(context, manager)).toBe(true);
  });

  test("does not count closed extra pages", async () => {
    const keeper = new FakePage(KEEPER_URL);
    const closedExtra = new FakePage("https://my.smartthings.com/advanced", true);
    const context = new FakeContext([keeper, closedExtra]);
    const manager = new KeeperPageManager(context);

    await manager.ensureKeeper();

    expect(isProbeBrowserIsolated(context, manager)).toBe(true);
  });
});
