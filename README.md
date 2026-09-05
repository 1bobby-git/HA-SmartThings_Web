<!-- project-branding:start -->
<p align="center">
  <img src="custom_components/smartthings_web/brand/logo@2x.png" alt="SmartThings Web 로고" width="520">
</p>
<p align="center">
  <a href="https://github.com/1bobby-git/HA-SmartThings_Web/stargazers"><img src="https://img.shields.io/github/stars/1bobby-git/HA-SmartThings_Web?style=flat-square&logo=github&label=Stars" alt="GitHub Stars"></a>
  <a href="https://github.com/1bobby-git/HA-SmartThings_Web/releases"><img src="https://img.shields.io/github/v/release/1bobby-git/HA-SmartThings_Web?style=flat-square&label=Release" alt="Latest Release"></a>
  <a href="https://github.com/1bobby-git/HA-SmartThings_Web/blob/main/addon/smartthings_web_bridge/config.yaml"><img src="https://img.shields.io/badge/Architecture-amd64%20%7C%20aarch64-0ea5e9?style=flat-square" alt="amd64 and aarch64"></a>
  <a href="https://github.com/1bobby-git/HA-SmartThings_Web/blob/main/LICENSE"><img src="https://img.shields.io/github/license/1bobby-git/HA-SmartThings_Web?style=flat-square&label=License" alt="License"></a>
  <a href="https://github.com/1bobby-git/HA-SmartThings_Web/commits/main"><img src="https://img.shields.io/github/last-commit/1bobby-git/HA-SmartThings_Web?style=flat-square&label=Updated" alt="Last Commit"></a>
</p>
<!-- project-branding:end -->

# HA SmartThings Web

`HA SmartThings Web`은 Home Assistant에서 `my.smartthings.com` 웹 세션을 이용해 SmartThings 기기 상태, 일반 제어, **Scene**과 **SmartThings Advanced의 안전한 command**를 연결하는 비공식 프로젝트입니다. `speechSynthesis.speak`를 제공하는 **Galaxy Home Mini의 TTS를 Home Assistant 자동화에서 사용할 수 있도록 전용 `smartthings_web.speak` 서비스**도 제공합니다.

브라우저 로그인을 담당하는 **SmartThings Web Bridge 앱**과 Home Assistant 엔티티를 생성하는 **`smartthings_web` 커스텀 통합**으로 구성됩니다. Samsung 비밀번호·MFA·CAPTCHA를 소스나 설정 파일에 입력하지 않고, 사용자가 앱의 noVNC 브라우저에서 직접 로그인합니다.

> **현재 상태: `1.8.6` · 실환경 부분 검증**
>
> 실제 Home Assistant OS에서 앱 기동, Ingress/noVNC Samsung 로그인, Bridge 연결, 인벤토리 수신과 Home Assistant 엔티티 생성까지 확인했습니다. `0.1.182`는 `0.1.181` 실환경 진단으로 확인된 Home Monitor 현재 모드 pill, 중복 Supervisor discovery, `..._on`·`..._jaesil` ID와 상태 이벤트 폭주 경로를 수정했으며, 모든 계정과 기기에서 실기기 재검증이 끝난 상태는 아닙니다.

`1.8.4`는 기존 팝업 처리를 유지하면서 대시보드 Home Monitor 카드의 `보안(실내)`·`보안(외출)` 직접 제어를 먼저 탐색합니다. HTML 외 SVG text/tspan, CSS 표시 문구와 분리된 접근성 라벨을 지원하며 Playwright 실제 포인터 클릭을 사용합니다. 최신 HA 로그에서 제어 실패가 계속됨을 확인했으며, 스크린샷만으로 실제 SVG 사용 여부나 근본 원인을 확정하지 않습니다. 합성 화면의 Chromium 회귀 테스트는 사용자 Samsung 계정의 실동작 검증과 구분합니다. Scene 실행 경로와 완료 확인 타임아웃 처리는 이번 버전에서 변경하지 않았습니다.

