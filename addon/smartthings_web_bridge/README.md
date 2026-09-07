# SmartThings Web Bridge 앱

## Home Monitor 1.8.11

실제 보안 카드의 버튼을 사용합니다. 경비 모드 간 전환은 **해제 → 해제 상태 확인 → 요청 모드 → 최종 확인** 순서입니다. 중간에 경비가 해제되며 재경비가 실패하면 해제 상태에 남을 수 있습니다. `command_transition_disarm_failed` / `command_transition_rearm_failed`가 나오면 실제 상태를 확인하세요. 문구·로고를 누르는 방식은 이 카드에서 사용하지 않습니다. Bridge와 HA 통합을 함께 업데이트하세요.


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

## 1.8.7 브리지 최적화

keeper 동시 복구와 실패 탭 정리, 최대 2,048개 HMAC 별칭 캐시, 캡처 SQL 문 재사용 및 capability 캐시 경합 수정이 포함됩니다. 기존 쿠키/Chromium 프로필·로그인/SSO 복구 간격·명령 동작은 그대로입니다. 서버 측 세션 만료를 연장하거나 우회하지 않습니다.

HA 앱 스토어 새로고침 후 1.8.7로 업데이트하고 앱의 실행 상태를 확인하세요. 기존 HACS 통합 1.8.7 재설치는 필요하지 않습니다. 업데이트 전 앱 백업과 디스크 여유 공간을 확보하고 앱 데이터/프로필은 삭제하지 마세요. 문제가 생기면 업데이트 전 앱 백업을 복원하세요.

브리지 소스 태그는 `bridge-v1.8.7`이며 `v1.8.7` 릴리스의 새 `smartthings-web-bridge-1.8.7.tgz`와 전용 체크섬/provenance를 사용합니다. 자동 회귀 검증과 운영 계정의 장시간 세션·실기기 검증은 별개입니다.


## 1.8.9

- Home Monitor가 캐시된 모드와 같다는 이유만으로 명령을 생략하지 않습니다. 해당 위치의 새 상태 조회로 확인된 경우에만 이미 적용된 상태로 처리합니다.
- Push 누락 시 명령 대기 중에만 최대 5회의 순차적 상태 확인 사이클을 수행합니다. 날짜 없는 반대 상태의 확인은 사이클당 두 번의 읽기를 사용합니다. 정상 이벤트 수신 시 즉시 중단하고, 동시 조회·무제한 재시도·제어 명령 재전송은 하지 않습니다. 확인 제한을 15초로 설정한 예에서는 조회 시작 목표가 1·2·4·7·10초입니다. 변경하지 않은 기본 설정은 30초이며 이 경우 마지막 확인 목표는 25초입니다. 실제 조회시간에 따라 시작이 늦어질 수 있습니다.
- 날짜 없는 반대 상태는 같은 위치에서 새로 수행한 두 번의 조회가 일치하고 조회 도중 더 최신 상태가 들어오지 않은 경우에만 반영합니다. 서버 시각을 만들어 넣지 않고, 일반 스냅샷의 오래된 상태·다른 위치·중간 상태 차단을 유지합니다.
- 명령 완료 후 HA가 실제 Bridge 인벤토리를 한 번 즉시 읽어 SSE 갱신을 기다리던 구간을 보완합니다. 요청 모드를 낙관적으로 표시하지 않으며, 늦게 도착한 이전 시퀀스는 거부합니다.
- 기존 Home Monitor 직접 버튼·선택기·탭 유지, Scene·Advanced commands·speak, 방 연결·개별 스위치·로그인 프로필·엔티티 ID는 보존합니다. protocol 5를 유지합니다.
- 새 회귀 검사에는 누락 Push, 캐시 기반 잘못된 no-op, 다른 위치의 증거, 진행 중 조회 경합, 취소·상한, HA의 완료 후 상태 반영이 포함됩니다. 합성 검사와 실제 Samsung 계정의 성공률·서버 지연은 별개입니다.

## 1.8.10

- Home Monitor 카드에서 검증한 선택기와 aria-controls/aria-owns/aria-labelledby로 직접 연결된 팝업을 같은 요청 안에서 추적합니다. 제목 없이 현재 모드를 제외한 두 선택지만 표시하는 dialog/listbox/menu도 이 연결이 확인된 경우에만 처리합니다. 연결되지 않은 팝업, 중복 대상, 비활성 제어는 계속 차단합니다.
- Home, Arm home, Armed (Home), 집 표기를 해당 Home Monitor 카드와 검증된 팝업 내부에서만 Stay로 해석합니다. 페이지 전체의 Home 메뉴나 방 이름을 누르는 규칙은 추가하지 않습니다. 실내 전환을 위해 자동으로 먼저 해제하지 않습니다.
- 기본 30초 확인 창의 7초~25초 조회 공백을 보완합니다. 상태 재확인이 활성화된 기본 경로의 조회 시작 목표는 1/2/4/7/10/15/20/25초이며 최대 8개 순차 사이클입니다. 실제 읽기 시간이 길면 늦어질 수 있고 정상 이벤트 수신 즉시 중단합니다. 제어 재전송이나 유휴 폴링은 추가하지 않습니다.
- HA가 완료 응답 이상의 시퀀스와 일치하는 실제 보안 상태를 이미 받았다면 중복 전체 인벤토리 조회를 생략합니다. 아직 뒤처졌다면 기존 1회 조회를 유지합니다. 요청값을 낙관적으로 표시하지 않습니다.
- 기존 외출/해제 직접 클릭, 확인까지 탭 유지, Scene/Advanced commands/speak, 로그인 프로필, 영역 및 개별 스위치, 엔티티 ID는 보존합니다. wire protocol은 5입니다.
- 사용자 오류 로그를 먼저 검토했으나 해당 계정의 최신 Web DOM과 단계별 시간은 확보하지 못했습니다. 선택기 패턴과 기본 조회 공백은 소스/합성 회귀로 검증하며 모든 실계정 모드 성공이나 실제 응답 시간 개선을 보장하지 않습니다.
