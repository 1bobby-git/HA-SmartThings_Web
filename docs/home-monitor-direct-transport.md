# Home Monitor 1.8.12: 직접 보안 상태 요청

## 확인한 실제 계약

사용자가 제공한 개발자 도구 화면에 표시된 SmartThings Web 2.57.0 공개 번들의 `changeArmState` 구현을 읽어 다음 계약을 확인했다.

```ts
client.service("api/location").patch(locationId, {
  patchType: "armStateChange",
  armState: requestedState
});
```

출처: `https://d7zh21xt4294z.cloudfront.net/assets/2.57.0/main.js`

2026-09-07 확인한 번들: 1,072,434 bytes, SHA-256 `b03a02f73d0b8ebc5320c26cbd24b3b86f67d413120cb590857dd9c91dfb03ea`.

검사 기록: GitHub Actions `Prepare Home Monitor 1.8.12`, run `34077449762`. 공개 소스만 조회했으며 사용자 계정이나 보안 상태는 조작하지 않았다. 번들 전체를 저장소에 복제하거나 배포하지 않는다.

일반 위치 모드 변경은 `patchType: "modeChange"`를 사용한다. 이 경로와 보안 `armStateChange`를 혼동하지 않는다. Advanced 장치 `commands` 경로를 보안 위치 명령으로 추측하여 변형하지 않는다.

## 실행 구조

1. 기존 dedicated Chromium context의 인증된 Cake 클라이언트를 재사용한다.
2. 내부 alias를 실행 중 확보한 원래 location ID로 해석하고, 명시적인 위치와 세 가지 보안 상태만 전달한다.
3. `armAway`는 `ARMED_AWAY`, `armStay`는 `ARMED_STAY`, `disarm`은 `DISARMED`를 한 번 요청한다.
4. 외출↔실내 요청에서도 중간 `DISARMED` 요청이나 화면 클릭을 수행하지 않는다.
5. 응답 완료는 접수 확인일 뿐이다. 기존 위치별 보안 이벤트 및 새 위치 상태 조회로 목표 상태가 확인돼야 HA에 성공을 반환한다.

Home Monitor의 운영 경로는 `LocationSecurityCommandExecutor`이다. 일반 기기·Scene을 위한 기존 UI 실행기와 테스트는 유지되지만 Home Monitor 요청 실패를 이 실행기로 보내지 않는다. 따라서 카드 렌더링·버튼 표시 언어·선택창·페이지의 Home 메뉴에 의존하지 않는다.

캡처된 클라이언트가 아직 없으면 상태 변경을 보내지 않은 경우에만 보조 페이지에서 정상 앱 초기화를 기다린다. 현재 keeper를 이동·종료하지 않으며, 보조 페이지는 확인 완료 또는 실패 후 닫는다. 새 클라이언트·별도 로그인·토큰 내보내기·별도 보안 권한을 만들지 않는다.

## 실패 및 중복 방지

- `command_security_unavailable`: 정상 앱 클라이언트의 위치 변경 서비스가 준비되지 않음. 임의의 URL 또는 DOM 제어로 전환하지 않는다.
- `command_security_permission_denied`: 서버가 권한을 거절함. 우회·자동 재전송하지 않는다.
- `command_security_busy`: 해당 context에서 이전 위치 변경 요청이 아직 미완료임. 새 요청을 보내지 않는다.
- `command_security_dispatch_uncertain`: 응답이 불명확하고 실제 상태로도 완료를 확인하지 못함. 같은 명령을 자동 재전송하지 않는다.
- `command_confirmation_timeout`: 요청 접수 이후 목표 상태 확인 실패. 접수만으로 보안 상태를 낙관적으로 변경하지 않는다.

미완료 요청은 타이머로 강제 삭제하지 않고 원래 요청이 끝날 때 정리한다. 로그인·권한 오류와 네트워크/응답 불명확 상태는 구분한다. 로그에는 `home_monitor_direct:start_*`, `client_bootstrap`, `keeper_reused`, `dispatch_*_ms_*`를 기록하고 쿠키·토큰·원시 응답·실제 location ID는 출력하지 않는다.

## 검증 범위

합성 Chromium에서 실제 명령 서비스와 라우터를 연결하여 세 모드의 6방향 전환, 동일 상태의 새 조회 확인, 렌더링 없는 페이지, 늦은 클라이언트 초기화, 다른 위치 이벤트, 응답 누락·권한 거절·미완료 요청의 중복 방지를 검사한다. 모든 브라우저 네트워크는 fixture로 차단한다.

실제 삼성 서버가 각 계정에서 외출↔실내 직접 변경을 승인하는지, 실제 지연이 얼마나 감소하는지는 별도의 실환경 확인 대상이다. 공개 웹앱 요청 계약 및 CI 성공을 사용자 계정의 실동작 성공으로 표현하지 않는다.

Bridge 앱과 HA 통합을 함께 1.8.12로 업데이트한다. 로그인 프로필, 엔티티 ID, 영역, Scene, Advanced 장치 명령, Galaxy Home Mini speak 서비스와 wire protocol 5는 유지한다.
