from pathlib import Path
import json
import re

VERSION = "1.8.5"
PREVIOUS = "1.8.4"


def read(path):
    return Path(path).read_text(encoding="utf-8")


def write(path, value):
    Path(path).write_text(value, encoding="utf-8")


def once(value, old, new, label):
    if value.count(old) != 1:
        raise SystemExit(f"{label}: expected one anchor, got {value.count(old)}")
    return value.replace(old, new, 1)


path = "bridge/src/browser/command-page.ts"
text = read(path)
scene_start = text.index("  async #executeScene(")
location_start = text.index("  async executeLocationAction(")
original_scene = text[scene_start:location_start]
end = text.index("\n  private async openLocationPage(", location_start)
block = text[location_start:end]
signature = '    action: "armAway" | "armStay" | "disarm";\n'
assert block.count(signature) == 2
block = block.replace(signature, signature + '    waitForConfirmation?: () => Promise<void>;\n    confirmationTimeoutMs?: number;\n')
block = once(block, "      let monitorOpened = false;", '''      const finishInteraction = () => finishHomeMonitorInteraction(page, {
        monitorLabels,
        modeLabelGroups,
        requestedGroup: { armAway: 0, armStay: 1, disarm: 2 }[input.action],
        ...(input.waitForConfirmation ? { waitForConfirmation: input.waitForConfirmation } : {}),
        ...(input.confirmationTimeoutMs === undefined ? {} : { confirmationTimeoutMs: input.confirmationTimeoutMs }),
        ...(this.#onDiagnostic ? { diagnostic: this.#onDiagnostic } : {})
      });
      let monitorOpened = false;''', "location completion helper")
block, count = re.subn(r'if \((dashboardResult|modalResult|textResult) === "clicked"\) return;',
    r'if (\1 === "clicked") { await finishInteraction(); return; }', block)
assert count == 6, f"success branches: {count}"
block, count = re.subn(r'(?P<indent> +)await action\.click\(\{ timeout: 15_000 \}\);\n(?P=indent)return;',
    r'\g<indent>await action.click({ timeout: 15_000 });\n\g<indent>await finishInteraction();\n\g<indent>return;', block)
assert count == 5, f"locator branches: {count}"
block = once(block,
    '      if (await clickHomeMonitorCardActionByText(page, monitorLabels, actionLabels)) return;',
    '      if (await clickHomeMonitorCardActionByText(page, monitorLabels, actionLabels)) { await finishInteraction(); return; }',
    "text action branch")
text = text[:location_start] + block + text[end:]
text = 'import { finishHomeMonitorInteraction, type HomeMonitorLifecycleStage } from "./home-monitor-post-action.js";\n' + text
text = once(text, "type CommandDiagnosticStage =\n", "type CommandDiagnosticStage =\n  | HomeMonitorLifecycleStage\n", "diagnostic union")
assert original_scene == text[text.index("  async #executeScene("):text.index("  async executeLocationAction(")]
write(path, text)

path = "bridge/src/command/command-service.ts"
text = read(path)
text = once(text, '''  executeLocationAction?(input: {
    action: LocationAction;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void>;''', '''  executeLocationAction?(input: {
    action: LocationAction;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    /** Await after the UI action, before closing its browser page. */
    waitForConfirmation?: () => Promise<void>;
    confirmationTimeoutMs?: number;
  }): Promise<void>;''', "executor completion contract")
