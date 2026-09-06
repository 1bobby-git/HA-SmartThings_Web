"""One-shot candidate synchronization; removed before release."""
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def replace(name, old, new, count=1):
    p=ROOT/name
    s=p.read_text(encoding="utf-8")
    if s.count(old)!=count:
        if new in s and old not in s:
            return
        raise SystemExit(f"Unexpected source anchor: {name}: {old[:70]}")
    p.write_text(s.replace(old,new),encoding="utf-8")

replace("bridge/src/runtime.ts", 'const bridgeVersion = "1.8.7";', 'const bridgeVersion = "1.8.8";')
for name, count in [("tests/addon-config.test.ts",6),("tests/protocol-version-contract.test.ts",4)]:
    p=ROOT/name
    s=p.read_text(encoding="utf-8")
    if '1.8.7' in s:
        if s.count('1.8.7')!=count:
            raise SystemExit(f"Unexpected version assertions: {name}: {s.count('1.8.7')}")
        s=s.replace('1.8.7','1.8.8')
        if name.endswith('addon-config.test.ts'):
            s=s.replace('    expect(changelog).toContain("## 1.8.8");','    expect(changelog).toContain("## 1.8.8");\n    expect(changelog).toContain("## 1.8.7");')
        p.write_text(s,encoding="utf-8")

name='bridge/tests/browser/home-monitor-live-dom.test.ts'
replace(name,'  readonly missing = new MissingLocator();', '''  readonly missing = new MissingLocator();
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
  }''')
replace(name,'  locator(): MissingLocator { return this.missing; }', '''  locator(selector: string): MissingLocator {
    if (selector.startsWith('[data-stw-hm-current-mode=')) return this.selector;
    if (selector.startsWith('[data-stw-hm-target=')) return this.action;
    return this.missing;
  }''')
replace(name,'    const input = argument as Record<string, unknown>;', '''    const input = argument as Record<string, unknown>;
    if (typeof input.marker === "string" && input.marker.startsWith("hm-mode-")) {
      return { kind: input.cleanup ? "missing" : "target", targets: input.cleanup ? 0 : 1 } as Result;
    }
    if (typeof input.markerId === "string") {
      if (input.phase === "select" && this.cardOpened) this.lastRequestedGroup = input.requestedGroup as number;
      const selectable = input.phase === "select" && this.cardOpened;
      return { kind: selectable ? "click" : "missing", dialogs: selectable ? 1 : 0,
        selects: 0, options: 0, modeGroups: selectable ? 3 : 0, targets: selectable ? 1 : 0 } as Result;
    }''')
replace(name,'''    if (input.currentModeProbe === true) {
      this.cardOpened = true;
      return "clicked" as Result;
    }
''','')
replace(name,'''    expect(page.cardOpened).toBe(true);
    expect(diagnostics).toEqual(["before_card_open"]);''', '''    expect(page.selector.click).toHaveBeenCalledTimes(1);
    expect(page.action.click).toHaveBeenCalledTimes(1);
    expect(page.selectedGroups).toEqual([0]); // Only the requested Away mode, not an intermediate Disarm.
    expect(page.cardOpened).toBe(false);
    expect(diagnostics).toEqual([]); // Fast selector path no longer needs a failed-card diagnostic.''')
replace(name,'''    expect(domSource).toContain("currentModeProbe: true");''', '''    const scopedSource = readFileSync("bridge/src/browser/home-monitor-current-mode.ts", "utf8");
    expect(domSource).toContain("clickScopedCurrentHomeMonitorMode");
    expect(scopedSource).toContain("root instanceof ShadowRoot");
    expect(scopedSource).toContain("const targets = new Set<Element>()");
    expect(scopedSource).toContain("local = modes.filter");
    expect(scopedSource).toContain("input.currentModeGroup");
    expect(scopedSource).not.toContain(".first()");''')
replace('README.md','**현재 버전: Bridge `1.8.7` / HA 통합 `1.8.7`','**현재 버전: Bridge `1.8.8` / HA 통합 `1.8.8`')
replace('README.md','## Bridge 1.8.7 후속 최적화','## 이전 Bridge 1.8.7 후속 최적화')
replace('README.md','## 통합 업데이트 1.8.7','## 이전 통합 업데이트 1.8.7')
for name in ['addon/smartthings_web_bridge/DOCS.md','addon/smartthings_web_bridge/README.md']:
    p=ROOT/name
    s=p.read_text(encoding='utf-8')
    if '## 1.8.8 Home Monitor' not in s:
        s+='\n## 1.8.8 Home Monitor\n\n현재 모드 선택기의 카드 범위와 동일 버튼 라벨 정규화를 보완하고 단일 모드 카드의 불필요한 탐색 대기를 줄였습니다. 기존 외출·해제 직접 클릭, 실제 보안 상태 확인 및 로그인 프로필을 유지합니다. Bridge와 HA 통합의 신규 버전은 모두 1.8.8이며 동일한 `v1.8.8` 소스 태그를 사용합니다. 중간 해제나 임의 성공 처리는 추가하지 않습니다. 합성 Chromium 테스트는 실제 삼성 계정 검증을 대신하지 않습니다.\n'
        p.write_text(s,encoding='utf-8')
print('Runtime, version contracts, selector mocks and current-version documentation synchronized.')
