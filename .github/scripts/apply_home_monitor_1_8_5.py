"""One-time source transformer; normal PR CI and release gates remain mandatory."""
from pathlib import Path
import hashlib
import json
import subprocess

BASE = '12e74619712a31fbe4dae9fe8bbdc581d2ad1664'
OLD, NEW = '1.8.4', '1.8.5'
BLOBS = {
    'bridge/src/command/command-service.ts': '1617fec8a83c208783652f71dff6d46eb39e535d',
    'bridge/src/browser/command-page.ts': '5f926ce8db5d409f48910a2d5e36884a8b6a56ca',
    'bridge/src/runtime.ts': '2b7eb1a9ad320ec6ed7d0dfd15b23d9405046965',
    '.github/workflows/validate.yml': 'fa1de9d0893ad6cd41e633305426991ab911de32',
    'bridge/tests/command/command-service.test.ts': 'cf19c4f25b1dc6dba94738c628fb0a7e2389616c',
}
subprocess.run(['git', 'merge-base', '--is-ancestor', BASE, 'HEAD'], check=True)
texts = {}
for path, expected in BLOBS.items():
    content = Path(path).read_bytes()
    actual = hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()
    if actual != expected:
        raise SystemExit(f'Reviewed source changed: {path}; refusing to overwrite')
    texts[path] = content.decode('utf-8')


def once(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f'{label}: expected one source anchor, got {text.count(old)}')
    return text.replace(old, new, 1)


path = 'bridge/src/browser/command-page.ts'
page = texts[path]
start = page.index('  async executeLocationAction(input: {\n')
end = page.index('  private async openLocationPage(', start)
region = page[start:end]
signature = '    action: "armAway" | "armStay" | "disarm";\n'
if region.count(signature) != 2:
    raise SystemExit('Location action signatures changed')
region = region.replace(signature, signature + '    waitForConfirmation?: () => Promise<void>;\n')
begin = region.index('    try {\n')
ending = '    } finally {\n      await page.close().catch(() => undefined);\n    }\n  }\n\n'
if not region.endswith(ending):
    raise SystemExit('Location cleanup boundary changed')
body = region[begin + len('    try {\n'):-len(ending)]
indented = ''.join('  ' + line if line.strip() else line for line in body.splitlines(keepends=True))
region = (region[:begin] + '    await runLocationCommandSession(\n      async () => {\n' + indented +
          '      },\n      () => page.close(),\n      input.waitForConfirmation\n    );\n  }\n\n')
texts[path] = ('import { runLocationCommandSession } from "../command/location-command-session.js";\n' +
               page[:start] + region + page[end:])

path = 'bridge/src/command/command-service.ts'
service = texts[path]
signature = '''  executeLocationAction?(input: {
    action: LocationAction;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void>;'''
service = once(service, signature,
    signature.replace('  }): Promise<void>;', '    waitForConfirmation?: () => Promise<void>;\n  }): Promise<void>;'),
    'Executor confirmation hook')
service = once(service, '  onPendingCountChange?: (count: number) => void;\n', '''  onLocationDiagnostic?: (diagnostic: {
    phase: "dispatching" | "waiting" | "confirmed" | "failed";
    action: LocationAction;
    elapsedMs: number;
    observedStateMatches: boolean;
    reason?: SafeCommandErrorCode;
  }) => void;
  onPendingCountChange?: (count: number) => void;
''', 'Location diagnostics')
start = service.index('  async #executeLocation(\n')
end = service.index('\n}\n\nfunction validateRequest(', start)
service = service[:start] + '''  async #executeLocation(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    const location = snapshot.locations.find((candidate) => candidate.id === request.targetId);
    if (!location) throw new SafeCommandError("device_not_found");
    const desired = armStateForCommand(request.command);
    if (!desired || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    if (location.armState?.toUpperCase() === desired) return alreadyConfirmed(request.clientRequestId, snapshot.sequence);
    const startedAt = Date.now();
    const timeoutMs = request.timeout === undefined ? this.options.timeoutMs : request.timeout * 1_000;
    const diagnostic = (phase: "dispatching" | "waiting" | "confirmed" | "failed", reason?: SafeCommandErrorCode) => {
      try {
        this.options.onLocationDiagnostic?.({
          phase,
          action: request.command as LocationAction,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          observedStateMatches: this.options.devices.snapshot().locations.some(
            (candidate) => candidate.id === request.targetId && candidate.armState?.toUpperCase() === desired
          ),
          ...(reason ? { reason } : {})
        });
      } catch {
        // Diagnostics must never change a security command's outcome.
      }
    };
    const confirmation = waitForLocationArmState({
      devices: this.options.devices,
      locationId: request.targetId,
      desired,
      afterSequence: snapshot.sequence,
      resync: this.options.resync
    });
    let started = false;
    const waitForConfirmation = async (): Promise<void> => {
      if (!started) {
        started = true;
        diagnostic("waiting");
        confirmation.startTimeout(timeoutMs, this.options.resyncAfterMs);
      }
      await confirmation.result;
    };
    try {
      if (!this.options.executor.executeLocationAction) throw new SafeCommandError("command_execution_failed");
      diagnostic("dispatching");
      await this.options.executor.executeLocationAction({
        action: request.command as LocationAction,
        locationId: request.targetId,
        locationNames,
        waitForConfirmation
      });
      // Compatibility for custom executors that do not own a browser page.
      await waitForConfirmation();
      const evidence = await confirmation.result;
      diagnostic("confirmed");
      return confirmed(request.clientRequestId, evidence.sequence, "security_arm_state_event");
    } catch (error) {
      confirmation.cancel();
      const failure = commandError(error);
      diagnostic("failed", failure.code);
      throw failure;
    }
  }
''' + service[end:]
start = service.index('function waitForLocationArmState(')
end = service.index('\nfunction waitForComponentVector(', start)
waiter = service[start:end]
anchor = '    matches: (event) => event.type === "inventory" && options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired)\n'
waiter = once(waiter, anchor, '''    forceFinalResync: true,
    invalidates: (event) => event.type === "inventory" && !options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired),
''' + anchor, 'Bounded confirmation with contradiction invalidation')
texts[path] = service[:start] + waiter + service[end:]