`1.8.5`는 새 Bridge 로그에서 HTML 보안 버튼 하나를 찾아 클릭한 뒤에도 상태 확인이 끝나지 않은 경로를 대상으로 합니다. 제어 탭을 클릭 직후 닫지 않고 기존 위치별 보안 상태 확인이 완료되거나 실패할 때까지 유지합니다. 클릭·일반 인벤토리 재조회 완료만으로 경보 상태를 성공으로 표시하지 않습니다. 요청별 timeout, 확인 오류의 원래 코드와 실패 시 탭 정리를 함께 검증합니다. 독립 Chromium 합성 화면과 전체 자동 검증 결과는 실제 삼성 계정의 Home Monitor 성공과 구분하며, 실환경 최종 성공은 아직 확인하지 않았습니다.

`1.8.6`는 사용자가 `1.8.4`에서 외출·해제와 지연된 외출 적용을 확인한 경로를 유지하며, 느린 상태 확인과 대기열을 개선합니다. Advanced 위치 메타데이터가 보안 상태를 지우던 문제를 수정하고, HA가 이미 지원하는 `AWAY`·`STAY`·`OFF`도 명령 확인에서 동일하게 해석합니다. 정확히 같은 위치의 열린 keeper에서는 직접 보안 버튼을 사용해 대시보드를 새로 로드하지 않으며, 위치 상태 재확인은 전체 기기 인벤토리 대신 기존 인증 클라이언트의 읽기 전용 위치 조회를 사용합니다. 오래 대기한 미실행 보안 요청은 뒤늦게 재생하지 않고 `command_queue_timeout`으로 종료합니다. 보안 성공은 실제 상태 근거로만 판정하며, 실환경 지연 시간과 실내 모드의 최종 성공은 업데이트 후 측정이 필요합니다.

## Scene·Advanced Commands·Galaxy Home Mini TTS

이 프로젝트는 센서 상태를 읽거나 일반 스위치를 켜고 끄는 수준에만 머물지 않습니다. SmartThings Web에서 발견한 **Scene을 Home Assistant의 표준 `scene` 엔티티로 등록**하고, SmartThings Advanced가 장치별로 실제 공개한 **safe command catalog를 Home Assistant 서비스로 연결**합니다.

| 기능 | Home Assistant에서 사용하는 방법 |
| --- | --- |
| SmartThings Scene | 생성된 `scene.*` 엔티티를 표준 `scene.turn_on`으로 실행 |
| Advanced command 목록 확인 | `smartthings_web.list_commands` |
| Advanced command 실행 | `smartthings_web.execute_command` |
| Galaxy Home Mini TTS | 전용 `smartthings_web.speak` |

### SmartThings Scene

선택한 SmartThings 위치에서 발견한 Scene은 원래 이름을 유지한 Home Assistant `scene` 엔티티로 등록됩니다. 대시보드, 자동화와 스크립트에서 다른 Home Assistant Scene과 같은 방식으로 실행할 수 있습니다.

```yaml
action: scene.turn_on
target:
  entity_id: scene.good_night
```

`scene.good_night`는 예시입니다. 실제로 생성된 Scene 엔티티 ID를 선택합니다.

### SmartThings Advanced commands

Advanced command를 이름만 추측해서 보내지 않습니다. 먼저 `smartthings_web.list_commands`로 선택한 장치의 현재 safe command catalog를 확인한 뒤, 응답에 나온 `component`, `capability`, `command`와 인자 schema를 그대로 `smartthings_web.execute_command`에 사용합니다.

```yaml
action: smartthings_web.list_commands
data:
  device_id: dev_001
```

예를 들어 `list_commands` 응답에 `main` / `switch` / `on` 조합이 실제로 포함된 장치라면 다음처럼 실행할 수 있습니다.

```yaml
action: smartthings_web.execute_command
data:
  device_id: dev_001
  component: main
  capability: switch
  command: on
  arguments: []
  confirm: true
  timeout: 30
```

