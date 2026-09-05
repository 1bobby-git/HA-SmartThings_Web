"""Apply only the reviewed Home Monitor lifecycle delta to the 1.8.4 baseline."""
from pathlib import Path
import hashlib
import json
import subprocess

BASE = "12e74619712a31fbe4dae9fe8bbdc581d2ad1664"
OLD, NEW = "1.8.4", "1.8.5"
ROOT = Path.cwd()
HASHES = {
    "bridge/src/command/command-service.ts": "1617fec8a83c208783652f71dff6d46eb39e535d",
    "bridge/src/browser/command-page.ts": "5f926ce8db5d409f48910a2d5e36884a8b6a56ca",
    "bridge/src/runtime.ts": "2b7eb1a9ad320ec6ed7d0dfd15b23d9405046965",
    ".github/workflows/validate.yml": "fa1de9d0893ad6cd41e633305426991ab911de32",
}
subprocess.run(["git", "merge-base", "--is-ancestor", BASE, "HEAD"], check=True)
if subprocess.check_output(["git", "status", "--porcelain"], text=True).strip():
    raise SystemExit("Refusing to apply to an unclean checkout")
texts = {}
for path, expected in HASHES.items():
    data = (ROOT / path).read_bytes()
    actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != expected:
        raise SystemExit(f"Reviewed source changed: {path}")
    texts[path] = data.decode("utf-8")

def once(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f"{label}: expected one anchor, got {text.count(old)}")
    return text.replace(old, new, 1)

page_path = "bridge/src/browser/command-page.ts"
page = texts[page_path]
start = page.index("  async executeLocationAction(input: {\n")
end = page.index("  private async openLocationPage(", start)
region = page[start:end]
signature = '    action: "armAway" | "armStay" | "disarm";\n'
if region.count(signature) != 2:
    raise SystemExit("Location method signatures changed")
region = region.replace(signature, signature + "    waitForConfirmation?: () => Promise<void>;\n")
begin = region.index("    try {\n")
ending = "    } finally {\n      await page.close().catch(() => undefined);\n    }\n  }\n\n"
if not region.endswith(ending):
    raise SystemExit("Location page cleanup boundary changed")
body = region[begin + len("    try {\n"):-len(ending)]
body = "".join("  " + line if line.strip() else line for line in body.splitlines(keepends=True))
region = (region[:begin] + "    await runLocationCommandSession(\n      async () => {\n" + body +
          "      },\n      () => page.close(),\n      input.waitForConfirmation\n    );\n  }\n\n")
texts[page_path] = ('import { runLocationCommandSession } from "../command/location-command-session.js";\n' +
                    page[:start] + region + page[end:])

service_path = "bridge/src/command/command-service.ts"
service = texts[service_path]
old_signature = '''  executeLocationAction?(input: {
    action: LocationAction;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void>;'''
service = once(service, old_signature, old_signature.replace(
    "  }): Promise<void>;", "    waitForConfirmation?: () => Promise<void>;\n  }): Promise<void>;"
), "executor lifetime hook")
service = once(service, "  onPendingCountChange?: (count: number) => void;\n", '''  onLocationDiagnostic?: (diagnostic: {
    phase: "dispatching" | "waiting" | "confirmed" | "failed";
    action: LocationAction;
    elapsedMs: number;
    observedStateMatches: boolean;
    reason?: SafeCommandErrorCode;
  }) => void;
  onPendingCountChange?: (count: number) => void;
''', "location diagnostics")
start = service.index("  async #executeLocation(\n")
end = service.index("\n}\n\nfunction validateRequest(", start)
replacement = '''  async #executeLocation(
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
    // Subscribe before dispatch so an event arriving during the click is retained.
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
      // Test/custom executors may not own a browser page or consume the optional hook.
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
  }'''
service = service[:start] + replacement + service[end:]
start = service.index("function waitForLocationArmState(")
end = service.index("\nfunction waitForComponentVector(", start)
waiter = service[start:end]
old_match = '    matches: (event) => event.type === "inventory" && options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired)\n'
waiter = once(waiter, old_match, '''    forceFinalResync: true,
    invalidates: (event) => event.type === "inventory" && !options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired),
''' + old_match, "bounded location waiter and conflicting evidence")
texts[service_path] = service[:start] + waiter + service[end:]

