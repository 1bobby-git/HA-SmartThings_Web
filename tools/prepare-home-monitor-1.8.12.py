from pathlib import Path
import json
import re


def replace(path, old, new, count=1):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    found = text.count(old)
    if found != count:
        raise SystemExit(f'{path}: expected {count} anchors, got {found}: {old[:80]}')
    p.write_text(text.replace(old, new), encoding='utf-8')


service = 'bridge/src/command/command-service.ts'
replace(service,
    '    remainingTransitionMs?: () => number;\n  }): Promise<void>;',
    '    remainingTransitionMs?: () => number;\n  }): Promise<void | "location_native">;')
replace(service, '  | "command_transition_rearm_failed"\n',
    '  | "command_transition_rearm_failed"\n  | "command_security_unavailable"\n  | "command_security_busy"\n  | "command_security_permission_denied"\n  | "command_security_dispatch_uncertain"\n')
replace(service, '      await this.options.executor.executeLocationAction({',
    '      const executionResult = await this.options.executor.executeLocationAction({')
replace(service,
    '      return confirmed(request.clientRequestId, evidence.sequence, "security_arm_state_event");',
    '      return confirmed(request.clientRequestId, evidence.sequence, "security_arm_state_event",\n        executionResult === "location_native" ? "location_native" : "smartthings_web_ui");')
router = 'bridge/src/command/advanced-first-executor.ts'
replace(router, 'export interface AdvancedFirstCommandExecutorOptions {',
    'export interface AdvancedFirstCommandExecutorOptions {\n  locationExecutor?: Pick<SafeCommandExecutor, "executeLocationAction">;')
replace(router, '    options: AdvancedFirstCommandExecutorOptions = {}',
    '    private readonly options: AdvancedFirstCommandExecutorOptions = {}')
replace(router,
    '  async executeLocationAction(\n    input: Parameters<NonNullable<SafeCommandExecutor["executeLocationAction"]>>[0]\n  ): Promise<void> {\n    if (!this.legacy.executeLocationAction) throw new Error("command_control_not_found");\n    await this.legacy.executeLocationAction(input);\n  }',
    '  async executeLocationAction(\n    input: Parameters<NonNullable<SafeCommandExecutor["executeLocationAction"]>>[0]\n  ): Promise<void | "location_native"> {\n    if (this.options.locationExecutor) {\n      const execute = this.options.locationExecutor.executeLocationAction;\n      if (!execute) throw new Error("command_execution_failed");\n      return await execute.call(this.options.locationExecutor, input);\n    }\n    if (!this.legacy.executeLocationAction) throw new Error("command_control_not_found");\n    return await this.legacy.executeLocationAction(input);\n  }')
runtime = 'bridge/src/runtime.ts'
replace(runtime, 'import { readLocationSecurityStatus } from "./browser/location-status.js";',
    'import { readLocationSecurityStatus } from "./browser/location-status.js";\nimport { LocationSecurityCommandExecutor } from "./browser/location-security-command.js";')
replace(runtime, '  const commandExecutor = new AdvancedFirstCommandExecutor(',
    '  const locationSecurityExecutor = new LocationSecurityCommandExecutor({\n    getManager: () => currentKeeperManager,\n    resolveRawLocationId: (alias) => volatileIdentifiers.rawLocationId(alias),\n    onDiagnostic: (stage) => log.info(`home_monitor_direct:${stage}`)\n  });\n  const commandExecutor = new AdvancedFirstCommandExecutor(')
replace(runtime, '      domFallbackEnabled: deps.config.domFallbackEnabled ?? true,',
    '      locationExecutor: locationSecurityExecutor,\n      domFallbackEnabled: deps.config.domFallbackEnabled ?? true,')
replace(runtime, '  const log = deps.log ?? console;',
    '  const log = deps.log ?? console;\n  log.info(`bridge_init:version:${bridgeVersion}:home_monitor_direct`);')

# Keep the previous browser fixtures; the mandatory CI entry now also exercises
# the new production direct route with its real command confirmation service.
p = Path('tools/ci-home-monitor-native-smoke.mjs')
s = p.read_text(encoding='utf-8')
assert 'ci-home-monitor-direct-smoke.mjs' not in s
p.write_text(s + '\n\n// Verify the production direct-only Home Monitor route as well.\nawait import("./ci-home-monitor-direct-smoke.mjs");\n', encoding='utf-8')

