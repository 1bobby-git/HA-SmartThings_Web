# Advanced 명령 전용 제어 — 1.8.14

## 제공된 데이터와 적용 범위

사용자가 제공한 `list_commands` 응답에는 `dev_344`의 다음 명령이 있었으며 누락 항목은 없었습니다. 식별자는 설치별 가명입니다. 실제 기기·capability ID를 추측하거나 이 가명을 운영 코드에 하드코딩하지 않습니다.

| 실제 명령 | 추가되는 제어 | 허용 입력 |
|---|---|---|
| `setUpdown` | 선택 | `minus_2`, `minus_1`, `plus_1`, `plus_2` |
| `setFreeze` | 선택 | 문자열 `on`, `off` |
| `setPeopleCounter` | 숫자 입력 | 정수 0~65535 |
| `refresh` | 버튼 | 인수 없음; 기존 refresh가 있으면 중복 생성하지 않음 |
| `push` | 버튼 | 인수 없음 |

같은 규칙은 현재 Advanced 카탈로그의 민감하지 않은 단일 필수 enum·범위가 명시된 정수 명령에 적용합니다. 확인된 명령 목록을 벗어난 버튼은 만들지 않습니다. 기존 Web 제어가 있으면 그 엔티티와 식별자를 우선합니다. `setFreeze`를 일반 전원 스위치로 바꾸거나 `setUpdown`의 상대 명령을 현재 인원수로 해석하지 않습니다.

## 현재값과 성공의 의미

제공된 카탈로그는 명령 인수 정의이지 명령과 상태 속성의 정확한 연결 정보가 아닙니다. 따라서 새 명령 전용 `number`·`select`의 현재값은 `unknown`입니다. 입력한 값을 임의로 현재값에 저장하지 않으며, 같은 capability에 있다는 이유로 센서 속성을 연결하지 않습니다. 실제 상태는 기존 센서에서 확인합니다. 기존 상태 연결이 검증된 숫자·선택 엔티티는 변경하지 않습니다.

새 엔티티에는 `smartthings_command_only: true`, `smartthings_confirmation: accepted_receipt` 속성이 붙습니다. 명령은 `require_advanced: true`, `confirm: false`로 정확한 component·capability에 한 번만 전달합니다. `accepted_unconfirmed`는 요청 접수이지 물리적 동작 완료가 아닙니다. 일반 사용자 정의 명령의 기본 `confirm: true`를 내부적으로 낮추지 않습니다. 상태 매핑이 검증되지 않은 확인형 서비스 호출은 계속 거절될 수 있습니다.

## 직접 호출 예제

다음 식별자는 제공된 응답 그대로입니다. 다른 설치에서는 `smartthings_web.list_commands`에서 받은 정확한 값을 사용하세요.

```yaml
action: smartthings_web.execute_command
data:
  device_id: dev_344
  component: identifier_c9246e0ac435
  capability: identifier_24b23b825273
  command: setPeopleCounter
  arguments: [3]
  confirm: false
```

Freeze 예에서는 capability를 `identifier_0f4a0e165316`, command를 `setFreeze`, arguments를 `["on"]` 또는 `["off"]`로 지정합니다. Updown은 capability `identifier_07455895e52f`, command `setUpdown`, arguments `["plus_1"]` 같은 허용 문자열만 사용합니다. 임의 재전송이나 일괄 기기 제어는 추가하지 않습니다.

## 호환성 및 업데이트

Bridge 앱과 HACS 통합을 모두 1.8.14로 업데이트하고 앱 및 Home Assistant를 재시작하세요. 기존 통합을 삭제해 다시 추가할 필요는 없습니다. 로그인 프로필·인증·영역·기존 엔티티 식별자·Home Monitor 직접 제어·Scene·speak는 이번 변경에서 수정하지 않습니다. wire protocol은 5이고 의존성도 그대로입니다.

브리지 인벤토리에서 명령 정보가 늦게 도착해도 새 제어를 발견합니다. 최신 카탈로그에서 명령이 없어지거나 중복·누락 처리되면 실행을 차단합니다. 정수 범위와 enum을 실행 직전에 다시 검사하며 브리지도 독립적으로 검증합니다. 정확한 새 entity_id는 Home Assistant 등록 상태와 이름 충돌에 따라 정해지므로 고정값을 안내하지 않습니다.

## 검증과 한계

제공된 카탈로그에 기반한 Python 회귀 검사는 다섯 명령의 분류, 경계값·잘못된 값, 정확한 가명 대상, 기존 Web 제어 우선, 늦은 발견, 상태를 조작하지 않는 동작, 명령 제거·오프라인·범위 변경·민감 인수·중복 차단을 포함합니다. 브리지 검사는 사용자 정의 명령의 접수형 전송, 무인수 명령, 정수 거부와 기존 확인형 요청의 의미 보존을 검사합니다. 전체 Validate·Security checks와 패키지 검증은 GitHub Actions 결과를 기준으로 확인합니다.

실제 Samsung 계정이나 사용자의 실행 중인 Home Assistant에서 카운터·Freeze·물리 버튼 효과를 수행하지 않았습니다. 자동 검사 통과를 실제 장치 제어 성공으로 해석해서는 안 됩니다.
