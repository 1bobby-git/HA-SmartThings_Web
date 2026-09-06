"""One-time exact-context source assembly; removed after candidate validation."""
from pathlib import Path
import json
import re

pending = {}
def replace(path, old, new):
    text = pending.get(path, Path(path).read_text(encoding="utf-8"))
    if text.count(old) != 1:
        raise SystemExit(f"Source context mismatch: {path}: {old[:100]!r}")
    pending[path] = text.replace(old, new)

service = "bridge/src/command/command-service.ts"
replace(service, 'import { enqueueWithDeadline } from "./bounded-command-queue.js";', 'import { enqueueWithDeadline } from "./bounded-command-queue.js";\nimport { boundedLocationRead, scheduleLocationRechecks } from "./location-rechecks.js";')
replace(service, '    if (normalizeLocationArmState(location.armState) === desired) return alreadyConfirmed(request.clientRequestId, snapshot.sequence);', '''    if (normalizeLocationArmState(location.armState) === desired) {
      // A cached match is not proof: a missed push can leave the previous mode here.
      const readStarted = Date.now();
      const evidence = await boundedLocationRead(() => this.options.resync({ locationId: request.targetId }));
      if (evidence?.source === "location_status" && evidence.locationId === request.targetId &&
          evidence.startedAtMs >= readStarted && normalizeLocationArmState(evidence.armState) === desired &&
          normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState) === desired) {
        return alreadyConfirmed(request.clientRequestId, this.options.devices.currentSequence());
      }
    }
    const initialLocation = this.options.devices.location(request.targetId);
    const initialSequence = this.options.devices.currentSequence();''')
replace(service, '''      afterSequence: snapshot.sequence,
      resync: () => this.options.resync({ locationId: request.targetId })''', '''      afterSequence: initialSequence,
      resync: () => this.options.resync({ locationId: request.targetId })''')
replace(service, '        isDesiredStateCurrent: () => normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState) === desired', '''        isDesiredStateCurrent: () => {
          const current = this.options.devices.location(request.targetId);
          return normalizeLocationArmState(current?.armState) === desired &&
            (current?.armState !== initialLocation?.armState || current?.updatedAt !== initialLocation?.updatedAt);
        }''')
replace(service, '''    forceFinalResync: true,
    invalidates: (event) => event.type === "inventory" && !matches(),''', '''    forceFinalResync: true,
    boundedLocationRechecks: true,
    invalidates: (event) => event.type === "inventory" && !matches(),''')
replace(service, 'stabilityMs?: number; forceFinalResync?: boolean }): ConfirmationWait {', 'stabilityMs?: number; forceFinalResync?: boolean; boundedLocationRechecks?: boolean }): ConfirmationWait {')
replace(service, '  let finalResyncTimer: NodeJS.Timeout | undefined;', '  let finalResyncTimer: NodeJS.Timeout | undefined;\n  let stopLocationRechecks: (() => void) | undefined;')
replace(service, '    if (finalResyncTimer) clearTimeout(finalResyncTimer);', '    if (finalResyncTimer) clearTimeout(finalResyncTimer);\n    stopLocationRechecks?.();')
replace(service, '''      if (options.forceFinalResync === true) {
        const finalLeadMs''', '''      if (options.boundedLocationRechecks === true) {
        stopLocationRechecks = scheduleLocationRechecks(
          () => resyncAndCheck(minResyncStartedAtMs, true),
          { timeoutMs, ...(hasEarlyResync ? { firstDelayMs: resyncAfterMs } : {}) }
        );
        timer = setTimeout(() => {
          timer = undefined;
          if (settled) return;
          cleanup();
          rejectResult(new SafeCommandError("command_confirmation_timeout"));
        }, timeoutMs);
        return;
      }
      if (options.forceFinalResync === true) {
        const finalLeadMs''')
replace(service, '''function waitForLocationArmState(options: { devices: DeviceStore; locationId: string; desired: string; afterSequence: number; resync: CommandResync }): ConfirmationWait {
  const matches = () => normalizeLocationArmState(options.devices.location(options.locationId)?.armState) === options.desired;''', '''function waitForLocationArmState(options: { devices: DeviceStore; locationId: string; desired: string; afterSequence: number; resync: CommandResync }): ConfirmationWait {
  const before = options.devices.location(options.locationId);
  const matches = () => normalizeLocationArmState(options.devices.location(options.locationId)?.armState) === options.desired;
  const changed = () => {
    const current = options.devices.location(options.locationId);
    return current?.armState !== before?.armState || current?.updatedAt !== before?.updatedAt;
  };''')
