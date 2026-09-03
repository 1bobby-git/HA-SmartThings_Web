import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class MissingLocator {
  click = vi.fn(async () => undefined);
  async count(): Promise<number> { return 0; }
  dispatchEvent = vi.fn(async () => undefined);
  fill = vi.fn(async () => undefined);
  filter(_options?: unknown): MissingLocator { return new MissingLocator(); }
  first(): MissingLocator { return this; }
  getByRole(_role?: string, _options?: { name?: string | RegExp }): MissingLocator { return new MissingLocator(); }
  getByText(_text?: string, _options?: { exact?: boolean }): MissingLocator { return new MissingLocator(); }
  async isVisible(): Promise<boolean> { return false; }
  locator(_selector?: string): MissingLocator { return new MissingLocator(); }
  async waitFor(): Promise<void> { throw new Error("not visible"); }
}

class ActionLocator extends MissingLocator {
  override click = vi.fn(async () => undefined);
  override async count(): Promise<number> { return 1; }
  override async waitFor(): Promise<void> { return undefined; }
}

class CardLocator extends MissingLocator {
  constructor(private readonly action: ActionLocator) { super(); }
  override getByRole(role: string, options?: { name?: string | RegExp }): MissingLocator {
    return role === "button" && options?.name instanceof RegExp && options.name.test("보안(외출)")
      ? this.action
      : new MissingLocator();
  }
}

class DelayedTitleLocator extends MissingLocator {
  constructor(private readonly card: CardLocator) { super(); }
  override async count(): Promise<number> { return 1; }
  override async waitFor(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  override locator(selector: string): MissingLocator {
    return selector === ".." ? this.card : new MissingLocator();
  }
}

class DelayedDashboardPage {
  currentUrl = "https://my.smartthings.com/location/raw-exampleoffice";
  closed = false;
  readonly close = vi.fn(async () => { this.closed = true; });
  readonly goto = vi.fn(async (url: string) => { this.currentUrl = url; });
  readonly action = new ActionLocator();
  readonly card = new CardLocator(this.action);
  readonly title = new DelayedTitleLocator(this.card);
  async evaluate<Result>(_pageFunction?: unknown, _argument?: unknown): Promise<Result> { return false as Result; }
  url(): string { return this.currentUrl; }
  isClosed(): boolean { return this.closed; }
  getByRole(_role?: string, _options?: { name?: string | RegExp }): MissingLocator { return new MissingLocator(); }
  getByText(text: string, _options?: { exact?: boolean }): MissingLocator {
    return text === "SmartThings Home Monitor" ? this.title : new MissingLocator();
  }
  locator(_selector?: string): MissingLocator { return new MissingLocator(); }
}

describe("Home Monitor command stability", () => {
  test("waits for the ExampleOffice dashboard to hydrate before clicking 보안(외출)", async () => {
    const page = new DelayedDashboardPage();
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager,
      () => "loc_office",
      { resolveRawLocationId: () => "raw-exampleoffice" }
    );

    await executor.executeLocationAction({
      locationId: "loc_office",
      locationNames: { loc_office: "ExampleOffice" },
      action: "armAway"
    });

    expect(page.action.click).toHaveBeenCalledWith({ timeout: 15_000 });
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("keeps context-level frame freshness but scopes close recovery to CDP keeper pages", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("onSmartThingsWebSocketFrame: observeSmartThingsWebSocketFrame");
    expect(runtime).not.toContain("onSmartThingsWebSocketClose: recoverSmartThingsWebSocket");
    expect(runtime).toContain("if (isRealtimeKeeper()) onSmartThingsWebSocketClose();");
    expect(runtime).toContain("() => false");
  });

  test("does not open a full detail page every second", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("const DETAIL_DISCOVERY_INTERVAL_MS = 15_000;");
    expect(runtime).toContain("}, DETAIL_DISCOVERY_INTERVAL_MS);");
  });
});