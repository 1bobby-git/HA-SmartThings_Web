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

**SmartThings 기기를 Home Assistant의 엔티티와 자동화로 연결합니다. 별도의 SmartThings 공개 API 토큰이나 SmartApp 설정은 필요하지 않습니다.**

`HA SmartThings Web`은 로그인된 `my.smartthings.com` 웹 세션을 사용하는 비공식 Home Assistant 통합입니다. SmartThings Advanced에서 기기·방·기능 정보를 읽고, Web의 실시간 이벤트로 상태를 동기화합니다. 일반 기기 제어뿐 아니라 **Scene, Home Monitor, Advanced 명령, Galaxy Home Mini 음성 안내**를 지원합니다.

브라우저와 로그인 세션을 관리하는 **SmartThings Web Bridge 앱**과 Home Assistant에 엔티티를 생성하는 **`smartthings_web` 통합**으로 구성됩니다. Samsung 계정 로그인은 앱의 noVNC 브라우저에서 직접 진행합니다.

## 현재 기준 버전: v1.8.16

**Bridge 앱 `1.8.16` / HA 통합 `1.8.16` / 통신 프로토콜 `5`**

2026-09-07 현재 사용자 운영 환경에서 **지금까지 가장 안정적이라는 피드백을 받은 버전**입니다. 아래 설치·기능·업데이트 안내는 v1.8.16을 기준으로 합니다.

