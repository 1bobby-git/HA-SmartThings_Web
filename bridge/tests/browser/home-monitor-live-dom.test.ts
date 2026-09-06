import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";
import {
  clickCurrentHomeMonitorMode,
  clickTextOnlyHomeMonitorCard,
  inspectHomeMonitorDom
} from "../../src/browser/home-monitor-dom.js";

class MissingLocator {
  click = vi.fn(async () => undefined);
  async count(): Promise<number> { return 0; }
  dispatchEvent = vi.fn(async () => undefined);
  fill = vi.fn(async () => undefined);
  filter(_options?: unknown): MissingLocator { return this; }
  first(): MissingLocator { return this; }
  getByRole(_role?: string, _options?: unknown): MissingLocator { return this; }
  getByText(_text?: string, _options?: unknown): MissingLocator { return this; }
  async isVisible(): Promise<boolean> { return false; }
  locator(_selector?: string): MissingLocator { return this; }
  async waitFor(): Promise<void> { throw new Error("not_visible"); }
}

class RolelessHomeMonitorPage {
  currentUrl = "https://my.smartthings.com/location/raw-home";
  cardOpened = false;
  readonly close = vi.fn(async () => undefined);
  readonly goto = vi.fn(async (url: string) => { this.currentUrl = url; });
  readonly missing = new MissingLocator();
  readonly selectedGroups: number[] = [];
  lastRequestedGroup = -1;
  readonly selector = new MissingLocator();
  readonly action = new MissingLocator();
  constructor() {
    this.selector.click.mockImplementation(async () => { this.cardOpened = true; });
    this.action.click.mockImplementation(async () => {
      this.selectedGroups.push(this.lastRequestedGroup);
      this.cardOpened = false;
    });
  }

  url(): string { return this.currentUrl; }
  isClosed(): boolean { return false; }
  getByRole(): MissingLocator { return this.missing; }
  getByText(): MissingLocator { return this.missing; }
  locator(selector: string): MissingLocator {
    if (selector.startsWith('[data-stw-hm-current-mode=')) return this.selector;
    if (selector.startsWith('[data-stw-hm-target=')) return this.action;
    return this.missing;
  }

  async evaluate<Result, Argument>(
    _pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    const input = argument as Record<string, unknown>;
    if (typeof input.marker === "string" && input.marker.startsWith("hm-mode-")) {
      return { kind: input.cleanup ? "missing" : "target", targets: input.cleanup ? 0 : 1 } as Result;
    }
    if (typeof input.markerId === "string") {
      if (input.phase === "select" && this.cardOpened) this.lastRequestedGroup = input.requestedGroup as number;
      const selectable = input.phase === "select" && this.cardOpened;
      return { kind: selectable ? "click" : "missing", dialogs: selectable ? 1 : 0,
        selects: 0, options: 0, modeGroups: selectable ? 3 : 0, targets: selectable ? 1 : 0 } as Result;
    }
    if (typeof input.phase === "string") {
      return {
        phase: input.phase,
        monitorExactCount: 1,
        actionExactCount: this.cardOpened ? 1 : 0,
        actionClickableCount: 0,
        modeGroupCount: this.cardOpened ? 3 : 0,
        visibleDialogCount: this.cardOpened ? 1 : 0,
        visibleIframeCount: 0,
        openShadowRootCount: 1
      } as Result;
    }
    if ("timeoutMs" in input && !("actionLabels" in input)) {
      return "not_found" as Result;
    }
    if ("modeLabelGroups" in input) {
      return (this.cardOpened ? "clicked" : "not_found") as Result;
    }
    return false as Result;
  }
}

const pageWithoutEvaluate = {
  url: () => "https://my.smartthings.com/location/raw-home",
  isClosed: () => false,
  goto: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined)
};

describe("live Home Monitor DOM recovery", () => {
  test("keeps browser-side helpers unavailable without page evaluation", async () => {
    await expect(
      clickTextOnlyHomeMonitorCard(pageWithoutEvaluate, ["SmartThings Home Monitor"])
    ).resolves.toBe("unavailable");
    await expect(
      clickCurrentHomeMonitorMode(
        pageWithoutEvaluate,
        ["SmartThings Home Monitor"],
        [["해제"], ["보안(외출)"], ["보안(실내)"]]
      )
    ).resolves.toBe("unavailable");
  });

  test("opens the current-mode pill and then executes the exact mode", async () => {
    const page = new RolelessHomeMonitorPage();
    const diagnostics: string[] = [];
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: vi.fn(async () => page as never) }),
      undefined,
      {
        onHomeMonitorDiagnostic: (value) => diagnostics.push(value.phase)
      }
    );

    await executor.executeLocationAction({
      locationId: "loc_home",
      locationNames: { loc_home: "Home" },
      action: "armAway"
    });

    expect(page.selector.click).toHaveBeenCalledTimes(1);
    expect(page.action.click).toHaveBeenCalledTimes(1);
    expect(page.selectedGroups).toEqual([0]); // Only the requested Away mode, not an intermediate Disarm.
    expect(page.cardOpened).toBe(false);
    expect(diagnostics).toEqual([]); // Fast selector path no longer needs a failed-card diagnostic.
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  test("returns bounded structural diagnostics without page text", async () => {
    const page = new RolelessHomeMonitorPage();
    const diagnostics = await inspectHomeMonitorDom(
      page,
      ["SmartThings Home Monitor"],
      ["보안(외출)"],
      [["보안(외출)"], ["보안(실내)"], ["해제"]],
      "final_failure"
    );

    expect(diagnostics).toEqual({
      phase: "final_failure",
      monitorExactCount: 1,
      actionExactCount: 0,
      actionClickableCount: 0,
      modeGroupCount: 0,
      visibleDialogCount: 0,
      visibleIframeCount: 0,
      openShadowRootCount: 1
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/SmartThings|보안|raw-home/u);
  });

  test("crosses open shadow hosts and logs only structural counters", () => {
    const domSource = readFileSync("bridge/src/browser/home-monitor-dom.ts", "utf8");
    const commandSource = readFileSync("bridge/src/browser/command-page.ts", "utf8");
    const runtimeSource = readFileSync("bridge/src/runtime.ts", "utf8");

    expect(domSource).toContain("root instanceof ShadowRoot");
    expect(domSource).toContain("clickCurrentHomeMonitorMode");
    const scopedSource = readFileSync("bridge/src/browser/home-monitor-current-mode.ts", "utf8");
    expect(domSource).toContain("clickScopedCurrentHomeMonitorMode");
    expect(scopedSource).toContain("root instanceof ShadowRoot");
    expect(scopedSource).toContain("const targets = new Set<Element>()");
    expect(scopedSource).toContain("local = modes.filter");
    expect(scopedSource).toContain("input.currentModeGroup");
    expect(scopedSource).not.toContain(".first()");
    expect(domSource).toContain("root.host instanceof HTMLElement");
    expect(domSource).toContain('"menuitemradio"');
    expect(commandSource).toContain("clickTextOnlyHomeMonitorCard");
    expect(commandSource).toContain('emitDomDiagnostic("final_failure")');
    expect(runtimeSource).toContain("home_monitor_diag:${diagnostics.phase}");
    expect(runtimeSource).not.toContain("monitorLabels.join");
    expect(runtimeSource).not.toContain("actionLabels.join");
  });
});