for path in ['package.json', 'package-lock.json', 'protocol/version.json',
             'custom_components/smartthings_web/manifest.json',
             'addon/smartthings_web_bridge/config.yaml',
             'bridge/src/runtime.ts', 'tests/protocol-version-contract.test.ts']:
    p = Path(path)
    s = p.read_text(encoding='utf-8')
    assert '1.8.11' in s, path
    p.write_text(s.replace('1.8.11', '1.8.12'), encoding='utf-8')

notes = '''- Home Monitor를 화면 버튼 대신 기존 로그인된 웹앱의 `api/location.patch`와 검증된 `patchType: armStateChange` 요청으로 제어합니다. Advanced 일반 기기 명령이나 추측한 보안 URL을 사용하지 않습니다.
- 외출↔실내 전환은 목표 `ARMED_AWAY` / `ARMED_STAY`를 한 번 전송하며 중간 해제나 DOM 클릭을 하지 않습니다. 요청 접수 이후 실제 위치 보안 이벤트·새 상태 조회가 확인돼야 완료합니다.
- 클라이언트가 준비되기 전에는 제한된 정상 초기화만 기다리고, 응답이 불명확하거나 권한이 거절되면 DOM fallback·자동 재전송·자동 해제를 하지 않습니다. 미완료 요청은 같은 context에서 중복 전송을 차단합니다.
- `home_monitor_direct` 단계와 실행 버전 로그를 추가했습니다. Scene, Advanced 장치 command, Galaxy Home Mini speak, 로그인 프로필, 영역, 엔티티 ID 및 protocol 5는 유지합니다.
- 공개 SmartThings Web 2.57.0 요청 계약과 합성 Chromium/실제 명령 처리기 연결 검사를 기반으로 합니다. 사용자 삼성 계정에서의 모드 전환 승인·성공률·실제 지연은 별도 확인 대상입니다.
'''
for path in ['addon/smartthings_web_bridge/CHANGELOG.md', 'CHANGELOG.md']:
    p = Path(path)
    if not p.exists():
        continue
    s = p.read_text(encoding='utf-8')
    assert '## 1.8.12' not in s
    pos = s.find('\n## ')
    if pos < 0:
        pos = len(s)
    p.write_text(s[:pos] + '\n\n## 1.8.12\n\n' + notes + '\n' + s[pos:], encoding='utf-8')

p = Path('README.md')
s = p.read_text(encoding='utf-8')
start = s.index('## Home Monitor 1.8.11')
end = s.index('<p align="center">', start)
s = s[:start] + '''## Home Monitor 1.8.12

Home Monitor는 기존 로그인된 웹앱의 **직접 보안 상태 요청**을 사용합니다. 외출↔실내 전환에서도 중간 해제·화면 버튼 클릭 없이 목표 모드를 한 번 전송하고, 실제 보안 상태를 확인합니다. 응답이 불명확하면 자동 재전송하지 않습니다. Bridge와 HA 통합을 함께 업데이트하세요. [요청 계약·실패 처리·검증 범위](docs/home-monitor-direct-transport.md)를 확인하세요.

''' + s[end:]
s = re.sub(r'(현재 버전: Bridge `)[^`]+(` / HA 통합 `)[^`]+(`)', r'\g<1>1.8.12\g<2>1.8.12\g<3>', s)
p.write_text(s, encoding='utf-8')

# Active docs for the app must not describe the historical DOM transport as current.
p = Path('addon/smartthings_web_bridge/DOCS.md')
if p.exists():
    s = p.read_text(encoding='utf-8')
    p.write_text('## Home Monitor 1.8.12\n\nHome Monitor 모드 변경은 로그인된 웹앱의 직접 보안 요청을 사용합니다. 외출↔실내 전환에 중간 해제나 DOM 버튼 탐색을 사용하지 않습니다. 성공 여부는 실제 상태로 확인하며, 응답 불명확 시 재전송하지 않습니다.\n\n' + s, encoding='utf-8')

print('Prepared 1.8.12 direct-only Home Monitor route; no live account mutation performed.')
