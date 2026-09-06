"""One-shot, pinned source preparation; removed before the pull request is merged."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]
OLD, NEW = "1.8.7", "1.8.8"
PINS = {
    "bridge/src/browser/command-page.ts": "1031f8126a4b0f3f578c9f78c916c2645eb6cd7a",
    "bridge/src/browser/home-monitor-dom.ts": "2715a360fefeeed677c6bc01375d6576707248bb",
    "bridge/src/browser/home-monitor-card.ts": "7ed450524309fc238904379a155112c62c020ba9",
    "bridge/src/command/command-service.ts": "7aaed9432d658841b374ea00b767f20f11f9bc8b",
}
for name, expected in PINS.items():
    data = (ROOT / name).read_bytes()
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != expected:
        raise SystemExit(f"Refusing changed input: {name}: {actual}")

def replace_once(text, before, after):
    if text.count(before) != 1:
        raise SystemExit(f"Expected one source anchor, found {text.count(before)}: {before[:100]}")
    return text.replace(before, after, 1)

def write(name, text):
    (ROOT / name).write_text(text, encoding="utf-8")

name = "bridge/src/browser/home-monitor-dom.ts"
s = (ROOT / name).read_text(encoding="utf-8")
start = s.index('/**\n * Click the one current Home Monitor mode')
end = s.index('/**\n * Open the exact Home Monitor card', start)
s = s[:start] + '''/** Open only the exact card's current mode; preserve real target ambiguity. */
export async function clickCurrentHomeMonitorMode(
  page: BrowserPageLike,
  monitorLabels: readonly string[],
  modeLabelGroups: readonly (readonly string[])[],
  timeoutMs = 3_000,
  currentModeGroup?: number
): Promise<HomeMonitorDomResult> {
  return clickScopedCurrentHomeMonitorMode(page, monitorLabels, modeLabelGroups, timeoutMs, currentModeGroup);
}

''' + s[end:]
s = 'import { clickScopedCurrentHomeMonitorMode } from "./home-monitor-current-mode.js";\n' + s
write(name, s)

for name, count in [("bridge/src/browser/command-page.ts", 2), ("bridge/src/command/command-service.ts", 1)]:
    s = (ROOT / name).read_text(encoding="utf-8")
    anchor = "    isDesiredStateCurrent?: () => boolean;"
    if s.count(anchor) != count:
        raise SystemExit(f"Unexpected location input shape in {name}")
    s = s.replace(anchor, anchor + "\n    getCurrentModeGroup?: () => number;")
    if name.endswith("command-service.ts"):
        anchor = "        isDesiredStateCurrent: () => normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState) === desired"
        s = replace_once(s, anchor, anchor + ''',
        getCurrentModeGroup: () => (["armAway", "armStay", "disarm"] as const).findIndex(
          (command) => armStateForCommand(command) === normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState)
        )''')
    else:
        anchor = "\n        let action = await findHomeMonitorCardAction("
        fast = '''
        // A rendered single-mode card needs its selector, not another series of absent-button waits.
        const fastModeResult = await clickCurrentHomeMonitorMode(
          page, monitorLabels, modeLabelGroups, budget(600), input.getCurrentModeGroup?.()
        );
        if (fastModeResult === "ambiguous") throw new Error("command_control_ambiguous");
        if (fastModeResult === "clicked") {
          monitorOpened = true;
          this.#diagnostic("home_monitor_current_mode_opened");
          const selected = await clickRequestedText(budget(3_000));
          if (selected === "clicked") return;
          if (selected === "ambiguous") throw new Error("command_control_ambiguous");
          await emitDomDiagnostic("final_failure");
          throw new Error("command_control_not_found");
        }
'''
        s = replace_once(s, anchor, fast + anchor)
        s = replace_once(s, '''          monitorLabels,
          modeLabelGroups,
          budget(1_000)
        );''', '''          monitorLabels,
          modeLabelGroups,
          budget(1_000),
          input.getCurrentModeGroup?.()
        );''')
    write(name, s)

name = "bridge/src/browser/home-monitor-card.ts"
s = (ROOT / name).read_text(encoding="utf-8")
s = replace_once(s, '| "dialog" | "scan_limit";', '| "dialog" | "scan_limit" | "current_mode";')
s = replace_once(s, "  let card: Element | undefined;", "  let card: Element | undefined;\n  let singleModeCard = false;")
s = replace_once(s, '''    if (new Set(localModes.map((element) => modeMap.get(element))).size >= 2) {
      card = scope;
      break;
    }
  }
  if (!card) return result; // A single current-mode pill is handled by the existing dialog path.''', '''    const localGroupCount = new Set(localModes.map((element) => modeMap.get(element))).size;
    if (localGroupCount >= 2) {
      card = scope;
      break;
    }
    if (localGroupCount === 1) singleModeCard = true;
    if (scope.matches('section,article,[role="region"]')) break;
  }
  if (!card) return singleModeCard ? { ...result, kind: "current_mode" } : result;''')
s = replace_once(s, "  let last: CardProbeResult | undefined;", "  let last: CardProbeResult | undefined;\n  let singleModeSince: number | undefined;")
s = replace_once(s, '''      if (last.kind === "target") {''', '''      if (last.kind === "current_mode") {
        singleModeSince ??= Date.now();
        // Debounce hydration, then stop waiting for buttons this layout does not expose.
        if (Date.now() - singleModeSince >= 300) { report("current_mode"); return "not_found"; }
      } else singleModeSince = undefined;
      if (last.kind === "target") {''')
write(name, s)

for name, field in [("package.json", "version"), ("custom_components/smartthings_web/manifest.json", "version"), ("protocol/version.json", "bridge_version")]:
    p = ROOT / name
    data = json.loads(p.read_text(encoding="utf-8"))
    if data[field] != OLD:
        raise SystemExit(f"Unexpected version in {name}: {data[field]}")
    data[field] = NEW
    write(name, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
p = ROOT / "package-lock.json"
data = json.loads(p.read_text(encoding="utf-8"))
if data.get("version") != OLD or data.get("packages", {}).get("", {}).get("version") != OLD:
    raise SystemExit("Unexpected root lockfile version")
data["version"] = NEW
data["packages"][""]["version"] = NEW
write("package-lock.json", json.dumps(data, ensure_ascii=False, indent=2) + "\n")
name = "addon/smartthings_web_bridge/config.yaml"
s = (ROOT / name).read_text(encoding="utf-8")
s, count = re.subn(r'(?m)^version: [\"\']?1\.8\.7[\"\']?$', 'version: "1.8.8"', s)
if count != 1:
    raise SystemExit("Unexpected app version")
write(name, s)

notes = '''## 1.8.8

- Home Monitor 현재 모드 탐색을 정확한 카드 내부로 제한합니다. 다른 기기의 Off/외출/실내 표시 때문에 모드 선택이 ambiguous로 중단되지 않도록 수정했습니다.
- 한 버튼의 텍스트·아이콘·접근성 라벨은 같은 실제 클릭 대상으로 정규화합니다. 서로 다른 버튼, 중복 카드, 비활성 제어와 모달 뒤의 제어는 계속 거부합니다.
- 이미 현재 모드만 표시된 카드에서는 300ms의 안정화 관찰 후 선택기를 먼저 탐색합니다. 존재하지 않는 직접 버튼을 5초 동안 찾은 뒤 다른 탐색을 반복하던 지연을 줄였습니다.
- 실제 관찰된 현재 보안 모드와 선택기 후보를 대조합니다. 실내 전환을 위해 해제를 자동 실행하거나, 모드 변경 확인 없이 성공으로 처리하지 않습니다.
- 기존 외출·해제 직접 클릭, 명령 확인까지 탭 유지, 큐 만료, Scene·Advanced commands·speak, 로그인 프로필 및 엔티티 식별자를 유지합니다.
- 합성 Chromium 회귀 테스트를 추가했습니다. 실제 삼성 계정의 DOM 캡처나 사용자 HA 환경의 업데이트 후 성공률·응답 시간 검증을 대신하지 않습니다.

'''
for name in ["addon/smartthings_web_bridge/CHANGELOG.md", "CHANGELOG.md"]:
    text = (ROOT / name).read_text(encoding="utf-8")
    if "## 1.8.8" in text:
        raise SystemExit(f"Version already documented: {name}")
    if text.startswith("# "):
        title, _, rest = text.partition("\n")
        text = title + "\n\n" + notes + rest.lstrip("\n")
    else:
        text = notes + text
    write(name, text)
name = "README.md"
s = (ROOT / name).read_text(encoding="utf-8")
s += "\n### 1.8.8 Home Monitor 제어 보완\n\n현재 모드 선택기의 카드 범위와 실제 클릭 대상 판정을 수정하고, 단일 모드 화면의 불필요한 직접 버튼 탐색 대기를 줄였습니다. 외출·실내·해제는 요청한 모드만 선택하며 중간 해제를 자동 실행하지 않습니다. 실제 상태 확인을 유지하고, 기존 Scene·Advanced commands·Galaxy Home Mini `speak`와 엔티티 ID는 변경하지 않습니다. Chromium 합성 회귀 검증과 실계정 동작 검증은 구분합니다. 세부 내용은 [변경 이력](addon/smartthings_web_bridge/CHANGELOG.md#188)을 확인하세요.\n"
write(name, s)
name = ".github/workflows/validate.yml"
s = (ROOT / name).read_text(encoding="utf-8")
s = replace_once(s, "          node tools/ci-home-monitor-latency-smoke.mjs", "          node tools/ci-home-monitor-latency-smoke.mjs\n          node tools/ci-home-monitor-current-mode-smoke.mjs")
write(name, s)
print("Prepared 1.8.8 with pinned inputs; no persistent-data or registry migration.")
