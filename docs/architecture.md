# Architecture

버전 0.1.146부터 Bridge는 하나의 persistent Chromium context와 하나의 `/location` keeper를 유지한다. `AuthenticatedSmartThingsSession`은 이 keeper의 인증 세션에서 same-origin Advanced 요청을 실행하고, origin 제약이 있을 때만 짧게 Advanced 페이지를 열었다가 닫는다. 쿠키, storage state, Authorization, CSRF 값과 원본 식별자는 로그·diagnostics·저장소에 기록하지 않는다.

Advanced 내부 경로는 장치·location·room·초기 상태·health·capability의 주 인벤토리다. 장치 목록은 서버의 next link를 우선하고, 없을 때 `isNext/max/page` 규칙으로 200개 이후 페이지를 계속 읽는다. 모든 페이지는 SmartThings `deviceId`로 병합하고, 완전히 병합된 결과만 authoritative snapshot으로 `DeviceStore`에 적용한다. 단일 관찰 페이지는 장치를 삭제할 근거로 사용하지 않는다.

버전 0.1.147부터 조회 source와 명령 transport evidence를 분리한다. Advanced는 주 인벤토리·상태 enrichment로 유지하지만, 실제 장치·component·capability·command 조합의 live 증거가 없는 Advanced POST는 보내지 않는다. 현재 기본 명령은 기존 `/location` native dispatcher이며, 검증된 DOM control은 마지막 fallback이다. timeout이나 불확실한 receipt 뒤에 다른 transport로 재전송하지 않는다. `ACCEPTED`는 접수 증거일 뿐이며 stateful 명령은 `/location` push 또는 상태 재조회로 확인한다. `refresh`, `press`, media next/previous 같은 stateless 명령은 authoritative refresh 또는 제한된 접수 결과로 처리하고 다른 상태를 낙관적으로 바꾸지 않는다.

`/location` keeper는 Socket.IO `DEVICE_EVENT`와 health event의 realtime delta source로 남는다. 연결이 끊기면 keeper를 복구하고, 복구 후 첫 수신 프레임으로 재구독을 확인한 다음 Advanced 전체 reconciliation을 한 번 실행한다. 정상 연결 중에는 짧은 주기 상태 polling을 하지 않는다.

Home Assistant의 `smartthings_web` domain과 config entry는 유지한다. 정확한 양방향 control이 없는 switch state는 제어 엔티티가 아니며, component Refresh는 장치당 main 하나로 정규화한다. 같은 owner/location/room/name/type과 Cloud/Local child 관계가 모두 증명된 쌍만 기존 Cloud `deviceId`를 canonical identifier로 유지하면서 Local state·health를 병합한다. 일반 동명 장치는 병합하지 않는다.

카메라는 기존과 같이 정지 이미지만 지원한다. signed URL은 volatile하게만 사용하고, 허용된 JPEG/PNG/WebP 바이트와 비민감 metadata만 로컬 인증 이미지 경로로 제공한다.
