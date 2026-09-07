"""One-shot branch preparation from reviewed 1.8.10 source anchors.
No user account data or runtime credentials are read. CI validates the final diff.
"""
from pathlib import Path


def edit(path, old, new, count=1):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"Source anchor mismatch: {path}: expected {count}, got {actual}")
    file.write_text(text.replace(old, new), encoding="utf-8")


service = "bridge/src/command/command-service.ts"
edit(service, '    isDesiredStateCurrent?: () => boolean;\n', '    isDesiredStateCurrent?: () => boolean;\n    disarmForTransition?: (dispatch: () => Promise<void>) => Promise<void>;\n    remainingTransitionMs?: () => number;\n')
edit(service, '  | "command_control_ambiguous"\n', '  | "command_control_ambiguous"\n  | "command_transition_confirmation_unavailable"\n  | "command_transition_disarm_failed"\n  | "command_transition_rearm_failed"\n')
edit(service, 'phase: "dispatching" | "waiting" | "confirmed" | "failed";', 'phase: "dispatching" | "waiting" | "confirmed" | "failed" | "transition_disarming" | "transition_disarmed" | "transition_failed";')
edit(service, '"command_control_not_found", "command_control_ambiguous", "component_command_partial_failure"', '"command_control_not_found", "command_control_ambiguous", "command_transition_confirmation_unavailable", "command_transition_disarm_failed", "command_transition_rearm_failed", "component_command_partial_failure"')
f = Path(service)
s = f.read_text(encoding="utf-8")
start = s.index('  async #executeLocation(\n')
end = s.index('\n}\n\nfunction validateRequest', start)
s = s[:start] + '''  async #executeLocation(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    const location = snapshot.locations.find((candidate) => candidate.id === request.targetId);
    if (!location) throw new SafeCommandError("device_not_found");
    const desired = armStateForCommand(request.command);
    if (!desired || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    if (normalizeLocationArmState(location.armState) === desired) {
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
    const startedAt = Date.now();
    const timeoutMs = request.timeout === undefined ? this.options.timeoutMs : request.timeout * 1_000;
    const diagnostic = (phase: "dispatching" | "waiting" | "confirmed" | "failed" | "transition_disarming" | "transition_disarmed" | "transition_failed", reason?: SafeCommandErrorCode) => {
      try {
        this.options.onLocationDiagnostic?.({
          phase, action: request.command as LocationAction,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          observedStateMatches: normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState) === desired,
          ...(reason ? { reason } : {})
        });
      } catch { /* Diagnostics cannot change a security command's outcome. */ }
    };
    const createConfirmation = (mode: string) => waitForLocationArmState({
      devices: this.options.devices, locationId: request.targetId, desired: mode,
      afterSequence: this.options.devices.currentSequence(),
      resync: () => this.options.resync({ locationId: request.targetId })
    });
    // Each stage subscribes before its click; a prior stage can never finish the next stage.
    let confirmation = createConfirmation(desired);
    let started = false;
    let transitionUsed = false;
    let transitionDisarmed = false;
    let transitionDeadline: number | undefined;
    const remainingTransitionMs = () => transitionDeadline === undefined
      ? timeoutMs : Math.max(0, transitionDeadline - Date.now());
    const waitForConfirmation = async (): Promise<void> => {
      if (!started) {
        started = true;
        const remaining = remainingTransitionMs();
        if (remaining <= 0) throw new SafeCommandError("command_confirmation_timeout");
        diagnostic("waiting");
        confirmation.startTimeout(remaining, this.options.resyncAfterMs, Date.now());
      }
      await confirmation.result;
    };
    const disarmForTransition = async (dispatch: () => Promise<void>): Promise<void> => {
      if (transitionUsed || request.command === "disarm") throw new SafeCommandError("command_transition_disarm_failed");
      transitionUsed = true;
      transitionDeadline = Date.now() + timeoutMs;
      confirmation.cancel();
      const intermediate = createConfirmation("DISARMED");
      try {
        diagnostic("transition_disarming");
        const clickStarted = Date.now();
        await dispatch();
        const remaining = remainingTransitionMs();
        if (remaining <= 0) throw new SafeCommandError("command_confirmation_timeout");
        intermediate.startTimeout(remaining, this.options.resyncAfterMs, clickStarted);
        await intermediate.result;
        if (normalizeLocationArmState(this.options.devices.location(request.targetId)?.armState) !== "DISARMED") {
          throw new SafeCommandError("command_confirmation_timeout");
        }
        transitionDisarmed = true;
        // Drop any desired-mode evidence preceding the confirmed intermediate disarm.
        confirmation = createConfirmation(desired);
        started = false;
        diagnostic("transition_disarmed");
      } catch (error) {
        const failure = error instanceof SafeCommandError ? error : commandError(error);
        diagnostic("transition_failed", failure.code);
        throw new SafeCommandError("command_transition_disarm_failed");
      } finally { intermediate.cancel(); }
    };
    try {
      if (!this.options.executor.executeLocationAction) throw new SafeCommandError("command_execution_failed");
      diagnostic("dispatching");
      await this.options.executor.executeLocationAction({
        action: request.command as LocationAction,
        locationId: request.targetId, locationNames, waitForConfirmation,
        disarmForTransition, remainingTransitionMs,
        isDesiredStateCurrent: () => {
          const current = this.options.devices.location(request.targetId);
          return normalizeLocationArmState(current?.armState) === desired &&
            (current?.armState !== initialLocation?.armState || current?.updatedAt !== initialLocation?.updatedAt);
        }
      });
      await waitForConfirmation();
      const evidence = await confirmation.result;
      diagnostic("confirmed");
      return confirmed(request.clientRequestId, evidence.sequence, "security_arm_state_event");
    } catch (error) {
      confirmation.cancel();
      const original = error instanceof SafeCommandError ? error : commandError(error);
      if (transitionDisarmed) diagnostic("transition_failed", original.code);
      const failure = transitionDisarmed ? new SafeCommandError("command_transition_rearm_failed") : original;
      diagnostic("failed", failure.code);
      // Never restore the previous mode optimistically or replay an uncertain action.
      throw failure;
    }
  }
''' + s[end:]
f.write_text(s, encoding="utf-8")

