import { describe, expect, test, vi } from "vitest";

import {
  ADVANCED_DEVICE_SNAPSHOT_URLS,
  KEEPER_URL,
  KeeperPageManager,
  fetchAdvancedDeviceSnapshots
} from "../../src/browser/keeper-page.js";

class FakePage {
  readonly bringToFront = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => {
    this.closed = true;
  });
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  readonly evaluateCalls: unknown[][] = [];

  constructor(public currentUrl: string, public closed = false) {}

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
    this.evaluateCalls.push([pageFunction, argument]);
    const urls = argument as string[];
    return urls.map((url, index) => ({
      url,
      items: [{ deviceId: `device-${index}` }]
    })) as Result;
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
  test("loads a bounded same-origin Advanced snapshot fallback without mutations", async () => {
    const page = new FakePage("https://my.smartthings.com/advanced");

    const snapshots = await fetchAdvancedDeviceSnapshots(page);

    expect(page.evaluateCalls).toHaveLength(1);
    expect(page.evaluateCalls[0]?.[1]).toEqual(ADVANCED_DEVICE_SNAPSHOT_URLS);
    expect(snapshots).toHaveLength(3);
    expect(ADVANCED_DEVICE_SNAPSHOT_URLS[0]).toBe(
      "/advanced/cupcake-api/api/devices?type=HUB"
    );
    expect(snapshots[0]).toEqual({
      url: ADVANCED_DEVICE_SNAPSHOT_URLS[0],
      items: [{ deviceId: "device-0" }]
    });
  });

  test("can request only the complete status endpoint for a command-time refresh", async () => {
    const page = new FakePage("https://my.smartthings.com/location/loc-home");
    const statusUrl = ADVANCED_DEVICE_SNAPSHOT_URLS[1];

    const snapshots = await fetchAdvancedDeviceSnapshots(page, [statusUrl]);

    expect(page.evaluateCalls).toHaveLength(1);
    expect(page.evaluateCalls[0]?.[1]).toEqual([statusUrl]);
    expect(snapshots).toEqual([
      {
        url: statusUrl,
        items: [{ deviceId: "device-0" }]
      }
    ]);
  });

  test("prunes unrelated restored tabs before choosing one keeper", async () => {
    const location = new FakePage("https://my.smartthings.com/location/restored-home");
    const login = new FakePage("https://account.samsung.com/accounts/v1/ST/signInGate");
    const advanced = new FakePage("https://my.smartthings.com/advanced");
    const unrelated = new FakePage("https://example.test/restored");
    const blank = new FakePage("about:blank");
    const context = new FakeContext([location, login, advanced, unrelated, blank]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.reconcileRestoredPages();

    expect(keeper).toBe(location);
    expect(location.close).not.toHaveBeenCalled();
    expect(login.close).toHaveBeenCalledTimes(1);
    expect(advanced.close).toHaveBeenCalledTimes(1);
    expect(unrelated.close).toHaveBeenCalledTimes(1);
    expect(blank.close).toHaveBeenCalledTimes(1);
    expect(location.goto).not.toHaveBeenCalled();
  });

  test("prefers a concrete restored location over an earlier generic location tab", async () => {
    const generic = new FakePage(KEEPER_URL);
    const concrete = new FakePage("https://my.smartthings.com/location/restored-home");
    const manager = new KeeperPageManager(new FakeContext([generic, concrete]));

    const keeper = await manager.reconcileRestoredPages();

    expect(keeper).toBe(concrete);
    expect(generic.close).toHaveBeenCalledTimes(1);
    expect(concrete.close).not.toHaveBeenCalled();
  });

  test("fails startup isolation when a restored extra tab cannot be closed", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location/restored-home");
    const stuck = new FakePage("https://example.test/stuck");
    stuck.close.mockRejectedValueOnce(new Error("close_failed"));
    const manager = new KeeperPageManager(new FakeContext([keeper, stuck]));

    await expect(manager.reconcileRestoredPages()).rejects.toThrow(
      "restored_page_close_failed"
    );
    expect(stuck.isClosed()).toBe(false);
  });

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

    expect(manager.currentKeeper()).toBeUndefined();

    const keeper = await manager.ensureKeeper();

    expect(context.created).toHaveLength(1);
    expect(keeper.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
    expect(manager.currentKeeper()).toBe(keeper);
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

  test("accepts the canonical location-id redirect as the keeper without reloading", async () => {
    const canonical = new FakePage("https://my.smartthings.com/location/loc-synthetic-001");
    const context = new FakeContext([canonical]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();

    expect(keeper).toBe(canonical);
    expect(canonical.goto).not.toHaveBeenCalled();
    expect(context.created).toHaveLength(0);
  });

  test("recovers a concrete location keeper without discarding its verified route", async () => {
    const concreteUrl = "https://my.smartthings.com/location/loc-synthetic-001";
    const keeper = new FakePage(concreteUrl);
    const manager = new KeeperPageManager(new FakeContext([keeper]));

    await manager.recoverKeeper();

    expect(keeper.goto).toHaveBeenCalledWith(concreteUrl, {
      waitUntil: "domcontentloaded"
    });
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
    expect(manager.currentKeeper()).toBeUndefined();

    const recovered = await manager.recoverKeeper();

    expect(recovered).not.toBe(first);
    expect(context.created).toHaveLength(2);
    expect(recovered.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
    expect(manager.currentKeeper()).toBe(recovered);
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

  test("keeps a tracked command location page separate from the observation keeper", async () => {
    const context = new FakeContext([new FakePage(KEEPER_URL)]);
    const manager = new KeeperPageManager(context);

    const keeper = await manager.ensureKeeper();
    const command = await manager.openCommandPage();
    const reconciled = await manager.ensureKeeper();

    expect(command).not.toBe(keeper);
    expect(command.goto).toHaveBeenCalledWith(KEEPER_URL, { waitUntil: "domcontentloaded" });
    expect(command.close).not.toHaveBeenCalled();
    expect(reconciled).toBe(keeper);
  });

  test("opens commands on the keeper's selected location route", async () => {
    const keeper = new FakePage("https://my.smartthings.com/location/selected-location");
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context);
    await manager.ensureKeeper();

    const command = await manager.openCommandPage();

    expect(command.goto).toHaveBeenCalledWith(keeper.url(), {
      waitUntil: "domcontentloaded"
    });
    expect(command.bringToFront).toHaveBeenCalledTimes(1);
  });
});
