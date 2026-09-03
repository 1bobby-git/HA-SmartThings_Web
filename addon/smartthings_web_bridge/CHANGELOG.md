## 0.1.170

- 임시 명령·상세 조회 페이지의 Socket.IO 종료를 영구 Location keeper 연결 종료로 오인하지 않도록 즉시 복구 신호를 page-scoped CDP keeper 연결에만 제한했습니다.
- 수백 개 장치의 상세 페이지를 1초마다 연속으로 열던 자동 탐색을 15초 간격으로 완화해 Chromium CPU·메모리 급증과 Home Assistant 연결 끊김을 줄였습니다.
- Sparkplus 대시보드의 React 렌더링이 끝날 때까지 `SmartThings Home Monitor` 카드와 `보안(외출)`·`보안(실내)` 컨트롤을 기다리고, 접근성 역할이 없는 경우에도 카드 내부의 정확한 표시 문자열만 제한적으로 클릭합니다.
- 임시 Socket.IO 종료, keeper CDP 종료, 지연 렌더링 Home Monitor 및 상세 탐색 주기에 대한 회귀 테스트를 추가했습니다.

## 0.1.169

- Home Assistant 앱 저장소 설치의 실제 내부 호스트(`d55cafb9-smartthings-web-bridge`)와 수동 로컬 설치 호스트(`local-smartthings-web-bridge`)를 구분하고, 네트워크 연결 실패 때만 다른 알려진 호스트를 안전하게 확인합니다.
- 0.1.168에서 저장소 앱 주소를 존재하지 않는 `local` 주소로 강제 변환하던 회귀를 제거했습니다.
- 페어링 또는 인벤토리 조회에 실제로 성공한 Bridge 주소만 구성 항목에 저장하며, HTTP 인증·명령 오류에는 다른 앱으로 재전송하지 않습니다.
- 통합, Bridge 앱, 프로토콜 및 패키지 버전을 0.1.169로 동기화해 HACS와 앱 스토어에서 새 업데이트를 감지할 수 있도록 했습니다.

## 0.1.168

- Home Assistant 통합의 기본 Bridge 주소를 `http://local-smartthings-web-bridge:8100`으로 고정하고, 기존 `d55cafb9` 저장소 호스트가 저장된 구성 항목은 시작 시 자동으로 로컬 주소로 변환합니다.
- 신규 페어링과 재인증도 검증된 로컬 Bridge 주소만 구성 항목에 저장합니다.
- 실제 소스·통합 manifest·Bridge 앱·프로토콜·패키지 버전을 0.1.168로 동기화해 HACS와 앱 업데이트가 정상적으로 감지되도록 수정했습니다.

## 0.1.167

- 재시작 직후 완전 스냅샷에서 특정 Location의 기기가 전부 누락되더라도, Consumer와 Advanced 양쪽에서 해당 Location이 확인되기 전에는 저장된 기기를 일괄 삭제하지 않습니다.
- Home Assistant가 재연결 중 선택된 Location은 존재하지만 기기 수만 0개인 의심스러운 ready 스냅샷을 받으면 기존 Location 기기와 방, 장면 정보를 보존합니다.
- 구성 항목 시작 시 선택된 Location만 비어 있으면 Advanced 인벤토리를 한 번 자동 재조회하여 Sparkplus 기기를 복구하도록 보강했습니다.
- 0.1.166의 Sparkplus Home Monitor 직접 제어 동작은 그대로 유지합니다.

## 0.1.166

- 현재 브라우저 URL의 raw Location ID가 명령 대상과 일치하면 별칭 정규화나 Location picker 탐색 전에 즉시 현재 위치로 확정합니다.
- Sparkplus 실제 대시보드의 SmartThings Home Monitor 카드 안에 노출되는 `보안(외출)` 및 `보안(실내)` 버튼을 카드 범위에서 직접 찾아 제어합니다.
- 기존 전역 버튼 및 Home Monitor 대화상자 경로는 하위 호환 fallback으로 유지합니다.

## 0.1.165

- Home Assistant의 기본 `code_arm_required=True`를 해제해 Home Monitor 무장 명령이 코드 없이 브리지까지 전달되도록 수정했습니다.
- Home과 Sparkplus를 포함한 모든 Location Home Monitor는 SmartThings 웹 세션으로 인증하며 HA 키패드 코드를 요구하지 않습니다.
- 회귀 테스트가 Home Assistant Core의 서비스 코드 검증 경로를 재현하도록 보강했습니다.

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

- 같은 이름의 generated primary switch가 여러 location에 있을 때 숫자나 `_switch` suffix 대신 location/room-qualified ID로 순서와 무관하게 수렴합니다.
- multi-switch 장치에서도 Web의 `전원` control 하나를 primary로 식별하고 Web 표시명은 유지합니다.
- 이미 수천 자까지 늘어난 generated entity ID와 restore metadata의 앞/뒤 반복 slug를 한 번의 migration으로 복구하고 이후 재시작에서 다시 늘지 않게 합니다.
- 0.1.157의 SmartThings Advanced POST CSRF 처리와 command service 동작을 그대로 포함합니다.

## 0.1.157

- SmartThings Advanced command POST를 실행할 때 로그인된 페이지 context 안에서 CSRF 토큰을 읽어 `x-csrf-token` 헤더로만 전달합니다.
- GET에는 CSRF 헤더나 body를 붙이지 않고, 토큰이 없거나 안전하지 않으면 raw 값을 노출하지 않은 채 Advanced 요청을 실패 처리합니다.
- generated entity ID가 `device_device_state`처럼 기존 canonical slug를 다시 입력으로 삼아 재시작마다 길어지는 경우를 한 번의 canonical ID로 복구합니다.
- 0.1.156의 service wrapper, command catalog, global entity parity, icon/name migration, parity audit 동작은 그대로 유지합니다.

## 0.1.156

- Home Assistant 2026.8.3에서 `smartthings_web.list_commands` response service가 coroutine 객체를 반환해 500이 나던 문제를 수정합니다.
- 모든 `smartthings_web` 서비스 등록 핸들러를 HA가 async 함수로 인식하는 wrapper로 바꿔 response-support 서비스는 dict 응답을 직접 반환하고, write/maintenance 서비스는 기존 동작을 유지합니다.
- SmartThings Advanced의 `maxLength`가 있는 `speechSynthesis.speak` schema를 안전하게 허용해 Galaxy Home Mini TTS command가 catalog에서 누락되지 않도록 합니다.
- 단일 `componentRole=Switch` 전원 채널을 primary switch로 판정해 생성 entity ID의 중복 `_switch` suffix를 제거하고, 사용자 지정 entity ID는 보존합니다.
- Home Assistant Actions 화면에서 `list_commands`, `execute_command`, `speak`, 운영 서비스를 쓰는 UI 가이드를 추가합니다.
- 0.1.155의 Advanced command catalog, safe service, global entity parity, icon/name migration, parity audit 동작은 그대로 유지합니다.

## 0.1.155

- 전체 Advanced capability catalog를 안전 정책으로 필터링해 `list_commands`, `execute_command`, `speak` Home Assistant 서비스로 노출합니다.
- 안전하고 되돌릴 수 있는 Advanced `on`/`off` 조합을 native switch/light 엔티티로 투영해 Web에 있는 전원 기능이 누락되지 않도록 합니다.
- Web 표시명과 component/capability 역할을 모든 기기에 같은 규칙으로 적용하고, 사용자 지정 이름과 기존 entity ID는 보존합니다.
- device class가 없는 범용 센서에 장치 유형 아이콘을 적용하되, 온도 등 기능형 센서 아이콘은 Home Assistant device class를 유지합니다.
- 패키지 안에서도 `npm run audit:web-parity`가 동작하도록 parity audit CLI/core를 포함하고, 위험 명령·중복 ID·중복 생성명·설명 없는 누락을 fail-closed로 검사합니다.

## 0.1.154

- Home Assistant Core 내부 API 경로에서 페어링 코드 발급을 차단하고, 인증된 Ingress 경로에서만 발급되도록 신뢰 경계를 분리합니다.
- Chromium 시작 재시도를 모두 소진한 `BROWSER_FAILED` 상태는 liveness 실패로 처리해 애드온 watchdog이 자동 복구하도록 합니다.
- 실행 중 브리지 토큰이 거부되면 무한 재시도 대신 Home Assistant 재인증 흐름을 시작합니다.
- SSE 재연결 backoff를 1초에서 최대 60초까지 확장해 장시간 애드온 중단 시 불필요한 연결 부하를 줄입니다.

## 0.1.153

