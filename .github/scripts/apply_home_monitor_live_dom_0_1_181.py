from __future__ import annotations

import json
from pathlib import Path


VERSION_OLD = "0.1.180"
VERSION_NEW = "0.1.181"


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def patch_command_page() -> None:
    path = "bridge/src/browser/command-page.ts"
    text = read(path)
    text = replace_once(
        text,
        'import { clickTextOnlyHomeMonitorAction } from "./home-monitor-dom.js";',
        '''import {
  clickTextOnlyHomeMonitorAction,
  clickTextOnlyHomeMonitorCard,
  inspectHomeMonitorDom,
  type HomeMonitorDomDiagnostics
} from "./home-monitor-dom.js";''',
        "command-page Home Monitor imports",
    )
    text = replace_once(
        text,
        '  onDiagnostic?: (stage: CommandDiagnosticStage) => void;\n',
        '''  onDiagnostic?: (stage: CommandDiagnosticStage) => void;
  onHomeMonitorDiagnostic?: (diagnostics: HomeMonitorDomDiagnostics) => void;
''',
        "command-page option",
    )
    text = replace_once(
        text,
        '  readonly #onDiagnostic: ((stage: CommandDiagnosticStage) => void) | undefined;\n',
        '''  readonly #onDiagnostic: ((stage: CommandDiagnosticStage) => void) | undefined;
  readonly #onHomeMonitorDiagnostic:
    | ((diagnostics: HomeMonitorDomDiagnostics) => void)
    | undefined;
''',
        "command-page field",
    )
    text = replace_once(
        text,
        '    this.#onDiagnostic = options?.onDiagnostic;\n',
        '''    this.#onDiagnostic = options?.onDiagnostic;
    this.#onHomeMonitorDiagnostic = options?.onHomeMonitorDiagnostic;
''',
        "command-page constructor",
    )

    start = text.index("  async #executeLocationAction(input: {")
    end = text.index("\n  private async openLocationPage(", start)
    new_method = '''  async #executeLocationAction(input: {
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    action: "armAway" | "armStay" | "disarm";
  }): Promise<void> {
    await this.#invalidateWarmPage();
    const page = await this.openLocationPage(input.locationId, input.locationNames);
    try {
      const actionName = locationActionName(input.action);
      const actionLabels = locationActionLabels(input.action);
      const modeLabelGroups = [
        locationActionLabels("armAway"),
        locationActionLabels("armStay"),
        locationActionLabels("disarm")
      ];
      const locationName = input.locationNames?.[input.locationId];
      const monitorName = homeMonitorName(locationName);
      const monitorLabels = homeMonitorLabels(locationName);
      const emitDomDiagnostic = async (
        phase: HomeMonitorDomDiagnostics["phase"]
      ): Promise<void> => {
        const diagnostics = await inspectHomeMonitorDom(
          page,
          monitorLabels,
          actionLabels,
          modeLabelGroups,
          phase
        );
        if (!diagnostics) return;
        try {
          this.#onHomeMonitorDiagnostic?.(diagnostics);
        } catch {
          // Diagnostics must never change command behavior.
        }
      };

      let action = await findHomeMonitorCardAction(
        page,
        monitorName,
        monitorLabels,
        actionName,
        3_000
      );
      if (action) {
        await action.click({ timeout: 15_000 });
        return;
      }

      let textResult = await clickTextOnlyHomeMonitorAction(
        page,
        monitorLabels,
        actionLabels,
        modeLabelGroups
      );
      if (textResult === "clicked") return;
      if (textResult === "ambiguous") {
        throw new Error("command_control_ambiguous");
      }

      if (
        await clickHomeMonitorCardActionByText(
          page,
          monitorLabels,
          actionLabels
        )
      ) {
        return;
      }

      action = await findLocationActionControl(page, actionName, 250);
      if (action) {
        await action.click({ timeout: 15_000 });
        return;
      }

      await emitDomDiagnostic("before_card_open");
      let cardOpened = false;
      const cardResult = await clickTextOnlyHomeMonitorCard(
        page,
        monitorLabels,
        3_000
      );
      if (cardResult === "ambiguous") {
        throw new Error("command_control_ambiguous");
      }
      if (cardResult === "clicked") {
        cardOpened = true;
        textResult = await clickTextOnlyHomeMonitorAction(
          page,
          monitorLabels,
          actionLabels,
          modeLabelGroups
        );
        if (textResult === "clicked") return;
        if (textResult === "ambiguous") {
          throw new Error("command_control_ambiguous");
        }
        action = await findLocationActionControl(page, actionName, 1_000);
        if (action) {
          await action.click({ timeout: 15_000 });
          return;
        }
      }

      if (!cardOpened) {
        const monitor = await findHomeMonitorControl(page, monitorName);
        if (monitor) {
          await monitor.click({ timeout: 15_000 });
          cardOpened = true;
          textResult = await clickTextOnlyHomeMonitorAction(
            page,
            monitorLabels,
            actionLabels,
            modeLabelGroups
          );
          if (textResult === "clicked") return;
          if (textResult === "ambiguous") {
            throw new Error("command_control_ambiguous");
          }
        }
      }

      if (cardOpened) {
        const dialog = page.getByRole("dialog");
        try {
          await dialog.first().waitFor({ state: "visible", timeout: 1_000 });
        } catch {
          // Cake may render a drawer or roleless overlay. The DOM scan above
          // already checked the whole visible page without assuming a dialog.
        }
        const dialogCount = await dialog.count();
        if (dialogCount > 1) {
          throw new Error("command_control_ambiguous");
        }
        if (dialogCount === 1) {
          action = await findLocationActionControl(dialog, actionName, 1_000);
          if (action) {
            await action.click({ timeout: 15_000 });
            return;
          }
        }
        await emitDomDiagnostic("after_card_open");
      }

      await emitDomDiagnostic("final_failure");
      throw new Error("command_control_not_found");
    } finally {
      await page.close().catch(() => undefined);
    }
  }
'''
    text = text[:start] + new_method + text[end:]

    text = replace_once(
        text,
        '["button", "radio", "tab"].map((role) =>',
        '["button", "radio", "tab", "menuitem", "menuitemradio", "option", "switch"].map((role) =>',
        "Home Monitor action roles",
    )
    text = replace_once(
        text,
        '["button", "link"].map((role) =>',
        '["button", "link", "menuitem", "tab"].map((role) =>',
        "Home Monitor card roles",
    )
    write(path, text)


