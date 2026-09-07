<!-- project-branding:start -->
<p align="center">
  <img src="custom_components/smartthings_web/brand/logo@2x.png" alt="SmartThings Web 로고" width="520">
</p>

[![최신 버전](https://img.shields.io/github/v/release/1bobby-git/HA-SmartThings_Web)](https://github.com/1bobby-git/HA-SmartThings_Web/releases/latest)
<!-- project-branding:end -->

# HA SmartThings Web

**SmartThings 기기를 Home Assistant에서 확인하고 제어합니다.**

Samsung 계정으로 로그인해 사용하며, 별도의 SmartThings API 키는 필요하지 않습니다.

## 주요 기능

- 기기 상태 확인·제어와 Home Assistant 자동화 연동
- SmartThings 장면(Scene) 실행과 Home Monitor 보안 모드 제어
- Galaxy Home Mini 음성 안내(TTS)
- SmartThings 방과 Home Assistant 영역 동기화

## 설치

**준비:** Home Assistant OS, HACS, SmartThings에 기기가 등록된 Samsung 계정

### 1. Bridge 앱 설치 및 로그인

[![Bridge 앱 설치](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=8a97f131_smartthings_web_bridge&repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

앱을 **설치 → 시작 → 웹 UI 열기** 순서로 실행하고, 열린 브라우저에서 Samsung 계정에 로그인합니다.

### 2. HACS 통합 설치

[![HACS에서 설치](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=1bobby-git&repository=HA-SmartThings_Web&category=integration)

HACS에서 **SmartThings Web**을 설치한 뒤 Home Assistant를 재시작합니다.

### 3. Bridge와 통합 연결

[![통합 연결](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=smartthings_web)

Bridge 웹 UI에서 **페어링 코드 생성**을 누릅니다. 위 버튼으로 통합 설정을 열고, **Bridge 주소** 칸에 자동 입력된 값을 확인한 뒤 **페어링 코드 입력 → SmartThings 위치 선택**으로 연결합니다.

연결이 끝나면 **설정 → 기기 및 서비스 → SmartThings Web**에서 기기를 확인할 수 있습니다. **Bridge 앱과 HACS 통합을 모두 설치해야 합니다.**

설치 버튼이 열리지 않거나 수동 설치가 필요하면 [설치 안내](addon/smartthings_web_bridge/DOCS.md)를 참고하세요.

## 참고

업데이트할 때는 **Bridge 앱과 HACS 통합을 함께 업데이트**합니다. 지원 기능은 기기에 따라 다르며, Samsung 로그인 세션이 만료되면 앱에서 다시 로그인합니다.

[사용법·자동화 예제](docs/smartthings-web-services-ui-guide.md) · [상세 문서](docs/) · [변경 이력](CHANGELOG.md) · [문제 신고](https://github.com/1bobby-git/HA-SmartThings_Web/issues)

Samsung 공식 통합이 아닌 비공식 프로젝트입니다. [MIT License](LICENSE).
