# 재실 센서와 방/영역 동기화 — 1.8.16

## 서로 다른 세 가지 엔티티

| 기능 | HA 타입 | 기준 |
|---|---|---|
| 인원수 설정 | 기존 `number` | Advanced 명령의 정수 입력. 실측값이 아님 |
| 실제 현재 인원수 | 기존 `sensor` | 수신한 `peopleCounter`, 증감 가능한 measurement |
| 재실 여부 | 새 `binary_sensor`, `device_class: occupancy` | 직접 `occupancy` 또는 실제 현재 인원수 |

컴포넌트별 직접 occupancy 속성이 하나면 그것을 우선합니다. 직접 상태가 없고 peopleCounter가 하나면 0은 미재실, 양의 정수는 재실입니다. 실제 인원수에서 계산한 **파생 상태**이며 물리적 mmWave 센서를 추가하거나 인원 카운터의 드리프트를 보정하는 것은 아닙니다. null·음수·소수·문자열·잘못된 값은 unknown이지 미재실이 아닙니다. 오프라인, 삭제된 소스, 중복으로 모호해진 소스는 unavailable입니다.

직접 재실 데이터가 늦게 도착하면 기존 새 엔티티 안에서 소스만 변경하며 컴포넌트별 unique_id는 같습니다. 같은 컴포넌트의 두 소스를 합산/임의 선택하지 않습니다. 명령 카탈로그만 있고 실제 상태가 없으면 모델 분류는 가능하지만 재실 엔티티를 만들어 값을 추측하지 않습니다. 기존 number/select, 현재 인원수 sensor, 엔티티 ID, 사용자 이름은 변경하지 않습니다.

새 엔티티의 속성 `smartthings_occupancy_source`는 occupancy 또는 peopleCounter이며, `smartthings_derived`가 true이면 인원수 기반입니다. `smartthings_people_count`에서 계산에 사용한 실제 수신 숫자를 확인할 수 있습니다. 추가 폴링·재실 추정 타이머·명령 전송은 없습니다.

## Advanced와 모델 표시

Advanced `components[].categories[].name`의 공개 `PresenceSensor`, `MotionSensor`, `MobilePresence`만 허용 목록으로 전달하며 컴포넌트 식별자는 기존 가명 처리를 사용합니다. 원본 프로필이나 임의의 카테고리 문자열은 저장/전달하지 않습니다. 실제 하드웨어 모델을 먼저 보존하고, 카운터 기능이 확인되면 모션 아이콘보다 `재실 센서 (인원 카운터)` 기본 표시를 우선합니다. 카테고리만으로 상태값을 생성하지 않으며 기존 motion·모바일 presence의 의미도 변경하지 않습니다.

## 방 동기화

**기본값이 꺼짐에서 켜짐으로 바뀝니다.** 기존 옵션이 없는 설치도 확인된 SmartThings 방을 따라갑니다. 저장된 `sync_rooms: false`는 변경하지 않습니다. 이 값이 있는 설치에서 방 동기화를 요청하려면 통합 옵션의 ‘SmartThings 방과 기기 영역 동기화’를 켭니다. 켜진 상태에서는 HA의 수동 기기 영역보다 SmartThings 방을 우선합니다. HA의 기기 영역을 독립적으로 관리하려면 끄세요.

기기 roomId와 같은 location의 방 목록을 **현재 로그인 세션에서 Advanced로 확인한 경우만** 기기 영역을 변경합니다. 예를 들어 HA는 거실, 확인된 SmartThings room은 주방이면 주방 영역으로 교정합니다. 명시적 null 방은 같은 검증 조건에서 해제합니다. 정보 누락, 다른 location, 출처 없는 캐시, 모호한 이름은 현재 영역을 유지합니다. 다른 통합과 공유된 기기 및 엔티티별 수동 영역은 덮어쓰지 않습니다.

HA 영역 생성/이름 변경/삭제, 우리 기기의 영역 변경도 캐시를 무효화하고 다음 이벤트 루프에서 한 번 병합해 재검사합니다. 정상 동기화로 발생한 자체 이벤트는 추가 쓰기를 만들지 않습니다. 통합 언로드 시 구독과 예약 콜백을 정리합니다. 영역 자체를 삭제하거나 모든 기기의 이름/ID를 다시 만들지 않습니다.

## 업데이트 및 검증 범위

Bridge 앱과 HACS 통합을 모두 **1.8.16**으로 업데이트하고 Bridge와 Home Assistant를 재시작합니다. 통합 삭제·재등록, 엔티티 삭제, 로그인 프로필 초기화는 필요하지 않습니다. protocol 5와 의존성, Home Monitor 직접 제어, Scene, speak는 유지합니다.

새 검사는 직접 재실/카운터 상태 전환, 경계값·unknown·오프라인, 컴포넌트 격리, 원본/ID 보존, 늦은 발견·중복 방지, Advanced 카테고리의 가명화·허용 목록·캐시 복원, 기존 잘못된 영역 교정, 명시적 끔, HA 레지스트리 이벤트·언로드 정리를 포함합니다. 자동 검증은 합성 데이터이며 사용자의 현재 Samsung 기기 상태나 실제 방을 조회한 결과가 아닙니다. GitHub 배포와 사용 중인 HA 설치는 별개입니다.

공식 의미: [HA binary sensor](https://developers.home-assistant.io/docs/core/entity/binary-sensor/), [SmartThings device profiles](https://developer.smartthings.com/docs/devices/device-profiles).