def patch_runtime() -> None:
    path = "bridge/src/runtime.ts"
    text = read(path)
    text = replace_once(
        text,
        'const bridgeVersion = "0.1.180";',
        'const bridgeVersion = "0.1.181";',
        "runtime version",
    )
    text = replace_once(
        text,
        '''      onDiagnostic: (stage) => log.info(`command_diag:${stage}`),
      resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),''',
        '''      onDiagnostic: (stage) => log.info(`command_diag:${stage}`),
      onHomeMonitorDiagnostic: (diagnostics) =>
        log.info(
          `home_monitor_diag:${diagnostics.phase}` +
          `:monitor_${diagnostics.monitorExactCount}` +
          `:action_${diagnostics.actionExactCount}` +
          `:clickable_${diagnostics.actionClickableCount}` +
          `:mode_groups_${diagnostics.modeGroupCount}` +
          `:dialogs_${diagnostics.visibleDialogCount}` +
          `:iframes_${diagnostics.visibleIframeCount}` +
          `:shadow_roots_${diagnostics.openShadowRootCount}`
        ),
      resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),''',
        "runtime Home Monitor diagnostic logger",
    )
    write(path, text)


def patch_versions() -> None:
    package = json.loads(read("package.json"))
    if package.get("version") != VERSION_OLD:
        raise SystemExit("package.json version mismatch")
    package["version"] = VERSION_NEW
    write("package.json", json.dumps(package, ensure_ascii=False, indent=2) + "\n")

    lock = json.loads(read("package-lock.json"))
    if lock.get("version") != VERSION_OLD or lock.get("packages", {}).get("", {}).get("version") != VERSION_OLD:
        raise SystemExit("package-lock.json version mismatch")
    lock["version"] = VERSION_NEW
    lock["packages"][""]["version"] = VERSION_NEW
    write("package-lock.json", json.dumps(lock, ensure_ascii=False, indent=2) + "\n")

    manifest = json.loads(read("custom_components/smartthings_web/manifest.json"))
    if manifest.get("version") != VERSION_OLD:
        raise SystemExit("manifest version mismatch")
    manifest["version"] = VERSION_NEW
    write(
        "custom_components/smartthings_web/manifest.json",
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
    )

    protocol = json.loads(read("protocol/version.json"))
    if protocol.get("bridge_version") != VERSION_OLD:
        raise SystemExit("protocol version mismatch")
    protocol["bridge_version"] = VERSION_NEW
    write("protocol/version.json", json.dumps(protocol, ensure_ascii=False, indent=2) + "\n")

    config_path = "addon/smartthings_web_bridge/config.yaml"
    config = read(config_path)
    config = replace_once(
        config,
        f"version: {VERSION_OLD}",
        f"version: {VERSION_NEW}",
        "add-on config version",
    )
    write(config_path, config)


