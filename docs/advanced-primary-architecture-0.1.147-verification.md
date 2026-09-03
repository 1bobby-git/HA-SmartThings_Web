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

## HAOS 릴리스·배포 증거

2026-09-01 KST live 실행:

- main merge SHA: `18711d6c0a5ca483a29463df8e467cf9b2248d83`
- GitHub Latest release: `v0.1.147`
- bridge asset SHA-256: `2f3459abf237c80d28d968fc812b12f689ef8cb712034614c43454a3a7ca9618`
- integration asset SHA-256: `f81b1fa574727903c9b8521323948c01b69e175b2444309b354315bc2cff971c`
- HAOS backup: `/mnt/data/ha-smartthings-web-backups/18711d6c0a5c-14e0ab39db2c`
- add-on/integration version: `0.1.147`
- runtime package manifest SHA-256: `14e0ab39db2c00fa1a99c39a524bbc2cc02a751b0d1425b38e441a5a5dc3b90e`
- Bridge: `CONNECTED`, `ready=true`, `activeConnections=2`, `advanced-primary-v1`
- Core: Home Assistant `2026.8.3`, 정상 재시작 완료

## 실명령·realtime 증거

`switch.geosil_ganjeobdeung`은 실행 전 HA와 Bridge 모두 `off`였다.

- `switch.turn_on`: HA 서비스 성공, `2026-08-31T16:14:10.325Z`의 더 새로운 `LOCATION_EVENT`로 Bridge main state가 `on`, HA state가 `2026-08-31T16:14:10.514048Z`에 `on`으로 반영됐다.
- command transport: `location_native`
- confirmation: `CONFIRMED_BY_EVENT`
- `switch.turn_off`: 같은 경로로 `2026-08-31T16:14:44.006Z` Bridge `off`, HA `2026-08-31T16:14:44.165665Z` `off`가 확인돼 원래 상태로 복구됐다.
- `button.geosil_ganjeobdeung_refresh_4`: Home Assistant `button.press` HTTP 200, `2026-08-31T16:15:13.380569Z` pressed state, `location_native`, `ACCEPTED_UNCONFIRMED`으로 성공했다.

route logs는 각 명령에 대해 `command_route:location_native:dispatch:attempt`, `command_diag:native_command_sent`, `command_route:location_native:receipt:accepted`를 기록했다. device/location/component/capability 원문이나 인증정보는 기록하지 않았다.

## Registry·실화면 증거

- `dev_151` 거실 간접등: device card 1개, control switch 1개, Refresh button 1개. `스위치 2/3/4`와 중복 Refresh는 registry에서 제거됐다.
- rendered device page: 제어 영역에 `거실 간접등` toggle 1개, 기기 설정에 `새로고침` 1개가 표시된다. 활동 기록에 on, off, Refresh가 모두 표시된다.
- 벽난로: canonical `dev_185` device card 1개만 남고 aliased `dev_602` card는 registry에서 제거됐다.
- rendered 벽난로 page: Refresh 1개와 Local source의 최신 firmware `1.163.1`, online, color temperature `4,000 K`, hue `0`, level `1%`, saturation `0`가 한 카드에 표시된다.
- 벽난로 switch는 exact 관찰 toggle이 없으므로 생성하지 않았다. 실행할 수 없는 control을 표시하지 않는 승인된 fail-closed 결과다.

Samsung 세션은 모든 live 검증 동안 `CONNECTED/ready=true`였으며 CAPTCHA나 MFA 우회는 발생하지 않았다. 이번 오류 복구·실명령·realtime·registry/UI gate는 통과했다. 72시간 유휴 내구성, 모든 기기 유형, 장기 endpoint drift는 별도의 `DECISION: LIMITED` 범위로 남는다.