- targeted Advanced `/status` 응답이 parent의 `childDeviceIds` 관계 메타데이터를 지우던 문제를 수정합니다.
- exact timestamp correlation으로 한 번 검증된 component-child 매핑을 별도 저장하고 재시작 뒤에도 복원해 연속 on/off가 같은 child Web 경로를 유지합니다.
- 0.1.152의 Location-native-only 실행, DOM 차단, parent+child Advanced status 확인과 rollback 경계를 유지합니다.

## 0.1.152

- composite child direct Advanced `/commands`도 404인 live 증거에 따라, 실제 child 실행은 관찰된 Location-native child control을 stable role 순서로 직렬 사용합니다.
- 일부 child Web 실행 실패 시 완료된 child를 원래 값으로 역순 rollback하며, 전체 성공과 복구는 parent+모든 child Advanced status vector로만 확정합니다.
- composite child는 `location_native` receipt만 허용하고 DOM fallback을 사용하지 않으며, 매핑 실패·부정확한 control은 parent fallback 없이 차단합니다.
- 0.1.151 exact unique mapping, 0.1.150 diagnostics, 0.1.149 liveness와 0.1.148 deadline/rollback 경계를 유지합니다.

## 0.1.151

- direct `/commands`가 404인 composite parent는 main을 명령하지 않고, secondary component와 child main state의 동일 값·900ms 이내 timestamp에 대한 전체 일대일 조합이 정확히 하나일 때만 실제 child device를 직렬 제어합니다.
- 모든 child와 parent의 Advanced status evidence 및 parent aggregate/secondary vector가 함께 일치해야 성공하며, rollback도 child 원래 값과 parent 원래 vector를 모두 확인합니다.
- 매핑이 누락·모호하거나 child가 offline/위험 유형/정확한 capability version 부재이면 parent Web/Advanced fallback 없이 `unsupported_command`로 닫습니다.
- 0.1.150 ordinal diagnostics, 0.1.149 persisted liveness, 0.1.148 deadline-bounded status·idempotent rollback 경계를 유지합니다.

## 0.1.150

- Advanced component transaction 실패 시 raw device/component/capability ID 없이 dispatch/rollback phase, one-based ordinal, outcome과 fixed transport error code만 기록합니다.
- 진단 callback 실패가 component 실행이나 original-vector rollback 결과를 바꾸지 않도록 격리합니다.
- 0.1.149 persisted liveness 복구와 0.1.148 bounded Advanced status·idempotent rollback 경계를 유지합니다.

## 0.1.149

- Bridge restart 시 offline으로 저장된 장치의 persisted Location/status evidence를 health timestamp와 다시 비교해 더 최신의 정상 상태가 있으면 online으로 복구합니다.
- `DeviceWatch-DeviceStatus`, `healthStatus` 등 값 자체가 explicit offline/unavailable/disconnected인 persisted state는 positive liveness evidence에서 제외해 실제 장애를 숨기지 않습니다.
- 0.1.148의 bounded Advanced component transaction, original-vector rollback, `lastUpdatedDate` precedence와 단일 Web control 경계를 그대로 유지합니다.

## 0.1.148

- 대표 HA switch 뒤에 둘 이상의 검증 가능한 switch component가 있으면 Advanced component transaction을 안정된 순서로 실행하고 bounded confirmation window의 독립된 조기·최종 `/status` 조회에서 `advanced_device_status` 증거와 전체 벡터가 일치할 때만 성공으로 확인합니다. 조기 조회가 멈춰도 전체 timeout과 장치별 queue는 bounded 상태를 유지합니다.
- 일부 component dispatch 또는 상태 확인이 실패하면 완료된 component를 원래 상태 벡터로 되돌립니다. 복구 중 부분 실패의 보상도 원래 값을 유지하며, 부분 실패와 rollback 실패는 고정된 비민감 오류 코드로 반환합니다.
- 실제 `lastUpdatedDate`를 포함해 timestamp 없는 Advanced `OFFLINE`은 무시하고, 더 새로운 Location 상태 이벤트나 성공한 Advanced status 조회를 online 증거로 사용하면서 더 최신의 명시적 health `OFFLINE`은 유지합니다.
- 단일 component 장치는 기존의 검증된 Web native 경로를 유지하며 lock, valve, door, garage 유형은 component transaction에서 제외합니다.

## 0.1.147

- 검증되지 않은 Advanced POST를 기본 명령 경로에서 제외하고, 실제 control metadata가 관찰된 `/location` native dispatcher로 switch/button 명령을 복구합니다.
- 장치·component·capability·원본 식별자를 기록하지 않는 transport/stage/outcome 명령 진단을 추가합니다.
- 정확한 양방향 toggle control이 없는 Advanced switch state를 Home Assistant 제어 엔티티로 만들지 않습니다.
- component마다 반복되는 Refresh는 main component를 우선한 장치당 하나의 버튼으로 정규화합니다.
- 기존 secondary switch와 중복 Refresh registry row를 현재 config entry와 `ready=true` inventory 범위에서 제거합니다.
- 같은 owner/location/room/name/type의 강한 Cloud/Local child 쌍만 Cloud 공개 ID로 병합하고 Local SSE device ID를 canonical ID로 변환합니다.

## 0.1.146

- 동일 Chromium 로그인 세션의 Advanced 내부 경로를 전체 장치·location·room·초기 상태·health·capability의 주 데이터 소스로 전환하고, 200개 이후 페이지를 끝까지 병합합니다.
- 장치 명령을 Advanced direct → Location native → 검증된 내부 경로 → DOM fallback 순서로 처리하며, 미지원 외 오류에서는 다음 경로를 실행하지 않습니다.
- stateful 명령은 push 또는 status 재조회로 확인하고, stateless 명령은 `ACCEPTED_UNCONFIRMED`로 구분해 낙관적 상태 변경을 막습니다.
- Socket.IO 복구 후 첫 수신 프레임에서 Advanced 전체 reconciliation을 실행하고, 기존 entity/config/device identity를 유지합니다.
- `smartthings_web.execute_command` 서비스, 고급 옵션, Advanced/command aggregate diagnostics를 추가하며 cookie·token·CSRF·원본 ID는 계속 차단합니다.
- Location native와 `DomFallbackAdapter`를 분리하고 DOM fallback을 앱 옵션으로 끌 수 있게 했습니다.
- post-command eventTime과 선택적 commandId를 확인하고, eventId 또는 canonical fallback key 중복을 DeviceStore 적용 전에 제거합니다.
- `reload_inventory`, `refresh_device`, `reconnect_realtime` 서비스와 bounded realtime reconnect backoff를 추가했습니다.
- capability schema가 허용하는 token-safe 표준/custom command를 고정 allowlist 없이 처리하고, Advanced send 시각 이후 이벤트만 확인합니다.
- owner/profile/presentation, parent/child, restricted/group, hub/driver, preference-key metadata를 redacted normalized inventory에 보존합니다.

## 0.1.145

- Give primary control entities a mapped device icon even when SmartThings artwork is also available, so the control area retains a stable device-specific visual while Refresh keeps its dedicated settings icon.

## 0.1.144

- Keep the location-derived `Home` presence label stable across repeated registry migrations without accumulating duplicate suffixes.

## 0.1.143

- Map the Advanced inventory's reserved `main` presence role to the current SmartThings location name, so mobile multi-place presence sensors can use `Home` alongside their named places instead of falling back to numbers.

## 0.1.142

- Replace stale numbered mobile-presence entity IDs with the current Advanced component roles, preserving user-renamed rows.
- Remove deleted `dev_N` Home Assistant entities and device cards only from a current ready inventory, while preserving location cards and shared foreign references.
- Move Refresh buttons into device settings with a dedicated refresh icon, and attach device artwork to the primary switch or light control instead.
- Keep main switch IDs free of the redundant `_switch` suffix and reuse the same room-free base when that control is represented as a fan.

## 0.1.141

- Keep the authenticated SmartThings location session warm with a bounded same-origin `/location` GET after the Bridge has been fully `CONNECTED` and ready for five minutes.
- Do not navigate, reload, inspect DOM state, read cookies, or call Advanced/device/scene/command endpoints for session maintenance.
- Skip the touch while commands, warm command pages, detail discovery, physical probes, non-isolated browser pages, login pages, or stale browser contexts are present.

## 0.1.140

- Defer restored-device pruning after Bridge restart until both a complete consumer snapshot and an exact whole Advanced snapshot agree inside the same snapshot epoch.
- Keep restored inventory and preserve restored exact controls for devices absent from the consumer snapshot but still present in the same-epoch Advanced snapshot, while resetting epoch flags on restart.
- Preserve actual fallback URLs during restart recovery and retain the observed-only, API-free, no-polling safety boundary.

## 0.1.139

- Preserve restart-time status snapshot switch controls when SmartThings Web reports plural `actions` with observed `commands` or `supportedCommands`, so safe on/off devices are not left uncontrollable until later detail discovery.
- Continue to ignore non-switch action lists and non-`on`/`off` commands for Home Assistant control discovery.

