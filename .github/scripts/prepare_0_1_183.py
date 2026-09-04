"""Apply the narrowly scoped 0.1.183 wiring/version change to the reviewed base."""
from pathlib import Path
import json


def once(path: str, old: str, new: str) -> None:
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    if source.count(old) != 1:
        raise SystemExit(f"{path}: exact anchor count {source.count(old)}, expected 1")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


command = "bridge/src/browser/command-page.ts"
once(command, 'import { clickExactSceneCard } from "./scene-dom.js";',
     'import { clickExactSceneCard } from "./scene-dom.js";\n'
     'import { clickHomeMonitorDialogAction, type HomeMonitorDialogDiagnostics } from "./home-monitor-dialog.js";')
once(command,
     '  onHomeMonitorDiagnostic?: (diagnostics: HomeMonitorDomDiagnostics) => void;',
     '  onHomeMonitorDiagnostic?: (diagnostics: HomeMonitorDomDiagnostics) => void;\n'
     '  onHomeMonitorDialogDiagnostic?: (diagnostics: HomeMonitorDialogDiagnostics) => void;')
once(command,
     '  readonly #resolveRawDeviceId: ((alias: string) => string | undefined) | undefined;',
     '  readonly #onHomeMonitorDialogDiagnostic: ((diagnostics: HomeMonitorDialogDiagnostics) => void) | undefined;\n'
     '  readonly #resolveRawDeviceId: ((alias: string) => string | undefined) | undefined;')
once(command,
     '    this.#onHomeMonitorDiagnostic = options?.onHomeMonitorDiagnostic;',
     '    this.#onHomeMonitorDiagnostic = options?.onHomeMonitorDiagnostic;\n'
     '    this.#onHomeMonitorDialogDiagnostic = options?.onHomeMonitorDialogDiagnostic;')
once(command, '''      const clickRequestedText = async (timeoutMs: number) =>
        clickTextOnlyHomeMonitorAction(
          page,
          monitorLabels,
          actionLabels,
          modeLabelGroups,
          timeoutMs
        );''', '''      let monitorOpened = false;
      const clickRequestedText = async (timeoutMs: number) => {
        const dialogResult = await clickHomeMonitorDialogAction(
          page, monitorLabels, actionLabels, modeLabelGroups, timeoutMs,
          monitorOpened, this.#onHomeMonitorDialogDiagnostic
        );
        if (dialogResult === "not_found") {
          // Never fall back to dashboard buttons behind an unrecognized modal.
          await emitDomDiagnostic("final_failure");
          throw new Error("command_control_not_found");
        }
        if (dialogResult !== "unavailable") return dialogResult;
        return clickTextOnlyHomeMonitorAction(
          page, monitorLabels, actionLabels, modeLabelGroups, timeoutMs
        );
      };''')
once(command, '''      if (currentModeResult === "clicked") {
        this.#onDiagnostic?.("home_monitor_current_mode_opened");''', '''      if (currentModeResult === "clicked") {
        monitorOpened = true;
        this.#onDiagnostic?.("home_monitor_current_mode_opened");''')
path = Path(command)
text = path.read_text(encoding="utf-8")
start = text.index("  async #executeLocationAction(")
end = text.index("  private async openLocationPage(", start)
block = text[start:end]
if block.count("cardOpened = true;") != 2:
    raise SystemExit("Home Monitor alternate-card anchor mismatch")
block = block.replace("cardOpened = true;", "cardOpened = true;\n          monitorOpened = true;")
path.write_text(text[:start] + block + text[end:], encoding="utf-8")

runtime = "bridge/src/runtime.ts"
once(runtime, '      resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),', '''      onHomeMonitorDialogDiagnostic: (diagnostics) =>
        log.info(
          `home_monitor_diag:dialog_${diagnostics.outcome}` +
          `:dialogs_${diagnostics.dialogs}:selects_${diagnostics.selects}` +
          `:options_${diagnostics.options}:mode_groups_${diagnostics.modeGroups}` +
          `:targets_${diagnostics.targets}`
        ),
      resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),''')

