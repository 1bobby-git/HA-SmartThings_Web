# HA SmartThings Web

`HA SmartThings Web`은 Home Assistant에서 `my.smartthings.com` 웹 세션을 이용해 SmartThings 기기 상태와 안전하게 허용된 제어를 연결하는 비공식 프로젝트입니다.

브라우저 로그인을 담당하는 **SmartThings Web Bridge 앱**과 Home Assistant 엔티티를 생성하는 **`smartthings_web` 커스텀 통합**으로 구성됩니다. Samsung 비밀번호·MFA·CAPTCHA를 소스나 설정 파일에 입력하지 않고, 사용자가 앱의 noVNC 브라우저에서 직접 로그인합니다.

> **현재 상태: LIMITED ALPHA**  
> 현재 게이트는 `DECISION: LIMITED`입니다. 실제 HAOS 환경에서 연결·재시작 복구·푸시 상태 반영이 검증되었지만, 장시간 유휴 상태·호스트 재부팅 복구·모든 기기 유형의 제어·완전한 API 독립성은 아직 검증 범위 밖입니다.

## Advanced 주 데이터·명령 구조

버전 0.1.155은 로그인된 동일 Chromium context에서 SmartThings Advanced 내부 경로를 장치·location·room·상태·health·capability·safe command catalog의 주 데이터 소스로 사용합니다. 200개를 넘는 장치는 next link 또는 `isNext/max/page` 규칙으로 끝까지 읽고 `deviceId`로 병합합니다. 단일 component 장치는 관찰된 `/location` native control을 유지하고, 안전하고 되돌릴 수 있는 Advanced `on`/`off` 조합은 native switch/light 엔티티로 추가 투영합니다. composite parent의 main이 직접 command endpoint가 아닌 aggregate 상태이면 secondary component와 child main 상태의 동일 값·900ms 이내 timestamp에 대한 전체 일대일 조합이 정확히 하나일 때만 child device들을 직렬 제어하고, 그 검증된 component-child 매핑을 Bridge 재시작 뒤에도 재사용하도록 별도 저장합니다. 실제 child 제어는 direct Advanced endpoint가 404인 실증에 따라 관찰된 Location-native child control만 직렬 사용하고 DOM fallback은 허용하지 않으며, bounded confirmation window의 parent+child Advanced `/status` 전체 벡터가 일치할 때만 성공합니다. status-only Advanced 응답은 전체 topology가 아니므로 기존 parent-child 관계를 지우지 않습니다. 부분 실패나 최종 확인 실패는 완료된 child를 원래 값으로 되돌리고 Advanced status로 원래 parent/child vector를 확인합니다. 매핑 실패는 parent fallback 없이 닫습니다. 실패 진단은 raw 식별자 없이 component one-based ordinal, dispatch/rollback phase, outcome과 fixed transport error code만 기록합니다. 실행할 수 없는 secondary switch와 중복 Refresh는 Home Assistant 제어 엔티티로 노출하지 않습니다.

`lastUpdatedDate`를 포함한 timestamp가 없는 Advanced `OFFLINE`은 장치를 unavailable로 만들지 않습니다. 더 새로운 Location 상태 이벤트나 성공한 Advanced `/status` 조회는 online 증거가 되고, 그보다 새로운 timestamp가 있는 명시적 health `OFFLINE`은 계속 우선합니다. Bridge 재시작 때도 offline으로 저장된 장치는 persisted Location/status evidence를 다시 비교해 더 최신의 정상 상태가 있으면 online으로 복구하되, 값 자체가 `offline`, `unavailable`, `disconnected`인 상태는 positive evidence로 사용하지 않습니다.

장치 명령은 live 증거가 있는 조합에서만 Advanced direct를 허용하고, 현재 기본은 **`/location` native command → 검증된 DOM fallback** 순서입니다. HTTP `ACCEPTED`만으로 HA 상태를 바꾸지 않으며, stateful 명령은 `/location`의 새 push 또는 상태 재조회로 확인합니다. `refresh`, `press`, media next/previous처럼 지속 상태가 없는 명령은 접수 성공만 반환합니다.

