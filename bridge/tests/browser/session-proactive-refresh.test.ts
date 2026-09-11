import { describe, expect, test } from "vitest";

import {
  KEEPER_URL,
  KeeperPageManager,
  type BrowserContextLike,
  type BrowserPageLike,
  type SessionTouchOutcome
} from "../../src/browser/keeper-page.js";

class FakePage implements BrowserPageLike {
  readonly gotoCalls: Array<{ url: string; options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number } }> = [];
  closeCount = 0;

  constructor(
    public currentUrl: string,
    private readonly touchOutcome: SessionTouchOutcome = "ok",
    private readonly redirectOnGoto?: string,
    public closed = false
  ) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }
  ): Promise<void> {
    this.gotoCalls.push(options ? { url, options } : { url });
    this.currentUrl = this.redirectOnGoto ?? url;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
  }

  async evaluate<Result, Argument>(
    _pageFunction: (argument: Argument) => Result | Promise<Result>,
    _argument: Argument
  ): Promise<Result> {
    return this.touchOutcome as Result;
  }
}

class FakeContext implements BrowserContextLike {
  readonly created: FakePage[] = [];

  constructor(
    readonly existing: FakePage[],
    private readonly createPage: () => FakePage = () => new FakePage("about:blank")
  ) {}

  pages(): FakePage[] {
    return [...this.existing, ...this.created];
  }

  async newPage(): Promise<FakePage> {
    const page = this.createPage();
    this.created.push(page);
    return page;
  }
}

describe("KeeperPageManager proactive session refresh", () => {
  test("refreshes the shared session in a disposable tab without navigating the keeper", async () => {
    let now = 10_000;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const context = new FakeContext([keeper]);
    const phases: string[] = [];
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      proactiveRefreshRetryMs: 5_000,
      onRecovery: (phase) => phases.push(phase)
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("verified");
    expect(context.created).toHaveLength(1);
    expect(context.created[0]?.gotoCalls).toEqual([{
      url: KEEPER_URL,
      options: { waitUntil: "domcontentloaded", timeout: 10_000 }
    }]);
    expect(context.created[0]?.closed).toBe(true);
    expect(keeper.gotoCalls).toHaveLength(0);
    expect(keeper.closed).toBe(false);
    expect(manager.currentKeeper()).toBe(keeper);
    expect(phases).toEqual(["refresh_attempt", "refresh_verified"]);
  });

  test("preserves the active keeper when the proactive refresh reaches Samsung login", async () => {
    let now = 20_000;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const loginUrl = "https://account.samsung.com/accounts/v1/ST/signInGate";
    const context = new FakeContext(
      [keeper],
      () => new FakePage("about:blank", "ok", loginUrl)
    );
    const phases: string[] = [];
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      proactiveRefreshRetryMs: 5_000,
      onRecovery: (phase) => phases.push(phase)
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("login_required");
    expect(context.created).toHaveLength(1);
    expect(context.created[0]?.closed).toBe(true);
    expect(keeper.gotoCalls).toHaveLength(0);
    expect(keeper.closed).toBe(false);
    expect(manager.currentKeeper()).toBe(keeper);
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(phases).toEqual(["refresh_attempt", "refresh_login_required"]);
  });

  test("skips the refresh while foreground navigation is unsafe", async () => {
    let now = 30_000;
    let canNavigate = true;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      canNavigate: () => canNavigate
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;
    canNavigate = false;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("skipped");
    expect(context.created).toHaveLength(0);
  });
});
