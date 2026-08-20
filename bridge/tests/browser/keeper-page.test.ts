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

  test("normalizes a query keeper to the exact keeper URL without opening another tab", async () => {
    const queryKeeper = new FakePage(`${KEEPER_URL}?x=1`);
    const context = new FakeContext([queryKeeper]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(keeper).toBe(queryKeeper);
    expect(context.created).toHaveLength(0);
    expect(queryKeeper.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("creates and navigates a keeper when none exists", async () => {
    const context = new FakeContext([]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(context.created).toHaveLength(1);
    expect(keeper.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("reuses a safe about:blank page for the keeper instead of opening a stray tab", async () => {
    const blank = new FakePage("about:blank");
    const context = new FakeContext([blank]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(keeper).toBe(blank);
    expect(context.created).toHaveLength(0);
    expect(blank.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("tracks keeper identity and navigates a drifted keeper back without creating a tab", async () => {
    const context = new FakeContext([]);
    const manager = new KeeperPageManager(context);
    const keeper = (await manager.ensureKeeper()) as FakePage;

    keeper.currentUrl = "https://my.smartthings.com/advanced";
    const recovered = await manager.ensureKeeper();

    expect(recovered).toBe(keeper);
    expect(context.created).toHaveLength(1);
    expect(keeper.goto).toHaveBeenLastCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("recovers a closed keeper with one replacement keeper", async () => {
    const context = new FakeContext([]);
    const manager = new KeeperPageManager(context);
    const first = (await manager.ensureKeeper()) as FakePage;

    first.closed = true;
    const recovered = await manager.recoverKeeper();

    expect(recovered).not.toBe(first);
    expect(context.created).toHaveLength(2);
    expect(recovered.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
  });

  test("does not interrupt a tracked Samsung login redirect", async () => {
    const login = new FakePage("https://account.samsung.com/accounts/v1/ST/signInGate");
    const context = new FakeContext([login]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(keeper).toBe(login);
    expect(login.goto).not.toHaveBeenCalled();
    expect(context.created).toHaveLength(0);
  });

  test("recovers arbitrary drift on the tracked keeper", async () => {
    const context = new FakeContext([]);
    const manager = new KeeperPageManager(context);
    const keeper = await manager.ensureKeeper();

    (keeper as FakePage).currentUrl = "https://example.test/manual-drift";
    await manager.ensureKeeper();

    expect(keeper.goto).toHaveBeenLastCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
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

  test("keeps exactly one keeper when opening a separate advanced page", async () => {
    const context = new FakeContext([new FakePage("about:blank")]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();
    const advanced = await manager.openAdvancedPage();

    expect(advanced).not.toBe(keeper);
    expect(
      context.pages().filter((page) => !page.isClosed() && page.url() === KEEPER_URL)
    ).toHaveLength(1);
    expect(
      context
        .pages()
        .filter((page) => !page.isClosed() && page.url() === "https://my.smartthings.com/advanced")
    ).toHaveLength(1);
  });
});