## 0.1.138

- Add bounded exact primary-toggle discovery that stays active until each pushed primary switch has one exact primary-toggle control or one unique `action:` alias, so unrelated buttons no longer close discovery early.
- Confirm observed Refresh actions only after the exact web action is followed by a post-action authoritative snapshot; a bare dispatcher ACK still does not count as success.
- Require already-satisfied scene execution once, then confirm only from a post-action authoritative snapshot that still matches every expected state.
- Add the nginx 85-second timeout ladder for Bridge proxy requests, keeping it below Home Assistant's 90-second client boundary while leaving noVNC websocket proxying unchanged.
- Retain the authenticated SmartThings Web session boundary: no official SmartThings API client, cookie replay, periodic SmartThings state polling, or DOM-derived state authority is added.

## 0.1.137

- Keep restart-time login restoration on Chromium's dedicated persistent profile and existing `--restore-last-session` path without rewriting browser preference files or pretending the previous exit crashed.
- Leave a healthy authenticated keeper and in-flight controls untouched instead of forcing a periodic navigation that can interrupt SmartThings Web commands and push recovery.

## 0.1.136

- Refresh the authenticated SmartThings keeper page every 10 minutes so the Samsung web session stays active during long idle periods without adding SmartThings state polling.
- Mark the dedicated Chromium profile for session restore before launch so a clean Bridge restart reopens the prior SmartThings web session instead of losing session-only Samsung login state.

## 0.1.135

- Reconcile Cake's duplicate action and detail-swatch aliases for one pushed toggle by selecting the unique observed action identity, while keeping unrelated duplicate controls fail-closed.

## 0.1.134

- Reclaim canonical Home Assistant entity IDs that are blocked only by an unowned, restored `unavailable` state, while preserving live states and registry-owned IDs.

## 0.1.133

- Require speaker/media identity or playback-track evidence in addition to volume and mute before creating a Home Assistant `media_player`, so accessory devices such as `아리` are not misclassified while Galaxy Home Mini and speaker devices remain media players.

## 0.1.132

- Reject stale pushed state events before advancing the local inventory sequence, so an old `updatedAt` cannot mask the next valid event or prevent an immediate snapshot resynchronization.
- Keep signed camera media URLs out of regular sensor entities while preserving the dedicated Home Assistant `image` entity and safe capture metadata sensors.
- Use one deterministic secondary-switch naming rule for both new entity creation and registry restoration, including identifier-only channels that must remain distinct as `스위치 2`, `스위치 3`, and later.
- Use one deterministic secondary-switch naming path for entity creation and registry repair, including identifier-only switch channels that fall back to `스위치 2`, `스위치 3`, and later slots.

## 0.1.131

- Keep ordinary on/off devices with auxiliary contact state exposed as primary Home Assistant `switch` entities while retaining their contact state as a separate binary sensor.
- Give secondary switch channels stable generated names such as `스위치 2` and migrate restored duplicate room-prefixed IDs onto those distinct channel IDs.
- Rebase current-state `smartthings_device_dev_*` fallback entity IDs even when a user display name is set, while preserving that display name and leaving unrelated custom rows untouched.

## 0.1.130

- Recover an authenticated SmartThings Socket.IO connection automatically when received frames stop beyond the existing push-freshness boundary, invalidating the old snapshot before reloading the keeper so Home Assistant performs a full resynchronization.
- Track liveness only from the exact SmartThings Socket.IO transport across Playwright and CDP observers, so unrelated WebSocket traffic cannot hide a stale push connection.
- Reject device, scene, and Home Monitor commands immediately when the push stream is no longer fresh, before any browser-side action can run.

## 0.1.129

- Replace stale `smartthings_device_dev_*` entity IDs with stable readable numbered IDs when same-name devices or other integrations already occupy the canonical target.
- Preserve every occupied entity ID and explicit user name while assigning same-name devices deterministic `_2`, `_3`, and later suffixes, advancing past restored-state reservations and persisting numbered restore metadata across Home Assistant restarts.

## 0.1.128

- Prevent restored entity metadata from accumulating transliterated role suffixes after repeated Home Assistant registry migration passes.
- Retry registry repair through the first 30 seconds of Home Assistant startup so a transient restored-state reservation cannot leave `smartthings_device_dev_*` fallback IDs behind.
- Preserve exact same-origin switch actions observed beside pushed device status, including action-only display rows, so controllable on/off devices are not reduced to auxiliary contact sensors.
- Expose a primary pushed `switch` state in Home Assistant even while its write action is temporarily absent, while keeping commands fail-closed until an exact safe toggle action is observed.

## 0.1.127

- Confirm SmartThings scene execution only from explicit scene action state expectations parsed from the observed `api/scene` snapshot, instead of accepting any newer same-location device event.
- Persist sanitized expected scene states across Bridge restarts and fail closed with a confirmation timeout when a scene exposes no safe device/component/capability/value expectation.
- Require every parsed scene action outcome to match before confirmation, accumulating newer target pushes while clearing an outcome again when a contradictory push arrives.
- Rebase Home Assistant entity IDs that were frozen from the early fallback name `SmartThings device <id>` onto the current SmartThings device name, including semantic duplicate-state suffixes such as `presence_home`, while preserving user-named registry rows.

## 0.1.126

- Publish a sanitized `type: "image"` SSE event whenever authenticated camera image cache bytes are atomically persisted, carrying only the public device alias, cache sequence, content type, and capture timestamp.
- Let Home Assistant image entities rotate their image token from that cache event even when SmartThings image metadata states do not change, while rejecting stale image cache events by sequence and `capturedAt`.
- Keep observed numeric sliders without explicit range metadata when the matching pushed state is numeric, so conservative Home Assistant ranges can expose controls such as detection frequency and fan speed.
- Advertise generic media playback only for an observed track control and reject TTS/speech media types before dispatch when SmartThings Web has not exposed a safe text argument shape.

## 0.1.125

- Normalize raw camera device IDs through the same redactor and DeviceStore alias generations used by the public inventory, so observed binary thumbnail bytes are cached under the exact `dev_*` ID that Home Assistant requests.
- Add a runtime regression that discovers the camera's public inventory ID first and requires the corresponding authenticated image endpoint to return the observed JPEG bytes, preventing hidden cache aliases from passing broad endpoint scans.

## 0.1.124

- Keep the latest raw camera image URL observed from authenticated Socket.IO or Advanced traffic in volatile Bridge memory and use that exact URL for the in-page `api/camera/thumbnail` request.
- Never substitute the identifier-redacted inventory URL for the authenticated request; normalized inventory continues to expose only safe aliases while raw URLs remain absent from persistence, logs, health output, and Home Assistant responses.

## 0.1.123

- Request Home Camera still-image thumbnails through the already authenticated SmartThings web page's observed `api/camera/thumbnail` service, then keep using the existing Socket.IO binary-frame observer to persist only validated image bytes and metadata.
- Validate the observed media URL against the existing HTTPS SmartThings/Samsung media allowlist and return only constant request outcomes from the page, without exporting or replaying Bearer tokens, cookies, CSRF values, response bodies, or signed URLs.
- Prioritize camera detail discovery ahead of the general bounded sweep so images are available promptly after login, reconnect, or Bridge restart without adding SmartThings state polling.

## 0.1.122

- Reserve canonical primary entity IDs for devices whose actual SmartThings name contains the numeric suffix. When an exact-room device holds `media_player.geosil_4` only as Home Assistant's fourth collision, it is safely moved to the next free generated ID so the device actually named `거실 4` can reclaim `media_player.geosil_4`.
- Refresh the public Home Assistant restore metadata after that relocation, including primary entities whose `object_id_base` is intentionally empty, so the corrected allocation survives Entity ID restore.

## 0.1.121

- Persist the complete canonical SmartThings device/entity object ID as Home Assistant's generated restore suggestion. This bypasses Home Assistant 2026.8's area-plus-device template, so restoring `화장실 도어센서` and `작은방 재실센서` keeps `hwajangsil_doeosenseo_contact` and `jageunbang_jaesilsenseo_presence` instead of recreating a duplicated room prefix.
- Build that canonical ID from the actual SmartThings device name, preserving a room token that belongs to the name while collapsing only a duplicated generated prefix. Exact room-named speakers such as `거실` remain `media_player.geosil`, and `거실 4` remains `media_player.geosil_4`.
- Keep collision reclamation, restore metadata repair, and orphaned Bridge device-card retirement on Home Assistant's public registry APIs, with direct regressions for the numbered-ID and stale-card paths.
- Make the Home Camera image-entity regression independently runnable while retaining the authenticated local byte proxy and functional sensor icons.

## 0.1.120

