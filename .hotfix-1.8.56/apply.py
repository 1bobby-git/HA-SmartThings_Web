"""Apply the reviewed switch hotfix to an immutable checkout; no Git/network writes."""
from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1]).resolve()
payload = Path(__file__).resolve().parent
base = {
    'bridge/src/command/light-status-recheck.ts': '20302790f745e01e63d9359aadb4eaccfa3e7e3f',
    'bridge/src/command/command-service.ts': '27a0c7735602e38224cb020b8c35d8e04ced712f',
    'bridge/src/state/device-store.ts': '5b1ed4705c05c54f3eb4c6cc3abb555320042a30',
    'bridge/src/runtime.ts': '9f147d690eab71e80620aa91b00511e44cd9d6ca',
    'bridge/tests/command/command-service.test.ts': '439fbbcd3e9b1d935ad6dcf81449b31d1b5fc75f',
}
texts = {}
for name, expected in base.items():
    data = (root / name).read_bytes()
    actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    if actual != expected:
        raise SystemExit(f'Baseline differs: {name}; no files changed')
    texts[name] = data.decode()

def replace(name, old, new, count=1):
    if texts[name].count(old) != count:
        raise SystemExit(f'Unexpected patch context: {name}; no files changed')
    texts[name] = texts[name].replace(old, new)

service = 'bridge/src/command/command-service.ts'
replace(service, '  lightComponent?: string;\n}', '  lightComponent?: string;\n  /** Internal, exact on/off state binding; never accepted from the HTTP request body. */\n  switchTarget?: Pick<BridgeDeviceState, "component" | "capability">;\n}')
replace(service, 'matches?: boolean; code?: string;', 'matches?: boolean; cacheMatches?: boolean; observedUpdatedAt?: string | null; cachedUpdatedAt?: string | null; code?: string;', 2)
replace(service, '    if (request.command === "applyLight") return await this.#executeLight(request, device, signal);\n    const deviceStartedAt = Date.now();', '    if (request.command === "applyLight") return await this.#executeLight(request, device, signal);\n    // A timed-out previous request may still have a GET in flight. Retire its proof.\n    this.options.devices.beginDeviceCommand(device.id);\n    const deviceStartedAt = Date.now();')
replace(service, '    let receiptCommandId: string | undefined;', '''    const switchTarget = attribute === "switch" && (desired === "on" || desired === "off") &&
      ["on", "off"].includes(effective.nativeCommand ?? effective.command)
      ? { component: executionInput.component, capability: executionInput.capability }
      : undefined;
    let receiptCommandId: string | undefined;''')
replace(service, '''          const evidence = await this.options.resync({ deviceId: effective.targetId });
          const candidates = evidence?.observedStates?.filter((candidate) =>
            candidate.component === effective.component && candidate.capability === effective.capability && candidate.attribute === attribute) ?? [];
          this.#deviceDiagnostic(effective, "read", deviceStartedAt, { stateCount: candidates.length,
            matches: candidates.length === 1 && matchesValue(candidates[0]!.value, desired) });
          return evidence;''', '''          const evidence = await this.options.resync({ deviceId: effective.targetId,
            ...(switchTarget ? { switchTarget } : {}) });
          const candidates = evidence?.observedStates?.filter((candidate) =>
            candidate.component === effective.component && candidate.capability === effective.capability && candidate.attribute === attribute) ?? [];
          const cached = this.options.devices.commandState(effective.targetId, device.locationId,
            executionInput.component, executionInput.capability, attribute);
          this.#deviceDiagnostic(effective, "read", deviceStartedAt, { stateCount: candidates.length,
            matches: candidates.length === 1 && matchesValue(candidates[0]!.value, desired),
            cacheMatches: cached !== undefined && matchesValue(cached.value, desired),
            observedUpdatedAt: candidates.length === 1 ? candidates[0]!.updatedAt : null,
            cachedUpdatedAt: cached?.updatedAt ?? null });
          return evidence;''')
