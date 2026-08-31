# SmartThings Web component 명령·Advanced 검증 설계

## 목적

두 문제를 같은 증거 체계로 해결한다.

1. 실제 온라인 기기가 Advanced의 오래되거나 시간이 없는 `OFFLINE` 값 때문에 Home Assistant에서 `unavailable`이 되는 문제
2. 화장실 조명처럼 하나의 HA switch 뒤에 여러 SmartThings switch component가 있는데 main Web 명령만 보내고 실제 상태가 바뀌지 않는 문제

UI에는 장치당 대표 switch 하나를 유지한다. 내부에서는 실행 가능한 component들을 조작하고 Advanced status와 Location event로 결과를 검증한다.

## 확인된 원인

- `advancedOnlineState()`는 Advanced의 `OFFLINE` 문자열을 timestamp 없이도 `device.online=false`로 적용한다.
- 새 `LOCATION_EVENT`가 도착해도 DeviceStore는 상태 값만 바꾸고 `online=true`로 복구하지 않는다.
- 현재 offline 판정 장치 중 `Screen Sync Smart Light 2.0`과 거실 가습기는 offline 표시 이후에도 최신 Location event를 보냈다.
- 화장실 조명 `dev_144`는 main, switch2, switch3, switch4 상태가 있지만 HA에는 main switch 하나만 있다.
- main native 명령은 두 번 전송됐지만 Advanced status와 Location event 모두 요청한 `off`를 확인하지 못해 `command_confirmation_timeout`이 발생했다.

## 선택한 방식

추천안은 **component transaction + Advanced status verification + state-first availability**다.

다른 방식은 사용하지 않는다.

- 모든 기기를 무조건 online 처리하지 않는다. 실제 고장을 숨길 수 있다.
- secondary switch 3개를 다시 HA UI에 노출하지 않는다. 사용자가 원한 단일 장치 제어를 깨뜨린다.
- main 명령 실패 직후 검증 없이 DOM을 중복 실행하지 않는다.

## Availability 증거 우선순위

DeviceStore는 장치별 `lastPositiveEvidenceAt`과 `healthUpdatedAt`을 비교한다.

온라인 증거:

- 최신 Location `DEVICE_EVENT`
- 성공한 Advanced `/status` 조회
- 성공한 component command의 Advanced status 확인
- 최신 Location `DEVICE_HEALTH_EVENT=ONLINE`

오프라인 증거:

- timestamp가 있는 Location `DEVICE_HEALTH_EVENT=OFFLINE`
- timestamp가 있고 마지막 positive evidence보다 새로운 Advanced health `OFFLINE`

시간이 없는 Advanced `OFFLINE`은 availability를 바꾸지 않는다. 더 새로운 상태 이벤트가 오면 즉시 online으로 복구한다. entity 상태와 마지막 값은 유지한다.

## Component 명령 계획

대표 HA switch가 눌리면 다음 순서로 처리한다.

1. 현재 Advanced status에서 모든 switch component와 원래 값 벡터를 읽는다.
2. capability definition에서 해당 component의 `switch.on/off` 지원을 확인한다.
3. main을 포함한 실행 가능한 switch component를 안정된 component 순서로 직렬 실행한다.
4. 각 POST의 `ACCEPTED`는 접수로만 기록한다.
5. 모든 POST 후 Advanced `/status`를 한 번 읽는다.
6. 각 component의 `switch` 값이 요청 값과 일치해야 성공한다.
7. Location event가 도착하면 같은 component 상태를 먼저 적용하며 Advanced status와 모순되면 더 최신 timestamp가 이긴다.

`off`는 대상 component 전체를 `off`로 만든다. `on`도 대표 switch 의미에 맞춰 대상 component 전체를 `on`으로 만든다.

## 부분 실패와 rollback

- component 명령은 장치별 mutex 안에서 실행한다.
- 일부 component만 성공하면 성공한 component를 명령 전 상태 벡터로 되돌린다.
- rollback도 Advanced status로 검증한다.
- rollback 검증에 실패하면 `component_command_partial_failure`를 반환하고 실제 component 결과를 diagnostics 집계에 남긴다.
- 불확실한 timeout 뒤에는 Web/DOM/Advanced 다른 transport로 같은 명령을 다시 보내지 않는다.
- lock, valve, door, garage와 위험 장치는 component transaction 대상에서 제외한다.

## 적용 범위

- component가 하나인 기존 switch/light는 검증된 Web native 경로를 유지한다.
- switch component가 둘 이상이고 정확한 Advanced command schema가 있는 장치만 component transaction을 사용한다.
- 첫 live 검증 대상은 `dev_144` 화장실 조명이다.
- 기존에 성공한 `dev_151` 거실 간접등은 회귀 표본으로 사용하며 원래 상태로 복구한다.

## Home Assistant 표시

- HA switch는 계속 하나만 유지한다.
- 추가 attribute로 component 개수, 검증 결과, 마지막 확인 시각만 노출한다.
- raw component ID와 원본 device ID는 diagnostics와 로그에서 계속 마스킹한다.
- component별 실제 값은 사용자 식별자가 아닌 역할 이름(`main`, `switch2` 등)만 사용한다.

## 테스트

구현 전에 다음 실패 테스트를 추가한다.

1. timestamp 없는 Advanced `OFFLINE`이 online 장치를 unavailable로 만들지 않는다.
2. 최신 Location state event가 이전 offline health보다 새로우면 online으로 복구한다.
3. 더 최신 timestamp의 health OFFLINE은 유지된다.
4. 다중 component off 명령이 모든 component에 정확한 body를 순서대로 보낸다.
5. Advanced status에서 모든 component가 off일 때만 성공한다.
6. 일부 component 실패 시 원래 상태 벡터로 rollback한다.
7. rollback 실패는 부분 실패 오류를 반환한다.
8. 단일 component 장치는 기존 Web native 경로를 유지한다.
9. 위험 장치는 component transaction을 거부한다.
10. 로그와 diagnostics에 raw ID, cookie, token, CSRF가 없다.

## live 완료 조건

- 화장실 조명을 원래 상태에서 반대 상태로 전환하고 Advanced status의 네 component가 모두 요청 값과 일치한다.
- HA 대표 switch가 같은 결과를 표시한다.
- 원래 상태 벡터로 복구하고 Advanced status와 HA 상태를 다시 확인한다.
- false offline 장치 중 최신 Location event가 있는 표본이 `available`로 복구된다.
- 실제 timestamp가 더 새로운 명시적 health OFFLINE 표본은 offline으로 유지된다.
- 전체 Node/Python 테스트, typecheck, build, package, audits와 HAOS runtime hash 검증을 통과한다.

공식 SmartThings API, PAT/OAuth/SmartApp/webhook, cookie replay, DOM 상태 스크래핑, optimistic HA mutation은 사용하지 않는다.
