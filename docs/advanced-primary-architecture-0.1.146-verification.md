# Advanced 주 데이터·명령 구조 0.1.146 검증 보고서

## 1. 변경 전 구조

- `/location` Socket.IO snapshot과 event가 인벤토리·realtime의 중심이었다.
- Advanced는 임시 페이지에서 한 번 관찰하는 읽기 전용 enrichment였다.
- 명령은 `/location` native dispatcher가 우선이고 DOM detail control이 fallback이었다.
- HA 명령 결과는 `smartthings_web_ui` transport만 허용했다.

## 2. 변경 후 구조

```text
AuthenticatedSmartThingsSession
├─ AdvancedInventoryAdapter
├─ AdvancedCommandAdapter
├─ LocationRealtimeAdapter
├─ SafeCommandService / confirmation coordinator
├─ StateReconciliationCoordinator
└─ verified DOM fallback in SmartThingsWebUiCommandExecutor
```

하나의 persistent Chromium context와 `/location` keeper를 공유한다. Advanced same-origin 요청이 먼저 실행되며 origin 제약 시에만 짧은 Advanced 페이지를 열고 닫는다.

## 3. 수정 파일

전체 목록은 `git diff main...HEAD --name-only`로 재현할 수 있다. 핵심 파일은 `bridge/src/advanced/*`, `bridge/src/realtime/location-realtime-adapter.ts`, `bridge/src/state/reconciliation-coordinator.ts`, `bridge/src/command/*`, `bridge/src/runtime.ts`, `custom_components/smartthings_web/services.py`, `config_flow.py`, `diagnostics.py`, README와 CHANGELOG다.

## 4. Advanced 데이터 경로

- locations, rooms, devices, device status/health/preferences, profile, capability, history, rules, scenes, hub/driver endpoint builder와 adapter method를 분리했다.
- device 목록은 server next link를 우선하고 없으면 `isNext/max/page`로 계속 읽는다.
- 모든 페이지를 `deviceId`로 병합하며 나중 응답이 이긴다.
- 완전히 병합한 결과만 authoritative snapshot으로 적용한다.
- capability 정의는 `(capabilityId, version)`으로 캐시하며 custom capability와 argument type/enum/range를 검증한다.
- normalized state에는 `ADVANCED_SNAPSHOT`, `LOCATION_EVENT`, `COMMAND_STATUS_RECHECK`, `DOM_FALLBACK` source 계약을 추가했다.

## 5. Advanced 명령 경로

- `POST /advanced/cupcake-api/api/devices/{deviceId}/commands`가 첫 경로다.
- device/component/capability/command/arguments는 동적으로 구성한다.
- capability version을 DeviceStore에서 command adapter까지 전달한다.
- 인증·권한·timeout·HTTP·parser 오류는 fallback하지 않는다. 명시적 unsupported만 다음 경로로 진행한다.

## 6. `/location`에 유지한 기능

- SmartThings Socket.IO keeper와 realtime delta 수신
- 물리 조작, 앱, 외부 자동화의 `DEVICE_EVENT`/health event 반영
- stateful 명령의 push confirmation
- disconnect 감지와 keeper 복구
- 복구 후 첫 inbound frame에서 Advanced 전체 reconciliation

## 7. DOM 기능 축소

Advanced가 지원되면 DOM을 호출하지 않는다. Advanced가 unsupported이고 Location native도 사용할 수 없을 때만 기존의 정확히 관찰된 detail control을 사용한다. 실패한 Advanced 명령을 DOM으로 반복하지 않는다.

## 8. 엔티티 호환성

- domain과 config entry를 유지한다.
- device registry identifier `(smartthings_web, deviceId)`를 유지한다.
- state unique ID `deviceId_component_capability_attribute`를 유지한다.
- 플랫폼 discovery와 registry migration 코드를 교체하지 않았다.
- Advanced metadata는 기존 canonical device key로 병합되므로 동일 device의 중복 생성을 만들지 않는다.

## 9. 테스트와 실행 결과

2026-08-31 최종 로컬 실행:

- `npm test -- --reporter=dot`: 66 files, 841 tests passed
- Python unittest discovery: 222 tests passed
- `npm run typecheck`: exit 0
- `npm run build`: exit 0
- `npm run package:addon`: exit 0, manifest SHA-256 `aff1aa5577b173b2189efdb4266fafcf3523c6da138b1402da71ef7884434618`
- `npm run audit:api-free`: exit 0
- `npm run audit:fixtures`: exit 0
- `npm run audit:secrets`: exit 0
- `git diff --check`: exit 0

## 10. 미지원 장치와 남은 fallback

- 위험한 lock, valve, garage, door 명령은 기존 fail-closed 정책을 유지한다.
- capability definition이 없거나 malformed이면 해당 명령만 사용할 수 없다.
- Location native와 검증된 DOM fallback은 Advanced가 명시적으로 unsupported일 때만 남는다.

## 11. 보안 점검

- 공식 `api.smartthings.com`, PAT/OAuth/SmartApp/webhook 경로는 계속 금지한다.
- same-origin Cupcake 요청은 `AuthenticatedSmartThingsSession` 파일과 origin/path guard 안에서만 audit allowlist가 적용된다.
- cookie, storage state, Authorization, CSRF, token, 원본 device/location ID와 원본 payload를 로그·diagnostics·서비스에 노출하지 않는다.
- HA 서비스는 aliased `dev_*` ID와 제한된 token/arguments만 받는다.

## 12. 후속 작업과 검증 경계

로컬 코드·테스트·패키지는 검증됐다. 실제 HAOS 0.1.146 배포, 실제 Advanced command permalink에 해당하는 physical device 동작, post-command push, reboot, long-idle, 실제 Socket.IO reconnect는 이번 로컬 작업에서 실행하지 않았다. 따라서 production/physical 동작은 별도 배포 권한과 live 검증 전까지 `DECISION: LIMITED`로 유지한다.
