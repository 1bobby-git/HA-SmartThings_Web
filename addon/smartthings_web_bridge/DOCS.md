## 1.8.15 방/영역 동기화

Bridge와 HA 통합을 함께 업데이트하고, 기존 잘못된 기기 영역을 수정하려면 HA 통합 옵션에서 **SmartThings 방과 기기 영역 동기화**를 켜세요(기본 끔). Advanced에서 확인된 room과 같은 location의 방 이름으로만 연결합니다. 엔티티별 수동 영역은 보존합니다. [세부 조건 및 유형 구분](../../docs/ROOM_SYNC_1.8.15.md).

## 1.8.14 Advanced 명령 전용 제어

Bridge와 HA 통합을 모두 1.8.14로 업데이트하세요. 실제 카탈로그의 enum 선택·정수 입력·무인수 버튼을 보완하며 기존 엔티티 ID와 로그인 프로필을 유지합니다. 새 명령 전용 제어는 접수만 확인하고 현재값을 추측하지 않습니다. [상세 안내](../../docs/ADVANCED_COMMAND_CONTROLS_1.8.14.md)를 참고하세요.

## Home Monitor 1.8.13

Home Monitor 모드 변경은 로그인된 웹앱의 직접 보안 요청을 사용합니다. 외출↔실내 전환에 중간 해제나 DOM 버튼 탐색을 사용하지 않습니다. 성공 여부는 실제 상태로 확인하며, 응답 불명확 시 재전송하지 않습니다.

# SmartThings Web Bridge

## 이전 버전 1.8.11의 동작 (현재 버전에는 적용되지 않음)

실제 보안 카드의 버튼을 사용합니다. 경비 모드 간 전환은 **해제 → 해제 상태 확인 → 요청 모드 → 최종 확인** 순서입니다. 중간에 경비가 해제되며 재경비가 실패하면 해제 상태에 남을 수 있습니다. `command_transition_disarm_failed` / `command_transition_rearm_failed`가 나오면 실제 상태를 확인하세요. 문구·로고를 누르는 방식은 이 카드에서 사용하지 않습니다. Bridge와 HA 통합을 함께 업데이트하세요.


Home Assistant OS/Supervised users install this as a normal add-on. Supervisor manages the underlying container; no separate Docker installation or Docker commands are required on the Home Assistant host.

For the current private repository, build the local add-on package first:

```powershell
npm ci
npm run package:addon
```

Copy the contents of `dist-addon/smartthings_web_bridge` to `/addons/smartthings_web_bridge`, then open **Settings → Apps → Install app**, choose **Check for updates**, and install **SmartThings Web Bridge** from **Local apps**. The configured slug is `smartthings_web_bridge`; Supervisor prefixes local apps, so the installed runtime slug is `local_smartthings_web_bridge`.

Do not copy the raw `addon/smartthings_web_bridge` source folder to Home Assistant. It lacks generated monorepo build inputs that are included by `npm run package:addon`.

Generated text is canonical UTF-8/LF. Equivalent Windows and Linux checkouts therefore produce the same package-manifest SHA-256 without rewriting monorepo source files.

Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.

Version 0.1.177 quarantines recoverable malformed Bridge files under root-only `/data/recovery` instead of blocking port 8098. It never quarantines the dedicated Chromium profile merely because nested ownership migration is pending, and it preserves valid Samsung login stores. If `bridge-secret` was empty or invalid and had to be regenerated, reauthenticate the existing Home Assistant integration once because its previous bearer token can no longer match.

For a passive soak from inside the production-pruned add-on container, use the compiled local collector:

```sh
node dist/tools/haos-soak.js --local-bridge
```

The equivalent package script is `npm run soak:haos:addon`.

Open the add-on Ingress panel, use the noVNC browser view, and sign in to Samsung manually. The bridge keeps `https://my.smartthings.com/location` open and stores that login only in its dedicated `/data/chromium-profile`. Never copy cookies, CSRF values, user IDs, or other browser session material into the integration.

On Supervisor installations, the app publishes its exact runtime hostname and Core-only port `8100` through app discovery after the Bridge health endpoint is ready. The integration uses that value to prefill the Bridge URL. Manual setup remains available, and current repository, local-install, and legacy repository hostnames are tried only as private migration fallbacks.

After the Bridge reaches `CONNECTED`, generate a ten-minute pairing code on its status page and add the `SmartThings Web` integration. Select the SmartThings location to add. As of 0.1.79, the limited alpha exposes all normalized pushed attributes plus binary sensors, switches, lights, buttons, numeric controls, fans, media players, updates, events, covers, climate entities, scenes, SmartThings Home Monitor, and refreshed camera stills. SmartThings Web-only state that the official integration does not model is kept as diagnostic sensors instead of being deleted. Clear domain values are grouped under their primary Home Assistant entities, while raw SmartThings Web content remains available as attributes. It never changes Home Assistant state optimistically. Existing stateful controls retain verified confirmation; command-only catalog controls explicitly return an accepted receipt without claiming a physical state change. Refresh controls require an observed Web button or an exact safe Advanced refresh descriptor; guessed refresh controls are not created.

Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed that the Supervisor-loaded AppArmor profile is enforced and the add-on remains non-privileged with bridge networking. Version 0.1.177 still attempts sandboxed Chromium 151 first as the non-root browser user, but performs one narrowly classified compatibility retry without the Chromium sandbox when the host runtime blocks both the pinned SUID helper and user namespaces. The packaged runtime smoke test requires the status endpoint, Chromium process, and mapped X11 window before passing.

After manual VNC login, the add-on reached `CONNECTED`, observed 213 devices, initially permitted readiness, decoded live DEVICE_EVENT counters, and kept `protocolChangeCount=0` and `restartCount=0`. Version 0.1.23 fixes the old 120-second readiness drop by treating the initial snapshot as a current browser-context proof; heartbeat freshness, recent push traffic, and current-context parser proof still gate readiness.

Version 0.1.28 was then verified on the same HAOS install: the persisted login session restored after add-on updates and Bridge-only restart, the complete inventory was reacquired after a local sequence reset, and readiness stayed true beyond the former 120-second boundary. A targeted manual contact-open action produced one passing component-less candidate and updated Home Assistant about 134 ms after its Bridge source time. Host-reboot recovery and long-idle durability remain unverified.

Home Assistant service usage for `smartthings_web.list_commands`, `smartthings_web.execute_command`, `smartthings_web.speak`, `smartthings_web.reload_inventory`, `smartthings_web.refresh_device`, and `smartthings_web.reconnect_realtime` is documented at `https://github.com/1bobby-git/HA-SmartThings_Web/blob/main/docs/smartthings-web-services-ui-guide.md`. Use Home Assistant Developer Tools -> Actions, select a SmartThings Web device, and copy the exact `commands[].component`, `commands[].capability`, and `commands[].command` values from `list_commands` before executing Advanced-only commands.

The current evidence gate is `DECISION: LIMITED`. Before Phase 2, collect sanitized evidence for long-idle delivery, keep-login behavior across a host reboot, network outage recovery, commands, and complete API independence. Keep Phase 2 closed until the gate reaches GO.

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
