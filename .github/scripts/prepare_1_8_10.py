from pathlib import Path
import hashlib

root=Path.cwd()
expected={
 'bridge/src/browser/command-page.ts':'eb1240dd3df41569d7ba357169fed027ed1e8966',
 'bridge/src/browser/home-monitor-selector.ts':'92eb3392fad5d36c709581b10fcb19cd167742d9',
 'bridge/src/browser/home-monitor-dom.ts':'f20a7d1531950222c35f958d1fbefc2a6eea3c00',
 'bridge/src/browser/home-monitor-card.ts':'46c68fc68d94a58fd70438a00372cec1c11e0fe1',
 'bridge/src/browser/home-monitor-dialog.ts':'1c2b8953e69d566ad6d6b1cbed9483c8ee6faa9d',
 'bridge/src/command/location-rechecks.ts':'c0759dfe8d3b6c06264b7e83087c3683a65da329',
 'custom_components/smartthings_web/alarm_control_panel.py':'a33c1bf8ea2615b8f54e329685636ccc21f7ab3e',
}
for name,sha in expected.items():
 b=(root/name).read_bytes()
 actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
 if actual!=sha: raise SystemExit(f'Unexpected source revision: {name}')
def change(name,old,new):
 p=root/name;s=p.read_text(encoding='utf-8')
 if s.count(old)!=1: raise SystemExit(f'Ambiguous source context: {name}: {old[:70]}')
 p.write_text(s.replace(old,new),encoding='utf-8')
base='bridge/src/browser/'
p=root/base/'home-monitor-mode-labels.ts'
if p.exists(): raise SystemExit('Mode label helper already exists')
p.write_text('''/** Only for an identified Home Monitor card or its associated popup, never page-wide navigation. */
export function scopedHomeMonitorModeGroups(groups: readonly (readonly string[])[]): string[][] {
  const aliases = [[], ["Arm home", "Armed home", "Armed (Home)", "Home", "Home mode", "집", "집 모드", "보안(집)"], []];
  return groups.map((group, index) => [...new Set([...group, ...(aliases[index] ?? [])])]);
}
''',encoding='utf-8')
for f in ['home-monitor-selector.ts','home-monitor-card.ts','home-monitor-dialog.ts']:
 change(base+f,'import type { BrowserPageLike } from "./keeper-page.js";', 'import type { BrowserPageLike } from "./keeper-page.js";\nimport { scopedHomeMonitorModeGroups } from "./home-monitor-mode-labels.js";')