page = "bridge/src/browser/command-page.ts"
edit(page, 'import { enqueueWithDeadline }', 'import { executeNativeSecurityAction, type NativeSecurityStage } from "./home-monitor-native.js";\nimport { enqueueWithDeadline }')
edit(page, 'type CommandDiagnosticStage =\n', 'type CommandDiagnosticStage =\n  | NativeSecurityStage\n')
edit(page, '    isDesiredStateCurrent?: () => boolean;\n', '    isDesiredStateCurrent?: () => boolean;\n    disarmForTransition?: (dispatch: () => Promise<void>) => Promise<void>;\n    remainingTransitionMs?: () => number;\n', count=2)
anchor = '    const dispatchStartedAt = Date.now();\n'
edit(page, anchor, anchor + '''    const nativeInput = {
      action: input.action,
      monitorLabels: homeMonitorLabels(input.locationNames?.[input.locationId]),
      modeLabelGroups: [locationActionLabels("armAway"), locationActionLabels("armStay"), locationActionLabels("disarm")],
      ...(input.disarmForTransition ? { disarmForTransition: input.disarmForTransition } : {}),
      ...(input.remainingTransitionMs ? { remainingTransitionMs: input.remainingTransitionMs } : {}),
      diagnostic: (stage: NativeSecurityStage) => this.#diagnostic(stage)
    };
''')
edit(page, '      await keeper.bringToFront?.();\n      const result = await clickHomeMonitorCardAction', '''      await keeper.bringToFront?.();
      if (await executeNativeSecurityAction(keeper, nativeInput, 350)) {
        this.#diagnostic("home_monitor_keeper_reused");
        this.#diagnostic(`home_monitor_dispatch_ms_${Date.now() - dispatchStartedAt}`);
        await input.waitForConfirmation?.();
        return;
      }
      const result = await clickHomeMonitorCardAction''')
edit(page, '        const actionName = locationActionName(input.action);', '''        if (await executeNativeSecurityAction(page, nativeInput)) return;
        const actionName = locationActionName(input.action);''')

http = "bridge/src/server/http-server.ts"
edit(http, '    code === "command_control_ambiguous" ||', '''    code === "command_control_ambiguous" ||
    code === "command_transition_confirmation_unavailable" ||
    code === "command_transition_disarm_failed" ||
    code === "command_transition_rearm_failed" ||''')
client = "custom_components/smartthings_web/bridge_client.py"
edit(client, '    "command_control_ambiguous",\n', '    "command_control_ambiguous",\n    "command_transition_confirmation_unavailable",\n    "command_transition_disarm_failed",\n    "command_transition_rearm_failed",\n')
alarm = "custom_components/smartthings_web/alarm_control_panel.py"
edit(alarm, '''        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err
''', '''        except BridgeClientError as err:
            if str(err) in {"command_transition_disarm_failed", "command_transition_rearm_failed"}:
                # An intermediate disarm may have succeeded. Read actual state once;
                # never present the requested or previous mode as a substitute.
                try:
                    async with asyncio.timeout(3):
                        latest = await self.runtime.client.async_get_inventory()
                    self.runtime.apply_inventory(latest)
                except (BridgeClientError, TimeoutError):
                    pass
                logging.getLogger(__name__).error(
                    "Home Monitor mode transition incomplete; the location may be disarmed. Verify its actual security state (%s)",
                    str(err),
                )
            raise HomeAssistantError(bridge_error_message("Home Monitor command", err)) from err
''')