`dev_001`은 설명용 Bridge 장치 alias입니다. Home Assistant 작업 화면에서는 SmartThings Web 장치 선택기를 사용하는 것이 가장 안전합니다. 잠금장치·차고문·밸브·보안·경보·사이렌 계열, 민감한 인자를 요구하는 command와 안전하게 검증할 수 없는 schema는 실행 대상에서 제외됩니다.

### Galaxy Home Mini TTS 전용 `speak`

Galaxy Home Mini처럼 Advanced catalog에 `speechSynthesis.speak`를 제공하는 장치는 raw component나 capability 값을 직접 찾지 않고 전용 `smartthings_web.speak` 서비스로 안내 문구를 재생할 수 있습니다. 이 서비스는 **안전한 `speechSynthesis.speak` descriptor가 정확히 하나일 때만** 실행하므로, 후보가 없거나 여러 개이면 임의의 command를 선택하지 않고 중단합니다.

```yaml
action: smartthings_web.speak
data:
  device_id: dev_001
  phrase: 현관문이 열렸습니다.
  timeout: 30
```

통합 서비스 입력은 제어 문자가 없는 1~1024자 문구를 허용합니다. Galaxy Home Mini에서 관찰된 live descriptor는 최대 1000자이므로 실제 사용에서는 1000자 이하를 권장하며, 장치가 더 짧은 `maxLength`를 제공하면 그 제한을 따릅니다.

> [!IMPORTANT]
> Scene, Advanced command와 TTS의 실제 지원 범위는 로그인한 Samsung 계정, 선택한 위치와 SmartThings Web이 현재 노출한 catalog에 따라 달라집니다. 읽기 전용 모드에서는 `list_commands`로 목록을 확인할 수 있지만 Scene 실행, `execute_command`와 `speak` 같은 쓰기 작업은 차단됩니다.

더 자세한 화면 입력 방법과 응답 형식은 [SmartThings Web 서비스 UI 사용법](docs/smartthings-web-services-ui-guide.md)을 참고합니다.

## Advanced 주 데이터·명령 구조

현재 구현은 로그인된 동일 Chromium context에서 SmartThings Advanced 내부 경로를 장치·location·room·상태·health·capability·safe command catalog의 주 데이터 소스로 사용합니다. 200개를 넘는 장치는 next link 또는 `isNext/max/page` 규칙으로 끝까지 읽고 `deviceId`로 병합합니다. 단일 component 장치는 관찰된 `/location` native control을 유지하고, 안전하고 되돌릴 수 있는 Advanced `on`/`off` 조합은 native switch/light 엔티티로 추가 투영합니다. Advanced command POST는 페이지 내부 CSRF 토큰을 same-origin fetch 헤더에만 붙이고 토큰을 로그·응답·진단에 반환하지 않습니다. composite parent의 main이 직접 command endpoint가 아닌 aggregate 상태이면 secondary component와 child main 상태의 동일 값·900ms 이내 timestamp에 대한 전체 일대일 조합이 정확히 하나일 때만 child device들을 직렬 제어하고, 그 검증된 component-child 매핑을 Bridge 재시작 뒤에도 재사용하도록 별도 저장합니다. 실제 child 제어는 direct Advanced endpoint가 404인 실증에 따라 관찰된 Location-native child control만 직렬 사용하고 DOM fallback은 허용하지 않으며, bounded confirmation window의 parent+child Advanced `/status` 전체 벡터가 일치할 때만 성공합니다. status-only Advanced 응답은 전체 topology가 아니므로 기존 parent-child 관계를 지우지 않습니다. 부분 실패나 최종 확인 실패는 완료된 child를 원래 값으로 되돌리고 Advanced status로 원래 parent/child vector를 확인합니다. 매핑 실패는 parent fallback 없이 닫습니다. 실패 진단은 raw 식별자 없이 component one-based ordinal, dispatch/rollback phase, outcome과 fixed transport error code만 기록합니다. 실행할 수 없는 secondary switch와 중복 Refresh는 Home Assistant 제어 엔티티로 노출하지 않으며, generated entity ID와 restore metadata가 기존 canonical slug를 다시 입력으로 삼아 길어지는 경우는 한 번의 bounded canonical ID로 되돌립니다. 같은 이름의 primary switch가 여러 location에 있으면 `_switch`나 숫자 suffix 대신 location/room-qualified ID를 사용합니다.