text = once(text, '  onPendingCountChange?: (count: number) => void;\n', '''  onPendingCountChange?: (count: number) => void;
  onLocationDiagnostic?: (event: {
    stage: "dispatch" | "waiting" | "confirmed" | "timed_out" | "failed";
    action: string;
    observed: string;
    timeoutMs: number;
    sequence: number;
  }) => void;
''', "location diagnostics option")
start = text.index("  async #executeLocation(\n")
end = text.index("\n}\n\nfunction validateRequest", start)
text = text[:start] + '''  async #executeLocation(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    const location = snapshot.locations.find((candidate) => candidate.id === request.targetId);
    if (!location) throw new SafeCommandError("device_not_found");
    const desired = armStateForCommand(request.command);
    if (!desired || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    if (location.armState?.toUpperCase() === desired) return alreadyConfirmed(request.clientRequestId, snapshot.sequence);
    const timeoutMs = request.timeout === undefined ? this.options.timeoutMs : request.timeout * 1_000;
    const diagnostic = (stage: "dispatch" | "waiting" | "confirmed" | "timed_out" | "failed") => {
      const current = this.options.devices.snapshot();
      const value = current.locations.find((item) => item.id === request.targetId)?.armState?.toUpperCase();
      const observed = value && ["ARMED_AWAY", "ARMED_STAY", "DISARMED"].includes(value) ? value : "UNKNOWN";
      try {
        this.options.onLocationDiagnostic?.({ stage, action: request.command, observed,
          timeoutMs, sequence: current.sequence });
      } catch { /* Diagnostics must never change a security command. */ }
    };
    // Subscribe before interaction. Fast events are held until interaction is marked complete.
    const confirmation = waitForLocationArmState({
      devices: this.options.devices,
      locationId: request.targetId,
      desired,
      afterSequence: snapshot.sequence,
      resync: this.options.resync
    });
    let waiting = false;
    const waitForConfirmation = async (): Promise<void> => {
      if (!waiting) {
        waiting = true;
        diagnostic("waiting");
        confirmation.startTimeout(timeoutMs, this.options.resyncAfterMs);
      }
      await confirmation.result;
    };
    diagnostic("dispatch");
    try {
      if (!this.options.executor.executeLocationAction) throw new SafeCommandError("command_execution_failed");
      await this.options.executor.executeLocationAction({
        action: request.command as LocationAction,
        locationId: request.targetId,
        locationNames,
        waitForConfirmation,
        confirmationTimeoutMs: timeoutMs
      });
      // Compatibility for other executors that return a receipt without consuming the hook.
      await waitForConfirmation();
    } catch (error) {
      confirmation.cancel();
      diagnostic(error instanceof Error && error.message === "command_confirmation_timeout" ? "timed_out" : "failed");
      throw commandError(error);
    }
    diagnostic("confirmed");
    return confirmed(request.clientRequestId, (await confirmation.result).sequence, "security_arm_state_event");
  }
''' + text[end:]
start = text.index("function waitForLocationArmState(")
end = text.index("\nfunction waitForComponentVector(", start)
text = text[:start] + '''function waitForLocationArmState(options: { devices: DeviceStore; locationId: string; desired: string; afterSequence: number; resync: CommandResync }): ConfirmationWait {
  const matches = () => options.devices.snapshot().locations.some((location) =>
    location.id === options.locationId && location.armState?.toUpperCase() === options.desired);
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => event.type === "inventory" && matches(),
    invalidates: (event) => event.type === "inventory" && !matches(),
    // Keep a hard deadline even if a refresh hangs. A refresh receipt alone is never proof.
    forceFinalResync: true
  });
}
''' + text[end:]
write(path, text)

path = "bridge/src/runtime.ts"
text = read(path)
text = once(text, '    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),', '''    onLocationDiagnostic: (event) => log.info(
      `home_monitor_confirmation:${event.stage}:action_${event.action}` +
      `:observed_${event.observed}:timeout_ms_${event.timeoutMs}:sequence_${event.sequence}`
    ),
    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),''', "runtime diagnostics")
text = once(text, f'const bridgeVersion = "{PREVIOUS}";', f'const bridgeVersion = "{VERSION}";', "runtime version")
write(path, text)

path = "bridge/tests/command/command-service.test.ts"
text = read(path)
text += '''

describe("Home Monitor confirmation lifetime", () => {
  const request = (id: string) => ({ targetType: "location", targetId: "loc_001",
    command: "armAway", arguments: [], clientRequestId: id });
  const initialStore = () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    return store;
  };

  test("passes a completion hook that waits for a delayed security event", async () => {
    const store = initialStore();
    let hookUsed = false;
    let evidenceReceived = false;
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 1_000, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => {
        expect(input.waitForConfirmation).toBeTypeOf("function");
        expect(input.confirmationTimeoutMs).toBe(1_000);
        const timer = setTimeout(() => {
          evidenceReceived = true;
          store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
        }, 20);
        try {
          await input.waitForConfirmation!();
          hookUsed = true;
          expect(evidenceReceived).toBe(true);
        } finally { clearTimeout(timer); }
      } }
    });
    await expect(service.execute(request("request_hm_delayed"))).resolves.toMatchObject({
      status: "confirmed", confirmation: "security_arm_state_event" });
    expect(hookUsed).toBe(true);
  });

  test("retains a fast in-click event until the hook starts", async () => {
    const store = initialStore();
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 100, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => {
        store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
        await input.waitForConfirmation!();
      } }
    });
    await expect(service.execute(request("request_hm_fast"))).resolves.toMatchObject({ status: "confirmed" });
  });

  test("does not accept a security event contradicted before UI completion", async () => {
    const store = initialStore();
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 30, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => {
        store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
        store.observe(received(securityEventFrame("DISARMED", "2026-08-25T00:00:02Z")));
        await input.waitForConfirmation!();
      } }
    });
    await expect(service.execute(request("request_hm_contradicted"))).rejects.toMatchObject({ code: "command_confirmation_timeout" });
  });

  test("has a hard deadline when the status resync never finishes", async () => {
    const store = initialStore();
    const resync = vi.fn(() => new Promise<CommandResyncEvidence | undefined>(() => undefined));
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 30, resyncAfterMs: 0, resync,
      executor: { executeLocationAction: async (input) => { await input.waitForConfirmation!(); } }
    });
    await expect(service.execute(request("request_hm_hung_resync"))).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(resync).toHaveBeenCalled();
  });

  test("honors the request deadline and isolates diagnostic failures", async () => {
    const store = initialStore();
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 30_000, resync: async () => undefined,
      onLocationDiagnostic: () => { throw new Error("diagnostic only"); },
      executor: { executeLocationAction: async (input) => {
        expect(input.confirmationTimeoutMs).toBe(1_000);
        store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:01Z")));
        await input.waitForConfirmation!();
      } }
    });
    await expect(service.execute({ ...request("request_hm_timeout_option"), timeout: 1 })).resolves.toMatchObject({ status: "confirmed" });
  });
});
'''
write(path, text)