for path in ["package.json", "package-lock.json", "custom_components/smartthings_web/manifest.json", "protocol/version.json", "bridge/src/runtime.ts", "addon/smartthings_web_bridge/config.yaml", "tests/protocol-version-contract.test.ts"]:
    file=Path(path)
    text=file.read_text(encoding="utf-8")
    if "1.8.10" not in text: raise RuntimeError(f"Version anchor absent: {path}")
    file.write_text(text.replace("1.8.10", "1.8.11"), encoding="utf-8")

notes = '''## 1.8.11

- 사용자 제공 실제 `section.homecard.security` / `.status-container .actions button` 구조로 Home Monitor를 제어합니다. `data-armstate`와 실제 버튼 의미를 검증하고, 문구·방패 로고·위치 Home 메뉴는 클릭하지 않습니다. 경비 중 Disarm 버튼 하나도 즉시 처리해 기존 5초 반복 탐색을 제거합니다.
- 외출↔실내 전환 요청은 같은 위치·같은 페이지·하나의 잠금 안에서 Disarm → 새 해제 상태 확인 → 요청 경비 버튼 → 최종 상태 확인 순서로 실행합니다. 중간 해제는 성공 응답이 아니며, 각 단계는 최대 한 번 클릭합니다.
- 중요: 모드 간 전환에는 짧은 경비 해제 구간이 있으며, 다음 단계가 실패하면 해제 상태에 남을 수 있습니다. 단계별 오류와 실제 상태를 전달하고 임의 재전송·자동 복원·낙관적 상태 변경은 하지 않습니다. 알려지지 않은 상태/레이아웃에서는 자동 해제하지 않습니다.
- 중간 해제 전에 수신된 최종 모드 증거는 폐기하고, 해제 확인 후 새로 구독합니다. 두 단계는 기존 명령 확인 제한을 공유하며, 다른 위치·오래된 캐시·해제 확인 실패로 다음 단계를 진행하지 않습니다.
- 실제 버튼의 보임·활성·가림·중복을 검사합니다. 포인터를 보내지 않는 trial 검사만 재확인할 수 있고, 실제 클릭의 결과가 불확실하면 같은 명령을 다시 클릭하지 않습니다.
- 기존 Scene/Advanced commands/speak, 로그인 프로필, 영역 연결, 개별 스위치, 엔티티 ID 및 protocol 5는 유지합니다. 새 네이티브 카드 회귀와 전체 CI는 합성 검증이며 실제 Samsung 계정의 성공률·지연은 별도 확인 대상입니다.

'''
for name in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    file=Path(name)
    file.write_text(notes + file.read_text(encoding="utf-8"), encoding="utf-8")
for name in ["README.md", "addon/smartthings_web_bridge/README.md", "addon/smartthings_web_bridge/DOCS.md"]:
    file=Path(name)
    text=file.read_text(encoding="utf-8")
    position=text.find("\n")+1
    text=text[:position]+"\n## Home Monitor 1.8.11\n\n실제 보안 카드의 버튼을 사용합니다. 경비 모드 간 전환은 **해제 → 해제 상태 확인 → 요청 모드 → 최종 확인** 순서입니다. 중간에 경비가 해제되며 재경비가 실패하면 해제 상태에 남을 수 있습니다. `command_transition_disarm_failed` / `command_transition_rearm_failed`가 나오면 실제 상태를 확인하세요. 문구·로고를 누르는 방식은 이 카드에서 사용하지 않습니다. Bridge와 HA 통합을 함께 업데이트하세요.\n\n"+text[position:]
    file.write_text(text,encoding="utf-8")
Path("docs/HOME_MONITOR_1.8.11.md").write_text(notes + '''### Evidence and validation scope

The user supplied the actual native card DOM, a DISARMED action button, and successful manual Disarm → Arm (stay). Armed away/stay cards contain only Disarm. The historical log shows a 5-second single-action probe delay and later missing-selector failures. No new live account command was executed during development. Fixtures contain no user camera images, location IDs, cookies or tokens.

The status captions and button layout are verified separately. Enum action attributes are checked at runtime; arming buttons may also use the exact localized labels in an identified native card. Unsupported/contradictory layouts, overlays, duplicates, disabled controls and route changes fail without speculative clicks.

The existing final confirmation remains authoritative. Each intermediate stage subscribes before dispatch and only accepts fresh exact-location evidence. A matching cache or a changed DOM alone cannot authorize rearming. Stage error paths refresh HA from the real Bridge inventory once and leave the actual state visible. No control is sent twice.
''', encoding="utf-8")
edit(".github/workflows/validate.yml", '          node tools/ci-home-monitor-linked-popup-smoke.mjs\n', '          node tools/ci-home-monitor-linked-popup-smoke.mjs\n          node tools/ci-home-monitor-native-smoke.mjs\n')
print("Prepared 1.8.11 source and docs from checked 1.8.10 anchors")
