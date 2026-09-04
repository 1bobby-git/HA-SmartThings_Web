import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";

class Locator {
  readonly click = vi.fn(async () => undefined);
  readonly dispatchEvent = vi.fn(async () => undefined);
  readonly fill = vi.fn(async () => undefined);

  constructor(private readonly matches: number) {}

  async count(): Promise<number> {
    return this.matches;
  }

  first(): Locator {
    return this;
  }

  filter(): Locator {
    return this;
  }

  getByRole(): Locator {
    return this;
  }

  getByText(): Locator {
    return this;
  }

  locator(): Locator {
    return this;
  }

  async isVisible(): Promise<boolean> {
    return this.matches === 1;
  }

  async waitFor(): Promise<void> {
    if (this.matches !== 1) throw new Error("not_visible");
  }
}

class RoutingPage {
  currentUrl: string;
  readonly scene = new Locator(1);
  readonly empty = new Locator(0);
  readonly close = vi.fn(async () => undefined);
  readonly waitForTimeout = vi.fn(async () => undefined);
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
  });
  readonly evaluate = vi.fn(async (_pageFunction: unknown, argument?: Record<string, unknown>) => {
    if (argument?.phase === "select" || argument?.phase === "cleanup") {
      return { kind: "missing", dialogs: 0, selects: 0, options: 0, modeGroups: 0, targets: 0 };
    }
    return "clicked";
  });

  constructor(url: string, private readonly sceneName?: string) {
    this.currentUrl = url;
  }

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return false;
  }

  getByRole(role: string, options?: { name?: string | RegExp }): Locator {
    if (
      role === "button" &&
      this.sceneName &&
      options?.name instanceof RegExp &&
      options.name.test(this.sceneName)
    ) {
      return this.scene;
    }
    return this.empty;
  }

  getByText(): Locator {
    return this.empty;
  }

  locator(): Locator {
    return this.empty;
  }
}

describe("location-aware Home Monitor and scene commands", () => {
  test("opens the exact raw location route before looking for a scene", async () => {
    const page = new RoutingPage(
      "https://my.smartthings.com/location/raw-current",
      "Evening"
    );
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager as never,
      (raw) => ({ "raw-current": "loc_current", "raw-target": "loc_target" })[raw] ?? raw,
      { resolveRawLocationId: (alias) => alias === "loc_target" ? "raw-target" : undefined }
    );

    await executor.executeScene({
      sceneName: "Evening",
      locationId: "loc_target",
      locationNames: { loc_current: "Current", loc_target: "Target" }
    });

    expect(page.goto).toHaveBeenCalledWith(
      "https://my.smartthings.com/location/raw-target",
      { waitUntil: "domcontentloaded" }
    );
    expect(page.scene.click).toHaveBeenCalledTimes(1);
  });

  test("does not require a hidden location picker for one known location", async () => {
    const page = new RoutingPage(
      "https://my.smartthings.com/location/raw-current"
    );
    const manager = { openCommandPage: vi.fn(async () => page) };
    const executor = new SmartThingsWebUiCommandExecutor(
      () => manager as never,
      () => "unmatched_location"
    );

    await executor.executeLocationAction({
      locationId: "loc_home",
      locationNames: { loc_home: "Home" },
      action: "disarm"
    });

    expect(page.goto).not.toHaveBeenCalled();
    // Inspection/cleanup evaluations do not dispatch actions. The legacy
    // card action must still execute exactly once when there is no dialog.
    const actionCalls = page.evaluate.mock.calls.filter(([, argument]) =>
      argument?.phase === undefined && Array.isArray(argument?.actionLabels)
    );
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]?.[1]?.actionLabels).toContain("Disarm");
    expect(page.empty.click).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledTimes(1);
  });
});
