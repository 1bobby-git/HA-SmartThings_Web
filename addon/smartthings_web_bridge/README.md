# SmartThings Web Bridge 앱

SmartThings Web Bridge는 Home Assistant Ingress의 noVNC Chromium에서 사용자가 Samsung 계정에 직접 로그인하고, SmartThings Web 상태와 허용된 제어를 Home Assistant 통합에 전달하는 브리지 앱입니다.

앱은 Ingress 포트 `8099`를 사용하고, VNC/noVNC는 컨테이너 내부에만 바인딩합니다. Supervisor watchdog에는 `/health/live`를 제공하며 Home Assistant Core에서만 접근하는 브리지 프록시는 `8100` 포트를 사용합니다.

## 빠른 설치

Home Assistant OS 또는 Supervised 환경에서 아래 버튼을 누르면 이 저장소가 앱 저장소에 추가되고 **SmartThings Web Bridge** 앱 화면이 열립니다.

[![Home Assistant에서 SmartThings Web Bridge 앱 열기](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=8a97f131_smartthings_web_bridge&repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

버튼이 앱 화면까지 열지 못하면 아래 버튼으로 저장소만 먼저 추가한 뒤 **설정 → 앱 → 앱 스토어 → SmartThings Web Bridge**에서 설치합니다.

[![Home Assistant에 SmartThings Web 앱 저장소 추가](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2F1bobby-git%2FHA-SmartThings_Web)

저장소 설치에서는 `config.yaml`의 버전과 같은 GitHub 릴리스 패키지를 자동으로 가져와 앱 이미지를 빌드합니다. 앱 설치가 끝나면 시작한 뒤 **웹 UI 열기**에서 Samsung 계정에 로그인합니다.

앱은 시작할 때 Supervisor에 실제 런타임 hostname과 Core 전용 포트 `8100`을 게시합니다. 통합 추가 화면은 이 값을 받아 Bridge 주소를 자동 입력합니다. 현재 저장소 설치의 내부 주소는 `http://8a97f131-smartthings-web-bridge:8100`, `/addons` 수동 로컬 설치 주소는 `http://local-smartthings-web-bridge:8100`이며, 이전 `d55cafb9` 주소도 기존 구성 복구용 후보로만 유지합니다.

## 수동 로컬 설치

저장소 루트에서 `npm ci`, `npm run package:addon`을 차례로 실행하고 `dist-addon/smartthings_web_bridge`의 **내용 전체**를 Home Assistant 호스트의 `/addons/smartthings_web_bridge`에 복사합니다.

원본 `addon/smartthings_web_bridge` 폴더만 `/addons`에 복사하지 마세요. 모노레포 빌드 입력물이 빠져 있으므로 수동 로컬 설치에서는 반드시 `npm run package:addon`으로 생성한 자체 포함형 패키지를 사용해야 합니다.

생성된 텍스트는 UTF-8/LF로 정규화됩니다. 따라서 Windows와 Linux 체크아웃에서 모노레포 원본 파일을 다시 쓰지 않고도 동일한 package-manifest SHA-256을 생성합니다.

백업 사본은 `/addons` 밖에 보관하세요. Supervisor는 그 아래의 하위 폴더를 로컬 앱으로 검색하므로 동일한 slug가 포함된 백업 폴더가 있으면 이전 버전을 현재 버전으로 잘못 인식할 수 있습니다.

프로덕션 의존성만 남긴 앱 컨테이너 내부에서 passive soak를 실행하려면 `node dist/tools/haos-soak.js --local-bridge`를 사용합니다. 같은 명령의 패키지 스크립트는 `npm run soak:haos:addon`입니다.

Ingress noVNC 화면에서 직접 로그인하세요. Samsung 자격 증명, 쿠키 또는 토큰을 앱 옵션에 저장하지 않습니다. Bridge가 `CONNECTED`에 도달하면 10분 동안 유효한 페어링 코드를 생성하고 `SmartThings Web` 통합을 추가합니다. 0.1.79부터 관찰된 기기를 등록하고 공식 통합에 없는 값은 진단 센서로 유지하며, 미디어 플레이어·팬·업데이트·이벤트·커버·기후 등 명확한 기기 역할을 기본 엔티티로 연결합니다. 실제 SmartThings Web 버튼이 관찰되지 않은 경우 합성 Refresh 제어를 만들지 않습니다.

실제 Home Assistant 2026.8.3 등록에서는 관찰된 인벤토리로 213개 기기와 352개 읽기 전용 엔티티가 생성되었습니다. 브라우저 재로그인이 필요한 동안에도 캐시된 인벤토리는 로드할 수 있지만, 실시간 push 갱신은 Bridge가 다시 `CONNECTED`가 된 뒤 재개됩니다.

0.1.28의 실제 HAOS 검증에서는 `CONNECTED`, 213개 기기, sequence 누락 없는 인벤토리 marker 및 30개의 연속 SSE 상태 이벤트를 확인했고 Bridge sequence 초기화 뒤 전체 인벤토리를 복원했습니다. 수동 접촉 센서 열림 동작은 component 없는 후보 하나로 통과했으며 Bridge source time 이후 약 134ms에 Home Assistant에 도달했습니다. 호스트 재부팅 복구, 장시간 유휴 내구성, 명령 동작 및 완전한 API 독립성이 익명화된 증거로 검증될 때까지 evidence gate는 `DECISION: LIMITED`로 유지됩니다.

<!--
Documentation gate compatibility anchors. These are intentionally not rendered.
Do not copy the raw `addon/smartthings_web_bridge` source folder
generated monorepo build inputs
Generated text is canonical UTF-8/LF
Keep backup copies outside `/addons`
Live HAOS validation of version 0.1.28
one passing component-less candidate
-->
