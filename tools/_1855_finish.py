from pathlib import Path
r=Path('.')
p=r/'bridge/src/browser/native-login-policy.ts';s=p.read_text().replace('reason?: NativeLoginPolicyReason };','reason?: NativeLoginPolicyReason; settingsOpen?: boolean };');s=s.replace('  try {\n    const guard = await bounded(page.evaluate!(inspectLoginSettingsDom', '  let settingsOpen = false;\n  try {\n    const guard = await bounded(page.evaluate!(inspectLoginSettingsDom');s=s.replace('    if (guard.result === "blocked"', '    settingsOpen = guard.settingsOpen === true;\n    if (guard.result === "blocked"');s=s.replace('if (existingPreference?.state === "enabled") return { report: existingPreference, clean: true };', 'if (existingPreference?.state === "enabled") return { report: existingPreference, clean: !settingsOpen };');s=s.replace('if (action === "guard") return { result: "clear" };','if (action === "guard") return { result: "clear", settingsOpen: !!root };');p.write_text(s)
p=r/'bridge/src/runtime.ts';s=p.read_text().replace('reason: n.uiKeepSignedIn ? "observed_enabled" : "observed_disabled" };','reason: n.uiKeepSignedIn ? "observed_enabled" : "observed_disabled" };\n          if (n.uiKeepSignedIn) { initialPolicyRefreshRequested = true; nativePolicyCheckQueued = false; }');p.write_text(s)
for path in ['package.json','package-lock.json','protocol/version.json','addon/smartthings_web_bridge/config.yaml','custom_components/smartthings_web/manifest.json','tests/addon-config.test.ts','tests/protocol-version-contract.test.ts','bridge/src/runtime.ts','bridge/tests/runtime.test.ts']:
 p=r/path;s=p.read_text();assert '1.8.54' in s,path;p.write_text(s.replace('1.8.54','1.8.55'))
notes='''## 세션 판독 조건과 로그인 유지 검사 보완

- 1.8.54 실행 로그에서 인증 조회는 성공하지만 `session_schema_unknown`과 `blocked`가 반복되는 경로를 다뤘습니다. 이 로그만으로 실제 계정이 로그아웃됐거나 특정 필드가 null이라고 단정하지 않습니다.
- 실제 로그인 유지의 참·거짓 값과 선택적 종료 시각을 독립적으로 읽습니다. 종료 시각이 null, 0, 문자열 등 읽을 수 없는 형식이어도 별도의 참·거짓 세션 상태를 숨기지 않습니다. 값이 없거나 잘못된 로그인 유지 플래그는 켜짐으로 추정하지 않습니다.
- 로그인 유지 ON에서는 웹 자동 로그아웃 예정 시각 경과만으로 서버 인증 거절을 단정하지 않고 보호된 Location 조회로 검증합니다. 실제 401은 계속 재인증 필요로 처리합니다. 읽을 수 없는 만료 시각은 자동 갱신 권한으로 사용하지 않습니다.
- 설정 모달을 열지 않고 실행 중인 웹 앱의 현재 설정값을 읽습니다. 이미 켜진 설정을 확인하기 위한 불필요한 새로고침을 줄였으며, 이 값만으로 실제 세션 적용이나 재시작 후 보존을 보장하지 않습니다.
- 화면에 표시되지 않는 투명 컨테이너의 인증 요소를 활성 입력창으로 오인하지 않도록 했습니다. 실제 표시된 인증 입력·보안 확인·다른 모달·비활성 컨트롤은 각각 보호하고 별도의 사유를 표시합니다. 기기 명령으로 보류된 작업은 페이지 변경과 구분합니다.
- 실패 시 로그인 유지/종료 시각 필드의 **형식만** 한글 화면과 로그에 표시합니다. 계정 식별자, 필드 원문, 쿠키, 인증 정보, DOM은 새 진단에 포함하지 않습니다.

### 적용 및 검증 범위

Bridge 앱을 1.8.55로 업데이트하고 웹페이지기를 새로고침하세요. 브릿지 내부의 로그인 유지는 켜진 상태를 유지하고 계정 삭제·프로필 초기화·로그아웃은 하지 않아도 됩니다. 실제 계정의 필드값과 차단 요소는 아직 직접 관찰하지 못했으므로 장시간 유지 해결을 보장하는 릴리스가 아닙니다. 세션 판독이 계속 실패하면 `native_session`의 `sessionFlagType`/`sessionExpiryType`와 세분화된 `native_login_policy` 사유로 남은 원인을 구분할 수 있습니다.

검증은 단위 테스트와 외부 계정 통신을 차단한 실제 Chromium 회귀입니다. 사용자의 실계정 8/24시간 연속 유지 검증과는 다릅니다.
'''
notes=notes.replace('웹페이지기를','웹페이지를')
(r/'release-notes/1.8.55.md').write_text(notes)
for path in ['CHANGELOG.md','addon/smartthings_web_bridge/CHANGELOG.md']:
 p=r/path;s=p.read_text();i=s.index('## 1.8.54');s=s[:i]+'## 1.8.55\n\n'+notes.split('\n',2)[2]+'\n'+s[i:];p.write_text(s)
