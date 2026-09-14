from pathlib import Path
r=Path('.')
more='"observer_missing", "store_missing", "session_not_ready", "preference_not_ready", "socket_not_ready", "session_schema_unknown", "capture_ambiguous", "invalid_target", "renewal_unsupported"'
p=r/'bridge/src/state/runtime-state.ts';s=p.read_text();s=s.replace('nativeSessionReason?: "unsupported"', 'nativeSessionReason?: ' + more.replace(', ', ' | ') + ' | "unsupported"');s=s.replace('!["unsupported", "setting_pending",', '!['+more+', "unsupported", "setting_pending",');p.write_text(s)
p=r/'bridge/src/server/status-page.ts';s=p.read_text();s=s.replace('unsupported: "현재 웹 버전에서 세션 정보를 읽지 못했습니다. 기존 브라우저 복구 방식은 유지됩니다.",','''unsupported: "세션 정보를 아직 확인하지 못했습니다. 로그인 유지가 꺼졌거나 로그아웃됐다는 뜻은 아닙니다.",
    observer_missing: "현재 브라우저 문서에 세션 관찰기가 아직 연결되지 않았습니다. 기존 인증 복구 경로에서 다시 확인합니다.",
    store_missing: "웹 앱의 세션 저장소를 아직 찾지 못했습니다. 로그인 상태와는 별도로 확인합니다.",
    session_not_ready: "웹 앱의 사용자 세션이 아직 준비되지 않았습니다. 인증 정보를 기다립니다.",
    preference_not_ready: "웹 앱의 로그인 유지 설정값이 아직 준비되지 않았습니다. 꺼짐으로 판단하지 않습니다.",
    socket_not_ready: "웹 앱의 연결·인증 상태가 아직 준비되지 않았습니다. 잠시 후 다시 확인합니다.",
    session_schema_unknown: "웹 앱이 제공한 세션 정보의 형식을 확인하지 못했습니다. 현재 로그인을 임의로 변경하지 않습니다.",
    capture_ambiguous: "둘 이상의 세션 저장소가 발견되어 자동 선택하지 않았습니다. 기존 인증 복구 경로를 유지합니다.",
    invalid_target: "SmartThings 기기 화면에서 세션을 다시 확인해야 합니다.",
    renewal_unsupported: "실제 세션 상태는 읽었지만 자동 갱신 기능 또는 세션 길이를 확인하지 못했습니다. 기존 인증 복구 경로를 유지합니다.",''')
s=s.replace('blocked: "다른 창이나 사용자 입력이 있어 변경하지 않았습니다."','blocked: "현재 화면에서 설정을 안전하게 확인할 수 없습니다. 로그인 유지가 꺼졌다는 뜻은 아닙니다."')
s=s.replace('`${Math.ceil(d.nativeSessionRemainingMs / 60000)}분` : "확인 대기";', '`${Math.ceil(d.nativeSessionRemainingMs / 60000)}분` : state === "active" ? "웹 앱에서 제공하지 않음" : "확인 대기";')
p.write_text(s)
# Existing fixture signatures remain supported along with production middleware variants.
p=r/'bridge/src/browser/cake-client-capture.ts';s=p.read_text().replace('source.includes("reducer:") && source.includes("client:") && source.includes("user:")', '(source.includes("socketAuthenticated") || (source.includes("reducer:") && source.includes("client:") && source.includes("user:")))');p.write_text(s)