for name in ["package.json", "custom_components/smartthings_web/manifest.json"]:
    path = Path(name)
    value = json.loads(path.read_text(encoding="utf-8"))
    assert value["version"] == "0.1.182", name
    value["version"] = "0.1.183"
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
path = Path("package-lock.json")
value = json.loads(path.read_text(encoding="utf-8"))
assert value["version"] == value["packages"][""]["version"] == "0.1.182"
value["version"] = value["packages"][""]["version"] = "0.1.183"
path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
path = Path("protocol/version.json")
value = json.loads(path.read_text(encoding="utf-8"))
assert value["bridge_version"] == "0.1.182"
value["bridge_version"] = "0.1.183"
path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
once("addon/smartthings_web_bridge/config.yaml", "version: 0.1.182", "version: 0.1.183")
once(runtime, 'const bridgeVersion = "0.1.182";', 'const bridgeVersion = "0.1.183";')
for name in ["tests/addon-config.test.ts", "tests/protocol-version-contract.test.ts"]:
    path = Path(name)
    text = path.read_text(encoding="utf-8")
    assert "0.1.182" in text, name
    path.write_text(text.replace("0.1.182", "0.1.183"), encoding="utf-8")

path = Path("addon/smartthings_web_bridge/CHANGELOG.md")
notes = '''## 0.1.183

- 0.1.182 실환경 로그의 `current_mode_opened`, `dialogs_1`, `action_0` 경로를 대상으로 Home Monitor의 열린 팝업을 별도로 처리합니다. 닫힌 native `select`의 화면 크기 0인 `option`, 설명이 붙은 라디오/모드 항목, `aria-labelledby`, 팝업에 연결된 combobox/listbox를 지원합니다.
- 괄호·공백으로 나뉜 모드 라벨을 일관되게 비교하고 Playwright의 실제 선택·클릭 동작을 사용합니다. 같은 팝업에 정확한 적용/저장 버튼이 하나 있으면 제출합니다. 실제 보안 상태 이벤트 확인은 유지하며 UI 클릭만으로 성공으로 처리하지 않습니다.
- 알 수 없는 팝업, 비활성 항목, 중복 후보에서는 배경의 다른 버튼을 클릭하지 않고 중단합니다. 추가 로그 `home_monitor_diag:dialog_*`에는 팝업/선택/모드/후보 개수만 남기고 페이지 문구·계정·쿠키·원본 식별자는 기록하지 않습니다.
- 합성 HTML을 실제 Chromium에서 실행하는 팝업 회귀 테스트를 영구 CI에 추가했습니다. 사용자 Samsung 계정의 실제 팝업 구조는 아직 확보되지 않았으므로 실계정 Home Monitor 성공을 검증했다고 주장하지 않습니다.
- 사용자 확인으로 동작하는 Scene 실행 경로와 기존 이벤트 폭주 억제·로그인 프로필·엔티티 ID 처리 로직은 변경하지 않았습니다. Scene의 완료 확인 타임아웃과 별도 HA 자동화의 잘못된 entity ID는 이번 수정 범위가 아닙니다.

'''
path.write_text(notes + path.read_text(encoding="utf-8"), encoding="utf-8")
once("README.md", '**현재 상태: `0.1.182` · 실환경 부분 검증**', '**현재 상태: `0.1.183` · 실환경 부분 검증**')
once("README.md", '## Scene·Advanced Commands·Galaxy Home Mini TTS', '''`0.1.183`은 Home Monitor 팝업 내부의 native 선택 상자·라디오·접근성 라벨·적용 버튼 처리를 보강합니다. 합성 화면을 실제 Chromium에서 검증하지만, 사용자 계정의 실제 Home Monitor 모드 변경 성공은 추가 확인이 필요합니다. Scene은 사용자가 실제 실행을 확인했고 이번 버전에서 실행 경로를 변경하지 않았습니다. 완료 확인 타임아웃은 별도 문제로 남습니다.

## Scene·Advanced Commands·Galaxy Home Mini TTS''')

once(".github/workflows/validate.yml", '      - name: Run Python tests\n', '''      - name: Exercise Home Monitor dialogs in real Chromium
        run: |
          npx playwright-core install --with-deps chromium
          node tools/ci-home-monitor-dialog-smoke.mjs

      - name: Run Python tests
''')