replace(service, '    matches: (event) => event.type === "inventory" && matches(),', '    matches: (event) => event.type === "inventory" && changed() && matches(),')

store = "bridge/src/state/device-store.ts"
replace(store, '  observeLocationStatusSnapshot(input: unknown, expectedLocationId: string): boolean {', '''  observeLocationStatusSnapshot(input: unknown, expectedLocationId: string,
    proof?: { before: BridgeLocation; undatedConfirmed: boolean }): boolean {''')
replace(store, '''    const updatedAt = validTimestamp(row?.updatedAt ?? row?.updated_at ?? row?.timestamp);
    // A dated event''', '''    const updatedAt = validTimestamp(row?.updatedAt ?? row?.updated_at ?? row?.timestamp);
    // Discard a read overtaken by another security observation, including an ABA change.
    if (proof && (proof.before.id !== id || proof.before.armState !== current.armState ||
        proof.before.updatedAt !== current.updatedAt)) return false;
    // A dated event''')
replace(store, '''    // An undated read may confirm the current state, but cannot replace a dated contrary event.
    if (current.updatedAt && !updatedAt) {
      return normalizeLocationArmState(current.armState) === normalizeLocationArmState(armState);
    }
    const next: BridgeLocation = { ...current, armState: armState!, updatedAt };''', '''    // Only two agreeing, fresh exact-location reads may repair a missed dated push.
    // The ordinary snapshot path has no proof and retains its strict ordering checks.
    if (current.updatedAt && !updatedAt) {
      if (normalizeLocationArmState(current.armState) === normalizeLocationArmState(armState)) return true;
      if (proof?.undatedConfirmed !== true) return false;
    }
    const next: BridgeLocation = { ...current, armState: armState!,
      // Keep the last upstream timestamp as the replay watermark, not a fabricated new time.
      updatedAt: updatedAt ?? current.updatedAt ?? null };''')

runtime = "bridge/src/runtime.ts"
replace(runtime, 'import { readLocationSecurityStatus } from "./browser/location-status.js";', 'import { readLocationSecurityStatus } from "./browser/location-status.js";\nimport { verifyLocationRead } from "./state/location-read-proof.js";')
replace(runtime, '''        const observed = await readLocationSecurityStatus(keeper, rawLocationId);
        if (!observed) {
          log.info("home_monitor_command:status_read_unavailable");
          throw new Error("location_status_unavailable");
        }
        // The exact raw ID has been checked by the reader. Do not expose it or copy names.
        const accepted = devices.observeLocationStatusSnapshot({
          locationId: request.locationId, armState: observed.armState, updatedAt: observed.updatedAt
        }, request.locationId);''', '''        const before = devices.location(request.locationId);
        const checked = await verifyLocationRead(
          () => readLocationSecurityStatus(keeper, rawLocationId), rawLocationId, before
        );
        if (!checked || !before) {
          log.info("home_monitor_command:status_read_unavailable");
          throw new Error("location_status_unavailable");
        }
        const { observed, undatedConfirmed } = checked;
        // Exact raw IDs remain browser-local. Compare against the pre-read observation.
        const accepted = devices.observeLocationStatusSnapshot({
          locationId: request.locationId, armState: observed.armState, updatedAt: observed.updatedAt
        }, request.locationId, { before, undatedConfirmed });''')

alarm = "custom_components/smartthings_web/alarm_control_panel.py"
replace(alarm, 'from homeassistant.components.alarm_control_panel import (', 'import asyncio\nimport logging\n\nfrom homeassistant.components.alarm_control_panel import (')
replace(alarm, '            await self.runtime.client.async_execute_command(', '            result = await self.runtime.client.async_execute_command(')
replace(alarm, '''        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err''', '''        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err
        if getattr(result, "status", None) not in {"confirmed", "already_confirmed"}:
            return
        try:
            # One post-command read closes the SSE delivery race; never set a requested mode.
            # A delayed read cannot overwrite a newer snapshot (apply_inventory checks sequence).
            async with asyncio.timeout(3):
                latest = await self.runtime.client.async_get_inventory()
            self.runtime.apply_inventory(latest)
        except (BridgeClientError, TimeoutError):
            logging.getLogger(__name__).warning(
                "Home Monitor command confirmed; immediate inventory read unavailable, waiting for Bridge events"
            )''')

