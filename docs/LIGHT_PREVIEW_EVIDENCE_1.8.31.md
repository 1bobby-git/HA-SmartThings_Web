# 조명 중복 전원 명령 생략의 검증 불일치 수정 — 1.8.31

## 실제 관측과 확인 범위
기준은 1.8.30, 커밋 `5e7577a35f35002e12eaa857f3b5c4f654b56cd7`이다. 사용자가 제공한 dev_200 로그에서 사전 조회는 65~84ms였지만 `skippedCommands: []`로 남아 `on → setColor`나 `on → setLevel`이 순차 실행됐다. 예를 들어 색상은 접수 1736ms/확인 1737ms, 밝기는 접수 1718ms/확인 1803ms였다. 단독 켜기는 접수 801ms/확인 901ms였다. 개별 POST의 fetchMs는 브라우저 내 요청부터 응답 헤더까지의 시간이며 서버 처리만을 의미하지 않는다.

이전 로그에는 사전 검증의 탈락 이유가 없다. 아래 두 가지 결함을 소스/회귀 검사로 재현했지만, 사용자 기기에서 어떤 조건이 실제로 실패했는지 확정한 것은 아니다. 물리 전구 및 사용자 HA 화면의 개선 시간도 측정하지 않았다.

## 수정
1. 등록 정보와 대상 상태에서 역할명이 `Main`/`main`처럼 대소문자만 다르면 동일한 의미의 역할로 비교한다. 이 규칙은 조명 중복 생략 판단의 메타데이터에만 적용한다. 불투명 ID나 값·단위를 변환하지 않는다. 실제 다른 역할과 누락된 역할의 충돌은 계속 거부한다.
2. 기존 관측이 LOCATION_EVENT이며 그 이벤트 시각보다 Advanced 속성 timestamp가 이전일 때, 첫 GET만으로 거부하거나 바로 신뢰하지 않고 두 번째 독립 GET으로 확인한다. 두 응답의 동일 대상 전원/밝기 값·시각·메타데이터가 일치하고 기존 관측값도 같으며 상태 revision이 그대로일 때만 생략한다. 같은 출처의 오래된 snapshot은 여전히 거부한다. store와 HA의 값이나 timestamp를 변경하지 않는다.
3. 두 읽기는 순차 실행하며 기존 사전 확인의 총 400ms 예산을 공유한다. 조회 실패·지연·취소·잘못된 대상·중간 상태 변경을 우회하지 않는다. 첫 읽기와 두 번째 읽기의 밝기만 다르면 setLevel을 유지하고, 전원이 다르면 최적화 전체를 취소한다.
4. 실제 변경 setter 및 단독 on/off는 계속 보내며 생략한 목표도 명령 이후 전체 확인에 포함한다. POST 접수나 사전 조회로 성공 처리하지 않는다. 기존 latest-intent 취소, 전송 순서, 실패 처리, 로그인 유지 및 Home Monitor 구현은 변경하지 않는다.

## 진단 예시
이미 켜진 전구의 색상만 바꾸고 검증 조건이 충족된 경우의 예시다. 실제 운영 로그를 꾸민 것이 아니다.

```json
{"commands":["setColor"],"skippedCommands":["on"],"preflightReason":"pruned_corroborated","preflightReads":2}
```

주요 reason은 `pruned`(기본 검증 통과), `pruned_corroborated`(두 번 확인), `power_not_on`, `power_unit_mismatch`, `power_component_role_mismatch`, `power_capability_role_mismatch`, `power_value_mismatch`, `power_timestamp_older`, `revision_changed`, `corroboration_failed`, `read_unavailable`, `read_too_slow`이다. enum·횟수만 추가하며 쿠키, 토큰, 원본 ID나 응답은 기록하지 않는다. 기존 preflightSource·preflightMs·개별 POST 타이밍도 유지한다.

## 검증
로컬 전체 Node 1,569개(112개 파일), Python 402개, 타입 검사·빌드·API 경계/비밀정보/fixture 검사와 패키징을 통과했다.

기존 1.8.30의 production 함수를 같은 회귀 검사에 넣으면 역할 차이/두 번 독립 조회/실제 runtime 등록 라벨을 포함한 네 가지 신규 검사가 실패한다. 수정안은 이 경로와 잘못된 대상·단위·역할·오래된 같은 출처·읽기 충돌·시간 예산·취소·무반응 timeout 유지 검사를 통과해야 한다.

실제 서비스/카탈로그/명령 어댑터를 가상 시계에서 실행하고 GET 80ms, POST 800ms로 고정한 합성 비교에서는 기존 1681ms(1 GET + 2 POST), 수정 961ms(2 GET + 1 POST)이다. 차이는 720ms이며 사용자 전구의 실측 개선 수치나 보장값은 아니다. 단독 전원 명령의 약 0.8~1초에 해당하는 기존 요청 왕복은 줄이지 않는다.

GitHub 전체 Validate/Security, 기존 Chromium Home Monitor/Advanced 타이밍/로그인 세션 복원, HAOS 패키지 시작, HACS/Hassfest를 통과한 뒤 릴리스한다. Bridge와 HACS 통합을 함께 업데이트한다. 새 로그에서 여전히 skippedCommands가 비어 있으면 preflightReason으로 실제 남은 경로를 구분할 수 있다.