def patch_tests() -> None:
    path = "tests/addon-config.test.ts"
    text = read(path)
    replacements = (
        (
            "packages Home Monitor, scene and Web-label fixes as version 0.1.180",
            "packages live Home Monitor DOM recovery as version 0.1.181",
        ),
        ('expect(config.version).toBe("0.1.180");', 'expect(config.version).toBe("0.1.181");'),
        ('expect(packageMetadata.version).toBe("0.1.180");', 'expect(packageMetadata.version).toBe("0.1.181");'),
        ('expect(protocolMetadata.bridge_version).toBe("0.1.180");', 'expect(protocolMetadata.bridge_version).toBe("0.1.181");'),
        (
            'expect(runtime).toContain(\'const bridgeVersion = "0.1.180";\');',
            'expect(runtime).toContain(\'const bridgeVersion = "0.1.181";\');',
        ),
    )
    for old, new in replacements:
        text = replace_once(text, old, new, f"addon config test {old}")
    anchor = '    expect(changelog).toContain("## 0.1.179");'
    text = replace_once(
        text,
        anchor,
        '    expect(changelog).toContain("## 0.1.181");\n' + anchor,
        "add-on changelog assertion",
    )
    write(path, text)

    test_path = Path("bridge/tests/browser/home-monitor-live-dom.test.ts")
    test_path.write_text(
        '''import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { SmartThingsWebUiCommandExecutor } from "../../src/browser/command-page.js";
import {
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

  url(): string { return this.currentUrl; }
  isClosed(): boolean { return false; }
  getByRole(): MissingLocator { return this.missing; }
  getByText(): MissingLocator { return this.missing; }
  locator(): MissingLocator { return this.missing; }

  async evaluate<Result, Argument>(
    _pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result> {
    const input = argument as Record<string, unknown>;
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
      this.cardOpened = true;
      return "clicked" as Result;
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
  });

  test("opens a roleless card and then executes the exact mode", async () => {
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

    expect(page.cardOpened).toBe(true);
    expect(diagnostics).toEqual(["before_card_open"]);
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
    expect(domSource).toContain("root.host instanceof HTMLElement");
    expect(domSource).toContain('"menuitemradio"');
    expect(commandSource).toContain("clickTextOnlyHomeMonitorCard");
    expect(commandSource).toContain('emitDomDiagnostic("final_failure")');
    expect(runtimeSource).toContain("home_monitor_diag:${diagnostics.phase}");
    expect(runtimeSource).not.toContain("monitorLabels.join");
    expect(runtimeSource).not.toContain("actionLabels.join");
  });
});
''',
        encoding="utf-8",
    )


