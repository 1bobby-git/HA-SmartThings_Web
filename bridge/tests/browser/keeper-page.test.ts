import { describe, expect, test, vi } from "vitest";

import { KEEPER_URL, KeeperPageManager } from "../../src/browser/keeper-page.js";

class FakePage {
  readonly close = vi.fn(async () => undefined);
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

class FakeContext {
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

describe("KeeperPageManager", () => {
  test("keeps exactly one /location keeper and closes duplicates", async () => {
    const first = new FakePage(KEEPER_URL);
    const second = new FakePage(`${KEEPER_URL}?duplicate=true`);
    const context = new FakeContext([first, second]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(keeper).toBe(first);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  test("creates and navigates a keeper when none exists", async () => {
    const context = new FakeContext([]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(context.created).toHaveLength(1);
    expect(keeper.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("opens /advanced only as a separate interactive page", async () => {
    const keeper = new FakePage(KEEPER_URL);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);

    const advanced = await manager.openAdvancedPage();

    expect(advanced).not.toBe(keeper);
    expect(advanced.goto).toHaveBeenCalledWith("https://my.smartthings.com/advanced", {
      waitUntil: "domcontentloaded"
    });
  });
});
