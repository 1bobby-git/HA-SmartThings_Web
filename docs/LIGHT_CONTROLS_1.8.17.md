# 조명 기능 보완 — 1.8.17

## 수정 범위

Hue의 색상 선택이 없거나 IKEA/Hue 조명이 켜기·끄기만 제공하던 코드 경로를 보완했습니다. 조명 기능을 생성 시점의 Web 슬라이더로 고정하지 않고, 현재 인벤토리의 같은 컴포넌트·capability에 속한 실제 상태와 안전한 명령을 함께 사용합니다. 브랜드·기기 이름·펌웨어 버전을 기준으로 기능을 강제하지 않습니다.

Web 슬라이더가 있으면 기존 경로를 유지합니다. 없으면 확인된 `setLevel`, `setColorTemperature`, `setHue`, `setSaturation` 스칼라 명령을 정확한 별칭 식별자로 전달합니다. 선택적 rate는 생략할 수 있으며 필수 인수나 민감 인수가 추가된 명령, 중복 후보는 임의 실행하지 않습니다. 일반 객체 명령의 허용 범위를 넓히지 않습니다.

밝기 제어가 확인된 조명은 디밍을 지원하며, 색온도와 색상(HS)이 함께 확인되면 두 모드를 모두 제공합니다. 흰색 전용 조명에 색상 기능을 가정하지 않습니다. 값이 null인 꺼진 조명도 실제 제어 계약이 있으면 기능을 유지합니다. 밝기·색온도·색상 변경과 나중에 도착한 기능 정보는 기존 엔티티에 반영합니다.

HA 밝기는 0~255, 색상각은 0~360도이며 native 값은 0~100입니다. 실제 Web 슬라이더의 step을 사용하고, Advanced 스칼라의 기본 정밀도는 1%입니다. 일부 드라이버의 정수 반올림 때문에 존재하지 않는 소수 상태 확인을 기다리는 것을 피합니다. 색온도는 같은 기능에서 제공하는 범위와 명령 범위를 교차 검사합니다. 입력을 모두 검증한 뒤 실행하고, 값은 요청값이 아니라 수신 상태에서 읽습니다.

## 자동화 예제

`light.bedroom_light`는 예시입니다. 실제 엔티티를 선택하세요.

```yaml
action: light.turn_on
target:
  entity_id: light.bedroom_light
data:
  brightness_pct: 60
  color_temp_kelvin: 3000
```

색상 지원 조명은 HA 색상 선택 UI 또는 다음 작업을 사용합니다. 색온도와 색상은 한 요청에 함께 지정하지 않습니다.

```yaml
action: light.turn_on
target:
  entity_id: light.bedroom_light
data:
  brightness_pct: 50
  hs_color: [180, 70]
```

## 업데이트 및 검증

Bridge 앱과 HACS 통합을 모두 **1.8.17**로 업데이트하고 Bridge와 Home Assistant를 재시작합니다. 기존 통합·조명 엔티티 삭제나 재등록은 필요하지 않습니다. README는 첫 사용자용 짧은 안내를 그대로 유지합니다.

회귀 검사는 RGB+색온도 조명, 흰색 조명 세 대의 서로 다른 발견 순서, 늦은 카탈로그·슬라이더 수신, 꺼짐/null, 컴포넌트 분리, 범위·읽기 전용·오프라인, 실제 이벤트 구독, 전송 후 상태 확인을 포함합니다. 모두 합성 데이터이며 사용자 Samsung 계정이나 실제 Hue/IKEA 제어 성공을 원격 확인한 것은 아닙니다. 기기에 실제 명령 또는 상태가 제공되지 않는 기능은 만들어내지 않습니다.

공식 인터페이스: [HA 조명 엔티티](https://developers.home-assistant.io/docs/core/entity/light/), [SmartThings Home API](https://developer.smartthings.com/docs/home-api/home-api-reference).