def patch_changelog_and_docs() -> None:
    path = "addon/smartthings_web_bridge/CHANGELOG.md"
    text = read(path)
    entry = '''## 0.1.181

- 실제 `0.1.180` 환경에서 위치 라우팅 이후에도 Home Monitor가 `command_control_not_found`로 실패한 경로를 보강했습니다. 접근성 role이 없는 React Home Monitor 카드의 정확한 제목을 찾아 카드를 먼저 열고, 그 뒤 전체 화면·drawer·dialog 안의 정확한 `외출`·`재실`·`해제` 제어를 다시 탐색합니다.
- 텍스트 제어와 카드 탐색은 open shadow root의 host 경계를 따라 상위 클릭 핸들러까지 추적하고 `menuitemradio`, `option`, `switch` 등 실제 렌더링 가능한 역할을 지원합니다. 동일 후보가 여러 개이면 계속 실행하지 않습니다.
- 최종 실패 때 페이지 텍스트·URL·계정·원본 식별자를 기록하지 않고, 정확한 제목/액션 수, 클릭 가능 후보 수, 모드 그룹, dialog, iframe, open shadow root 개수만 `home_monitor_diag`로 남깁니다.
- roleless 카드 열기, 정확한 모드 재탐색, 진단 콜백과 비식별 구조 로그에 대한 회귀 테스트를 추가했습니다.

'''
    if not text.startswith("## 0.1.180\n"):
        raise SystemExit("changelog head mismatch")
    write(path, entry + text)

    docs_path = Path("docs/releases/0.1.181-home-monitor-live-dom.md")
    docs_path.write_text(
        '''# 0.1.181 Home Monitor live DOM recovery

실제 `0.1.180` 사용 환경에서는 Location 직접 라우팅까지 성공했지만, Home Monitor의 `외출`·`재실` 제어가 접근성 button으로 노출되지 않아 `command_control_not_found`가 발생했습니다.

`0.1.181`은 정확한 Home Monitor 제목을 가진 roleless React 카드를 먼저 열고, 열린 drawer·dialog 또는 전체 visible page에서 정확한 모드 라벨을 다시 찾습니다. open shadow root의 host 경계를 따라 React 상위 클릭 요소를 확인하며, 후보가 정확히 하나일 때만 클릭합니다.

실패 시 다음 구조 개수만 `home_monitor_diag` 로그에 기록합니다.

- 정확한 Home Monitor 제목 후보 수
- 정확한 요청 모드 후보와 클릭 가능 후보 수
- 알려진 보안 모드 그룹 수
- visible dialog·iframe과 open shadow root 수

페이지 텍스트, 위치·계정·기기 이름, URL, 쿠키, 토큰과 원본 식별자는 기록하지 않습니다. 이 로그로 현재 SmartThings Web 렌더링이 라벨 변경인지, roleless 카드인지, iframe/shadow DOM 경계인지 구분할 수 있습니다.
''',
        encoding="utf-8",
    )


def patch_readme() -> None:
    path = "README.md"
    text = read(path)
    text = replace_once(
        text,
        "**현재 상태: `0.1.180` · 실환경 부분 검증**",
        "**현재 상태: `0.1.181` · 실환경 부분 검증**",
        "README visible version",
    )
    text = replace_once(
        text,
        "`v0.1.180` Bridge 앱과 Home Assistant 통합 패키지가 GitHub Release에 게시됨",
        "`v0.1.181` Bridge 앱과 Home Assistant 통합 패키지가 GitHub Release에 게시됨",
        "README release table",
    )
    old_row = "| Home Monitor | 실제 발생한 `command_location_picker_not_found` 경로를 `0.1.180`에서 위치 직접 라우팅 방식으로 수정 | 자동 검증 통과, 사용자 환경 재검증 필요 |"
    new_row = "| Home Monitor | `0.1.180`에서 위치 직접 라우팅 뒤 `command_control_not_found`가 실환경 재현됨. `0.1.181`은 roleless React 카드 열기, shadow host 탐색과 비식별 구조 진단을 추가 | 자동 검증 통과, 사용자 환경 재검증 필요 |"
    text = replace_once(text, old_row, new_row, "README Home Monitor row")
    anchor = "`0.1.180` 변경 검증에서는 Vitest 89개 파일·1,054개 Node 테스트, TypeScript typecheck/build, Python 통합 테스트, HACS, Hassfest, 보안 검사와 패키지형 HAOS 런타임 smoke가 통과했습니다. 실제 사용자 환경에서 아직 다시 확인하지 않은 Home Monitor, Scene, Web 표시명과 Galaxy Home Mini TTS는 완료로 과장하지 않고 재검증 필요 상태로 표시합니다."
    replacement = anchor + "\n\n`0.1.181`은 실제 `command_control_not_found` 재현을 기준으로 Home Monitor의 roleless 카드 열기와 실패 전용 `home_monitor_diag` 구조 로그를 추가했습니다. 현재 실기기 성공 여부는 새 버전 설치 후 다시 확인해야 합니다."
    text = replace_once(text, anchor, replacement, "README validation note")
    write(path, text)


def main() -> None:
    patch_command_page()
    patch_runtime()
    patch_versions()
    patch_tests()
    patch_changelog_and_docs()
    patch_readme()


if __name__ == "__main__":
    main()
