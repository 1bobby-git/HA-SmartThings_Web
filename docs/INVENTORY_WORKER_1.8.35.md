# 느린 상태 캐시 저장의 제어 루프 분리 — 1.8.35

## 최신 사용자 로그의 해석
기준 0110aefdafd452bfc69b99bcc276633f04dcfe24 (1.8.34). 새 로그는 묶음 전송이 실제 사용되며 정상 요청의 총 시간이 대체로 760~846ms, 접수 처리 0~3ms, 대기열 0~2ms임을 보여 준다. 색온도 요청 한 건은 앞선 POST가 끝날 때까지183ms 기다려 총1035ms였다. POST fetch는670~740ms 수준, Bridge 추가 비용은 대부분3~15ms이며 한 건33ms이다. 상태 확인은 실제 값을 받은 뒤 성공한다. 이것을 즉각적인 물리 점등 또는 HA 화면 렌더링 시간으로 해석하지 않는다.

별도로 inventory_persist_timing에 snapshot26ms/write1242ms/total1267ms가 관측됐다. 명령 로그 바로 앞에 있다는 이유로 해당 명령을 정확히1267ms 지연시켰다고는 단정할 수 없다. 하지만 현재 메인 스레드 DatabaseSync.run은 그 호출 동안 새 HTTP 요청이나 상태 이벤트를 처리하지 못한다. 기존 .34의 타이머 연기는 명령이 이미 진행 중일 때 저장 시작을 미룰 뿐, 유휴 중 시작된 저장이 끝나기 전에 새 요청이 도착하는 상황은 막지 않는다. 기존 request timing은 서비스 진입 이후라 진입 이전의 이 대기는 포함하지 않는다.

## 변경
생성/복원 과정과 기존 DeviceStore 복사·필터를 유지하되 실제 Bridge runtime은 backgroundPersistence를 사용한다. 전체 snapshot을 분리해 Worker로 전달한 후 JSON 인코딩과 SQLite upsert/체크포인트를 Worker에서 처리한다. 메인 스레드의 snapshot과 메시지 복사 CPU 비용까지 없어진 것은 아니다. 객체 이전의 transferMs와 Worker의 workerSerializeMs/writeMs를 따로 기록한다. 따라서 Worker writeMs가1242로 남아도 메인 스레드 정지를 의미하지 않는다.

Worker가 동일한 bridge.sqlite의 쓰기 잠금을 오래 보유하면 동기 별칭/캡처 저장과 충돌하므로 독립된 bridge.sqlite.inventory를 사용한다. 기존 SQLite 스키마의 normalized_inventory 한 행 구조는 유지한다. 메인DB inventory_cache_identity와 새 캐시의 cache_identity를 트랜잭션으로 연결해 다른 DB 세대의 번호 별칭을 복원하지 않는다. 새 캐시가 없거나 검증에 실패하면 기존 캐시를 읽고 오류는 고정 분류로만 알린다. 두 캐시가 유효하면 persisted_at이 최신인 것을 사용해 구버전 롤백 후 새 상태가 저장된 경우를 보존한다. 기존DB·컴포넌트 매핑·비밀키·쿠키·Chromium 프로필은 이동하거나 삭제하지 않는다.

1개 Worker/1개 전송 중 snapshot으로 제한하고, 저장 중 변경은 dirty 표지만 남겨 다음에 최신 스냅샷을 보낸다. 이전 완료로 새로운 변경을 지우지 않는다. 실패 시5초 재시도, 기존 유휴750ms/추가연기30초 정책 유지. Worker 요청은15초로 제한하며 중지된 이전 Worker가 종료되기 전에는 새 Worker가 저장하지 않는다. 동기 쓰기로 되돌아가는 fallback은 없다. graceful shutdown은 새HTTP 처리가 정리된 후 진행 중 쓰기와 최신 변경을 순서대로 기다린다. 캐시 쓰기가 실패해도 기기 확인 성공을 실패로 바꾸지 않는다. 강제 종료 또는 지속 저장 실패 때 최신 캐시는 보존되지 않을 수 있다.

기존 준비 스크립트는 새 캐시의 파일/보조파일 권한을0600으로 유지하고 손상 헤더를 원본 보존 격리한다. 수동 복사/백업 시 전체 `/data`(두DB와 SQLite 보조파일/비밀키/프로필)를 함께 보존한다. 과거 버전은 새 캐시를 모르므로 마지막 기존캐시에서 시작한 뒤 실제 웹 상태를 재수집한다. 저장된 값은 재인증이나 실제 상태 검증을 대체하지 않는다.

## 검증과 한계
제어/상태 이벤트 중 저장진행, 중간 변경 합치기, 종료 최신값, 실패 후 최신값 재시도, 관측 예외, 실Worker SQLite 잠금과 메인DB 동시 접근, 프로필과 별칭 복원, 롤백 후 최신 캐시, 재생성된DB의 캐시 배제, 심볼릭링크 거부, Worker정지15초 제한과 교체를 검사한다.

컴파일된 코드에 실제 SQLite 재귀 트리거로 느린 쓰기를 주는 smoke를 추가했다. 기존 동기경로의 이벤트루프 타이머가498ms 후 실행된 첫 로컬 관측에 비해 Worker 경로는3ms 후 실행됐고 쓰기가 완료되기 전 HTTP 읽기도 응답했다. 총 저장 자체는515ms/541ms로 더 빨라진 것이 아니다. 이 결과는 합성 SQLite 부하의 루프 분리 검사이며 사용자 전구의 개선 수치가 아니다. 모든 값/최종 저장이 동일한지도 검증한다. GitHub CI와 실제 앱 이미지 내부에서도 동일 smoke를 실행한다.

약0.7초의 명령POST 왕복은 변경하지 않는다. 사용자 HA 설치, 변경후 물리 전구 성능, 장기 로그인 유지, 디스크 자체의 병목원인은 직접 검증하지 못했다. 기존 POST내용/묶음선택/순서/최신의도 직렬화/확인 조건/HomeMonitor/세션복구는 변경하지 않는다.

## 외부 근거
Node.js DatabaseSync의 모든 API는 동기로 실행된다: https://nodejs.org/api/sqlite.html#class-databasesync
Worker는 별도 JavaScript 실행 스레드와 structured clone 메시지를 사용한다: https://nodejs.org/api/worker_threads.html
