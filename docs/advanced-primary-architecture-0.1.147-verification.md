# SmartThings Web 실명령·가시 엔티티 복구 0.1.147 검증 보고서

## 변경 목적

0.1.146은 Advanced 인벤토리를 실제 HAOS에서 사용했지만 검증되지 않은 Advanced command POST가 기존 Web native dispatcher를 차단했고, Advanced state/control을 그대로 Home Assistant 엔티티로 승격해 실행 불가능한 switch와 중복 Refresh를 만들었다.

0.1.147은 다음 원칙으로 복구한다.

- Advanced는 인벤토리·상태·health·capability enrichment의 주 source로 유지한다.
- 실제 장치·component·capability·command 조합의 live 증거가 없는 Advanced POST는 실행하지 않는다.
- 관찰된 `/location` native control을 기본 command transport로 사용한다.
- exact 양방향 toggle이 없는 switch state는 제어 엔티티로 만들지 않는다.
- component별 Refresh는 main 우선 장치당 하나로 노출한다.
- 강한 same-owner Cloud/Local child 쌍만 기존 Cloud 공개 ID로 canonicalize한다.

## 명령 경로

`AdvancedFirstCommandExecutor`는 `canUseAdvanced()` evidence policy가 true인 명령만 Advanced adapter로 보낸다. 기본 production policy는 false이며, 기존 `SmartThingsWebUiCommandExecutor`가 Location native를 먼저 실행하고 검증된 DOM control을 마지막 fallback으로 유지한다.

transport/stage/outcome/safe error code만 `command_route:*` 진단으로 기록한다. 장치·location·component·capability 원문, 요청 body, 쿠키, token, CSRF 값은 기록하지 않는다.

stateful 명령은 기존 `CommandConfirmationCoordinator`가 더 새로운 Location push 또는 bounded status refresh로 확인한다. 불확실한 receipt나 timeout 뒤에 다른 transport로 재전송하지 않는다.

## 엔티티와 registry

- `control_kind()`는 exact toggle, safe control, 양방향 on/off를 모두 요구한다.
- `거실 간접등`처럼 main toggle 하나와 secondary switch state 세 개가 있는 장치는 main SwitchEntity 하나만 생성한다.
- Refresh는 main component를 우선하고 main이 없을 때 deterministic first control 하나만 선택한다.
- migration은 current config entry의 무제어 switch와 noncanonical Refresh registry row만 제거한다.
- `ready=true` inventory가 아니면 destructive orphan cleanup을 실행하지 않는다.

## Cloud/Local canonical identity

canonicalization은 같은 location, room, 정규화 이름, type, owner를 공유하는 정확히 두 장치만 검토한다. Cloud 하나와 parent가 있는 Local 하나, main switch/light state signature, Local-only control 부재를 모두 요구한다.

승인된 `dev_185`/`dev_602` 구조에서는 Cloud `dev_185`를 공개 ID로 유지하고 Local의 더 최신 state·health와 parent metadata를 병합한다. Local `dev_602` SSE event는 runtime alias map에서 `dev_185`로 변환한다. 다른 owner, 세 번째 후보, parent 부재, 약한 state overlap, Local-only control은 병합하지 않는다.

## 로컬 검증 결과

2026-09-01 KST 전용 worktree 실행 결과:

- targeted Vitest: 6 files, 107 tests passed
- full Vitest: 67 files, 859 tests passed
- Home Assistant Python unittest discovery: 234 tests passed
- `npm run typecheck`: passed
- `npm run build`: passed
- `npm run package:addon`: passed
- add-on package manifest SHA-256: `14e0ab39db2c00fa1a99c39a524bbc2cc02a751b0d1425b38e441a5a5dc3b90e`
- `npm run audit:secrets`: passed
- `npm run audit:api-free`: passed
- `npm run audit:fixtures`: passed
- `git diff --check`: passed

새 회귀 범위는 Web-default/Advanced-evidence routing, safe command diagnostics, exact switch control, canonical Refresh, scoped registry removal, strong duplicate identity guards, alias SSE apply와 alias inventory merge를 포함한다.

## 현재 검증 경계

이 문서는 로컬 candidate 증거다. 다음 항목은 릴리스·HAOS 배포 후에만 완료로 기록한다.

- exact main SHA와 GitHub `v0.1.147` asset hash
- HAOS add-on/integration version과 runtime manifest hash
- Home Assistant `switch.turn_on` 또는 `switch.turn_off` 실동작과 원상복구
- 같은 command의 post-command Location push와 Home Assistant state 반영
- canonical `button.press` 성공
- `거실 간접등` main switch 하나와 Refresh 하나
- `벽난로` device card 하나와 `dev_602` stale registry 제거
- 실제 Home Assistant 렌더링 증거
- Samsung login/MFA 안전 경계

위 live 항목을 확인하기 전 production/physical 완료를 주장하지 않는다.