`/location` 페이지는 제거하지 않습니다. Socket.IO realtime keeper로 계속 유지되며 물리 조작, SmartThings 앱, 외부 자동화의 변경을 HA에 전달합니다. 재연결 후 첫 수신 프레임이 확인되면 Advanced 전체 snapshot을 다시 동기화합니다. 쿠키·토큰·CSRF·원본 device/location ID는 서비스, 로그, diagnostics에 노출하지 않습니다.

기존 `smartthings_web` config entry, entity ID, unique ID, device registry identifier, area와 사용자 이름은 유지됩니다. Web 표시명은 generated `original_name`에만 반영하고, device class가 없는 범용 센서는 장치 유형 아이콘을 받으며, 온도 같은 기능형 센서는 Home Assistant device class 아이콘을 유지합니다. 범용 명령은 `smartthings_web.execute_command` 서비스를 사용하며 `device_id`, `component`, `capability`, `command`와 선택적인 `arguments`, `confirm`, `timeout`을 받습니다.

명령 확인에는 `smartthings_web.list_commands`와 `smartthings_web.speak`도 제공합니다. `speak`는 안전한 `speechSynthesis.speak` descriptor가 정확히 하나일 때만 1-1024자 control-character 없는 문구를 전달합니다. 운영 서비스로 `smartthings_web.reload_inventory`, `smartthings_web.refresh_device`, `smartthings_web.reconnect_realtime`도 제공합니다. 앱 옵션에서 confirmation timeout, status recheck, 저빈도 reconciliation interval, DOM fallback, protocol debug logging을 설정할 수 있으며 잘못된 값은 시작 전에 거부됩니다. 패키지에 포함된 `npm run audit:web-parity`는 Bridge inventory와 Home Assistant projection을 비교해 위험 명령, 중복 unique ID, 중복 generated name, 설명 없는 safe omission을 검사합니다.

## 빠른 설치

설치는 **브리지 앱 → HACS 통합 → 통합 설정** 순서로 진행합니다.

### 1. SmartThings Web Bridge 앱 설치

Home Assistant OS 또는 Supervised 환경에서 저장소를 내려받은 뒤 자체 포함형 앱 패키지를 생성합니다.

```bash
npm ci
npm run package:addon
```

생성된 `dist-addon/smartthings_web_bridge` 폴더의 **내용 전체**를 Home Assistant 호스트의 `/addons/smartthings_web_bridge`에 복사합니다.

Home Assistant에서 다음 순서로 설치합니다.

1. **설정 → 앱 → 앱 설치**로 이동합니다.
2. 우측 상단 메뉴에서 **업데이트 확인**을 실행합니다.
3. **로컬 앱**의 **SmartThings Web Bridge**를 설치하고 시작합니다.
4. 앱의 **웹 UI 열기**를 눌러 noVNC Chromium 화면에서 Samsung 계정에 로그인합니다.
5. 브리지 상태가 `CONNECTED`이고 `ready=true`인지 확인합니다.

> 원본 `addon/smartthings_web_bridge` 폴더를 그대로 복사하면 안 됩니다. 이 폴더에는 모노레포 루트의 빌드 입력물이 포함되지 않으므로 반드시 `npm run package:addon`으로 생성한 패키지를 사용해야 합니다.

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
3. 기본 브리지 주소 `http://local-smartthings-web-bridge:8100`과 8자리 페어링 코드를 입력합니다.
4. 연결할 SmartThings 위치를 선택합니다.

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

- 소스 폴더: `/addons/smartthings_web_bridge`
- 앱 구성 slug: `smartthings_web_bridge`
- Supervisor 설치 후 실제 런타임 slug: `local_smartthings_web_bridge`

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

## 현재 검증 결과

