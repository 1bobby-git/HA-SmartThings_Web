# 조명 명령 스키마 누락 수정 — 1.8.18

## 증상과 원인

1.8.17의 실제 사용자 응답은 전원·색온도·ping·refresh만 조회되고 `schema_invalid: 6`이었습니다. 이는 전체 연결 실패나 버전 미적용이 아니라 일부 명령이 카탈로그의 스키마 검사에서 제외된 결과입니다. 개수만으로 여섯 명령의 이름/원본 스키마를 모두 특정할 수는 없습니다.

기존 파서는 숫자 스키마의 `title`까지 지원하지 않는 제약으로 간주했습니다. 예를 들어 선택적 rate 인수에 `title: PositiveInteger`가 있으면 밝기 명령 전체가 제외되고, hue/saturation의 `title: PositiveNumber`도 색상 명령을 제외합니다. HA 쪽 조명 제어만 보완했던 1.8.17에서는 이 앞단의 누락이 남아 있었습니다.

## 변경

문자열 `title`과 `description`만 설명용 메타데이터로 인정해 공개 카탈로그에서 제거합니다. 타입·최솟값·최댓값·열거값 등 검증 조건은 그대로 유지합니다. 제목을 보고 타입을 추측하거나, 없는 명령을 만들거나, 선택적 인수의 기본값을 임의로 채우지 않습니다. 아직 처리하지 않는 `properties`, `items`, `$ref`, `pattern`, `multipleOf` 등의 제약을 버리고 명령을 허용하지 않습니다. 기존 위험 명령/민감 인수 차단도 유지합니다.

확인된 숫자 명령이 복원되면 1.8.17의 기존 동적 조명 연결이 같은 컴포넌트의 실제 상태와 결합하여 밝기·색상(HS)·색온도 기능을 제공합니다. 단순 전원 전구에 기능을 강제로 부여하지 않습니다.

## 업데이트와 확인

Bridge 앱과 HACS 통합을 모두 **1.8.18**로 업데이트한 뒤 Bridge와 Home Assistant를 재시작합니다. 계정 재로그인, 통합 삭제/재등록, 엔티티 삭제나 새 페어링은 일반 업데이트에 필요하지 않습니다. 짧은 README는 변경하지 않습니다.

`smartthings_web.list_commands`에서 대상 조명의 `setLevel`, 색상 지원 시 `setHue`·`setSaturation`, 색온도 지원 시 `setColorTemperature`가 포함되는지 확인합니다. `rate`는 선택 인수(`required: false`)입니다. 그 밖의 미지원 복합 명령은 제외될 수 있으므로 **omissions 개수가 반드시 0이 되어야 정상인 것은 아닙니다.**

## 검증 범위

회귀 데이터는 계정에서 추출한 원문이 아닌 합성 데이터입니다. 설명이 붙은 원본 형태 capability 정의를 실제 TypeScript 캐시 파서/카탈로그에 넣은 출력과, Python이 읽어 조명 엔티티에 연결하는 공개 JSON을 공유합니다. 기존 코드에서 해당 세 숫자 명령이 누락되는 것을 재현하고, 수정 후 필수/선택 인수와 범위 제한, 색상/색온도, 기존 ID 및 비낙관적 상태 처리를 검사합니다. 실제 Hue/IKEA 기기 제어 완료나 여섯 누락 명령 전체의 해소를 자동 검사만으로 주장하지 않습니다.

참고: [SmartThings capability 정의](https://developer.smartthings.com/docs/devices/capabilities/), [JSON Schema 설명용 키워드](https://json-schema.org/understanding-json-schema/reference/annotations), [기존 조명 제어](LIGHT_CONTROLS_1.8.17.md).
