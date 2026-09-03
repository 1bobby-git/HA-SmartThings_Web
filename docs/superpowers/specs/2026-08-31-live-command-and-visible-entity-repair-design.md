# SmartThings Web 실명령·가시 엔티티 복구 설계

## 목적

`0.1.146`의 Advanced 백엔드 전환은 실제 HAOS에서 로드됐지만, 사용자가 보는 엔티티 구조와 실제 명령 성공을 개선하지 못했다. 이 설계는 다음 세 결과를 동시에 만든다.

1. `switch.turn_on`과 `button.press`가 실행 가능한 SmartThings Web 경로로 전달된다.
2. 실행할 수 없는 Advanced 상태는 Home Assistant 제어 엔티티로 노출되지 않는다.
3. 승인된 중복 장치 쌍은 기존 공개 식별자를 보존하면서 하나의 카드로 수렴한다.

기존 `smartthings_web` 도메인은 공식 `smartthings` 통합과 계속 분리한다. 공식 API, PAT/OAuth, SmartApp, webhook, DOM 상태 스크래핑, 쿠키 재사용, 낙관적 상태 변경은 사용하지 않는다.

## 확인된 현재 결함

- Bridge가 `CONNECTED`, `ready=true`, `advanced-primary-v1`인 상태에서도 HA 서비스 호출과 직접 인증된 Bridge 호출이 `command_execution_failed`를 반환한다.
- `AdvancedFirstCommandExecutor`는 Advanced 오류가 `unsupported`일 때만 Web 경로로 이동한다. 그 밖의 오류는 구체적인 원인을 잃고 `command_execution_failed`로 합쳐진다.
- `거실 간접등`은 Advanced switch 상태가 네 개지만 실행 가능한 Web toggle은 main 하나뿐이다. 현재 Home Assistant에는 네 switch가 모두 활성화돼 있다.
- 같은 기기에 Advanced refresh control이 component마다 네 개 생기고 Home Assistant에도 Refresh 버튼 네 개가 생성된다.
- `벽난로`는 같은 location, room, 이름, 장치 유형을 가진 Cloud `dev_185`와 Local child `dev_602`가 별도 카드로 노출된다.
- 현재 테스트는 제어가 없는 switch state와 보조 switch를 생성하는 동작을 정상으로 간주한다.

## 명령 라우팅

명령 라우팅은 "조회에 가장 풍부한 출처"와 "실제로 검증된 실행 출처"를 분리한다.

1. Advanced는 인벤토리, 상태, health, component, capability와 argument schema의 주 데이터 소스다.
2. 각 Home Assistant 제어 엔티티는 정확히 일치하는 관찰된 Web control을 가져야 한다.
3. 기본 실행은 그 control이 제공한 `/location` native dispatcher를 사용한다.
4. Advanced 명령은 같은 장치·component·capability·command 조합이 실제 HAOS에서 `ACCEPTED` 후 push/status로 확인된 경우에만 사용할 수 있다.
5. Advanced 실행 여부를 증명하는 기록이 없으면 Advanced POST를 추측해서 먼저 보내지 않는다.
6. timeout, 응답 손실, `ACCEPTED` 이후 불확실 상태에서는 다른 transport로 재전송하지 않는다. 중복 물리 명령을 막기 위해 실패로 종료하고 상태 재조회만 수행한다.
7. DOM fallback은 기존 검증 조건을 모두 만족하는 control에 한해 마지막으로 유지한다.

첫 복구 릴리스에서는 현재 실증된 Web native dispatcher가 기본이다. Advanced command adapter와 capability validation 코드는 유지하며, 후속 실증 결과를 transport-evidence 정책에 추가할 수 있다.

## 명령 진단

실패는 민감정보 없이 다음 집계 필드로 남긴다.

- transport
- stage: resolve, validate, dispatch, receipt, confirm
- safe error class
- HTTP status class 또는 endpoint-changed 여부
- fallback attempted 여부
- command lifecycle

실제 device ID, location ID, component/capability 원문, 요청 body, 쿠키, token, CSRF 값은 기록하지 않는다. Home Assistant 오류에는 기존 안전 코드와 transport/stage만 포함해 `command_execution_failed` 한 종류로 모든 원인이 사라지지 않게 한다.

## switch 엔티티 정책

`switch` attribute가 존재한다는 사실만으로 SwitchEntity를 생성하지 않는다.

- 정확한 component, capability, attribute에 대응하는 유일한 toggle control이 있어야 한다.
- control은 `safe_observed_control()`과 양방향 on/off 검사를 통과해야 한다.
- main과 secondary를 같은 규칙으로 판정한다.
- 상태는 있지만 control이 없는 secondary component는 제어 엔티티로 생성하지 않는다.
- 원시 상태 보존이 필요한 경우 기존 diagnostics에서만 확인하며 일반 제어 카드로 승격하지 않는다.
- 이미 registry에 존재하는 무제어 switch 엔티티는 명시적 migration에서 제거한다. 사용자 정의 이름이나 자동화가 붙은 실행 가능한 엔티티는 유지한다.

`거실 간접등`의 완료 상태는 main switch 하나만 남고 `스위치 2/3/4`가 registry와 UI에서 제거되는 것이다.

## Refresh 버튼 정책