- `0.1.91`은 상세 페이지에서 로드된 인증 native client를 최대 24시간 검증·재사용하여, 최초 UI 탐색 뒤의 반복 제어가 다시 DOM 탐색 대기열로 내려가지 않게 합니다.
- `0.1.90`은 인증된 in-page native 기기 명령을 느린 DOM 탐색 대기열 밖에서 즉시 전송하고, 응답 타이머 대신 기존 push/snapshot 확인을 권위로 사용합니다. 허용된 SmartThings presentation 아이콘은 HA 엔티티에 노출하며, 새로고침 버튼은 실제 관측된 refresh control에서만 생성합니다.
- `0.1.89`는 my.smartthings.com Socket.IO 종료를 Playwright와 CDP 양쪽에서 즉시 감지해 keeper를 재로드하고 새 전체 snapshot이 끝날 때까지 readiness를 차단합니다. 송신 프레임은 push freshness를 연장하지 않으며, reconnect 때 같은 sequence inventory를 중복 fetch하지 않고 SSE marker도 O(1) sequence 조회로 전송합니다.
- `0.1.88`은 현재 fingerprint가 호환되고 Bridge가 `ready+CONNECTED`라면 과거 protocol change 횟수를 현재 오류로 오판하지 않습니다. 물리 probe·Core continuity·72시간 소크는 시작 baseline보다 횟수가 증가할 때만 즉시 실패하므로 실제 규격 변경 보호는 유지됩니다.
- `0.1.87`은 HAOS Chromium 실행 인자에서 Playwright가 이미 백그라운드 타이머·occlusion·renderer throttling을 모두 해제하고 있음을 확인해 중복 사용자 인자를 제거합니다. 0.1.86의 로컬 SSE Nagle 지연 제거와 50ms 첫 재연결은 그대로 유지합니다.
- `0.1.86`은 로컬 SSE의 Nagle 지연을 끄고, 일시적인 Bridge 스트림 장애의 첫 재연결을 1초에서 50ms로 단축합니다. 반복 장애만 최대 1초까지 완만하게 backoff하고 SmartThings 상태 polling은 추가하지 않습니다.
- `0.1.85`는 실제 Cake 캡처에서 확인된 토글 명령 규격에 따라, 안전한 toggle swatch가 명령 메타데이터를 생략해도 표준 `on`/`off`를 인증된 웹 직접 명령으로 전송해 상세 화면 탐색을 건너뜁니다.
- `0.1.84`는 캡처 경계에서 두 번 익명화된 device ID와 DeviceStore까지 거친 component/capability의 모든 실제 별칭 단계를 원본 식별자의 휘발성 메모리 매핑에 연결합니다.
- `0.1.83`은 1MB를 넘는 실제 전체 device snapshot도 최대 8MB의 메모리 전용 한도 안에서만 원본 식별자 매핑에 사용하고, 저장되는 진단 캡처의 더 작은 한도는 그대로 유지합니다.
- `0.1.82`는 익명화된 component/capability가 DeviceStore에서 다시 정규화되는 3단계 별칭을 원본 식별자의 휘발성 메모리 매핑에 포함해, 전체 snapshot 직후에도 인증된 웹 직접 명령 경로를 사용할 수 있게 합니다.
- `0.1.81`은 관찰된 안전 제어를 인증된 my.smartthings.com 페이지의 기존 Feathers/Socket.IO 클라이언트로 직접 전송하고, 이 경로를 사용할 수 없을 때만 기존의 정확한 UI 제어 경로를 사용합니다. 원본 기기·컴포넌트·capability 식별자는 브라우저 세션 동안 메모리에만 보관하며, 성공 판정은 계속 최신 push 상태로만 수행합니다.
- `0.1.80`은 SmartThings Web push를 진단 캡처와 전체 인벤토리 SQLite 저장보다 먼저 Bridge SSE로 전달합니다. 동일 논리 이벤트의 다중 WebSocket 전달은 프로토콜 카운터에는 유지하되 한 번만 저장하고, 큰 인벤토리 스냅샷은 짧은 이벤트 묶음 단위로 합쳐 저장하며 일시적 잠금은 재시도합니다.
- `0.1.79`는 각 SmartThings push마다 모든 HA 엔티티를 다시 쓰던 전역 listener 병목을 제거합니다. 기존 속성 변화는 정확히 일치하는 상태 엔티티와 같은 기기의 복합 엔티티만 갱신하고, 새 속성이나 inventory 변화에만 discovery/registry 검사를 실행하며, inventory 재동기화도 실제 변경된 기기로 제한합니다.
- 같은 릴리스에서 공식 SmartThings 통합의 구성 원칙에 맞춰 접촉·동작·측정값은 올바른 센서 클래스로, 물리 버튼은 `event`, 펌웨어는 하나의 읽기 전용 `update`, 스피커는 `media_player`, 팬·공기청정기는 `fan`으로 정리했습니다. 관찰되지 않은 합성 Refresh는 제거하고 실제 웹 버튼만 만들며, 공식 통합에 없는 SmartThings Web 고유 상태도 삭제하거나 숨기지 않고 진단 센서로 계속 노출합니다. 한 기능에 속한 값만 해당 통합 엔티티의 속성으로 모아 중복을 줄입니다.
- 실제 웹의 range 입력을 네이티브 값 변경 이벤트로 구동해 감지 주기·팬 속도·볼륨·밝기·색온도를 포함한 관찰된 모든 숫자 슬라이더를 처리합니다. 스피커의 재생·일시정지·정지·빨리감기·되감기 선택 명령은 정확한 상세 swatch 안에서만 실행하고, 빨리감기/되감기는 Home Assistant의 다음/이전 트랙 기능으로 연결합니다.
- 상태값만 있고 대응하는 웹 제어가 관찰되지 않은 경우에는 읽기 값은 유지하되 동작하지 않는 쓰기 엔티티나 서비스 기능을 만들지 않습니다. 스위치·조명·팬·미디어·숫자·선택·버튼 제어는 component/capability/attribute와 control ID가 일치하는 실제 웹 제어에만 연결됩니다.
- `0.1.78`은 Bridge 재시작이나 로그인 만료 중에도 SQLite에서 복원된 cached inventory 기기 수를 health에 정확히 표시합니다. 이 값은 진단·soak의 잘못된 `0 devices` 판정을 막지만, 로그인과 새 snapshot/push 증거가 없으면 `ready=false`를 그대로 유지합니다.
- `0.1.77`은 `/rooms` 진입 직후 정확한 Cake 방 카드 제목의 렌더링을 먼저 기다려 느린 전역 접근성 탐색을 피하고, 한 HA 엔티티 listener 실패가 SSE push 루프와 다른 센서 갱신을 중단하지 않도록 격리합니다. Bridge SSE 전달, HA SSE 파싱, runtime에서 엔티티 상태 쓰기까지의 직접 회귀 테스트도 포함합니다.
- `0.1.76`은 Cake의 닫히는 overlay 뒤에 남은 정확한 same-page 기기 래퍼에서 일반 클릭의 동작 가능 상태를 최대 15초 기다리지 않고, 탐색용 click 이벤트만 래퍼 자체에 전달합니다. 이후 상세 URL과 정확한 기기 dialog, dialog 내부 제어, push 상태 확인을 모두 다시 거치므로 인라인 제어나 다른 기기를 대체 대상으로 사용하지 않습니다.
- `0.1.75`는 제어 뒤 상세창이 닫혀도 현재 페이지 뒤에 이미 렌더링된 정확히 하나의 동일 기기 카드를 먼저 즉시 다시 엽니다. 상세 URL과 정확한 기기 dialog를 다시 확인한 뒤에만 제어하며, 카드가 없거나 복구 검증이 실패하면 엄격한 방 경로로 돌아갑니다. 실측에서 느렸던 SmartThings 전체 애플리케이션 상세 URL 재로딩은 사용하지 않습니다.
- `0.1.74`는 실제 Cake `draggable-room`의 보이는 heading을 CSS로 먼저 정확히 하나만 찾고, inventory에 방 정보가 있으면 overview 전체 탐색을 생략해 바로 그 방으로 이동합니다. 닫힌 warm 상세창은 직전에 검증된 동일 상세 URL을 다시 열어 정확한 URL과 기기 dialog를 재검증한 뒤에만 제어하며, 실패할 때만 엄격한 방 경로로 돌아갑니다. 포그라운드 명령은 별도 백그라운드 분석 페이지의 느린 종료를 기다리지 않고 사전 중단된 직렬 대기열을 인계받습니다.
- `0.1.73`은 실제 Cake `draggable-room` 구조에서 유일한 정확한 방 heading과 그 부모를 먼저 선택해 213개 기기 전체가 포함된 page-wide button 접근성 트리 탐색을 피합니다. warm page의 상세 dialog 복구가 실패해도 직전에 성공하며 저장한 상세 경로를 즉시 폐기하지 않고, 새 페이지에서 정확한 상세 URL과 기기 dialog를 독립적으로 재검증한 뒤에만 제어합니다.
- `0.1.72`는 Playwright가 방 대상을 보이게 만들기 위해 반복 대기하는 구간을 제거하고 현재 가시성만 즉시 검사합니다. 정확한 방 대상이 지금 보이지 않으면 아무 이벤트도 보내지 않고 실패하며, 보이는 유일한 탐색 전용 대상에만 click 이벤트를 전달한 뒤 정확한 기기 카드·상세 URL·dialog·제어와 push 상태를 재검증합니다.
- `0.1.71`은 실기기 단계 로그에서 확인된 Cake 방 탐색 완료 대기를 제거합니다. 정확히 하나이며 이미 보이는 탐색 전용 방 대상에만 click 이벤트를 전달하고, 실제 이동 성공은 이후 정확한 기기 카드와 상세 dialog로 재검증합니다. warm page 복구가 실패한 명령에서는 이미 실패가 확인된 직접 상세 경로를 다시 열지 않습니다.
- `0.1.70`은 실측된 제어 병목을 줄입니다. 포그라운드 제어가 들어오면 백그라운드 상세 분석이 즉시 직렬 대기열을 양보하고, 토글 뒤 상세창이 닫힌 경우 새 브라우저 페이지와 실패하는 직접 경로를 만들지 않고 같은 warm page에서 정확한 방과 기기를 다시 열어 정체성을 재검증합니다. 방 선택은 정확히 하나의 보이는 탐색 전용 버튼에만 제한된 클릭을 사용하며, 기기 카드·상세 dialog·제어의 정확한 일치와 push 상태 확인은 그대로 유지합니다.
- `0.1.69`는 제어 지연을 값·기기명·식별자·URL 노출 없이 분해하기 위해 warm page, verified route, location, room, device, detail dialog, toggle click 경계에 고정 단계 진단을 추가합니다. 이 릴리스는 계측 후보이며, 실제 속도 개선은 측정된 병목에만 적용합니다.
- SmartThings Web Bridge 앱과 Home Assistant 통합 `0.1.68`은 일시적 SmartThings 500 snapshot 오류를 프로토콜 변경으로 오판하지 않고, 정확히 하나의 보이는 `data-testid="device"` 카드 래퍼만 눌러 상세 화면을 엽니다. 카드 클릭 뒤에는 정확한 SmartThings 상세 경로뿐 아니라 방을 아는 경우 정확한 `기기명 + 방 이름`, 방을 모르는 경우 정확한 `기기명` 접근성 제목을 가진 보이는 `role="dialog"` 상세 모달까지 기다립니다. 최초의 방 탐색이 차가운 SmartThings 페이지 로딩 때문에 `command_room_not_found`로 끝나면, 어떤 제어도 탐색하기 전 실패한 페이지를 닫고 새 페이지에서 정확히 한 번만 같은 엄격한 탐색을 반복합니다. 제어 탐색이 시작되거나 상태 변경 가능성이 생긴 뒤에는 재시도하지 않습니다. 모든 제어 탐색은 그 정확한 상세 모달 내부로 제한되며, 관찰된 Power 라벨이 접근성 이름이나 텍스트로 주소화되지 않을 때도 상세창 안의 유일한 `switch` 또는 `checkbox`만 허용합니다. 배경 카드의 제어는 절대 대체 대상으로 사용하지 않습니다. Cake가 모달 제목의 시각 텍스트에 뒤로가기 기호와 방 이름을 붙여도 접근성 제목으로 정확히 검증하며, 접두어가 같은 다른 기기, 뒤쪽 방 목록에 남아 있는 동일 기기 카드, 부분 이름은 상세 준비 증거로 인정하지 않습니다. 전환이 완료되지 않으면 어떤 제어도 누르지 않고 실패합니다. 카드 내부의 인라인 전원 버튼, 페이지 전체의 이름 기반 버튼, 단순 텍스트는 장치 상세 열기 대체 경로로 절대 누르지 않습니다. 동일한 실제 토글이 접근성 `switch`와 내부 `checkbox`로 함께 노출되면 그 순서로 우선하고, Cake가 토글을 `button`으로 렌더링한 경우에도 관찰된 정확한 Power swatch 안의 단 하나만 허용합니다. 새 상세 페이지에서는 관찰된 정확한 토글 swatch가 최대 15초 안에 늦게 나타나는 것을 허용하고, swatch가 공용 탐색 시간을 소진해도 그 안의 유일한 제어에는 별도의 제한된 가시성 확인 시간을 부여합니다. 따뜻한 재사용 페이지의 짧은 탐색과 다른 제어의 기존 제한은 유지합니다. 제어 진단 로그는 기기명·ID·URL 없이 이름 기반 제어, 정확한 swatch 범위, 접근성 역할 개수의 고정 단계만 남깁니다. 검증된 상세 경로와 정확한 방 카드의 탐색 대기 시간을 줄이고 동일 기기 상세 페이지를 5분간 재검증해 재사용합니다. 0.1.94부터는 브라우저 동작이 끝난 뒤 요청 상태의 새 권위 push가 도착하는 즉시 제어를 확정해 고정 500ms 대기와 같은 기기의 후속 명령 직렬 지연을 제거합니다. Home Assistant의 SSE 작업은 연결 또는 일시적 인증 실패 뒤에도 다시 연결하며, 매 연결 전에 Bridge의 로컬 전체 snapshot을 원자적으로 병합합니다. 이는 SmartThings 상태 polling이 아닙니다. 숫자가 아닌 배터리 상태 같은 push 값은 원문을 보존하되 HA 숫자 센서 클래스를 적용하지 않고, 이후 숫자 측정값이 들어오면 자동으로 숫자 클래스를 다시 적용합니다. 허용된 SmartThings 아이콘/Lottie 메타데이터는 상태와 분리해 보존하며 Cake가 타입을 `NONE`으로 보낼 때 기기 모델 분류에 사용하고, 최신 inventory에서 제거된 메타데이터는 HA에서도 원자적으로 제거합니다. 애드온과 통합 구성요소 모두 SmartThings 브랜드 아이콘을 사용합니다.
- Bridge 재시작 뒤 SmartThings Web 재로그인이 필요한 상태에서도 저장된 213개 inventory와 sequence 47을 즉시 복원했습니다. 실제 push/제어 재검증은 전용 Chromium 재인증 뒤 `ready=true`, `CONNECTED`로 돌아온 후 진행해야 합니다.
- Home Assistant에는 215개 기기와 1,724개 활성 엔티티가 로드됐습니다. 14개 플랫폼에는 16개 `media_player`, 66개 `number`, 6개 `select`, 4개 `scene`, 1개 Home Monitor `alarm_control_panel`, 2개 `image`가 포함됩니다.
- 안전한 무드등 연속 제어와 후속 실제 상태 변화에서 Bridge `updatedAt` 이후 Home Assistant `last_updated`가 스위치는 0.327초, 전력 0 W는 1.12초 뒤 갱신됐습니다. SmartThings 상태 폴링이나 낙관적 상태 변경은 사용하지 않았습니다.
- 정확한 보이는 기기 래퍼가 식별되면 명령 탐색은 그 내부에서만 진행되며, 검토된 Feathers 400·일시적 GeneralError 500은 스냅샷 요청 실패로 처리하고 404 등 미검토 구조는 프로토콜 변경으로 노출합니다.
- 감지주기 중복 엔티티와 활성 `smartthings_web` 수리 경고는 모두 0이었고, 제어 모드 옵션 창도 Core 재시작 뒤 정상적으로 열렸습니다.
- 72시간 수동 HAOS soak는 사용자가 다시 요청할 때까지 보류되어 있습니다.

이 결과는 해당 시점과 환경의 검증 기록입니다. SmartThings Web 변경, Samsung 세션 만료, 계정 구성, 기기 종류에 따라 결과가 달라질 수 있습니다.

## 제한 사항

- 비공식 통합이므로 Samsung 웹 구조 변경으로 동작이 중단될 수 있습니다.
- DOM이나 픽셀을 기기 상태의 권위 있는 값으로 사용하지 않습니다.
- SmartThings 상태 반복 폴링, 영구 원본 이벤트 저널, 카메라 실시간 스트리밍은 포함하지 않습니다.
- 호스트 재부팅 복구, 장시간 유휴 내구성, 위험도가 높은 액추에이터 제어는 아직 완전 검증되지 않았습니다.
- Phase 2는 익명화된 실제 트래픽으로 전체 인벤토리·초기 스냅샷·위치 전체 푸시·재연결·공개 SmartThings API 비의존성이 입증될 때까지 닫혀 있습니다.

## 라이선스

MIT License. 자세한 내용은 `LICENSE`와 `NOTICE`를 확인하세요.

<!--
Documentation gate compatibility anchors. These are intentionally not rendered.
Current gate: `DECISION: LIMITED`
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