- Apply pushed `DEVICE_HEALTH_EVENT` availability changes immediately, reject stale health timestamps, and persist only actual online/offline transitions.
- Keep inventory sequence monotonic inside one SSE connection epoch, explicitly accept a lower full snapshot only after reconnect/Bridge restart, and resynchronize once when the first push references a newly observed device.
- Seed Home Camera still images from the raw authenticated Advanced snapshot before identifier redaction, persisting only validated image bytes and metadata so redacted query parameters can no longer leave the HA image entity at HTTP 404.
- Inspect every observed device detail once per browser session, including devices that already expose only Refresh or another cached control, while retaining bounded retries and foreground-command preemption. This lets Galaxy Home Mini and other partially discovered devices expose the rest of their actual web controls without state polling.
- Name duplicated appliance states from safe component roles shared by sibling states, so refrigerator contact and temperature entities use compartment labels such as 냉장고, 냉동실, 맞춤보관실, 냉장실, and 단일 도어 instead of anonymous `(1)` through `(5)` suffixes.
- Preserve the push-first local Bridge/SSE architecture and its existing authenticated-web-session boundaries; no new state polling, DOM-derived state authority, or optimistic HA state mutation is added.

## 0.1.119

- Fixed Home Assistant entity-ID generation so `has_entity_name` entities provide only their local suffix (`contact`, `temperature`, `refresh`, and similar) instead of feeding the full device name back into Home Assistant and creating duplicated room prefixes.
- Reclaims a free canonical entity ID from collision-numbered variants such as `binary_sensor.hwajangsil_doeosenseo_contact_4` after stale/orphaned reservations are removed, while continuing to preserve active cross-integration collisions.
- Refreshes stale Restore entity ID metadata through Home Assistant's public registry API by clearing the old full `suggested_object_id` and preserving the local `object_id_base`, so restoring returns to the same single-room canonical ID instead of recreating `{room}_{room}_{device}`.
- Prefers the name-aware Bridge binding over the anonymous HA device-registry fallback for the same room, preventing generated IDs from alternating between room-prefixed and room-free forms across migration passes.
- Skips full entity-registry migration for ordinary value/timestamp-only inventory updates while retaining bounded settling whenever a device, state, control, room, or entity-value topology actually changes.
- Resolves the owning Bridge device independently for every registry row, so a numbered ID such as `binary_sensor.hwajangsil_doeosenseo_contact_4` is reclaimed correctly even when hundreds of unrelated SmartThings Web entities follow it in Home Assistant's registry.

## 0.1.118

- Follow the authenticated SmartThings 2.57.0 web application's actual `/automations` route when a scene is not pinned on the location dashboard, preventing exact scene execution from failing on the obsolete `/installedapps` path.
- Remove only a room prefix injected by an older entity-ID template. When the SmartThings device name itself starts with its room, preserve and restore that token, so `작은방 재실센서` settles on `binary_sensor.jageunbang_jaesilsenseo_presence` instead of `binary_sensor.jaesilsenseo_presence`.
- Keep exact single-scene matching and fail closed on missing or ambiguous controls; no official API, periodic SmartThings state polling, or DOM-derived state authority is introduced.

## 0.1.117

- Keep the 72-hour HAOS soak collector measurable when the container runtime denies cgroup memory-file reads by falling back to the Bridge Node process RSS instead of recording every sample as `stats_response_invalid`.
- Preserve exact live-control state binding, scene fallback execution, push-first SSE state delivery, and the prohibition on periodic SmartThings state polling.

## 0.1.116

- Resolve the live control benchmark against the entity registry's exact normalized Bridge state key, including aliased component and capability identifiers, so pushed ON/OFF transitions are measured instead of being discarded as canonical-name mismatches.
- Keep benchmark matching push-first and exact to one entity state without adding SmartThings state polling.

## 0.1.115

- Preserve the numeric collision suffix of an existing exact-room primary entity during migration, so `media_player.3_4` and `media_player.geosil_geosil_4` settle on `media_player.geosil_4` instead of being renumbered to `media_player.geosil_2`.
- Keep the SmartThings device name `거실` intact; room-prefix cleanup applies only to the generated entity ID and never substitutes a generic type name such as `스피커`.
- When a scene is not pinned on the location dashboard, open the authenticated SmartThings `Automations` route and execute exactly one matching routine card instead of failing with `command_control_not_found`.
- Retain the push-first realtime path, bounded registry settling, observed device controls, and event-driven one-shot Advanced supplement without periodic SmartThings state polling.

## 0.1.114

- Preserve a device name that is the exact SmartThings room name instead of replacing it with a localized device-type label such as `스피커`.
- Keep only one leading room token in generated entity IDs and migrate legacy exact-room primary IDs such as `media_player.3_4` to a stable room-based candidate such as `media_player.geosil_4` without later numeric rotation.
- Retain the 0.1.113 bounded registry repair, push-first state path, and event-driven one-shot Advanced supplement without periodic SmartThings state polling.

## 0.1.113

- Replace the Home Assistant entity-registry feedback listener with bounded settling retries, preventing a registry feedback loop from retriggering cleanup and rotating generated IDs through numeric suffixes during startup.
- Preserve observed Refresh controls while removing synthetic duplicates, and immediately reuse an entity ID released earlier in the same atomic migration pass.
- Keep Socket.IO/SSE push as the primary state path and the same-session Advanced status read as an event-driven one-shot supplement; periodic SmartThings state polling remains disabled.

## 0.1.112

- Keep alias cleanup compatible with HAOS's small temporary filesystem: remove mandatory startup `VACUUM`, commit the legacy transient-alias deletion and migration marker in one logical cleanup transaction, and let SQLite reuse freed pages without blocking Bridge startup.
- Preserve the 0.1.111 room-normalized entity IDs, SmartThings device presentation, event-driven Advanced status supplement, and push-first state authority.

## 0.1.111

- Prevent newly discovered Home Assistant entities from generating duplicated room-name object IDs such as `geosil_geosil_*`; existing registry repair still cleans older generated IDs on startup.
- Keep device-info rows free of sensor-specific icons while preserving SmartThings artwork or device-type icons on primary device entities.
- Stop persisting deterministic transient identifier aliases and compact legacy rows once at startup, preventing request/event diagnostics from inflating the Bridge database and degrading long-running responsiveness.
- Keep SmartThings push as the primary state authority. Same-session Advanced status GET remains a bounded event-driven supplement after commands/reconnect gaps, not periodic SmartThings state polling.

## 0.1.110

- Preserve the raw semantic identity of the authenticated Advanced `refresh` capability in memory only, then expose its observed control as the missing Home Assistant Refresh button for contact sensors without inventing controls from state attributes.
- After a web command, keep Socket.IO push as the primary confirmation path while issuing one serialized, same-session Advanced status GET after one second. A matching redacted snapshot can confirm the command immediately; the request is event-driven rather than periodic and never leaves the authenticated web origin or requires developer credentials.
- Extend the final confirmation window to 30 seconds without allowing a hung Advanced refresh to bypass that deadline.

## 0.1.109

- Allow the packaged live verification tool to read Home Assistant state and subscribe to state changes through the Supervisor-provided API token.

## 0.1.108

- Keep inventory restored from SQLite through Samsung-login, reconnect, and partial-response gaps. Retire unrefreshed aliases only after a complete consumer `api/device` snapshot; non-device snapshots, malformed acknowledgements, and partial Advanced enrichment can no longer delete current Home Assistant device cards.
- Limit SmartThings presentation artwork to primary device entities so state-backed sensors keep their Home Assistant functional icons for temperature, humidity, battery, contact, motion, power, and similar values.
- Remove the unused periodic Advanced polling configuration surface. Advanced remains a bounded one-shot, same-origin, read-only bootstrap enrichment path and never becomes SmartThings state polling.

## 0.1.107

- Start non-mutating background detail discovery from the location overview, retaining the exact-room and search fallbacks when the card is absent. This avoids layout-drift failures that prevented value-only devices such as contact sensors from exposing their observed Refresh action, while foreground controls continue to require the strict exact-room path.

## 0.1.106

- Devices restored from a previous browser session now start as unconfirmed: the live session must refresh them (whole snapshots, detail sweeps, or the advanced refresh poll) or they are pruned after a grace period. This stops one physical device from splitting into old-alias and new-alias cards whenever the session is rebuilt.
- Registry repair now also detaches this config entry from Bridge device cards that no longer match any current inventory device and have no active entities, letting Home Assistant retire the leftover card automatically.

## 0.1.105

- Fix a startup crash in the registry repair: rows already removed by the stale-duplicate pre-pass are now skipped, and every rename/update verifies the row still exists before writing (KeyError on removed IDs, e.g. climate.boilreo_2).
- Add an additive-on-demand same-origin Advanced refresh poll: the Bridge can periodically re-read the same authenticated device-list GET the web UI uses (read-only, redacted, serialized; never command endpoints) and merge it into the push inventory, so states converge faster without leaving the api-free boundary. Enabled via add-on option `advanced_poll_seconds` (0 = off, default 60; standalone docker env `ADVANCED_POLL_SECONDS`/`STW_ADVANCED_POLL_SECONDS`).