`lastUpdatedDate`를 포함한 timestamp가 없는 Advanced `OFFLINE`은 장치를 unavailable로 만들지 않습니다. 더 새로운 Location 상태 이벤트나 성공한 Advanced `/status` 조회는 online 증거가 되고, 그보다 새로운 timestamp가 있는 명시적 health `OFFLINE`은 계속 우선합니다. Bridge 재시작 때도 offline으로 저장된 장치는 persisted Location/status evidence를 다시 비교해 더 최신의 정상 상태가 있으면 online으로 복구하되, 값 자체가 `offline`, `unavailable`, `disconnected`인 상태는 positive evidence로 사용하지 않습니다.

장치 명령은 live 증거가 있는 조합에서만 Advanced direct를 허용하고, 현재 기본은 **`/location` native command → 검증된 DOM fallback** 순서입니다. HTTP `ACCEPTED`만으로 HA 상태를 바꾸지 않으며, stateful 명령은 `/location`의 새 push 또는 상태 재조회로 확인합니다. `refresh`, `press`, media next/previous처럼 지속 상태가 없는 명령은 접수 성공만 반환합니다.

`/location` 페이지는 제거하지 않습니다. Socket.IO realtime keeper로 계속 유지되며 물리 조작, SmartThings 앱, 외부 자동화의 변경을 HA에 전달합니다. 재연결 후 첫 수신 프레임이 확인되면 Advanced 전체 snapshot을 다시 동기화합니다. 쿠키·토큰·CSRF·원본 device/location ID는 서비스, 로그, diagnostics에 노출하지 않습니다.

로그인 세션은 `/data/chromium-profile`의 고정 `Default` 프로필에 보존합니다. Bridge는 5분마다 `/location`과 경량 인증 endpoint를 함께 확인하고, realtime이 일시적으로 끊기거나 명령/상세 페이지가 열려 있어도 세션 유지 요청은 계속합니다. 인증 redirect가 감지되면 저장된 Samsung SSO 쿠키로 자동 재진입을 시도하며, SSO 자체가 만료된 경우에만 noVNC에서 다시 로그인해야 합니다.

기존 `smartthings_web` config entry, entity ID, unique ID, device registry identifier, area와 사용자 이름은 유지됩니다. Web 표시명은 generated `original_name`에만 반영하고, device class가 없는 범용 센서는 장치 유형 아이콘을 받으며, 온도 같은 기능형 센서는 Home Assistant device class 아이콘을 유지합니다. 범용 명령은 `smartthings_web.execute_command` 서비스를 사용하며 `device_id`, `component`, `capability`, `command`와 선택적인 `arguments`, `confirm`, `timeout`을 받습니다.

명령 확인에는 `smartthings_web.list_commands`와 `smartthings_web.speak`도 제공합니다. `speak`는 안전한 `speechSynthesis.speak` descriptor가 정확히 하나일 때만 1-1024자 control-character 없는 문구를 전달합니다. 운영 서비스로 `smartthings_web.reload_inventory`, `smartthings_web.refresh_device`, `smartthings_web.reconnect_realtime`도 제공합니다. 앱 옵션에서 confirmation timeout, status recheck, 저빈도 reconciliation interval, DOM fallback, protocol debug logging을 설정할 수 있으며 잘못된 값은 시작 전에 거부됩니다. 패키지에 포함된 `npm run audit:web-parity`는 Bridge inventory와 Home Assistant projection을 비교해 위험 명령, 중복 unique ID, 중복 generated name, 설명 없는 safe omission을 검사합니다.
화면에서 서비스와 TTS를 실행하는 방법은 [SmartThings Web 서비스 UI 사용법](docs/smartthings-web-services-ui-guide.md)에 정리되어 있습니다.