f=base+'home-monitor-selector.ts'
change(f,'  cleanup?: boolean;','  cleanup?: boolean;\n  popupToken?: string;')
change(f,'["listbox", "menu"].includes(element.getAttribute("aria-haspopup") ?? "")','["true", "dialog", "listbox", "menu"].includes(element.getAttribute("aria-haspopup") ?? "")')
change(f,'"Armed away", "Armed (Away)", "Armed stay", "Armed (Stay)", "Disarmed"','"Armed away", "Armed (Away)", "Armed stay", "Armed (Stay)", "Armed home", "Armed (Home)", "Disarmed"')
change(f,'  target.setAttribute(attribute, input.marker);','  target.setAttribute(attribute, input.marker);\n  if (input.popupToken) target.setAttribute("data-stw-hm-popup-owner", input.popupToken);')
p=root/f;s=p.read_text(encoding='utf-8');s=s.replace('modeLabelGroups.map((group) => [...group])','scopedHomeMonitorModeGroups(modeLabelGroups)');p.write_text(s,encoding='utf-8')
change(f,'page: BrowserPageLike, monitorLabels: readonly string[], modeLabelGroups: readonly (readonly string[])[], timeoutMs: number\n','page: BrowserPageLike, monitorLabels: readonly string[], modeLabelGroups: readonly (readonly string[])[], timeoutMs: number, popupToken?: string\n')
change(f,'monitorLabels: [...monitorLabels], modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups) };\n  const deadline', 'monitorLabels: [...monitorLabels], modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups),\n    ...(popupToken ? { popupToken } : {}) };\n  const deadline')
f=base+'home-monitor-dom.ts'
change(f,'  timeoutMs = 3_000\n): Promise<HomeMonitorDomResult> {\n  return clickScopedHomeMonitorSelector(page, monitorLabels, modeLabelGroups, timeoutMs);','  timeoutMs = 3_000,\n  popupToken?: string\n): Promise<HomeMonitorDomResult> {\n  return clickScopedHomeMonitorSelector(page, monitorLabels, modeLabelGroups, timeoutMs, popupToken);')
f=base+'home-monitor-card.ts'
change(f,'modeLabelGroups: modeLabelGroups.map((group) => [...group]), requestedGroup','modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups), requestedGroup')
f=base+'home-monitor-dialog.ts'
change(f,'  phase: "select" | "commit" | "cleanup";','  phase: "select" | "commit" | "cleanup";\n  popupToken?: string;')
change(f,'  optionValue?: string;','  optionValue?: string;\n  associated?: boolean;')
change(f,'''  const dialogs = elements.filter((element) =>
    (element.matches('dialog,[role="dialog"]')) && visible(element));''','''  const modals = elements.filter((element) =>
    element.matches('dialog,[role="dialog"],[aria-modal="true"]') && visible(element));
  const linked = new Set<Element>();
  const owners = input.popupToken ? elements.filter((element) =>
    element.getAttribute("data-stw-hm-popup-owner") === input.popupToken) : [];
  if (owners.length > 1) return { ...result, kind: "ambiguous" };
  for (const owner of owners) {
    if (owner.getAttribute("aria-expanded") === "false" || disabled(owner)) continue;
    const root = owner.getRootNode() as Document | ShadowRoot;
    const ids = `${owner.getAttribute("aria-controls") ?? ""} ${owner.getAttribute("aria-owns") ?? ""}`.split(/\\s+/u).filter(Boolean);
    for (const id of ids) {
      const popup = root.getElementById?.(id);
      if (popup && visible(popup) && !within(owner, popup) &&
          !popup.matches('html,body,main,nav,header,footer,[role="main"]')) linked.add(popup);
    }
    if (owner.id) {
      for (const popup of elements) {
        if (visible(popup) && popup.matches('[role="menu"],[role="listbox"],dialog,[role="dialog"],[aria-modal="true"]') &&
            (popup.getAttribute("aria-labelledby") ?? "").split(/\\s+/u).includes(owner.id) &&
            !within(owner, popup)) linked.add(popup);
      }
    }
  }
  // A popup inside an existing dialog is one surface, not two competing dialogs.
  const surfaces = [...new Set([...modals, ...linked])];
  const dialogs = surfaces.filter((element) => !surfaces.some((other) => other !== element && within(element, other)));''')
change(f,'  if (!identified && seenGroups.size !== 3) return { ...result, kind: "unrecognized" };','''  const belongsToOpener = [...linked].some((popup) => within(popup, dialog) || within(dialog, popup));
  result.associated = belongsToOpener;
  // Two alternatives are sufficient ONLY with an explicit link from the validated monitor opener.
  // Unlinked/titleless dialogs still require all three security modes.
  if (!identified && seenGroups.size !== 3 && !(belongsToOpener && seenGroups.size >= 2)) {
    return { ...result, kind: "unrecognized" };
  }''')