replace('bridge/src/state/device-store.ts', '''  /** Invalidate older read proofs when a newer light intent begins dispatching. */
  beginLightCommand(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device) this.#commandReadRevisions.set(device, (this.#commandReadRevisions.get(device) ?? 0) + 1);
  }''', '''  /** Invalidate detached status proofs before a newer device operation. */
  beginDeviceCommand(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device) this.#commandReadRevisions.set(device, (this.#commandReadRevisions.get(device) ?? 0) + 1);
  }

  /** Preserve the existing light entry point and its shared per-device revision. */
  beginLightCommand(deviceId: string): void {
    this.beginDeviceCommand(deviceId);
  }''')
replace('bridge/src/runtime.ts', '          }, request.lightComponent);', '          }, request.lightComponent, request.switchTarget);')
texts['bridge/src/command/light-status-recheck.ts'] = (payload / 'light-status-recheck.ts').read_text()
new_test = 'bridge/tests/command/switch-status-recheck.test.ts'
if (root / new_test).exists():
    raise SystemExit('New test already exists; no files changed')
texts[new_test] = (payload / 'switch-status-recheck.test.ts').read_text()
addition = (payload / 'service-regression.insert.ts').read_text()
anchor = 'describe("SafeCommandService", () => {\n'
replace('bridge/tests/command/command-service.test.ts', anchor, anchor + ''.join('  ' + line if line.strip() else line for line in addition.splitlines(keepends=True)) + '\n')
for name in ['package.json', 'package-lock.json', 'custom_components/smartthings_web/manifest.json']:
    text = (root / name).read_text()
    data = json.loads(text)
    if data.get('version') != '1.8.55':
        raise SystemExit(f'Unexpected version: {name}; no files changed')
    texts[name] = text.replace('"version": "1.8.55"', '"version": "1.8.56"')
config = 'addon/smartthings_web_bridge/config.yaml'
text = (root / config).read_text()
if text.count('version: 1.8.55\n') != 1:
    raise SystemExit('Unexpected add-on version; no files changed')
texts[config] = text.replace('version: 1.8.55\n', 'version: 1.8.56\n')
replace('bridge/src/runtime.ts', 'const bridgeVersion = "1.8.55";', 'const bridgeVersion = "1.8.56";')
notes = '''일반 스위치의 상태 조회값이 요청과 일치하지만 내부 캐시가 이전 값으로 남아 `command_confirmation_timeout`이 발생하는 확인 경로를 수정합니다.

- 타임스탬프가 없거나 기존 값과 같은 스위치 응답은 정확히 같은 대상에 대한 연속 두 번의 상태 조회가 일치할 때만 보정합니다.
- 다른 기기·채널·속성, 더 오래된 응답, 조회 중 새 명령이나 이벤트가 발생한 경우에는 예외 보정을 허용하지 않습니다.
- `cacheMatches`, `observedUpdatedAt`, `cachedUpdatedAt` 진단 항목과 실제 DeviceStore/명령 서비스 회귀 테스트를 추가합니다.
- HTTP 200만으로 성공 처리하거나 제어 명령을 자동 재전송하지 않으며 기존 시간 제한과 상태 확인 정책을 유지합니다.

GitHub CI 검증과 실제 사용자 기기의 제어 검증은 구분됩니다. 사용자 HA 서버 설치 및 실제 기기 동작은 별도 확인이 필요합니다.
'''
for name in ['CHANGELOG.md', 'addon/smartthings_web_bridge/CHANGELOG.md']:
    text = (root / name).read_text()
    position = text.find('\n## ')
    if position < 0:
        raise SystemExit(f'Unexpected changelog: {name}; no files changed')
    texts[name] = text[:position] + '\n## 1.8.56\n\n' + notes + '\n' + text[position:]
texts['release-notes/1.8.56.md'] = notes
for name, text in texts.items():
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
print(f'Applied {len(texts)} source/test/version/document changes')