replace("bridge/tests/command/location-command-session.test.ts", '''    await f.service.execute(request("request_first_arm"));
    await expect(f.service.execute(request("request_second_arm"))).resolves.toMatchObject({ status: "already_confirmed" });
    expect(f.execute).toHaveBeenCalledOnce();''', '''    await f.service.execute(request("request_first_arm"));
    f.resync.mockImplementation(async () => ({ source: "location_status", locationId: "loc_001", armState: "ARMED_AWAY",
      authoritativeSnapshot: false, startedAtMs: Date.now() }));
    await expect(f.service.execute(request("request_second_arm"))).resolves.toMatchObject({ status: "already_confirmed" });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.resync).toHaveBeenCalledOnce();''')

old = 'class SmartThingsWebHomeMonitorTests(unittest.IsolatedAsyncioTestCase):\n    """Map location arm state to HA alarm state and exact arm commands."""'
replace("custom_components/smartthings_web/tests/test_alarm_control_panel.py", old, old + '''

    async def test_confirmed_command_fetches_real_snapshot_without_waiting_for_sse(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "disarmed"))
        latest = BridgeInventory(2, True, "1.8.9", "5", {"loc_001": BridgeLocation("loc_001", "Home", "armed_home")}, {}, {})
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="confirmed")),
            async_get_inventory=AsyncMock(return_value=latest),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "armed_home")
        runtime.client.async_get_inventory.assert_awaited_once()

    async def test_snapshot_failure_does_not_turn_a_confirmed_command_into_failure(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "disarmed"))
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="confirmed")),
            async_get_inventory=AsyncMock(side_effect=BridgeClientError("bridge_request_failed")),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "disarmed", "never assign the requested state optimistically")

    async def test_unconfirmed_receipt_does_not_trigger_snapshot_or_optimistic_state(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "disarmed"))
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="accepted_unconfirmed")),
            async_get_inventory=AsyncMock(),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "disarmed")
        runtime.client.async_get_inventory.assert_not_awaited()

    async def test_delayed_snapshot_cannot_overwrite_a_newer_push(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "armed_away"))
        runtime.inventory.sequence = 5
        stale = BridgeInventory(4, True, "1.8.9", "5", {"loc_001": BridgeLocation("loc_001", "Home", "armed_home")}, {}, {})
        runtime.client = SimpleNamespace(
            async_execute_command=AsyncMock(return_value=SimpleNamespace(status="confirmed")),
            async_get_inventory=AsyncMock(return_value=stale),
        )
        entity = SmartThingsWebHomeMonitor(runtime)
        await entity.async_alarm_arm_home()
        self.assertEqual(entity.state, "armed_away")
''')

version_paths = ["package.json", "package-lock.json", "protocol/version.json", "custom_components/smartthings_web/manifest.json", "addon/smartthings_web_bridge/config.yaml", "bridge/src/runtime.ts", "tests/addon-config.test.ts", "tests/protocol-version-contract.test.ts"]
for path in version_paths:
    text = pending.get(path, Path(path).read_text(encoding="utf-8"))
    if "1.8.8" not in text:
        raise SystemExit(f"Unexpected base version: {path}")
    pending[path] = text.replace("1.8.8", "1.8.9")