Refresh는 장치 단위 동작으로 노출한다.

- main component의 안전한 refresh control을 우선한다.
- main이 없으면 정렬된 첫 안전 control 하나만 사용한다.
- 동일 장치의 나머지 component refresh control은 인벤토리에 보존하지만 ButtonEntity로 생성하지 않는다.
- 기존 중복 Refresh registry 엔티티는 canonical control 하나를 제외하고 migration에서 제거한다.

## 벽난로 canonical 그룹

일반적인 이름 기반 자동 병합은 하지 않는다. 병합은 다음 강한 조건을 모두 만족할 때만 허용한다.

- 같은 location과 room
- 같은 정규화 이름과 장치 유형
- 같은 owner identity
- Cloud 장치 하나와 Local child 장치 하나의 정확한 쌍
- switch/light 상태 signature가 중복됨
- 세 번째 후보가 없음

승인된 현재 쌍에서는 `dev_185`를 공개 canonical ID로 유지한다. 기존 entity unique ID와 자동화 참조를 보존하기 위해서다. `dev_602`의 최신 Advanced health, firmware, parent 관계와 더 최신인 상태는 내부 source binding으로 합친다.

충돌 상태는 attribute별 `updatedAt`이 더 최신인 값을 사용한다. 시간이 없거나 같으면서 값이 다르면 기존 canonical 값을 유지하고 diagnostics에 conflict count만 올린다. 명령 target은 실행 가능한 관찰 control이 연결된 source를 선택하며, control이 없으면 제어 엔티티를 만들지 않는다.

## 실시간 상태 경로

상태 경로는 다음 불변조건을 유지한다.

```text
Location push -> DeviceStore -> SSE -> SmartThingsWebRuntime -> exact entity listener
```

- Advanced snapshot은 더 최신인 Location event를 덮지 않는다.
- 중복 event는 한 번만 적용한다.
- sequence gap 또는 SSE reconnect는 전체 inventory resync 후 재개한다.
- entity registry migration은 topology가 실제로 바뀔 때만 실행한다.
- 값만 바뀐 push는 해당 state/device listener만 호출하고 전체 registry migration을 실행하지 않는다.

실동작 검증에서는 명령 전 Bridge sequence와 HA state를 기록하고, 명령 후 같은 component/capability/attribute의 더 새로운 push와 HA state 변경을 모두 확인한다.

## Registry migration

마이그레이션은 현재 inventory에서 생성 가능한 canonical unique ID 집합을 계산한다.

- control 없는 switch unique ID 제거
- 비canonical refresh button unique ID 제거
- `dev_602` 엔티티는 canonical `dev_185` 엔티티가 동일 의미를 제공할 때 제거
- 남길 canonical entity ID, 사용자 이름, area, enabled state는 변경하지 않음
- 다른 config entry, 공식 통합 또는 수동 엔티티는 건드리지 않음
- 완전한 `ready=true` inventory에서만 destructive cleanup 실행

배포 전 Home Assistant registry와 Bridge source를 백업하고, 제거 대상 entity/device ID 목록을 출력해 범위를 검증한다.

## 테스트 설계

구현 전에 다음 실패 테스트를 추가한다.

1. 관찰 toggle이 없는 main switch state는 SwitchEntity를 만들지 않는다.
2. 네 switch state와 main toggle 하나가 있는 장치는 main SwitchEntity 하나만 만든다.
3. component별 refresh 네 개는 canonical ButtonEntity 하나만 만든다.
4. migration은 무제어 secondary switch와 중복 refresh만 제거하고 canonical 엔티티를 유지한다.
5. 승인된 Cloud/Local duplicate pair는 `dev_185` ID 하나로 합쳐지고 최신 상태·health를 보존한다.
6. 일반적인 동명이거나 강한 조건이 부족한 장치는 병합하지 않는다.
7. Web native transport가 정확한 control identity로 실행되고 post-command event로 확정된다.
8. Advanced가 검증되지 않은 control에는 Advanced POST를 시도하지 않는다.
9. 불확실한 Advanced 결과 뒤에 두 번째 transport를 실행하지 않는다.
10. 명령 실패 diagnostics가 transport/stage를 보존하면서 식별자와 인증정보를 노출하지 않는다.

수정 후 targeted 테스트, 전체 Vitest, 전체 Home Assistant Python 테스트, typecheck, build, package, secret/API-free/fixture audits를 실행한다.

## 배포와 완료 조건

- Lore 형식 커밋을 `main`에 push한다.
- 새 patch 버전 HACS 릴리스를 발행한다.
- 릴리스 asset SHA와 HAOS runtime package manifest SHA를 일치시킨다.
- HAOS 배포 전 source와 integration registry를 백업한다.
- 배포 후 integration/Core와 add-on을 정상 재시작한다.
- 안전한 switch를 원래 상태로 복구 가능한 방향으로 실행하고 post-command push와 HA state를 확인한다.
- canonical Refresh 버튼 하나를 Home Assistant에서 실행해 성공 응답을 확인한다.
- `거실 간접등` main switch 하나, Refresh 하나, 벽난로 카드 하나를 registry와 실제 UI에서 확인한다.
- Samsung 로그인, CAPTCHA, MFA가 필요하면 우회하지 않고 정확한 blocker로 남긴다.
