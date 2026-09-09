# 단독 전원도 느린 경우의 로컬 지연 제거 — 1.8.33

## 관측과 한계
기준은 008736d241387d1d3d46ca83a744d773cfaaed9c (1.8.32)이다. 제공된 웹아카이브의 단독 켜기 기록은 접수803ms/확인909ms, 해당 POST는 전체800ms/브라우저797ms/fetch792ms/브리지 추가3ms였다. 별도 조작에는 POST전체2234ms/브라우저1093ms/브리지 추가1141ms, 사전 조회790ms도 기록됐다. Core inventory 응답의 임시파일 버퍼링 경고가54회 있었다. 이 수치가 물리 점등 시간이나 HA 화면 렌더링 지연을 직접 측정한 것은 아니다. 브리지 추가 지연1141ms의 원인을 이 파일만으로 특정 함수나 디스크라고 확정하지 않는다.

캡처된 명령은 mode_sequence이며 묶음 전송이 실행된 증거가 없다. 사용자가 이후 옵션을 켰다는 보고를 부정하지 않으며, 캡처의 설정이 현재 설정과 같다고 단정하지 않는다. 한 명령의 실제 왕복은 묶음 설정으로 없어지지 않는다.

## 변경
기존 코드에서는 새 조명 요청의 검증과 실행에 전체 inventory.snapshot을 각각 만들고, 상태 재조회에도 전체를 만들어 대상 하나를 찾았다. 이 작업은 수많은 관련 없는 상태와 중첩된 명령 스키마를 동기 복사한다. 접수 검증/실행 전 일부 시간은 기존 command_device:start 이전이어서 해당 로그로는 보이지 않았다.

DeviceStore.device(id)는 전체 snapshot과 동일한 순수 복사 함수를 통해 해당 기기만 반환한다. 오프라인 기기도 반환해 기존 명시적 오프라인 오류를 유지한다. 같은 값 필터와 중첩 복사 규칙을 사용하며 새 요청값을 실제 상태처럼 표시하지 않는다. light plan 경로만 전체 목록 없이 실행한다. 접수 때의 상태를 대기열 이후 재사용하지 않고 다시 읽고 계약과 온라인 상태를 검증한다. 장면/위치/복합 기기의 검증 범위는 그대로다.

명령 대기/실행 중 새 백그라운드 상세 탐색의 시작을 보류한다. Core 전용 프록시의 proxy_buffering을 off로 지정해 inventory 응답을 임시파일로 넘기지 않고 스트리밍한다. 접근제어와 API 인증은 바꾸지 않는다. full inventory API 자체의 내용이나 재동기화 규칙을 제거하지 않는다.

새 command_request_timing은 service.execute 진입부터 호출자가 결과를 받기까지의 admissionMs/queueMs/executionMs/totalMs와 고정 outcome, 대상 별칭만 기록한다. 기존 dispatch/receipt/read/confirmed와 함께 비교한다. superseded 결과가 먼저 반환돼도 실제 전송 중인 명령은 기존 직렬화 규칙대로 끝날 때까지 대기열을 점유하므로 다음 명령의 queueMs에 그 시간이 나타난다. HA 요청 전 네트워크나 화면 렌더링 시간까지 포함하는 수치는 아니다. 중복 clientRequestId는 전송과 새 로그를 한 번만 만든다.

bridge_init:light_command_mode:batch 또는 sequence는 실행 프로세스가 읽은 옵션을 표시한다. 기존 light_command_batch_enabled의 기본값과 의미를 변경하지 않는다. 이번 대상 읽기 개선은 옵션 값과 상관없이 적용된다.

## 검증
400~500대 합성 기기와 실제 서비스/카탈로그/어댑터로 단독 on/off 및 색상 명령이 whole snapshot을 호출하지 않으며 실제 상태 확인이 끝나야 성공함을 검사한다. 기존 production command-service에 같은 선택 검사3개를 넣으면 전체 snapshot 호출로 실패하는 것을 재현했다. 실제 runtime 등록→별칭→Bridge HTTP→명령/재조회 경로에서도 batch false/true 모두 전역 snapshot 호출이0회임을 검사했다. 중첩 스키마 복사, 오프라인 변경 재검증, 최신 요청 취소와 대기 시간 계측, 관측자 예외, 중복 요청 ID, 프록시 접근제어도 검사한다.

별도의 로컬 합성 선택 연산 비교는500기기×100상태, 워밍업5회/측정40회다. 전체 snapshot 후 대상 찾기의 중앙값91.873ms/p95 110.858ms, 동일 결과인 대상 전용 읽기의 중앙값0.149ms/p95 0.940ms였다. 기기 선택 연산만 측정한 결과이며 사용자 전등의 개선 시간이나700~800ms의 POST 왕복이 사라졌다는 수치가 아니다. 전체 Node/Python 및 기존 Chromium 로그인/홈모니터/Advanced 검사와 HAOS 패키지 시작 검사를 완료한 뒤 릴리스한다.

외부 근거: nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering 은 비활성화 시 수신하는 응답을 바로 클라이언트로 전달하고 전체 응답을 읽으려고 하지 않는 동작을 정의한다.