path = 'bridge/src/runtime.ts'
texts[path] = once(texts[path], '    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),\n', '''    onLocationDiagnostic: (diagnostic) => log.info(
      `home_monitor_command:${diagnostic.phase}:action_${diagnostic.action}` +
      `:matches_${Number(diagnostic.observedStateMatches)}:elapsed_ms_${diagnostic.elapsedMs}` +
      (diagnostic.reason ? `:reason_${diagnostic.reason}` : "")
    ),
    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),
''', 'Diagnostic wiring')
texts[path] = once(texts[path], f'const bridgeVersion = "{OLD}";', f'const bridgeVersion = "{NEW}";', 'Runtime version')
path = '.github/workflows/validate.yml'
texts[path] = once(texts[path], '      - name: Exercise Home Monitor dialogs and dashboard in real Chromium\n',
    '      - name: Verify Home Monitor command-page lifetime\n        run: node --test tools/ci-home-monitor-lifecycle-smoke.mjs\n\n      - name: Exercise Home Monitor dialogs and dashboard in real Chromium\n', 'Lifecycle CI')
texts[path] = once(texts[path], '          node tools/ci-home-monitor-card-smoke.mjs\n',
    '          node tools/ci-home-monitor-card-smoke.mjs\n          node tools/ci-home-monitor-lifecycle-browser-smoke.mjs\n', 'Browser lifecycle CI')

for path, key in [('package.json', 'version'), ('package-lock.json', 'version'),
                  ('protocol/version.json', 'bridge_version'),
                  ('custom_components/smartthings_web/manifest.json', 'version')]:
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if value.get(key) != OLD:
        raise SystemExit(f'{path}: unexpected version')
    value[key] = NEW
    if path == 'package-lock.json':
        if value['packages']['']['version'] != OLD:
            raise SystemExit('Lock root version mismatch')
        value['packages']['']['version'] = NEW
    texts[path] = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
path = 'addon/smartthings_web_bridge/config.yaml'
texts[path] = once(Path(path).read_text(encoding='utf-8'), f'version: {OLD}\n', f'version: {NEW}\n', 'App version')
for path in ['tests/addon-config.test.ts', 'tests/protocol-version-contract.test.ts']:
    text = Path(path).read_text(encoding='utf-8')
    if OLD not in text:
        raise SystemExit(f'{path}: missing version assertions')
    texts[path] = text.replace(OLD, NEW)
path = 'addon/smartthings_web_bridge/CHANGELOG.md'
texts[path] = '''## 1.8.5

- Home Monitor 제어 탭을 클릭 직후 닫던 종료 순서를 수정했습니다. 기존 위치별 보안 상태 확인이 성공하거나 실패할 때까지 명령 탭과 UI 작업 잠금을 유지하고, 결과 확정 후 탭을 정리합니다.
- 클릭이나 HTTP 접수만으로 보안 상태를 성공 처리하지 않습니다. 요청별 timeout을 반영하고, 상태 재조회가 멈춰도 확인 대기가 제한 시간에 종료되도록 했습니다. 확인 전 상태가 다시 달라지면 이전 일치 증거를 무효화합니다.
- `home_monitor_command:`에 실행·대기·확인·실패 단계, 모드, 경과 시간과 현재 상태 일치 여부를 기록합니다. 계정·위치명·식별자·쿠키·토큰은 포함하지 않습니다.
- 실제 Chromium 합성 화면에서 지연된 외출/실내 클릭 처리와 실패 시 정리를 검증하는 영구 CI 및 명령 서비스 회귀 테스트를 추가했습니다. 사용자 Samsung 계정의 Home Monitor 성공은 아직 확인하지 않았습니다.
- 기존 Scene 실행, 로그인 프로필, 엔티티 ID 및 이벤트 폭주 억제는 유지합니다. 버튼 탐색 실패, Scene 확인 타임아웃, HA 자동화 참조 오류 및 Tapo 연결 오류를 모두 해결했다고 주장하지 않습니다.

''' + Path(path).read_text(encoding='utf-8')
path = 'README.md'
text = Path(path).read_text(encoding='utf-8')
text = once(text, '> **현재 상태: `1.8.4` · 실환경 부분 검증**', '> **현재 상태: `1.8.5` · 실환경 부분 검증**', 'README version')
texts[path] = once(text, '## Scene·Advanced Commands·Galaxy Home Mini TTS\n', '''`1.8.5`는 Home Monitor 버튼 클릭 직후 명령 탭을 닫던 종료 순서를 수정하여, 실제 보안 상태 확인이 끝날 때까지 탭을 유지합니다. 요청별 확인 제한 시간과 단계별 진단을 추가했으며 클릭만으로 성공 처리하지 않습니다. 지연된 브라우저 처리와 명령 서비스 테스트는 합성 회귀 검증이고, 사용자 Samsung 계정의 실동작 성공은 아직 확인하지 않았습니다. Scene·로그인·엔티티 ID·이벤트 폭주 억제는 유지합니다.

## Scene·Advanced Commands·Galaxy Home Mini TTS
''', 'README validation scope')