## 0.1.104

- Attach the device's my.smartthings.com presentation artwork (or a matching type icon) to every entity, including individual sensors and binary sensors, instead of only primary device entities.
- Registry repair now also reclaims clean entity IDs once collisions disappear (e.g. `status_home_2` → `status_home`) and removes legacy duplicate rows whose unique IDs no longer match the current inventory, so one physical device keeps one card and one set of entities.

## 0.1.103

- Fix a startup crash introduced by the 0.1.102 repair on current Home Assistant builds: device identifiers can now carry more than two elements (a config-subentry part), so the slug mapping no longer unpacks them as fixed two-tuples.

## 0.1.102

- Harden the frozen entity-ID repair discovered on a live install: resolve owning devices through the device registry's identifier sets even when `DeviceRegistry.devices`/`AreaRegistry.areas` are live wrapper mappings rather than plain dicts, accept both the Bridge room-name slug and the user-assigned area ID (e.g. 데이터룸 vs deiteorum), and fall back to numbered IDs (`_2`...`_9`) when a cleaned target is occupied by another integration instead of skipping silently.

## 0.1.101

- Add a one-shot registry repair that renames this integration's frozen legacy entity IDs whose generated slug embeds the device's own SmartThings room-name prefix (for example `switch.deiteorum_status_home` becomes `switch.status_home`) once the corrected device name reaches Home Assistant; user-renamed entities and occupied target IDs are left untouched. Entity IDs were never auto-regenerated before, which kept stale room-prefixed IDs visible even after 0.1.99/0.1.100 fixed naming at generation time.

## 0.1.100

- Replace the broad 0.1.99 room-name stripping with a single narrow rule: only devices whose SmartThings name exactly matches their own room name (SmartThings room clones such as a speaker named "거실" in the "거실" room) fall back to a room-free device-type label, ending duplicated slugs like geosil_geosil. Every other device name — including "거실 2", compounds, and names merely containing the room — stays untouched; inventory names are never rewritten.

## 0.1.99

- Strip leading or trailing SmartThings room names from parsed device display names so generated Home Assistant entity and device names stop embedding the room (for example "디티오룸 Status" becomes "Status"); occurrences in the middle of a name, devices named exactly like their room, and user-renamed entities stay untouched.

## 0.1.98

- Package the HAOS soak collector in the add-on image and add an explicit local Bridge mode that writes 72-hour evidence under `/data/soak` from Bridge health, inventory, and SSE sequence routes.
- Keep the inactive Chromium keeper and native command dispatcher responsive by launching with explicit background timer, occluded-window, and renderer throttling suppression flags.
- Cache the recovered authenticated `api/device` service in the live SmartThings page so consecutive native commands do not rescan the webpack module cache.
- Remove stale camera-image and image-transfer states from non-camera devices while preserving Home Camera image entities; still inspect value-only devices for real detail actions, restoring the living-room window sensor to Contact, Battery, Received Signal Metrics, and its observed Refresh button.
- Preserve the 0.1.97 Advanced HUB enrichment behavior while keeping Cupcake endpoints read-only and excluded from command execution.

## 0.1.97

- Include the Advanced `type=HUB` same-origin device-list GET in the one-shot bootstrap fallback so SmartThings hub metadata can enrich the normalized inventory when the Advanced page does not naturally finish that request.
- Keep Advanced responses read-only enrichment only; `allowedActions` and Cupcake endpoints remain excluded from command execution and polling.

## 0.1.96

- Fall back to two bounded same-origin Advanced device-list GETs when the authenticated page does not naturally finish its snapshot request within five seconds; responses are redacted and merged only as bootstrap metadata/state, never used for direct Cupcake commands or polling.
- Keep the temporary Advanced page alive briefly after the first complete response so its observed continuation page can enrich devices beyond the initial batch.
- Refine existing generated sensor and binary-sensor registry names when newly observed component roles replace numeric qualifiers, while preserving every user-supplied entity name.

## 0.1.95

- Keep Ari/SmartTag alarm volume and other audio accessory controls off `media_player`, while retaining real speakers only when the required pushed audio volume and mute evidence is present; remove stale media_player registry entries owned by this integration after reclassification.
- Expose pushed speaker duration, position, repeat, shuffle, source, and source-list metadata, and enable their write features only when the exact corresponding SmartThings Web control was observed.
- Observe the authenticated Advanced device-list JSON once for each new browser context, close its temporary page promptly, and atomically enrich the push inventory with status, health, presentation, type, room, and safe component-role metadata without SmartThings polling or direct Advanced commands.
- Distinguish repeated refrigerator, freezer, pantry, ice-maker, hub, setup, Bixby, and multi-switch states with localized component-role labels while keeping stable aliased entity identities.
- Keep official-style read-only appliance power categories as binary sensors, retain web-only states, and apply SmartThings presentation artwork only to primary device entities while preserving functional icons on individual sensors.

## 0.1.94

- Correlate SmartThings Web camera image-state URLs with `api/camera/thumbnail` requests and persist the real Socket.IO binary thumbnail response for Home Assistant's authenticated image proxy.
- Open camera detail pages for bounded initial image discovery even when other observed controls already exist, without adding SmartThings state polling.
- Keep pushed powered-down laundry state readable while leaving device controls unavailable when the washer or dryer is offline.
- Localize current SmartThings device types, remove trailing technical numeric suffixes, and migrate one repeated room prefix from generated entity IDs.
- Distinguish repeated state rows with stable component, capability, or numeric qualifiers and remove raw sensor duplicates already represented by an observed select.
- Complete a device command as soon as the post-dispatch authoritative push confirms the requested state, removing the fixed 500 ms hold that serialized consecutive controls.

## 0.1.93

- Keep SmartThings presentation artwork off state-backed sensor rows so Home Assistant can show distinct temperature, humidity, battery, and other device-class icons.
- Preserve translated entity names by leaving an unset entity name truly unset instead of shadowing the translation key with `None`.

## 0.1.92

- Capture the authenticated Cake client when the SmartThings app naturally invokes its private webpack module factory, then reuse only that volatile reference.
- Accept a verified SmartThings device-detail page as the warm native dispatcher instead of rejecting it as a non-location page.
- Send the exact captured `patch` request to the existing `api/device` Socket.IO service without direct SmartThings API calls, cookie replay, or DOM state authority.

## 0.1.91

- Reuse the authenticated client loaded by a successful device-detail page for native commands instead of limiting native dispatch to the overview keeper.
- Keep the single verified warm detail page available for up to 24 hours while continuing to validate that it is open and on SmartThings before each use.

## 0.1.90

- Dispatch authenticated in-page native device commands outside the serialized DOM navigation queue, so a slow fallback control cannot delay unrelated native controls.
- Return from native dispatch immediately after the authenticated patch is invoked and use the existing authoritative push/snapshot confirmation path for success.
- Expose allowlisted SmartThings presentation artwork on Home Assistant entities and create refresh buttons only from real observed refresh controls.
- Add a guarded live control benchmark that permits only the explicitly allowlisted Home Assistant entity, requires an initial and final OFF state, and records sanitized Bridge/HA timing evidence.

## 0.1.89

- Recover the authenticated keeper immediately when the consumer-web Socket.IO transport closes, and require a fresh complete snapshot before readiness returns.
- Treat only received WebSocket frames as push freshness so outbound traffic cannot hide a stalled subscription.
- Eliminate duplicate reconnect inventory fetches and avoid cloning the full inventory merely to emit the SSE sequence marker.
- Track active Home Assistant SSE connections for accurate transport diagnostics without adding polling.

## 0.1.88

- Treat a compatible historical protocol change count as durable history rather than a current mismatch in the physical-action probe, Core restart continuity operator, and sealed soak deployment gate.
- Continue to fail closed when the runtime is not ready/connected or when the protocol change count increases after the scenario baseline.

## 0.1.87

- Remove duplicate custom Chromium background flags after live HAOS process inspection confirmed that Playwright already supplies all three; retain the SSE and reconnect latency improvements without redundant launch arguments.

## 0.1.86

- Keep the authenticated SmartThings Web keeper socket responsive while its Chromium window is inactive by disabling background timer and renderer throttling.
- Disable Nagle delay for the local SSE stream and retry transient Bridge stream failures after 50 ms, with a bounded one-second backoff for repeated failures.

## 0.1.85

- Send the canonical `on`/`off` command used by captured Cake toggle exchanges when an observed safe toggle omits its optional command metadata, avoiding the slow detail-page fallback.

## 0.1.84