notes = '''## 1.8.9

- Home Monitor가 캐시된 모드와 같다는 이유만으로 명령을 생략하지 않습니다. 해당 위치의 새 상태 조회로 확인된 경우에만 이미 적용된 상태로 처리합니다.
- Push 누락 시 명령 대기 중에만 최대 5회의 순차적 상태 확인을 수행합니다. 정상 이벤트 수신 시 즉시 중단하고, 동시 조회·무제한 재시도·제어 명령 재전송은 하지 않습니다. 기본 15초 확인 창에서 조회 시작 목표는 1·2·4·7·10초이며 실제 처리시간에 따라 늦어질 수 있습니다.
- 날짜 없는 반대 상태는 같은 위치에서 새로 수행한 두 번의 조회가 일치하고 조회 도중 더 최신 상태가 들어오지 않은 경우에만 반영합니다. 서버 시각을 만들어 넣지 않고, 일반 스냅샷의 오래된 상태·다른 위치·중간 상태 차단을 유지합니다.
- 명령 완료 후 HA가 실제 Bridge 인벤토리를 한 번 즉시 읽어 SSE 갱신을 기다리던 구간을 보완합니다. 요청 모드를 낙관적으로 표시하지 않으며, 늦게 도착한 이전 시퀀스는 거부합니다.
- 기존 Home Monitor 직접 버튼·선택기·탭 유지, Scene·Advanced commands·speak, 방 연결·개별 스위치·로그인 프로필·엔티티 ID는 보존합니다. protocol 5를 유지합니다.
- 새 회귀 검사에는 누락 Push, 캐시 기반 잘못된 no-op, 다른 위치의 증거, 진행 중 조회 경합, 취소·상한, HA의 완료 후 상태 반영이 포함됩니다. 합성 검사와 실제 Samsung 계정의 성공률·서버 지연은 별개입니다.

'''
for path in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    text = Path(path).read_text(encoding="utf-8")
    if "## 1.8.9" in text:
        raise SystemExit(f"Duplicate version section: {path}")
    pending[path] = notes + text

readme = Path("README.md").read_text(encoding="utf-8")
readme = re.sub(r'(현재 버전: Bridge `)[^`]+(` / HA 통합 `)[^`]+(`)', r'\g<1>1.8.9\g<2>1.8.9\g<3>', readme, count=1)
heading = "# HA SmartThings Web\n"
if heading not in readme:
    raise SystemExit("README heading missing")
pending["README.md"] = readme.replace(heading, heading + "\n## 1.8.9 Home Monitor 상태 전달 개선\n\n캐시된 모드의 재확인, Push 누락 시 제한된 순차 조회, 날짜 없는 상태의 교차 확인 및 명령 완료 후 HA 상태 갱신을 보완했습니다. 제어 명령을 반복 전송하거나 요청값으로 상태를 덮어쓰지 않습니다. 변경 범위와 검증 한계는 `docs/HOME_MONITOR_1.8.9.md`를 참조하세요.\n", 1)
pending["docs/HOME_MONITOR_1.8.9.md"] = "# Home Monitor 1.8.9\n\n" + notes + '''## 증거와 적용 범위

작업 전 사용자 제공 Bridge/Core 로그를 확인했습니다. 해당 로그에서 외출은 2.726초, 해제는 6.014초에 확인됐고 당시 실내 실패는 선택기 단계였습니다. 이번 1.8.9의 작업 시점에는 새로운 실환경 상세 로그가 추가되지 않았으므로, 상태 누락의 전체 원인을 확정하거나 사용자 계정에서 개선된 시간을 측정했다고 주장하지 않습니다. 이번 수정은 1.8.8 소스에서 재현한 상태 검증·전달 경로의 결함을 대상으로 합니다.

Bridge 앱과 HA 통합을 모두 업데이트하고 기존 설치·기기·로그인 프로필은 유지합니다. 확인 대기시간만 늘린 버전이 아닙니다. Push가 정상 도착하면 기존처럼 바로 확인하며 보완 조회는 중단됩니다. 상태 조회는 기존 로그인된 웹 서비스의 읽기 경로만 사용합니다.

불일치나 서버 응답 지연이 계속되면 `home_monitor_command:dispatching/waiting/confirmed/failed`, `status_read_completed/unavailable`, `home_monitor_dispatch_ms_*` 기록으로 클릭과 확인 대기를 구분합니다. 쿠키·토큰·원본 위치 식별자를 진단에 추가하지 않습니다.
'''
for path in ["addon/smartthings_web_bridge/README.md", "addon/smartthings_web_bridge/DOCS.md"]:
    pending[path] = Path(path).read_text(encoding="utf-8") + "\n\n" + notes

# All source/version contexts are checked before the first write.
for path, text in pending.items():
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
print(f"Prepared {len(pending)} source/documentation files for 1.8.9")