for path in ("package.json", "package-lock.json", "custom_components/smartthings_web/manifest.json", "protocol/version.json"):
    value = json.loads(read(path))
    key = "bridge_version" if path == "protocol/version.json" else "version"
    assert value[key] == PREVIOUS, f"{path}: unexpected version"
    value[key] = VERSION
    if path == "package-lock.json":
        assert value["packages"][""]["version"] == PREVIOUS
        value["packages"][""]["version"] = VERSION
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
path = "addon/smartthings_web_bridge/config.yaml"
write(path, once(read(path), f"version: {PREVIOUS}", f"version: {VERSION}", "app version"))
for path in ("tests/addon-config.test.ts", "tests/protocol-version-contract.test.ts"):
    text = read(path)
    assert PREVIOUS in text
    write(path, text.replace(PREVIOUS, VERSION))
path = ".github/workflows/validate.yml"
write(path, once(read(path), "          node tools/ci-home-monitor-card-smoke.mjs\n",
    "          node tools/ci-home-monitor-card-smoke.mjs\n          node tools/ci-home-monitor-lifecycle-smoke.mjs\n", "permanent lifecycle CI"))
path = "addon/smartthings_web_bridge/CHANGELOG.md"
write(path, '''## 1.8.5

- 최신 HA 오류의 `command_confirmation_timeout` 경로를 점검하여 Home Monitor 클릭 직후 명령 탭을 닫던 결함을 수정했습니다. 기존 1.8.4의 실제 Chromium 합성 테스트에서 탭 조기 종료로 지연된 상태 이벤트가 취소되는 것을 재현하고, 명령 탭을 보안 상태 확인 또는 제한 시간까지 유지하도록 변경했습니다.
- Home Monitor임과 요청한 단일 모드가 확인된 후속 확인창에서만 유일한 적용/확인 버튼을 한 번 누릅니다. 다른 기기의 창, 다른 모드, 비활성·중복 버튼은 실행하지 않습니다. 클릭이나 일반 장치 인벤토리 갱신만으로 경보 설정 성공을 만들지 않습니다.
- 보안 상태 이벤트는 클릭 전부터 구독하고, UI 완료 전에 반대 상태가 관찰되면 이전 성공 후보를 폐기합니다. 재조회가 멈춰도 보안 명령 제한 시간이 끝나면 종료하며 요청별 timeout을 반영합니다.
- `command_diag:home_monitor_confirmation_*` 및 `home_monitor_confirmation:*` 단계별 진단을 추가했습니다. 계정, 위치명, 기기 ID, 쿠키 및 토큰은 기록하지 않습니다.
- 실제 page.close를 무효화하지 않는 Chromium 명령 수명 회귀 검사와 지연/즉시/반대 상태/재조회 정지 검사를 추가했습니다. 합성 테스트는 실제 Samsung 계정의 최종 성공 확인을 대신하지 않습니다. Scene 실행, 로그인 프로필, 엔티티 ID, 이벤트 폭주 억제 로직과 별도 Tapo/자동화 설정은 변경하지 않았습니다.

''' + read(path))
path = "README.md"
text = read(path).replace("1.8.4", VERSION)
text += '''

### 1.8.5 Home Monitor 명령 완료 확인

Home Monitor 명령은 버튼 클릭 직후 브라우저 탭을 닫지 않고 실제 보안 상태 이벤트를 확인할 때까지 유지합니다. `home_monitor_confirmation:confirmed`는 요청 상태 확인을 의미하고, `timed_out`은 클릭 이후에도 확인되지 않았음을 의미합니다. 확인 시간 초과를 성공으로 바꾸거나 자동으로 모드를 다시 실행하지 않습니다. Chromium 합성 회귀 검증과 사용자 삼성 계정의 실동작 검증은 별개입니다.
'''
write(path, text)
print("Applied Home Monitor lifecycle 1.8.5; Scene body unchanged")