change(f,'[role="option"],[role="menuitemradio"], [role="tab"]','[role="option"],[role="menuitem"],[role="menuitemradio"], [role="tab"]')
change(f,'  onDiagnostic?: (value: HomeMonitorDialogDiagnostics) => void\n','  onDiagnostic?: (value: HomeMonitorDialogDiagnostics) => void,\n  popupToken?: string\n')
change(f,'modeLabelGroups: modeLabelGroups.map((group) => [...group]), requestedGroup, phase: "select"','modeLabelGroups: scopedHomeMonitorModeGroups(modeLabelGroups), requestedGroup, phase: "select",\n    ...(popupToken ? { popupToken } : {})')
change(f,'        report(last.kind);','        report(`${last.associated ? "linked_" : ""}${last.kind}`);')
f=base+'command-page.ts'
change(f,'        let monitorOpened = false;','        let monitorOpened = false;\n        const popupToken = `hm-popup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;')
change(f,'          monitorOpened, this.#onHomeMonitorDialogDiagnostic','          monitorOpened, this.#onHomeMonitorDialogDiagnostic, monitorOpened ? popupToken : undefined')
change(f,'          modeLabelGroups,\n          budget(1_000)\n        );','          modeLabelGroups,\n          budget(1_000),\n          popupToken\n        );')
change('bridge/src/command/location-rechecks.ts','[first!, first! + 1_000, first! + 3_000, first! + 6_000]','[first!, first! + 1_000, first! + 3_000, first! + 6_000, first! + 9_000, first! + 14_000, first! + 19_000]')
change('custom_components/smartthings_web/alarm_control_panel.py','''        if getattr(result, "status", None) not in {"confirmed", "already_confirmed"}:
            return
        try:''','''        if getattr(result, "status", None) not in {"confirmed", "already_confirmed"}:
            return
        sequence = getattr(result, "sequence", None)
        expected_state = {"armAway": "armed_away", "armStay": "armed_home", "disarm": "disarmed"}.get(command)
        if (
            isinstance(sequence, int)
            and not isinstance(sequence, bool)
            and self.runtime.inventory.sequence >= sequence
            and self.state == expected_state
        ):
            # The verified result has already arrived through SSE. Avoid a redundant full read.
            return
        try:''')
change('custom_components/smartthings_web/tests/test_alarm_control_panel.py','''class SmartThingsWebHomeMonitorTests(unittest.IsolatedAsyncioTestCase):
''','''class SmartThingsWebHomeMonitorTests(unittest.IsolatedAsyncioTestCase):
    async def test_current_confirmed_sse_skips_redundant_inventory_read(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "armed_home"))
        runtime.inventory.sequence = 9
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="confirmed", sequence=9)),
            async_get_inventory=AsyncMock(),
        )
        await SmartThingsWebHomeMonitor(runtime).async_alarm_arm_home()
        runtime.client.async_get_inventory.assert_not_awaited()

    async def test_matching_state_with_older_sequence_still_gets_verified_snapshot(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "armed_home"))
        runtime.inventory.sequence = 8
        latest = BridgeInventory(9, True, "1.8.10", "5", {"loc_001": BridgeLocation("loc_001", "Home", "armed_home")}, {}, {})
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="confirmed", sequence=9)),
            async_get_inventory=AsyncMock(return_value=latest),
        )
        await SmartThingsWebHomeMonitor(runtime).async_alarm_arm_home()
        runtime.client.async_get_inventory.assert_awaited_once()
        self.assertEqual(runtime.inventory.sequence, 9)

''')
change('.github/workflows/validate.yml','          node tools/home-monitor-selector-regression.mjs','          node tools/home-monitor-selector-regression.mjs\n          node tools/ci-home-monitor-linked-popup-smoke.mjs')
for name in ['package.json','package-lock.json','protocol/version.json','custom_components/smartthings_web/manifest.json','addon/smartthings_web_bridge/config.yaml','bridge/src/runtime.ts','tests/addon-config.test.ts','tests/protocol-version-contract.test.ts']:
 p=root/name;s=p.read_text(encoding='utf-8')
 if '1.8.9' not in s:raise SystemExit(f'Missing old version in {name}')
 p.write_text(s.replace('1.8.9','1.8.10'),encoding='utf-8')
