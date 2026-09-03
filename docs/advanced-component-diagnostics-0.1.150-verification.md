# SmartThings Web component diagnostics 0.1.150 검증 보고서

## 목적

0.1.149 live `switch.hwajangsil_jomyeong turn_on`은 `component_command_partial_failure`를 반환했고 자동 rollback 후 네 component 모두 원래 `off`를 유지했다. 기존 로그는 민감정보 보호를 위해 실패 component와 transport 분류를 전혀 남기지 않아 원인을 더 좁힐 수 없었다.

0.1.150은 raw ID를 기록하지 않고 component transaction의 다음 정보만 기록한다.

- phase: `dispatch` 또는 `rollback`
- one-based ordinal
- outcome: `attempt`, `accepted`, `failed`
- fixed transport code: `unsupported`, `authentication`, `permission`, `transient`, `invalid_arguments`, `offline`, `response_invalid`, `http_error`, 또는 `unknown`

진단 callback 오류는 명령과 rollback을 바꾸지 않는다. 0.1.149 availability 복구와 0.1.148 Advanced status/rollback 경계는 유지한다.

## 로컬 검증

- full Vitest: 68 files, 888 tests passed
- Home Assistant Python unittest discovery: 235 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run package:addon`: passed
- add-on package manifest SHA-256: `cf24e79cac8fe7f6f0518e3f4fa7ee83e0434c5a1120d83cec819810701b31c7`
- `npm run audit:secrets`: passed
- `npm run audit:api-free`: passed
- `npm run audit:fixtures`: passed
- `git diff --check`: passed

## HAOS 검증

- 화장실 명령 전 원본 벡터: `main=off, switch2=off, switch3=off, switch4=off`
- 0.1.149 `turn_on`: HTTP 500, `component_command_partial_failure`, 자동 rollback 후 원본 벡터 유지
- 0.1.150에서 같은 reversible `turn_on`을 한 번 실행해 최초 failed ordinal/code를 기록하고 원래 `off` 벡터를 재확인한다.