- Reverse the second sanitized device-alias generation as well as every component/capability generation used by DeviceStore, allowing the authenticated native command path to start from the public inventory alias.

## 0.1.83

- Parse bounded full-snapshot websocket frames up to 8 MiB for volatile native-command identifier mapping while retaining the smaller persisted diagnostic capture limit.
- Distinguish missing device, component, and capability mappings with fixed-value diagnostics that never reveal identifiers.

## 0.1.82

- Retain the third identifier-alias generation produced by sanitized component metadata plus DeviceStore normalization, so the authenticated native command path is available immediately after a full snapshot.

## 0.1.81

- Dispatch device commands through the authenticated in-page SmartThings Web client before any DOM navigation fallback, while preserving post-command push confirmation.
- Keep volatile raw identifiers only in process memory, clear them on browser restart, and never expose them through persistence, logs, SSE, or Home Assistant.
- Preserve the warm command page during background detail discovery and fail closed unless switch and refresh actions bind to exact observed toggle and refresh controls.
- Reject additional localized door control identities and keep graceful shutdown available when the final best-effort inventory persistence flush remains locked.

## 0.1.80

- Publish SmartThings push state to Bridge SSE before diagnostic capture and normalized-inventory persistence can block the live path.
- Coalesce full normalized-inventory persistence across event bursts, retry transient write failures, and flush the newest snapshot during graceful shutdown.
- Keep duplicate-delivery protocol counters intact without repeatedly persisting the same logical SmartThings Web device event.

## 0.1.79

- Deliver existing pushed states only to matching state and device listeners; run global discovery/registry listeners only for a new state key or inventory change.
- Scope inventory refresh writes to devices whose normalized state or metadata actually changed.
- Aggregate raw firmware fields into one read-only `update` entity, publish physical button pushes as `event` entities, apply official-style names/classes/categories, and consolidate richer-domain values into primary entity attributes while retaining other SmartThings Web-only values as diagnostic sensors.
- Drive native SmartThings Web range inputs for all observed numeric sliders and route enumerated media/fan/select options through their exact observed commands.
- Map speaker fast-forward/rewind to Home Assistant next/previous, preserve current-track metadata, and add brightness/color-temperature handling for observed light sliders.
- Keep read-only pushed content visible while exposing writable switch, light, fan, media, and number features only when their exact web control has been observed.

## 0.1.78

- Report the restored cached inventory count immediately after Bridge startup and browser reconnects, while keeping login-required sessions unready until fresh push proof returns.

## 0.1.77

- Wait for the exact visible Cake room-card heading to hydrate before considering slower page-wide accessibility fallbacks.
- Isolate Home Assistant entity-listener failures so one entity cannot interrupt the SSE push loop or block other sensor updates.
- Add direct Bridge SSE delivery, HA SSE parsing, and runtime-to-entity write regression coverage.

## 0.1.76

- Dispatch a navigation-only click event on the already verified unique visible same-page device wrapper, avoiding the fifteen-second actionability wait observed behind Cake's closing overlay.
- Keep the exact detail URL, visible device dialog, dialog-scoped control, and post-command push confirmation gates unchanged.

## 0.1.75

- Recover a dismissed warm detail from the already rendered exact device card before navigating anywhere, then require the exact detail URL and visible device dialog again before control lookup.
- Fall back to the exact room path when that immediate card is missing or fails, without reloading the SmartThings application at the slow verified detail URL.

## 0.1.74

- Resolve the exact visible Cake `draggable-room` heading through CSS before any page-wide accessibility-tree fallback, and go straight to the authoritative inventory room instead of probing the overview first.
- Reopen a dismissed warm device dialog at its already verified exact detail URL and revalidate the exact URL and dialog identity before control lookup, falling back to the exact room path only when that fails.
- Let foreground control proceed after background inspection preemption without waiting for the separate inspection page's potentially slow close operation.

## 0.1.73

- Resolve the exact room heading and its unique parent before scanning Cake's page-wide button accessibility tree, matching the observed `draggable-room` structure while retaining fail-closed room, device, dialog, and control checks.
- Keep a freshly verified detail route after same-page warm recovery fails, then independently revalidate its exact URL and device dialog on a new page before any control lookup.

## 0.1.72

- Replace the room target's retrying visibility wait with Playwright's non-waiting visibility check before dispatching its navigation-only click event.
- Preserve exact unique room, device card, device-detail URL, dialog identity, dialog-scoped control, and post-command push verification.

## 0.1.71

- Dispatch one exact click event to the already visible, unique navigation-only room target instead of waiting for Cake's slow navigation completion inside `Locator.click()`.
- Skip a known-invalid direct detail route after same-page warm recovery fails, then rebuild the exact room, device, and dialog context on one fresh page.

## 0.1.70

- Preempt background detail discovery as soon as a foreground command arrives, so inventory enrichment cannot hold the command queue.
- Recover a dismissed device dialog on the same warm page by reopening the exact room and device before any control lookup.
- Bound and force only the exact visible navigation-only room button, while retaining exact device, dialog, and control identity checks.

## 0.1.69

- Add fixed phase diagnostics for warm-page validation, verified-route reuse, room navigation, exact device selection, detail readiness, and toggle click completion.
- Keep diagnostic output free of device names, identifiers, URLs, values, and credentials while exposing the precise command latency boundary.

## 0.1.68

- Retry one cold room-navigation failure on a new page before any control probing, while preserving exact room, device, and detail-dialog matching.
- Close the failed page and never retry after control discovery starts or a mutation might have occurred.

## 0.1.67

- Preserve non-numeric pushed values such as battery health status without assigning Home Assistant numeric sensor classes.
- Reapply numeric device and state classes automatically when a later push contains a numeric measurement.

## 0.1.66

- Scope every control lookup to the exact verified device-detail dialog.
- Allow a unique dialog-local switch or checkbox when Cake exposes the observed Power toggle without an addressable label.
- Resynchronize Home Assistant from the Bridge-local full snapshot before every SSE connection and recover from transient stream authentication or connection failures.

## 0.1.65

- Require an exact device-only accessible heading when inventory has no room name.
- Reject prefix-matching device headings before probing any control.

## 0.1.64

- Match the device-detail dialog by its exact accessible device-and-room heading, mirroring Cake's live modal structure.
- Keep the background device card and partial device-name matches outside the readiness proof.

## 0.1.63

- Require the visible SmartThings device-detail dialog containing the exact device name before probing any control.
- Do not mistake the still-visible room card behind a routed modal for detail readiness.

## 0.1.62

- Allow a fresh or directly reopened detail page up to fifteen seconds to render the exact observed toggle swatch.
- Keep warm-page probes short and leave unrelated controls at their existing five-second bound.

## 0.1.61

- Give a unique control inside the exact observed swatch its own bounded visibility probe after late swatch rendering.
- Preserve exact scope, uniqueness checks, and push confirmation while avoiding a one-millisecond residual visibility timeout.

## 0.1.60

- Add fixed, identifier-free toggle discovery stages that distinguish missing names, exact swatch scope, and scoped accessibility-role counts.
- Keep the added live diagnostics observational only; target selection and push confirmation behavior are unchanged.

## 0.1.59

- Wait for the exact SmartThings device-detail route and visible identity before probing any control after a card click.
- Fail closed without clicking controls when Cake never completes the detail transition.
- Emit only fixed, identifier-free command navigation stages for live failure diagnosis.

## 0.1.58

- Accept a single button-rendered toggle only inside the exact observed Power swatch, while preserving switch/checkbox priority and ambiguity rejection.
- Shorten verified-detail and exact-room discovery probes so stale optimized routes fall back faster without weakening push confirmation.
- Retain a revalidated exact device-detail page for five minutes to accelerate consecutive commands on the same device.

## 0.1.57

- Apply the 500 ms push stability requirement to timeout-triggered full snapshot resynchronization as well as direct device events.
- Reject a requested state that reverses during the timeout boundary instead of confirming from a transient snapshot.
- Clear removed presentation metadata during Home Assistant's atomic inventory merge instead of retaining a stale icon/model hint.

## 0.1.56

- Open device details only by clicking the unique visible `data-testid="device"` wrapper; never click a page-wide named button, an exact text label, or a descendant inline action as a fallback.
- Delay command success until browser interaction has completed and the requested newer push value remains stable for 500 ms, rejecting transient values that immediately reverse.
- Preserve only allowlisted SmartThings active, inactive, and Lottie asset URLs, and use the published asset type when Cake reports the device type as `NONE`.
- Keep public presentation metadata separate from authoritative push/snapshot state; no SmartThings polling or asset-based state inference is added.

## 0.1.55

- Give foreground device, scene, and Home Monitor commands priority over optional background detail discovery.
- Close only the isolated background inspection page when a command arrives so it cannot block the UI queue for tens of seconds.
- Do not count command-preempted discovery as a failed or consumed inspection attempt.

