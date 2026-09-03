## 0.1.165

- Home Assistant의 기본 `code_arm_required=True`를 해제해 Home Monitor 무장 명령이 코드 없이 브리지까지 전달되도록 수정했습니다.
- Home과 Sparkplus를 포함한 모든 Location Home Monitor는 SmartThings 웹 세션으로 인증하며 HA 키패드 코드를 요구하지 않습니다.
- 회귀 테스트가 Home Assistant Core의 서비스 코드 검증 경로를 재현하도록 보강했습니다.
- 0.1.164 이하에서는 테스트가 통합의 직접 메서드만 호출해 Core의 무장 코드 사전 검증을 놓쳤으며, 0.1.165부터 실제 서비스 진입 경로를 검증합니다.

## 0.1.164

- Home Monitor 가용성을 armState 수집 여부와 분리했습니다. Location이 존재하면 초기 상태가 아직 없어도 alarm_control_panel을 제어할 수 있습니다.
- 다중 Location에서 Sparkplus처럼 첫 SECURITY_ARM_STATE_EVENT가 아직 수신되지 않은 Home Monitor도 unavailable 대신 unknown 상태로 유지하고 외출/재실/해제 명령을 허용합니다.

## 0.1.163

- Home Monitor 제어를 my.smartthings.com 대시보드 카드와 열린 모달에 정확히 연결하고, Home/다중 Location 모두 동일한 위치 단위 경로를 사용합니다.
- Home Monitor 모드 컨트롤을 열린 모달 내부로 한정하고 button/radio/tab 및 한국어 상태 문구 변형을 지원합니다.
- 기존 SECURITY_ARM_STATE_EVENT 시간순 보호를 유지하면서 대시보드 제어 후 위치별 Home Monitor 상태를 기존 push 경로로 동기화합니다.

## 0.1.162

- 기본 스위치 엔티티 ID는 위치·방 접두사 없이 SmartThings 기기 이름만 사용합니다. 동일 이름 충돌은 `_2`, `_3` 숫자 접미사로만 구분합니다.
- 기존 generated 위치·방 접두사 ID를 기기명 기반 ID로 자동 이전하며, 사용자 지정 ID와 다른 통합이 점유한 ID는 보존합니다.
- Home Monitor 카드 선택에서 위치명 접두사와 `홈모니터`/`홈 모니터` 및 영문 변형을 정확히 지원합니다.

## 0.1.161

- 최종 SmartThings 기본 아이콘을 통합 구성 요소와 애드온에 다시 적용했습니다.
- 통합 구성 요소는 Home Assistant 로컬 Brands Proxy API가 제공하는 256px 및 512px 투명 PNG를 포함합니다.
- 애드온 아이콘은 동일한 디자인의 128px 투명 PNG로 맞췄습니다.
- 세션 유지, 프로토콜 및 기기 제어 동작은 변경하지 않았습니다.

## 0.1.160

- `/location` 정적 GET뿐 아니라 로그인된 동일 브라우저의 경량 Advanced location GET도 5분마다 호출해 실제 SmartThings 인증 세션을 갱신합니다.
- realtime 상태가 `STALE`·동기화 중이거나 명령/상세 페이지가 열려 있어도 인증된 keeper가 있으면 세션 유지를 계속하고, 인증 만료가 확인되면 30초 뒤 저장된 Samsung SSO 세션으로 `/location` 재진입을 시도합니다. 로그인 화면이 계속되면 15분 간격으로 재시도합니다.
- Chromium은 항상 `Default` 프로필과 `/data/chromium-profile`의 basic password store·XDG data/state 경로를 사용하며, 종료 신호는 Bridge가 직접 처리해 브라우저 프로필을 먼저 정상 종료합니다.
- 비밀번호·MFA·쿠키를 별도 파일이나 로그로 복사하지 않으며 기존 config entry, entity ID, unique ID, 장치/영역 이름과 명령 구조는 변경하지 않습니다.

## 0.1.159

- Home Assistant 2026.3 이상 로컬 Brands Proxy API용 SmartThings 아이콘과 라이트/다크 로고를 통합 패키지에 포함했습니다.
- Bridge 프로토콜 계약과 장치 제어 동작은 변경하지 않았습니다.

# Changelog

## 0.1.158

- 일반 스위치 엔티티는 복합 장치 구성요소 개수와 관계없이 SmartThings 기기 자체를 대표하는 이름을 우선 사용합니다.
- 구성요소별 이름을 사용하지 못할 때는 장치 이름을 사용하고, Home Assistant가 같은 이름 충돌을 처리하도록 하여 `_switch` 접미사가 붙지 않게 했습니다.
- 기존 unique ID, 엔티티 레지스트리 식별자, 사용자 이름과 영역은 유지됩니다.

## 0.1.157

- SmartThings 컴포넌트 구조 최적화 및 보안 개선.
