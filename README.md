# HA SmartThings Web

`HA SmartThings Web`은 Home Assistant에서 `my.smartthings.com` 웹 세션을 이용해 SmartThings 기기 상태와 안전하게 허용된 제어를 연결하는 비공식 프로젝트입니다.

브라우저 로그인을 담당하는 **SmartThings Web Bridge 앱**과 Home Assistant 엔티티를 생성하는 **`smartthings_web` 커스텀 통합**으로 구성됩니다. Samsung 비밀번호·MFA·CAPTCHA를 소스나 설정 파일에 입력하지 않고, 사용자가 앱의 noVNC 브라우저에서 직접 로그인합니다.

> **현재 상태: LIMITED ALPHA**  
> 현재 게이트는 `DECISION: LIMITED`입니다. 실제 HAOS 환경에서 연결·재시작 복구·푸시 상태 반영이 검증되었지만, 장시간 유휴 상태·호스트 재부팅 복구·모든 기기 유형의 제어·완전한 API 독립성은 아직 검증 범위 밖입니다.

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

- 센서, 바이너리 센서, 스위치, 조명, 버튼, 숫자 입력
- 팬, 미디어 플레이어, 기후, 커버, 선택 항목
- 장면, SmartThings Home Monitor 경보 패널
- 캐시된 카메라 스틸 이미지

기기나 SmartThings Web 화면에서 제공하지 않는 기능은 생성되지 않을 수 있습니다. 카메라는 실시간 스트리밍이 아니라 관찰된 서명 URL에서 제한된 크기의 이미지 바이트만 받아 로컬 캐시에 저장합니다.

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

- SmartThings Web Bridge 앱과 Home Assistant 통합 `0.1.53`은 일시적 SmartThings 500 snapshot 오류를 프로토콜 변경으로 오판하지 않고, 현재 위치 화면의 정확한 `data-testid="device"` 카드 상세 열기 버튼을 먼저 사용한 뒤 필요할 때만 방 화면으로 이동합니다. 동일한 실제 토글이 접근성 `switch`와 내부 `checkbox`로 함께 노출되면 `switch`를 우선합니다. 한 번 확인한 device detail 경로는 디스크에 저장하지 않고 실행 중 메모리에서만 제한적으로 재사용해, warm 페이지가 만료된 뒤에도 전체 카드 탐색을 반복하지 않습니다. 애드온과 통합 구성요소 모두 SmartThings 아이콘을 사용합니다.
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