## 0.1.54

- Recognize the live Cake `/location/<id>/rooms/device/<id>` detail route in addition to the direct `/location/<id>/device/<id>` route.
- Keep exact visible device-identity validation before retaining or reusing either route.
- Restore warm-page reuse for room-originated device details instead of closing them after every command.

## 0.1.53

- Retain verified device-detail routes in bounded process memory so controls do not repeat the full location/card search after a warm page expires.
- Revalidate the exact visible device identity before every direct-route reuse and discard stale or redirected routes.
- Keep route data ephemeral; nothing new is persisted to disk.

## 0.1.52

- Prefer the single accessibility `switch` when one observed Cake toggle also exposes its underlying `checkbox`.
- Continue to fail closed when the preferred role itself resolves to multiple controls.
- Preserve the exact-label scope and warm device-detail reuse for fast consecutive commands.

## 0.1.51

- Use the exact visible device-card opener on the current location view before falling back to the room route.
- Keep the room fallback for virtualized cards, but never restore the unsafe page-wide named-button shortcut.

## 0.1.50

- Remove the page-wide named-button shortcut that could select a device-card inline action instead of opening the detail route.
- Prefer the exact visible `data-testid="device"` wrapper and its unique name-bearing opener before locating any control.
- Keep room activation ahead of virtualized device-card discovery so control lookup starts only on the intended device detail page.

## 0.1.49

- Treat a validated transient SmartThings `GeneralError` 500 snapshot response as a request failure instead of permanently entering `PROTOCOL_CHANGED`.
- Advance the reviewed protocol contract to v4 so an earlier false-positive snapshot mismatch is cleared through the normal persisted-state migration.
- Reuse verified `/location/<id>/device/<id>` pages for consecutive commands instead of reopening the full location/room flow.
- Resolve observed exact-label toggles exposed as either an accessibility `switch` or native `checkbox`, while preserving ambiguity rejection.

## 0.1.48

- Restore Chromium session cookies across a clean app restart while pruning every restored tab except one verified SmartThings keeper before network observation starts.
- Preserve the concrete SmartThings location route on keeper recovery and fail closed when a command page has no verifiable location id.
- Revalidate the exact warm device detail URL and visible identity before every cached control action.
- Bound first-load control probes at 5 seconds and warm same-device probes at 1.5 seconds, prioritizing already-rendered localized labels before bounded late-render waits while preserving actual click and push-confirmation safety windows.
- Wait for delayed SmartThings SPA location-route changes before reporting a location change failure.

## 0.1.47

- Map the live Air Purifier `percent` slider and space-delimited `supportedAcFanModes` state into Home Assistant fan speed, number, preset, and mode-backed on/off controls.
- Parse the live speakers' space-delimited playback and track command lists so play, pause, stop, next, and previous controls remain available after a cached-inventory restore.
- Expose `playTrackAndResume` only when its exact detail control is observed, retaining exact UI targeting plus authoritative push confirmation.
- Include only sanitized Bridge error codes in every Home Assistant control failure so login, target, selector, and confirmation failures are distinguishable.

## 0.1.46

- Wait for the persistent Chromium context to close before the add-on process exits so session state can be flushed during a normal rebuild or restart.
- Retain the restart-safe cached inventory and push-confirmed UI command repairs from 0.1.45.

## 0.1.45

- Restore persisted inventories containing a valid `null` location update timestamp instead of discarding the entire cached snapshot after a Bridge restart.
- Retain the push-confirmed, UI-only warm command path and Home Assistant fan/error fixes from 0.1.44.

## 0.1.44

- Keep commands on the SmartThings Web UI click path only; remove the aborted direct Socket.IO command fallback from the release candidate.
- Retain the 0.1.43 command-page serialization and sanitized Bridge error-code propagation.
- Reuse a verified device-detail command page for sixty seconds so consecutive controls avoid a new tab, room navigation, and React detail render while preserving exact-target and push confirmation checks.
- Open a unique visible device directly from the location overview before using the exact-room fallback, and match known English/Korean control labels without waiting on the wrong locale.
- Pause background detail discovery while the warm command page is active, then close the page automatically before discovery resumes.

## 0.1.43

- Serialize SmartThings Web detail-discovery pages and user command pages so background control discovery cannot overlap the actual control click flow in the shared browser context.
- Preserve fixed Bridge command error codes in Home Assistant exceptions while keeping response bodies sanitized and secret-free.

## 0.1.42

- Match the current Home Assistant fan `turn_on` percentage and preset-mode service signature so HA no longer rejects fan power-on before reaching the Bridge.
- Use an already unique visible room device target immediately and prefer the exact observed labeled swatch before waiting on a missing accessible control name.
- Remove the two fixed 15-second waits observed ahead of a successful air-purifier power command while preserving unique-target and ambiguity checks.

## 0.1.41

- Treat an empty `api/device` result for a selected location as an authoritative zero-device snapshot instead of a permanent protocol mismatch.
- Advance the reviewed protocol contract so a previously persisted empty-location false positive cannot keep the Bridge blocked after the confirmed compatible snapshot shape returns.
- Include the 0.1.40 exact-toggle command routing and newer full-inventory command confirmation repair.

## 0.1.40

- Bind switch, light, fan, and media power commands to the exact observed SmartThings toggle instead of a different generic power control on multi-toggle devices.
- Accept a newer full SmartThings Web inventory snapshot as authoritative command confirmation when the direct push is missed, while retaining exact device/component/capability/attribute/value, sequence, and timestamp guards.
- Keep command state push/snapshot-grounded without optimistic Home Assistant mutation or SmartThings status polling.

## 0.1.39

- Add the official SmartThings icon to the Home Assistant add-on and local custom-integration brand assets, including the high-density integration variant.

## 0.1.38

- Foreground the isolated command page, activate the exact observed room before querying its lazily rendered device cards, and select the unique exact-name opener inside a multi-button card so commands follow the real SmartThings room UI without falling back to a same-named device or secondary card action.
- Exclude Cake's hidden duplicate device wrappers from exact-card ambiguity checks while preserving fail-closed behavior for multiple visible exact matches.
- Accept the one visible unnamed power switch used by the current Cake detail surface only when it is unambiguous; named and duplicated controls still fail closed.
- Treat only the observed Feathers `BadRequest`/400 request-error ACK as a failed snapshot request; 404 and server-error shapes still surface a protocol change, and the protocol contract advances to clear the earlier false-positive block safely.
- Keep command success dependent on a newer matching SmartThings push event; no optimistic state mutation or SmartThings polling is added.
- Add Home Assistant control-mode options, local Bridge-token reauthentication, Samsung-login Repairs, redacted diagnostics, and migration of obsolete duplicate number entries.

## 0.1.37

- Recover Bridge startup after the sanitized diagnostic database crossed Node's 2 GiB whole-file read limit.
- Keep the newest 50,000 diagnostic captures so the same restart failure cannot recur while preserving inventory and alias tables.

## 0.1.36

- Scope similarly named devices to the real SmartThings `data-testid=device` cards so room drag wrappers cannot make commands ambiguous.
- Drive detail sliders, toggles, and buttons from their visible swatch labels, matching the actual generic range, switch, and icon-button markup.
- Normalize enumerated `possibleStates` atomically and click only the observed status-to-command mapping while confirming the newer pushed status.
- Validate large private SQLite files by descriptor metadata instead of reading the entire database during startup.
- Retain only the newest 50,000 sanitized diagnostic captures and reapply that bound while observations continue.

## 0.1.35

- Prefer one exact SmartThings device-card name before partial-name matches so similarly named speakers remain safely addressable without weakening duplicate-name ambiguity checks.

## 0.1.34

- Scope CDP WebSocket identities to their browser session so repeated Chrome request IDs cannot cross-wire delayed acknowledgements.
- Accept camera thumbnail URLs nested inside the acknowledged SmartThings Web response envelope while keeping host, content type, redirect, and size validation fail-closed.

## 0.1.33

- Wait for asynchronously rendered named controls and give camera detail pages a longer bounded settle window so thumbnail ACKs can complete.
- Add push-only Home Assistant cover and climate entities plus observed enumerated select controls.
- Bind select, cover, and position commands to observed safe web controls and newer matching push confirmation while rejecting lock, valve, door, and garage control shapes.

## 0.1.32

- Serve camera thumbnail image bytes discovered from CDP-observed SmartThings Web Socket.IO ACKs.
- Keep capture storage non-fatal when a concurrent inspector holds the SQLite database.
- Remove stale Home Assistant `fan` registry entries that no longer classify as fan devices in the latest selected-location inventory.

## 0.1.31

- Correlate Socket.IO snapshot, detail, protocol, and camera thumbnail acknowledgements by WebSocket connection as well as ACK number.
- Preserve numeric level controls while preventing generic light and blind levels from creating false fan entities.