path = 'bridge/tests/command/command-service.test.ts'
texts[path] = 'import { runLocationCommandSession } from "../../src/command/location-command-session.js";\n' + texts[path] + '''

describe("Home Monitor confirmation-owned command lifetime", () => {
  const request = (commandName = "armAway", id = "request_location_lifecycle") => ({
    targetType: "location", targetId: "loc_001", command: commandName,
    arguments: [], clientRequestId: id
  });

  test.each([
    ["armAway", "DISARMED", "ARMED_AWAY"],
    ["armStay", "DISARMED", "ARMED_STAY"],
    ["disarm", "ARMED_AWAY", "DISARMED"]
  ])("keeps %s page alive until a delayed matching security event", async (action, initial, desired) => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, initial, "2026-08-25T00:00:00Z");
    let closed = false;
    const phases: string[] = [];
    const service = new SafeCommandService({
      devices: store, status: connectedStatus(), timeoutMs: 1_000,
      resync: async () => undefined,
      onLocationDiagnostic: (entry) => phases.push(entry.phase),
      executor: { executeLocationAction: async (input) => runLocationCommandSession(
        async () => {
          setTimeout(() => {
            if (!closed) store.observe(received(securityEventFrame(desired, "2026-08-25T00:00:01Z")));
          }, 25);
        },
        async () => { closed = true; }, input.waitForConfirmation
      ) }
    });
    await expect(service.execute(request(action))).resolves.toMatchObject({
      status: "confirmed", confirmation: "security_arm_state_event"
    });
    expect(closed).toBe(true);
    expect(phases).toEqual(["dispatching", "waiting", "confirmed"]);
  });

  test("request timeout bounds a hung recheck and closes the page", async () => {
    vi.useFakeTimers();
    try {
      const store = readyDeviceStore();
      observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
      let closed = false;
      const service = new SafeCommandService({
        devices: store, status: connectedStatus(), timeoutMs: 5_000, resyncAfterMs: 10,
        resync: async () => new Promise<undefined>(() => undefined),
        executor: { executeLocationAction: async (input) => runLocationCommandSession(
          async () => {}, async () => { closed = true; }, input.waitForConfirmation
        ) }
      });
      const checked = expect(service.execute({ ...request(), timeout: 1 })).rejects.toMatchObject({
        code: "command_confirmation_timeout"
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await checked;
      expect(closed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test("does not confirm contradicted evidence observed during dispatch", async () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    const service = new SafeCommandService({
      devices: store, status: connectedStatus(), timeoutMs: 25, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => runLocationCommandSession(
        async () => {
          store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
          store.observe(received(securityEventFrame("DISARMED", "2026-08-25T00:00:02Z")));
        }, async () => {}, input.waitForConfirmation
      ) }
    });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
  });

  test("wrong-location security traffic cannot confirm the request", async () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    const service = new SafeCommandService({
      devices: store, status: connectedStatus(), timeoutMs: 25, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => runLocationCommandSession(
        async () => store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z").replaceAll("loc_001", "loc_999"))),
        async () => {}, input.waitForConfirmation
      ) }
    });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
  });

  test("dispatch failure closes once and keeps the original error", async () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    let closes = 0;
    const phases: string[] = [];
    const service = new SafeCommandService({
      devices: store, status: connectedStatus(), timeoutMs: 25, resync: async () => undefined,
      onLocationDiagnostic: entry => phases.push(entry.phase),
      executor: { executeLocationAction: async (input) => runLocationCommandSession(
        async () => { throw new Error("command_control_not_found"); },
        async () => { closes++; }, input.waitForConfirmation
      ) }
    });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_control_not_found" });
    expect(closes).toBe(1);
    expect(phases).toEqual(["dispatching", "failed"]);
  });
});
'''

for path, text in texts.items():
    Path(path).write_text(text, encoding='utf-8', newline='\n')
print(f'Applied {len(texts)} reviewed file changes for {NEW}; normal CI must validate before release.')