notes='''## 1.8.10

- Home Monitor 카드에서 검증한 선택기와 aria-controls/aria-owns/aria-labelledby로 직접 연결된 팝업을 같은 요청 안에서 추적합니다. 제목 없이 현재 모드를 제외한 두 선택지만 표시하는 dialog/listbox/menu도 이 연결이 확인된 경우에만 처리합니다. 연결되지 않은 팝업, 중복 대상, 비활성 제어는 계속 차단합니다.
- Home, Arm home, Armed (Home), 집 표기를 해당 Home Monitor 카드와 검증된 팝업 내부에서만 Stay로 해석합니다. 페이지 전체의 Home 메뉴나 방 이름을 누르는 규칙은 추가하지 않습니다. 실내 전환을 위해 자동으로 먼저 해제하지 않습니다.
- 기본 30초 확인 창의 7초~25초 조회 공백을 보완합니다. 상태 재확인이 활성화된 기본 경로의 조회 시작 목표는 1/2/4/7/10/15/20/25초이며 최대 8개 순차 사이클입니다. 실제 읽기 시간이 길면 늦어질 수 있고 정상 이벤트 수신 즉시 중단합니다. 제어 재전송이나 유휴 폴링은 추가하지 않습니다.
- HA가 완료 응답 이상의 시퀀스와 일치하는 실제 보안 상태를 이미 받았다면 중복 전체 인벤토리 조회를 생략합니다. 아직 뒤처졌다면 기존 1회 조회를 유지합니다. 요청값을 낙관적으로 표시하지 않습니다.
- 기존 외출/해제 직접 클릭, 확인까지 탭 유지, Scene/Advanced commands/speak, 로그인 프로필, 영역 및 개별 스위치, 엔티티 ID는 보존합니다. wire protocol은 5입니다.
- 사용자 오류 로그를 먼저 검토했으나 해당 계정의 최신 Web DOM과 단계별 시간은 확보하지 못했습니다. 선택기 패턴과 기본 조회 공백은 소스/합성 회귀로 검증하며 모든 실계정 모드 성공이나 실제 응답 시간 개선을 보장하지 않습니다.
'''
for name in ['CHANGELOG.md','addon/smartthings_web_bridge/CHANGELOG.md']:
 p=root/name;p.write_text(notes+'\n'+p.read_text(encoding='utf-8'),encoding='utf-8')
for name in ['addon/smartthings_web_bridge/DOCS.md','addon/smartthings_web_bridge/README.md']:
 p=root/name;p.write_text(p.read_text(encoding='utf-8').rstrip()+'\n\n'+notes,encoding='utf-8')
p=root/'docs/HOME_MONITOR_1.8.10.md';p.write_text('# Home Monitor popup selection and latency\n\n'+notes+'\nBridge 앱과 HA 통합을 함께 업데이트합니다. 실제 실패 시 home_monitor_card, home_monitor_diag의 dialog_linked_click 및 home_monitor_command 단계 기록으로 버튼 선택과 서버 상태 확인을 구분합니다. 쿠키나 원본 식별자를 기록하지 않습니다.\n',encoding='utf-8')
p=root/'README.md';s=p.read_text(encoding='utf-8');s=s.replace('현재 버전: Bridge `1.8.9` / HA 통합 `1.8.9`','현재 버전: Bridge `1.8.10` / HA 통합 `1.8.10`');s=s.replace('# HA SmartThings Web\n','# HA SmartThings Web\n\n## 1.8.10 Home Monitor 실내 선택 및 지연 개선\n\n검증된 카드 선택기에 연결된 두 선택지 팝업과 Home/집 표기를 지원하고 기본 상태 재확인 공백과 중복 HA 조회를 줄였습니다. 실제 보안 상태 확인과 기존 제어 경로는 유지합니다. 상세 범위 및 검증 한계는 `docs/HOME_MONITOR_1.8.10.md`를 참조하세요.\n',1);p.write_text(s,encoding='utf-8')
print('Prepared hash-checked 1.8.10 source, regression tests and documentation')
