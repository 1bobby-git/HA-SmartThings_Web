import { describe, expect, test, vi } from "vitest";

import {
  ADVANCED_URL,
  KEEPER_URL,
  KeeperPageManager
} from "../../src/browser/keeper-page.js";

class TestPage {
  closed = false;
  constructor(public currentUrl = "about:blank") {}
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.closed; }
  readonly goto = vi.fn(async (url: string) => { this.currentUrl = url; });
  readonly close = vi.fn(async () => { this.closed = true; });
}

class TestContext {
  constructor(readonly pagesList: TestPage[] = []) {}
  pages(): TestPage[] { return this.pagesList; }
  readonly newPage = vi.fn(async () => {
    const page = new TestPage();
    this.pagesList.push(page);
    return page;
  });
}

describe("keeper lifecycle regression", () => {
  test("coalesces concurrent creation without closing another caller's keeper", async () => {
    const context = new TestContext();
    const manager = new KeeperPageManager(context);
    const gate = Promise.withResolvers<void>();
    context.newPage.mockImplementationOnce(async () => {
      await gate.promise;
      const page = new TestPage();
      context.pagesList.push(page);
      return page;
    });
    const pending = Array.from({ length: 30 }, () => manager.ensureKeeper());
    gate.resolve();
    const pages = await Promise.all(pending);
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(new Set(pages).size).toBe(1);
    expect(context.pagesList[0]?.goto).toHaveBeenCalledTimes(1);
    expect(context.pagesList[0]?.close).not.toHaveBeenCalled();
    expect(manager.currentKeeper()).toBe(pages[0]);
  });

  test("shares restored-page reconciliation with concurrent keeper creation", async () => {
    const keeper = new TestPage(KEEPER_URL);
    const extra = new TestPage("https://example.test/restored");
    const gate = Promise.withResolvers<void>();
    extra.close.mockImplementationOnce(async () => {
      await gate.promise;
      extra.closed = true;
    });
    const context = new TestContext([keeper, extra]);
    const manager = new KeeperPageManager(context);
    const first = manager.reconcileRestoredPages();
    const second = manager.reconcileRestoredPages();
    const third = manager.ensureKeeper();
    gate.resolve();
    expect(await Promise.all([first, second, third])).toEqual([keeper, keeper, keeper]);
    expect(extra.close).toHaveBeenCalledTimes(1);
    expect(context.newPage).not.toHaveBeenCalled();
    expect(keeper.close).not.toHaveBeenCalled();
  });

  test("failed reconciliation can retry without leaving a rejected cached task", async () => {
    const keeper = new TestPage(KEEPER_URL);
    const extra = new TestPage("https://example.test/restored");
    extra.close.mockRejectedValueOnce(new Error("temporary_close_failure"));
    const manager = new KeeperPageManager(new TestContext([keeper, extra]));
    await expect(manager.ensureKeeper()).rejects.toThrow("restored_page_close_failed");
    await expect(manager.ensureKeeper()).resolves.toBe(keeper);
    expect(extra.close).toHaveBeenCalledTimes(2);
  });

  test("a failed new keeper navigation closes the unreturned tab and permits retry", async () => {
    const context = new TestContext();
    const failedPage = new TestPage();
    const failure = new Error("navigation_failed");
    failedPage.goto.mockRejectedValueOnce(failure);
    context.newPage.mockImplementationOnce(async () => {
      context.pagesList.push(failedPage);
      return failedPage;
    });
    const manager = new KeeperPageManager(context);
    await expect(manager.ensureKeeper()).rejects.toBe(failure);
    expect(failedPage.close).toHaveBeenCalledTimes(1);
    expect(manager.currentKeeper()).toBeUndefined();
    const recovered = await manager.ensureKeeper();
    expect(recovered).not.toBe(failedPage);
    expect(recovered.isClosed()).toBe(false);
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  test("completed operations are not cached when the keeper later closes", async () => {
    const context = new TestContext();
    const manager = new KeeperPageManager(context);
    const first = await manager.ensureKeeper();
    await first.close();
    const replacements = await Promise.all([manager.ensureKeeper(), manager.ensureKeeper()]);
    expect(replacements[0]).toBe(replacements[1]);
    expect(replacements[0]).not.toBe(first);
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });

  test("does not navigate or close an active Samsung login while coalescing", async () => {
    const login = new TestPage("https://account.samsung.com/accounts/v1/ST/signInGate");
    const context = new TestContext([login]);
    const manager = new KeeperPageManager(context);
    expect(await Promise.all([manager.ensureKeeper(), manager.ensureKeeper()])).toEqual([login, login]);
    expect(login.goto).not.toHaveBeenCalled();
    expect(login.close).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled();
  });

  test("closes an Advanced tab when its before-navigation hook rejects", async () => {
    const keeper = new TestPage(KEEPER_URL);
    const context = new TestContext([keeper]);
    const manager = new KeeperPageManager(context);
    await manager.ensureKeeper();
    const failure = new Error("observer_attach_failed");
    await expect(manager.openAdvancedPage(async () => { throw failure; })).rejects.toBe(failure);
    expect(context.pagesList[1]?.close).toHaveBeenCalledTimes(1);
    expect(context.pagesList[1]?.goto).not.toHaveBeenCalled();
    expect(keeper.close).not.toHaveBeenCalled();
  });

  test("preserves a navigation failure even if temporary-tab cleanup also fails", async () => {
    const context = new TestContext();
    const failure = new Error("advanced_navigation_failed");
    const page = new TestPage();
    page.goto.mockRejectedValueOnce(failure);
    page.close.mockRejectedValueOnce(new Error("close_failed"));
    context.newPage.mockResolvedValueOnce(page);
    const manager = new KeeperPageManager(context);
    await expect(manager.openAdvancedPage()).rejects.toBe(failure);
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("returns a successful Advanced tab open for its caller", async () => {
    const context = new TestContext();
    const manager = new KeeperPageManager(context);
    const hook = vi.fn(async () => undefined);
    const page = await manager.openAdvancedPage(hook);
    expect(hook).toHaveBeenCalledWith(page);
    expect(page.goto).toHaveBeenCalledWith(ADVANCED_URL, { waitUntil: "domcontentloaded" });
    expect(page.isClosed()).toBe(false);
  });
});
