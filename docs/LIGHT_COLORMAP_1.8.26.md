# SmartThings Web 1.8.26 — ColorMap 검증 수정안

## 상태
- 기준 main: 9aca2d9e221f6bca055cfa148897eeb1ee7dcb65 (1.8.25).
- 로컬 작업 시작 트리: 907293b3462d550a655e21c839f5dad384c09f39. GitHub의 1.8.25 트리와 일치 확인.
- 이 문서는 로컬 수정안 검증 결과이다. GitHub 커밋·릴리스 발행 및 사용자 HA 설치 완료를 의미하지 않는다.

## 관측과 원인 범위
사용자 dev_300 명령 목록에는 setHue/setSaturation은 있지만 setColor는 없으며 schema_invalid 합계는 3이다. 이 합계만으로 제외된 세 명령의 이름/스키마를 확정할 수 없다. 이전 로그는 요청 hue/saturation과 실제 조회 값의 지속적인 불일치를 보였다.

기존 color-argument.ts는 hue/saturation 속성만 정확히 두 개, 각 속성에 minimum/maximum 모두 존재하는 경우에만 허용했다. 공개된 ColorMap 형태(추가 선택 속성 hex/level/switch, 숫자 범위 생략)를 주입하면 실제 카탈로그 경로가 setColor를 schema_invalid로 제외한다. 기존 공유 테스트 자료에도 범위 없는 setColor를 제외하는 것을 기대하는 검사가 있었으며, 정상 수용을 기대하도록 고쳤다.

## 수정
- 알려진 선택 ColorMap 속성의 선언과 숫자 범위 생략을 수용한다.
- 전송값은 hue/saturation 두 숫자만 허용한다. 허용 범위는 선언된 범위와 0..100의 교집합이며 정수 제약을 유지한다.
- 추가 필수 속성, 미지원 복합 제약, 잘못된 숫자 범위는 거부한다. 검증 우회나 임의 성공 처리는 없다.
- 기존 HA setColor 우선 경로, Bridge 순차 전송, 최신 조작 우선 처리를 그대로 사용한다.
- dispatch 진단에 검증된 명령명만 추가한다. 비밀정보나 원본 식별자는 추가하지 않는다.
- Home Monitor 관련 구현은 변경하지 않는다.

## 실행한 검증
- Node 전체: 109개 파일, 1,431개 테스트 통과.
- Python 전체: 393개 테스트 통과. 이 전체 검사에는 조명 격리 테스트 실행 래퍼가 포함된다.
- 조명 격리 실행: 61개 테스트 통과(393개와 별개의 추가 총수로 합산하지 않는다).
- TypeScript 타입 검사 및 빌드 통과.
- API 경계 검사, 생산 소스 비밀정보 검사, 테스트 자료 정제 검사 통과.
- 앱 패키징 통과.
- 최신 npm 취약점 조회, GitHub CI/Chromium/HAOS 실환경 시작 검증은 이번 작업에서 수행하지 않았다.

## 설치 후 확인할 성공 기준
1. Bridge 앱과 HACS 통합의 실행 버전이 모두 수정 버전이어야 한다.
2. smartthings_web.list_commands에서 dev_300에 정상화된 setColor가 나타나야 한다. 다른 제외 명령이 있다면 schema_invalid 합계는 0이 아닐 수도 있다.
3. dispatch 로그에서 setColor를 사용했는지 확인한다.
4. hue=34, saturation=96 요청 뒤 실제 GET/이벤트 값과 전구 동작을 비교한다. 마지막 요청이 실제로 반영되지 않으면 실패를 유지해야 한다.
5. 전원·밝기·색온도의 실기기 검증은 별도로 필요하다. 색상 누락 수정만으로 모든 지연의 해결을 단정하지 않는다.

## 자료
- 원본 검증 코드: https://github.com/1bobby-git/HA-SmartThings_Web/blob/9aca2d9e221f6bca055cfa148897eeb1ee7dcb65/bridge/src/advanced/color-argument.ts
- JSON Schema 숫자 범위는 최소/최대 한쪽만 정의할 수도 있음: https://developer.smartthings.com/docs/devices/capabilities/
- ColorMap 공개 캡처(사용자 기기의 최신 응답은 아님): https://github.com/hongtat/smartthings-capabilities/blob/824124d2ca0e4ba322fa4cd86a96fdd7709d0845/json/colorControl.json
- SmartThings 지원팀은 앱의 색상 선택에 setColor를 사용한다고 안내: https://community.smartthings.com/t/bug-with-sethue-and-setsaturation-commands-for-devices-with-colorcontrol-capabilities/253078