[현재 기준 릴리스](https://github.com/1bobby-git/HA-SmartThings_Web/releases/tag/v1.8.16) · [전체 변경 이력](CHANGELOG.md) · [서비스 UI 사용법](docs/smartthings-web-services-ui-guide.md)

## 주요 기능

| 기능 | Home Assistant에서 사용할 수 있는 내용 |
| --- | --- |
| 상태 동기화 | 물리 조작, SmartThings 앱과 외부 자동화에서 발생한 상태 변경을 실시간 이벤트로 반영 |
| 센서 | 온도·습도·조도·배터리·전력·에너지·공기질·현재 인원수 등 실제 수신 상태 |
| 감지 센서 | 열림·움직임·재실·누수 등 기능에 맞는 바이너리 센서와 버튼 이벤트 |
| 기기 제어 | 스위치·조명·팬·기후·커버·미디어 플레이어와 숫자 입력·선택 항목·버튼 |
| SmartThings Scene | 발견한 Scene을 표준 `scene` 엔티티로 등록하고 자동화에서 실행 |
| Home Monitor | 외출·실내·해제 모드를 전용 경보 패널에서 제어하고 실제 보안 상태 확인 |
| Advanced 명령 | 실제 기기가 제공하는 명령 목록 조회와 입력 규격을 검증한 실행 |
| Galaxy Home Mini TTS | `smartthings_web.speak`로 음성 안내 문구 전달 |
| 방과 영역 연결 | Advanced의 확인된 방 정보로 HA 기기 영역 동기화 및 기존 오배치 교정 |
| 카메라·진단 | 캐시된 카메라 스틸 이미지, 펌웨어 업데이트 상태와 기기 진단 정보 |

엔티티는 기기가 실제 제공하는 상태·기능·명령에 따라 생성됩니다. 숫자 설정, 실제 측정값과 재실 여부는 서로 다른 엔티티로 유지합니다.

### 재실 센서와 인원 카운터

카운터 기능이 확인된 기기는 단순 모션 아이콘 대신 **재실 센서 (인원 카운터)**로 기본 분류합니다. 실제 하드웨어 모델명이 있으면 그 정보를 보존합니다. Advanced의 센서 카테고리와 실제 상태를 구분해 사용하며, 기존 모션 센서와 모바일 재택 상태의 의미를 바꾸지 않습니다.

| 항목 | 엔티티 | 값의 기준 |
| --- | --- | --- |
| 인원수 설정 | `number` | `setPeopleCounter` 등 실제 명령의 정수 입력 규격 |
| 현재 인원수 | `sensor` | 기기가 보고한 `peopleCounter` 상태 |
| 재실 여부 | `binary_sensor` / `occupancy` | 직접 재실 상태를 우선하고, 없으면 현재 인원수 0은 미재실·양의 정수는 재실 |
| 증감·고정 설정 | `select` | `setUpdown`, `setFreeze` 등 실제 명령의 선택값 |

설정용 숫자를 입력했다는 이유만으로 실제 인원수나 재실 상태를 바꾸지 않습니다. 재실 센서는 실제 `occupancy` 또는 `peopleCounter` 상태가 있을 때 생성합니다. 인원수에서 계산한 재실 여부는 카운터 기반 파생 상태이며, 잘못된 값이나 누락을 미재실로 처리하지 않습니다. 소스가 늦게 도착해도 같은 컴포넌트의 재실 엔티티를 중복 생성하지 않습니다.

동작 예와 상태 속성은 [재실 센서와 방 동기화 안내](docs/OCCUPANCY_ROOM_SYNC_1.8.16.md)를 참고하세요.

### SmartThings 방과 HA 영역 동기화

통합 옵션의 **SmartThings 방과 기기 영역 동기화**는 기본적으로 켜져 있습니다. 현재 로그인 세션에서 Advanced의 기기 `roomId`와 같은 Location의 방 목록이 확인되면 해당 방을 HA 기기 영역에 반영합니다.

예를 들어 SmartThings에서는 **주방**에 있는 기기가 HA에 **거실**로 남아 있다면 **주방**으로 교정합니다. 방 정보가 나중에 도착하거나 HA 영역을 변경한 경우에도 다시 대조합니다.

기존에 `sync_rooms: false`를 저장했다면 그 설정은 유지되므로 옵션에서 직접 켜세요. 동기화를 켜면 HA의 수동 **기기 영역**보다 SmartThings 방을 우선합니다. 기기 영역을 HA에서 독립적으로 관리하려면 끄면 됩니다. **엔티티별 수동 영역**과 다른 통합이 공유하는 기기는 덮어쓰지 않으며, 출처가 불명확하거나 다른 Location의 정보로 기기를 옮기지 않습니다.

## 빠른 설치

**Home Assistant OS에서 Bridge 앱 → HACS 통합 → 통합 설정** 순서로 진행합니다. 앱은 `amd64`와 `aarch64`를 지원합니다. Supervisor가 앱 컨테이너를 관리하므로 Docker를 따로 설치하거나 직접 관리할 필요는 없습니다.

### 1. SmartThings Web Bridge 앱 설치

[![Home Assistant에서 SmartThings Web Bridge 앱 열기](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=8a97f131_smartthings_web_bridge&repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

1. 앱 화면에서 **설치**를 누른 뒤 앱을 시작합니다.
2. **웹 UI 열기**를 눌러 noVNC Chromium 화면에서 Samsung 계정에 로그인합니다.
3. Bridge 상태가 `CONNECTED`이고 `ready=true`인지 확인합니다.

앱 화면이 바로 열리지 않으면 아래 버튼으로 저장소를 추가한 뒤 **설정 → 앱 → 앱 스토어 → SmartThings Web Bridge**에서 설치하세요.

[![Home Assistant에 SmartThings Web 앱 저장소 추가](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

### 2. HACS 통합 설치

[![HACS에서 SmartThings Web 저장소 열기](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=1bobby-git&repository=HA-SmartThings_Web&category=integration)

HACS에서 **SmartThings Web**을 설치하고 Home Assistant를 재시작합니다. 버튼이 열리지 않으면 HACS의 **사용자 정의 저장소**에 아래 주소를 **통합** 유형으로 추가하세요.

```text
https://github.com/1bobby-git/HA-SmartThings_Web
```

### 3. Bridge와 통합 연결

[![SmartThings Web 통합 설정 시작](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=smartthings_web)

1. Bridge 웹 UI에서 **페어링 코드 생성**을 누릅니다.
2. 위 버튼 또는 **설정 → 기기 및 서비스 → 통합 추가 → SmartThings Web**에서 설정을 시작합니다.
3. 앱이 게시한 내부 주소가 **Bridge 주소** 칸에 자동 입력되는지 확인합니다.
4. 8자리 페어링 코드를 입력하고 연결할 SmartThings 위치를 선택합니다.

| 설치 방식 | 내부 Bridge 주소 |
| --- | --- |
| 이 저장소의 앱 설치 | `http://8a97f131-smartthings-web-bridge:8100` |
| `/addons` 수동 로컬 설치 | `http://local-smartthings-web-bridge:8100` |

페어링 코드는 10분 동안 유효하며 한 번 사용하면 폐기됩니다. 통합은 교환된 **로컬 Bridge 인증 토큰**을 HA 구성 항목에 저장합니다. Samsung 비밀번호나 MFA 코드를 통합 설정에 입력하지 않습니다.

## 기존 설치 업데이트

**Bridge 앱과 HACS 통합을 모두 `1.8.16`으로 맞춘 뒤 Bridge와 Home Assistant를 재시작하세요.** 일반 업데이트에서는 기존 통합 삭제·재등록, 엔티티 삭제, 로그인 프로필 초기화가 필요하지 않습니다. 기존 엔티티 ID와 사용자 지정 이름을 유지합니다.

방 동기화를 이전에 꺼서 저장했다면 **SmartThings Web → 옵션 → SmartThings 방과 기기 영역 동기화**를 켜세요. 이 README 변경만 반영하기 위해 이미 설치된 `1.8.16`을 다시 설치할 필요는 없습니다.

릴리스에는 다음 두 설치 파일이 제공됩니다.

| 파일 | 용도 |
| --- | --- |
| `smartthings-web-bridge-1.8.16.tgz` | Bridge 앱 패키지 |
| `smartthings-web-integration-1.8.16.tgz` | Home Assistant 통합 패키지 |

<details>
<summary>수동 로컬 앱 설치·업데이트</summary>

저장소 루트에서 자체 포함형 앱 패키지를 생성합니다.

```bash
npm ci
npm run package:addon
```

생성된 `dist-addon/smartthings_web_bridge` 폴더의 **내용 전체**를 HA 호스트의 `/addons/smartthings_web_bridge`에 복사하고 앱 스토어에서 **업데이트 확인**을 실행합니다.

원본 `addon/smartthings_web_bridge` 폴더만 복사하면 모노레포 빌드 입력물이 빠집니다. 반드시 생성된 패키지를 사용하세요. 수동 로컬 앱의 런타임 slug는 `local_smartthings_web_bridge`입니다. 같은 slug의 백업 폴더를 `/addons` 안에 두지 말고 외부에 보관하세요.

현재 저장소 설치 앱 ID: `8a97f131_smartthings_web_bridge`

현재 저장소 설치 내부 DNS: `8a97f131-smartthings-web-bridge`

</details>

## 자동화와 서비스 예제

아래 `entity_id`와 `dev_001`은 예시입니다. HA 작업 화면에서 실제 엔티티·기기를 선택하세요. Advanced 식별자는 `list_commands` 응답의 값을 그대로 사용하고, `identifier_*`를 임의로 `main`이나 원본 capability 이름으로 바꾸지 않습니다.

### SmartThings Scene 실행

발견한 Scene은 원래 이름을 유지한 표준 `scene` 엔티티로 등록됩니다.

```yaml
action: scene.turn_on
target:
  entity_id: scene.good_night
```

### Galaxy Home Mini 음성 안내

Advanced에서 `speechSynthesis.speak`를 제공하는 기기에 전용 서비스를 사용합니다.

```yaml
action: smartthings_web.speak
data:
  device_id: dev_001
  phrase: 현관문이 열렸습니다.
  timeout: 30
```

전용 서비스는 지원 명령이 정확히 하나인 기기를 대상으로 합니다. 입력은 제어 문자를 제외한 1~1024자 범위이며 기기가 더 짧은 `maxLength`를 지정하면 그 규격을 따릅니다. Galaxy Home Mini에서 관찰된 명령 규격은 최대 1000자입니다.

### Advanced 명령 조회·실행

먼저 해당 기기가 제공하는 현재 명령 목록을 확인합니다.

```yaml
action: smartthings_web.list_commands
data:
  device_id: dev_001
```

응답에 `main` / `switch` / `on` 조합이 **실제로 포함된 경우**의 실행 예입니다. 다른 식별자가 반환되면 응답에 나온 정확한 값으로 바꿉니다.

```yaml
action: smartthings_web.execute_command
data:
  device_id: dev_001
  component: main
  capability: switch
  command: "on"
  arguments: []
  confirm: true
  timeout: 30
```

상태 확인이 가능한 명령은 실제 상태 변경을 확인합니다. `refresh`·`push`·음성 출력 같은 지속 상태가 없는 명령과 `confirm: false` 호출의 접수 응답은 물리적 동작 완료와 구분합니다. 상태 연결 정보가 없는 명령 전용 `number`·`select`의 현재값은 `unknown`일 수 있습니다. 자세한 예제는 [Advanced 명령 전용 제어 안내](docs/ADVANCED_COMMAND_CONTROLS_1.8.14.md)에 있습니다.

### Home Monitor와 유지보수

Home Monitor는 전용 경보 패널을 통해 **외출·실내·해제**를 제어합니다. 로그인된 웹앱의 직접 보안 상태 요청을 사용하며 외출↔실내 전환에서도 중간 해제나 화면 버튼 클릭 없이 목표 모드를 한 번 전달합니다. 요청 접수만으로 성공 표시하지 않고 실제 보안 상태를 확인합니다. [직접 제어 동작](docs/home-monitor-direct-transport.md)을 참고하세요.

| 서비스 | 용도 |
| --- | --- |
| `smartthings_web.reload_inventory` | 기기·방·기능 인벤토리 다시 읽기 |
| `smartthings_web.refresh_device` | 선택한 기기 새로고침 |
| `smartthings_web.reconnect_realtime` | 실시간 연결 재연결 |

통합 옵션의 `safe_control` 모드에서 제어 서비스를 사용합니다. `read_only` 모드는 상태·명령 목록 조회만 허용하며 Scene 실행과 기기 제어·TTS를 차단합니다. 화면별 입력 방법은 [서비스 UI 사용법](docs/smartthings-web-services-ui-guide.md)에 정리되어 있습니다.

## 동작 구조와 세션 유지

```text
Samsung 계정으로 로그인한 Chromium
        │
        ├─ SmartThings Advanced: 기기·방·상태·기능·명령 목록
        └─ SmartThings Web /location: 실시간 이벤트와 기기 제어
        ▼
SmartThings Web Bridge 앱
  ├─ 지속 Chromium 프로필과 세션 복구
  ├─ 상태 병합·중복 이벤트 억제
  ├─ 민감정보 제거와 식별자 별칭화
  └─ 로컬 인증 API / SSE
        │ Home Assistant 내부 네트워크
        ▼
smartthings_web 통합
  └─ 엔티티·방/영역 동기화·서비스·자동화
```

Advanced는 페이지가 나뉜 기기 목록을 끝까지 읽어 병합합니다. `/location` 연결은 실시간 이벤트 수신용으로 유지하며 재연결 후 인벤토리를 다시 동기화합니다. 명령 종류와 확인된 전달 경로에 따라 Web native 제어·Advanced 명령·검증된 DOM 대체 경로를 사용하고, 응답이 불명확한 명령을 무작정 반복 전송하지 않습니다.

로그인 세션은 `/data/chromium-profile`의 고정 `Default` 프로필에 보존합니다. Bridge는 주기적으로 인증 상태를 확인하고 저장된 Samsung SSO 세션으로 재진입을 시도합니다. Samsung SSO 자체가 만료되어 사용자 인증이 필요해지면 noVNC에서 다시 로그인합니다. **Samsung 로그인 갱신과 HA의 로컬 Bridge 재페어링은 별개**입니다.

여기서 **API-free**는 별도의 SmartThings 공개 API 연동, PAT, 사용자 설정 OAuth/SmartApp 자격 증명이나 웹훅을 사용하지 않는다는 뜻입니다. 로그인된 웹앱의 내부 Web 요청과 인터넷 연결은 사용합니다.

## 사용 시 참고

| 항목 | 현재 동작 |
| --- | --- |
| Samsung Web 의존성 | 비공식 웹 세션 기반이므로 Samsung의 인증·화면·프로토콜 변경 시 대응 업데이트나 재로그인이 필요할 수 있습니다. |
| 기기별 기능 | 계정·Location의 실제 상태와 명령 목록을 기준으로 지원합니다. 대상이나 입력 규격이 불명확한 명령은 임의 실행하지 않습니다. |
| 범용 명령의 안전 정책 | 잠금장치·차고문·밸브·사이렌 등 위험 명령, 민감 인자, 일부 OCF·오디오 그룹 구성 명령은 제외합니다. Home Monitor는 별도의 전용 제어 경로로 지원합니다. |
| 카메라 | 현재는 관찰된 이미지의 로컬 캐시를 이용한 스틸 이미지 지원이며 실시간 영상 스트리밍은 제공하지 않습니다. |

과거 버전에서 발생했던 Home Monitor 선택기·제어 지연·엔티티 누락 등의 기록은 [변경 이력](CHANGELOG.md)과 버전별 문서를 참고하세요. 이전 버전의 실패 기록을 현재 버전의 미지원 기능 목록으로 사용하지 않습니다.

## 보안과 개인정보

Samsung 비밀번호·MFA·CAPTCHA는 브라우저에서 직접 입력합니다. 쿠키·SSO 정보가 포함될 수 있는 Chromium 프로필과 Bridge 데이터는 앱의 `/data` 아래에서 접근 권한을 제한해 보관합니다. 진단 캡처에서는 인증정보를 제거하고 계정·기기·위치 식별자를 별칭화합니다. 로컬 Bridge 토큰은 HA 구성 항목에 저장되므로 HA 백업과 진단 자료도 안전하게 관리하세요.

noVNC는 Home Assistant Ingress를 통해 사용하고, Bridge API는 Bearer 토큰으로 인증합니다. 통합의 Bridge 주소는 허용된 로컬·사설 네트워크 주소만 사용하며 공개 인터넷 호스트에 연결하지 않습니다. 카메라 이미지와 진단 캡처에는 크기·개수 제한을 적용합니다.

호환되지 않는 프로토콜을 감지하면 `PROTOCOL_CHANGED`로 전환해 잘못된 상태 처리와 제어를 중단하고 상태 화면은 유지합니다. `/data/protocol-fingerprint.json`을 임의로 삭제하거나 변경을 자동 승인하는 방식으로 우회하지 않습니다. 자세한 처리 원칙은 [프로토콜 문서](docs/protocol-report.md), 취약점 신고는 [SECURITY.md](SECURITY.md)를 참고하세요. 공개 이슈에 쿠키·토큰·비밀번호·원본 인증 헤더를 올리지 마세요.

## 릴리스 검증

[v1.8.16 배포 커밋](https://github.com/1bobby-git/HA-SmartThings_Web/commit/29dad2cc1d8bff9bb6c25bf9edfacdf47e7841e3)에서 다음 자동 검사를 통과했습니다.

| 검사 | 결과 |
| --- | --- |
| Node 테스트 | 102개 파일, 1,205개 테스트 통과 |
| Python 통합 테스트 | 385개 테스트 통과 |
| TypeScript·빌드·보안 | 타입 검사·빌드·API 경계·비밀정보·익명화 fixture 검사 통과 |
| 브라우저·패키지 | Chromium 회귀 검사, HACS, Hassfest, 패키지형 HAOS 런타임 기동 검사 통과 |
| 배포 | Bridge 앱과 통합 패키지 발행 완료 |

[Validate 결과](https://github.com/1bobby-git/HA-SmartThings_Web/actions/runs/34095166661) · [Security checks 결과](https://github.com/1bobby-git/HA-SmartThings_Web/actions/runs/34095166630) · [Release 결과](https://github.com/1bobby-git/HA-SmartThings_Web/actions/runs/34095315815)

자동 검사는 회귀 방지와 패키지 검증 결과입니다. 현재 사용자 환경의 안정성 피드백과 별개로, 모든 계정·기기 및 72시간 연속 운용을 새로 검증했다는 뜻은 아닙니다. 장기 운용 검증 절차와 이전 측정 기록은 [수동 검사 안내](MANUAL_TEST.md)와 [HAOS 장기 검사 문서](docs/haos-soak.md)에서 확인할 수 있습니다.

<details>
<summary>개발용 실행과 검사 명령</summary>

저장소가 고정한 Node 환경과 의존성을 사용합니다. 실행 환경은 [package.json](package.json)과 [검증 워크플로](.github/workflows/validate.yml)를 참고하세요.

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

Supervisor 없는 환경에서 브리지 자체를 개발 확인할 때는 제공된 Dockerfile을 사용할 수 있습니다. 아래 예제는 루프백에만 노출하며 일반 HAOS 앱 설치를 대체하는 자동 설정 과정은 아닙니다.

```bash
docker build -f docker/Dockerfile -t ha-smartthings-web:dev .
docker run --rm --shm-size=1g -p 127.0.0.1:8099:8099 -v smartthings-web-data:/data ha-smartthings-web:dev
```

아래 HAOS 진단·배포 도구는 관련 문서와 실행 게이트를 먼저 확인하세요. 배포 도구는 실행 모드에 따라 운영 환경을 변경할 수 있습니다.

```bash
npm run probe:physical-action:haos -- status
npx tsx tools/haos-capture-origin-audit.ts
npx tsx tools/haos-core-restart-continuity.ts
npm run deploy:haos:candidate
```

</details>

## 라이선스

MIT License. [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 확인하세요. Samsung 또는 SmartThings가 제공하거나 보증하는 공식 통합이 아닙니다.

<!--
Historical documentation-gate compatibility anchors retained from the previous README.
These describe earlier verification records, not the current release's feature status.
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