## 빠른 설치

설치는 **브리지 앱 → HACS 통합 → 통합 설정** 순서로 진행합니다.

### 1. SmartThings Web Bridge 앱 설치

Home Assistant OS 또는 Supervised 환경에서 아래 버튼을 누르면 이 저장소가 앱 저장소에 추가되고 **SmartThings Web Bridge** 앱 화면이 열립니다.

[![Home Assistant에서 SmartThings Web Bridge 앱 열기](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=8a97f131_smartthings_web_bridge&repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

1. 열린 앱 화면에서 **설치**를 누릅니다.
2. 설치가 끝나면 앱을 시작합니다.
3. **웹 UI 열기**를 눌러 noVNC Chromium 화면에서 Samsung 계정에 로그인합니다.
4. 브리지 상태가 `CONNECTED`이고 `ready=true`인지 확인합니다.

버튼이 앱 화면까지 열지 못하면 아래 버튼으로 저장소만 먼저 추가한 뒤 **설정 → 앱 → 앱 스토어 → SmartThings Web Bridge**에서 설치합니다.

[![Home Assistant에 SmartThings Web 앱 저장소 추가](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

<details>
<summary>수동 로컬 설치</summary>

저장소 루트에서 자체 포함형 앱 패키지를 생성합니다.

```bash
npm ci
npm run package:addon
```

생성된 `dist-addon/smartthings_web_bridge` 폴더의 **내용 전체**를 Home Assistant 호스트의 `/addons/smartthings_web_bridge`에 복사하고, 앱 스토어 우측 상단 메뉴에서 **업데이트 확인**을 실행합니다.

> 원본 `addon/smartthings_web_bridge` 폴더만 `/addons`에 복사하면 안 됩니다. 모노레포 빌드 입력물이 빠져 있으므로 수동 로컬 설치에서는 반드시 `npm run package:addon`으로 생성한 패키지를 사용해야 합니다.

</details>

### 2. HACS에서 `smartthings_web` 통합 설치

아래 버튼은 Home Assistant의 HACS 커스텀 저장소 추가 화면을 엽니다.

[![HACS에서 SmartThings Web 저장소 열기](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=1bobby-git&repository=HA-SmartThings_Web&category=integration)

버튼이 열리지 않으면 HACS에서 직접 추가합니다.

1. **HACS → 통합 → 우측 상단 메뉴 → 사용자 정의 저장소**
2. 저장소: `https://github.com/1bobby-git/HA-SmartThings_Web`
3. 유형: **통합**
4. 설치 후 Home Assistant를 재시작합니다.

### 3. 통합 설정

1. SmartThings Web Bridge 웹 UI에서 **페어링 코드 생성**을 누릅니다.
2. 아래 버튼을 눌러 `smartthings_web` 설정을 시작합니다.
3. 앱이 Supervisor에 게시한 실제 내부 주소가 **Bridge 주소** 칸에 자동 입력되는지 확인합니다. 현재 저장소 설치 주소는 `http://8a97f131-smartthings-web-bridge:8100`, `/addons` 수동 로컬 설치 주소는 `http://local-smartthings-web-bridge:8100`입니다.
4. 8자리 페어링 코드를 입력하고 연결할 SmartThings 위치를 선택합니다.

0.1.179부터 앱 discovery가 실제 `{REPO}_{SLUG}` 런타임 hostname과 Core 전용 `8100` 포트를 통합에 전달합니다. 수동 설정에서도 현재 저장소 주소가 기본값이며, 이전 `d55cafb9` 주소와 `local` 주소는 기존 구성 복구용으로 안전하게 순차 확인한 뒤 실제 응답한 주소를 저장합니다.

[![SmartThings Web 통합 설정 시작](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=smartthings_web)

페어링 코드는 10분 동안만 유효하고 한 번 사용하면 폐기됩니다. 통합은 교환된 브리지 토큰을 Home Assistant 구성 항목에 저장합니다.

## 동작 구조

```text
my.smartthings.com
        │ 사용자가 직접 로그인
        ▼
SmartThings Web Bridge 앱
  ├─ 전용 Chromium 프로필
  ├─ WebSocket·SSE·XHR 관찰
  ├─ 민감정보 제거 및 식별자 별칭화
  ├─ 로컬 인증 API / SSE
  └─ 푸시 확인 후에만 명령 성공 처리
        │ Home Assistant 내부 네트워크
        ▼
smartthings_web 커스텀 통합
        ▼
센서·스위치·조명·기후·커버·미디어 등 엔티티
```

브리지는 SmartThings 공개 API, PAT, OAuth, SmartApp, 웹훅을 직접 사용하지 않습니다. 브라우저가 가진 SmartThings Web 세션을 관찰하고, 명령은 실제 웹 UI에서 확인된 제어만 실행한 뒤 더 최신의 권위 있는 푸시 이벤트가 도착해야 성공으로 처리합니다.

## 지원 엔티티

관찰된 기기 특성에 따라 다음 플랫폼을 생성할 수 있습니다.

- 센서, 바이너리 센서, 버튼 이벤트, 스위치, 조명, 버튼, 숫자 입력, 펌웨어 업데이트 상태
- 팬, 미디어 플레이어, 기후, 커버, 선택 항목
- 장면, SmartThings Home Monitor 경보 패널
- 캐시된 카메라 스틸 이미지

기기나 SmartThings Web 화면에서 제공하지 않는 기능은 생성되지 않을 수 있습니다. 카메라는 실시간 스트리밍이 아니라 관찰된 서명 URL 또는 같은 WebSocket 연결의 Socket.IO 바이너리 썸네일 응답에서 제한된 크기의 JPEG/PNG/WebP 바이트만 받아 로컬 캐시에 저장합니다.

## 보안 원칙

- Samsung 비밀번호, MFA 코드, CAPTCHA, 쿠키, CSRF 값, Authorization 헤더, 브리지 토큰을 소스·설정·로그·이슈에 기록하지 않습니다.
- Chromium 프로필과 브리지 데이터는 앱의 `/data` 아래에만 저장하며 디렉터리는 `0700`, 민감 파일은 `0600`으로 제한합니다.
- noVNC는 Home Assistant Ingress를 통해서만 열고 공개 호스트 포트를 제공하지 않습니다.
- 브리지 API는 Bearer 토큰으로 인증하며, 페어링 코드 생성은 Ingress 내부 요청으로 제한합니다.
- 통합의 브리지 URL은 루프백·사설 IP·링크 로컬·단일 레이블 호스트·`.local`·`.home.arpa`만 허용합니다. 공개 인터넷 호스트는 거부합니다.
- 텍스트 캡처의 `Cookie`, `Set-Cookie`, `Authorization` 등 민감 헤더는 헤더 값 전체를 제거합니다.
- 카메라 응답은 `Content-Length`가 없어도 스트림을 읽는 동안 최대 크기를 강제해 과도한 메모리 사용을 차단합니다.
- 저장소 보안 점검은 테스트·타입 검사·빌드·비밀정보 검사·API 무사용 검사·fixture 검사·프로덕션 의존성 감사를 실행합니다.

보안 취약점은 공개 이슈에 인증정보나 재현용 비밀값을 올리지 말고 `SECURITY.md` 절차에 따라 비공개로 신고해 주세요.

## 프로토콜 무결성

검토된 의미 기반 프로토콜 지문은 `/data/protocol-fingerprint.json`에 저장되며 일반 설정 파일과 분리됩니다.

SmartThings Web이 호환되지 않는 ACK 또는 이벤트 구조를 반환하면 브리지는 `PROTOCOL_CHANGED` 상태로 전환합니다. 이때 liveness와 Ingress 상태 화면은 유지하지만 파서 상태와 readiness는 실패 상태로 닫힙니다.

프로토콜 변경은 자동 승인하지 않습니다. 익명화된 실제 증거 검토, 파서·재생 테스트 추가, 숫자 `protocol_version` 증가가 모두 완료되어야 새 구조를 허용합니다.

## 데이터와 개인정보

브리지는 다음 값을 별칭 또는 제거 처리합니다.

- 계정·사용자·위치·기기 ID
- UUID 및 IP 주소
- 세션·쿠키·토큰·비밀번호·CSRF·MFA·CAPTCHA
- URL의 민감한 쿼리 값

진단 캡처는 익명화 경계를 통과한 레코드만 SQLite에 기록하며 최신 50,000개로 제한됩니다. 원본 로그인 자격 증명과 원본 인증 헤더는 영구 진단 데이터로 저장하지 않습니다.

## 설치 경로 주의사항

- 앱 구성 slug: `smartthings_web_bridge`
- 현재 저장소 설치 앱 ID: `8a97f131_smartthings_web_bridge`
- 현재 저장소 설치 내부 DNS: `8a97f131-smartthings-web-bridge`
- 수동 로컬 설치 소스 폴더: `/addons/smartthings_web_bridge`
- 수동 로컬 설치 런타임 slug: `local_smartthings_web_bridge`

`/addons` 아래에 동일한 `config.yaml`과 slug를 가진 백업 폴더를 두면 Supervisor가 최신 패키지를 잘못 인식할 수 있습니다. 백업은 `/addons` 외부에 보관합니다.

Home Assistant Supervisor가 앱 컨테이너를 빌드하고 관리하므로 사용자가 별도로 Docker를 설치하거나 컨테이너를 직접 관리할 필요는 없습니다.

## 개발용 단독 실행

Home Assistant Container/Core처럼 Supervisor가 없는 환경의 개발 확인 용도입니다. 공개 인터페이스에 바인딩하지 말고 루프백으로만 노출합니다.

```powershell
docker build -f docker/Dockerfile -t ha-smartthings-web:phase1 .
docker run --rm --shm-size=1g -p 127.0.0.1:8099:8099 -v smartthings-web-data:/data ha-smartthings-web:phase1
```

## 개발 및 검증

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run audit:api-free
npm run audit:secrets
npm run audit:fixtures
npm run protocol:replay
npm run snapshot:replay
npm run package:addon
```

실제 HAOS 검증 도구는 운영 환경을 변경할 수 있으므로 관련 문서와 실행 게이트를 확인한 뒤 사용합니다.

```bash
npm run probe:physical-action:haos -- status
npx tsx tools/haos-capture-origin-audit.ts
npx tsx tools/haos-core-restart-continuity.ts
npm run deploy:haos:candidate
```

## 현재 검증 상태

아래 표는 **기능 구현**, **자동 검증**, **실제 HAOS 확인**을 구분합니다. 테스트 통과만으로 실기기 동작까지 확인됐다고 표시하지 않습니다.

| 영역 | 현재 확인 상태 | 검증 수준 |
| --- | --- | --- |
| 최신 배포 | `v0.1.181` Bridge 앱과 Home Assistant 통합 패키지가 GitHub Release에 게시됨 | 배포 확인 |
| HAOS 앱·브라우저 | 실제 사용자 HAOS에서 `0.1.178` 이후 앱 기동, Ingress/noVNC 접속과 Samsung 계정 로그인 확인 | 실환경 확인 |
| Bridge·통합 연결 | 페어링, 내부 Bridge 연결, 인벤토리 수신과 Home Assistant 기기·엔티티 생성 확인 | 실환경 확인 |
| 상태 동기화·부하 억제 | push/SSE 상태 반영, 동일 인벤토리 억제, 유한 큐·백프레셔, 무변경 상태 및 registry 쓰기 억제 구현 | 자동 검증 통과, 장시간 실환경 soak 필요 |
| Home Monitor | `0.1.180`에서 위치 직접 라우팅 뒤 `command_control_not_found`가 실환경 재현됨. `0.1.181`은 roleless React 카드 열기, shadow host 탐색과 비식별 구조 진단을 추가 | 자동 검증 통과, 사용자 환경 재검증 필요 |
| SmartThings Scene | 실제 발생한 `command_control_not_found` 경로를 정확한 Scene 카드 탐색 방식으로 수정 | 자동 검증 통과, 사용자 환경 재검증 필요 |
| Web 표시명 | `On 1`, `On 2` 같은 근거 없는 숫자 이름 대신 관찰된 SmartThings Web 라벨을 우선하도록 수정 | 자동 검증 통과, 실제 인벤토리 재확인 필요 |
| Advanced commands | `smartthings_web.list_commands`와 `smartthings_web.execute_command` 구현. 장치의 live safe command catalog에 실제로 존재하는 명령만 실행 | 구현·자동 검증 완료, 장치별 지원 범위는 실환경 의존 |
| Galaxy Home Mini TTS | 안전한 `speechSynthesis.speak` descriptor가 정확히 하나일 때 사용하는 `smartthings_web.speak` 구현 | 구현·자동 검증 완료, Galaxy Home Mini 실기기 재검증 필요 |

`0.1.180` 변경 검증에서는 Vitest 89개 파일·1,054개 Node 테스트, TypeScript typecheck/build, Python 통합 테스트, HACS, Hassfest, 보안 검사와 패키지형 HAOS 런타임 smoke가 통과했습니다. 실제 사용자 환경에서 아직 다시 확인하지 않은 Home Monitor, Scene, Web 표시명과 Galaxy Home Mini TTS는 완료로 과장하지 않고 재검증 필요 상태로 표시합니다.

`0.1.181`은 실제 `command_control_not_found` 재현을 기준으로 Home Monitor의 roleless 카드 열기와 실패 전용 `home_monitor_diag` 구조 로그를 추가했습니다. 현재 실기기 성공 여부는 새 버전 설치 후 다시 확인해야 합니다.

## 제한 사항

- Samsung의 비공식 Web 화면과 내부 요청 구조를 기반으로 하므로 UI·프로토콜 변경 시 일부 기능이 중단될 수 있습니다.
- 기기·Scene·Home Monitor·Advanced command·TTS 지원 범위는 로그인한 계정, 위치, 지역과 현재 Web catalog가 실제로 노출한 항목에 따라 달라집니다.
- 제어 대상이 정확히 하나로 검증되지 않거나 안전한 command descriptor가 없으면 임의의 대체 제어를 실행하지 않고 실패합니다.
- 잠금장치·차고문·밸브·보안·경보·사이렌 등 위험도가 높은 command와 민감 인자를 요구하는 command는 실행 대상에서 제외합니다.
- 72시간 장기 soak, 장시간 유휴 뒤 세션 복구, 모든 호스트 재부팅 조합과 전체 기기 유형은 아직 완전 검증되지 않았습니다.
- 여기서 API-free는 SmartThings 공개 API, PAT, OAuth, SmartApp 자격 증명을 사용하지 않는다는 뜻입니다. 로그인된 SmartThings Web이 사용하는 내부 Web 요청까지 없다는 의미는 아닙니다.

## 라이선스

MIT License. 자세한 내용은 `LICENSE`와 `NOTICE`를 확인하세요.

<!--
Documentation gate compatibility anchors. These are intentionally not rendered.
Current status is documented as live HAOS partially verified
do not install or manage Docker yourself
Settings → Apps → Install app
The folder path and add-on slug are different
Do not copy the raw `addon/smartthings_web_bridge` source folder
generated monorepo build inputs
canonicalizes generated text files to UTF-8 with LF line endings
same contract cannot self-heal
numeric `protocol_version` bump
Version 0.1.28 is deployed on Home Assistant 2026.8.3
Live temperature, humidity, contact, motion, and power observations
Manual physical-action attribution is verified
sequence 642 through 672 with zero gaps
The 72-hour passive HAOS soak remains explicitly deferred
The probe adds no browser command, DOM state scraping, direct SmartThings API call, Home Assistant entity, or persistent event journal.
0.1.28 is deployed
final-summary.json.sha256
-->