runtime_path = "bridge/src/runtime.ts"
texts[runtime_path] = once(texts[runtime_path],
    "    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),\n", '''    onLocationDiagnostic: (diagnostic) => log.info(
      `home_monitor_command:${diagnostic.phase}:action_${diagnostic.action}` +
      `:matches_${Number(diagnostic.observedStateMatches)}:elapsed_ms_${diagnostic.elapsedMs}` +
      (diagnostic.reason ? `:reason_${diagnostic.reason}` : "")
    ),
    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),
''', "runtime diagnostics")
texts[runtime_path] = once(texts[runtime_path], f'const bridgeVersion = "{OLD}";',
                           f'const bridgeVersion = "{NEW}";', "runtime version")
workflow = ".github/workflows/validate.yml"
texts[workflow] = once(texts[workflow], "          node tools/ci-home-monitor-card-smoke.mjs\n",
    "          node tools/ci-home-monitor-card-smoke.mjs\n          node tools/ci-home-monitor-confirmation-smoke.mjs\n",
    "permanent real-browser confirmation test")

for path, key in [("package.json", "version"), ("package-lock.json", "version"),
                  ("protocol/version.json", "bridge_version"),
                  ("custom_components/smartthings_web/manifest.json", "version")]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if value.get(key) != OLD:
        raise SystemExit(f"Version differs in {path}")
    value[key] = NEW
    if path == "package-lock.json":
        if value["packages"][""]["version"] != OLD:
            raise SystemExit("Lockfile root version differs")
        value["packages"][""]["version"] = NEW
    texts[path] = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
path = "addon/smartthings_web_bridge/config.yaml"
texts[path] = once(Path(path).read_text(encoding="utf-8"), f"version: {OLD}\n", f"version: {NEW}\n", "app version")
path = "addon/smartthings_web_bridge/CHANGELOG.md"
texts[path] = '''## 1.8.5

- 실제 Bridge 로그의 `home_monitor_card:clicked` 이후 확인 타임아웃을 기준으로, Home Monitor 제어 탭을 클릭 직후 닫던 수명을 수정했습니다. 기존 위치별 보안 상태 확인이 끝나거나 실패할 때까지 탭과 foreground 작업을 유지합니다.
- 보안 상태 이벤트 구독은 클릭 전에 등록하고, 클릭 도중 수신한 일치 상태는 보존합니다. 이후 반대 상태가 수신되면 이전 일치 증거를 무효화합니다. 클릭·인벤토리 재조회 완료만으로 보안 성공을 보고하지 않습니다.
- 요청별 timeout을 반영하고, 상태 재조회가 응답하지 않더라도 확인 대기를 기한 내 종료합니다. 성공·실패 시 제어 탭과 구독/타이머를 정리합니다.
- `home_monitor_command:`에 전송/대기/완료/실패, 동작 종류, 경과 시간 및 상태 일치 여부만 기록합니다. 계정·위치 식별자·쿠키·토큰·페이지 문구는 기록하지 않습니다.
- 실제 Chromium에서 지연된 보안 상태 이벤트, 즉시 탭 종료 회귀, 확인 실패 및 정리를 검증하는 영구 CI 테스트를 추가했습니다. 이는 합성 화면 검증이며 실제 삼성 계정에서의 Home Monitor 성공을 대신하지 않습니다. Scene·로그인·엔티티 ID·이벤트 폭주 억제 경로는 변경하지 않았습니다.

''' + Path(path).read_text(encoding="utf-8")
for path in ("tests/addon-config.test.ts", "tests/protocol-version-contract.test.ts"):
    text = Path(path).read_text(encoding="utf-8")
    if OLD not in text:
        raise SystemExit(f"Version contract missing: {path}")
    texts[path] = text.replace(OLD, NEW)
    if path.endswith("addon-config.test.ts"):
        texts[path] = once(texts[path], '    expect(changelog).toContain("## 1.8.5");',
                          '    expect(changelog).toContain("## 1.8.5");\n    expect(changelog).toContain("## 1.8.4");', "retain previous changelog gate")
for path, text in texts.items():
    Path(path).write_text(text, encoding="utf-8", newline="\n")
print("Reviewed lifecycle changes applied:")
print("\n".join(texts))