## 0.1.30

- Resynchronize inventory markers and expose normalized scenes, swatch controls, SmartThings Home Monitor, media, fan, number, button, and camera image surfaces.
- Confirm generic commands only from newer SmartThings push state, scene-location events, or Home Monitor arm-state inventory.
- Visit device details once on a separate bounded discovery page so the web app exposes every available swatch without using DOM content as device state.

## 0.1.29

- Add a safe authenticated switch command endpoint that serializes per device and succeeds only after a newer push event confirms the requested state.
- Keep command activity in a separate browser page while the keeper page remains observation-only.
- Add Home Assistant switch and fail-closed light entities without optimistic state updates.

## 0.1.28

- Keep physical-action correlation armed for valid component-less physical-action events by recording an explicit safe `unspecified` component.
- Accept the observed epoch-millisecond source timestamps in privacy-safe physical-action evidence.

## 0.1.27

- Restore live sensor and binary-sensor updates by reconciling component-less push events with the normalized snapshot state identity.
- Normalize epoch-millisecond event timestamps and reject older state events before they can overwrite newer snapshot values.
- Re-fetch and atomically merge Bridge inventory on SSE connection markers, sequence gaps, and Bridge sequence resets without adding SmartThings polling.

## 0.1.26

- Route the authenticated Bridge API to Home Assistant Core on internal port 8100 while allowing only the Core container address.
- Register 213 observed devices and 352 read-only entities on Home Assistant 2026.8.3, using state attributes that remain stable after capability identifiers are privacy-aliased.
- Permit cached inventory startup during a browser re-login window and use Home Assistant's supported illuminance unit constant.
- Add an authenticated local inventory API, one-time Ingress pairing codes, and an SSE state stream for the `smartthings_web` Home Assistant integration.
- Reconstruct all observed devices from the real SmartThings Web snapshot and update supported read-only sensor states from push events without SmartThings polling.
- Canonicalize generated package text as UTF-8/LF so equivalent cross-platform checkouts retain one manifest identity.
- Add a bounded in-memory physical-action correlation probe with fixed safe contact, motion, switch, and button presets.
- Require exactly one settled `/location` keeper page before arming and fail active evidence on browser isolation loss, protocol change, or runtime restart.
- Collapse Playwright/CDP duplicate deliveries into one logical candidate while exposing only safe metadata and an output-only SHA-256 logical-event hash.
- Add fixed no-store Ingress control responses with strict JSON validation, a 4 KiB request limit, and no request-body or raw-event logging.
- Keep commands, DOM state scraping, direct SmartThings APIs, and a persistent event journal outside the current limited alpha.
- Defer the interrupted 72-hour soak until after the first real Home Assistant device-registration result.

## 0.1.25

- Keep missing-event-ID deduplication source-independent by hashing the canonical sanitized Socket.IO delivery instead of an observer-specific capture envelope.
- Treat a changed value or event timestamp as a distinct fallback event while still collapsing the same delivery observed by Playwright and CDP.
- Align Phase 1 documentation with the already verified 0.1.24 add-on restart session and snapshot restore.
- Keep source backups outside `/addons` so duplicate local-app slugs cannot hide the newest package metadata.

## 0.1.24

- Attach Playwright and CDP network observers before keeper navigation, then reload an already restored authenticated SmartThings keeper once so restart-time snapshot requests cannot escape observation.
- Preserve Samsung login pages without automatic navigation and retain the 0.1.23 current-context readiness semantics.

## 0.1.23

- Keep readiness true for the current browser-context initial snapshot proof after the old 120-second snapshot TTL, while heartbeat freshness, recent push traffic, and current-context parser proof continue to gate readiness.
- Document the logged-in HAOS add-on validation that reached `CONNECTED`, observed 213 devices, decoded live device events, and kept `protocolChangeCount=0` and `restartCount=0`.
- Retain the owner-qualified `/proc` AppArmor write rule for Chromium's user-namespace setup and keep Phase 2 under the LIMITED evidence gate.

## 0.1.22

- Permit Chromium's HAOS user-namespace sandbox probe under enforced AppArmor with owner-qualified access to only the exact `/proc` map files it writes, while keeping the add-on's Docker privilege list empty and retaining `chromiumSandbox: true`.
- Allow the read-only GnuTLS configuration lookup observed during the same sandbox startup path.

## 0.1.21

- Allow HAOS Debian coreutils targets in the AppArmor profile so the `data-prep` oneshot can execute `chown` under enforced AppArmor.
- Run Openbox with temporary HOME/XDG cache paths to avoid root-home cache writes inside the confined add-on.

## 0.1.20

- Run the bridge and Chromium as the existing non-root `pwuser`, with a root-only data preparation oneshot for the add-on's private `/data` volume.
- Enable Playwright's Chromium sandbox explicitly and configure the pinned architecture-specific `chrome_sandbox` helper as `root:root` mode `4755`, without privileged mode, broad AppArmor access, a global sysctl change, or a `--no-sandbox` fallback.
- Add only the helper execution paths and the `chown`, `dac_override`, `setpcap`, and `sys_chroot` capabilities required by that fail-closed sandbox experiment.

## 0.1.19

- Run websockify in its standard proxy mode after live HAOS testing showed the distribution `--libserver` path accepted the WebSocket upgrade and then crashed on a missing `unix_listen` attribute.

## 0.1.18

- Keep the noVNC WebSocket URL relative to the `/novnc-ui/` Ingress page and proxy that exact path to websockify, preventing the duplicated `/novnc-ui/novnc/` route that completed an HTTP upgrade and then disconnected.

## 0.1.17

- Route the status-page login link through a fresh `/novnc-ui/` asset namespace and mark noVNC assets `no-store`, avoiding stale edge-cached MIME responses without requiring an external cache purge.

## 0.1.16

- Load nginx's standard MIME map so noVNC styles, ES modules, fonts, and images are served with browser-accepted content types through Ingress.
- Permit only the nginx MIME map plus the standard fontconfig and Openbox configuration trees required by the confined desktop session.

## 0.1.15

- Restore compatibility with the Home Assistant OS 18.2 AppArmor parser after it rejected the newer `userns` rule syntax.
- Serve noVNC static assets directly from nginx and run websockify on its thread-based library server so HTTP requests do not depend on per-request child processes under confinement.

## 0.1.14

- Allow user-namespace creation only inside the add-on's AppArmor profile so the pinned Chromium build can initialize its Linux sandbox without global sysctl or privileged-container changes.

## 0.1.13

- Allow read and executable mapping only for the pinned Playwright Chromium revision, with explicit amd64 and aarch64 browser and crash-handler entrypoints.

## 0.1.12

- Match the Supervisor-owned persistent data root as a directory (`/data/`) so AppArmor permits its metadata validation without broad file access.
- Use s6-overlay's bundled millisecond sleep utility while waiting for Xvfb readiness, avoiding ambiguous system `sleep` resolution under confinement.

## 0.1.11

- Permit only the `setgid` and `setuid` capabilities Xvfb needs to drop root privileges inside the AppArmor-confined container.
- Emit path-free initialization stage markers so startup permission failures can be isolated without exposing private data paths or contents.

## 0.1.10

- Reuse the existing `/tmp` directory for nginx and emit only an allowlisted startup error code for safe live diagnostics.
- Keep nginx's worker identity aligned with the already-root, AppArmor-confined service container so startup performs no ownership changes.

## 0.1.9

- Keep nginx temporary state in `/tmp`, let the bridge own `/data` initialization, and allow only the standard TLS configuration tree needed by Node.

## 0.1.8

- Allow nginx to read only its generated configuration and Xvfb to write only its keyboard-cache directory.

## 0.1.7

- Permit only the nginx binary under `/usr/sbin` and disable the unnecessary Xvfb lock file in the single-display container.

## 0.1.6

- Match both the pinned s6 bootstrap directories and their contents so s6 can enumerate its immutable service sources.

## 0.1.5

- Move the service bundle to s6-overlay's current `user-bundles.d` layout so startup does not rewrite the immutable image configuration.

## 0.1.4

- Declare the s6 user service bundle in the image so startup never needs to modify the read-only `/etc/s6-overlay` tree.

## 0.1.3

- Allow read access only to the pinned s6-overlay interpreter and bootstrap-data subtrees required by its verified startup chain.

## 0.1.2

- Allow the pinned s6-overlay `preinit` interpreter to be read without broadening the rest of `/package`.

## 0.1.1

- Reload the enforced Home Assistant AppArmor profile with read access for the s6 `/init` entrypoint.

## 0.1.0

- Initial Phase 1 inspector add-on skeleton.
- Added read-only protocol observation boundary, static API/secret audit gates, and a LIMITED evidence gate that keeps Phase 2 closed.
