from pathlib import Path
root=Path('.')
def change(path,old,new):
 p=root/path;s=p.read_text();assert old in s,(path,old[:120]);p.write_text(s.replace(old,new))
p='bridge/src/browser/native-session-observer.ts'
change(p,'  const known = (s: ReturnType<typeof state>)', '''  // Field shape is diagnostic metadata only: never export raw values or infer
  // a flag from truthiness. A missing/invalid optional expiry is not a logout.
  const fieldType = (v: unknown) => v === undefined ? "missing" : v === null ? "null" :
    typeof v === "boolean" ? "boolean" : typeof v === "number" ?
      (!Number.isFinite(v) ? "non_finite" : v === 0 ? "zero" : v < 0 ? "negative" : "number") :
    typeof v === "string" ? "string" : "other";
  const expiry = (s: ReturnType<typeof state>): number | undefined =>
    typeof s?.session.exp === "number" && Number.isFinite(s.session.exp) && s.session.exp > 0
      ? s.session.exp : undefined;
  const known = (s: ReturnType<typeof state>)''')
change(p,'    (s.session.exp === undefined || (Number.isFinite(s.session.exp) && s.session.exp > 0)) &&\n','')
change(p,'    Number.isFinite(s!.session.exp) && [7200, 28800, 86400].includes(s!.prefs.sessionLength);', '    expiry(s) !== undefined && [7200, 28800, 86400].includes(s!.prefs.sessionLength);')
change(p,'    return "session_schema_unknown";', '''    if (s.session.stayLoggedIn === undefined || s.session.stayLoggedIn === null) return "session_flag_missing";
    if (typeof s.session.stayLoggedIn !== "boolean") return "session_flag_invalid";
    return "session_schema_unknown";''')
change(p,'    const s = refresh();\n    if (!locationAllowed()', '''    const s = refresh();
    const fields = !locationAllowed() || ambiguous || !store || !s || typeof s.user !== "string" ? {} : {
      sessionFlagType: fieldType(s.session.stayLoggedIn), sessionExpiryType: fieldType(s.session.exp),
      ...(typeof s.prefs.stayLoggedIn === "boolean" ? { uiKeepSignedIn: s.prefs.stayLoggedIn } : {})
    };
    if (!locationAllowed()''')
change(p,'outcome: "unsupported", diagnostic: captureDiagnostic(s) };','outcome: "unsupported", diagnostic: captureDiagnostic(s), ...fields };')
change(p,'return { schema: 1, available: true, instance, revision, uiKeepSignedIn: s!.prefs.stayLoggedIn,','return { schema: 1, available: true, instance, revision, ...fields, uiKeepSignedIn: s!.prefs.stayLoggedIn,')
change(p,'...(s!.session.exp === undefined ? {} : {','...(expiry(s) === undefined ? {} : {')
change(p,'s!.session.exp * 1000 - Date.now()))) }),','expiry(s)! * 1000 - Date.now()))) }),')
p='bridge/src/browser/native-session-maintenance.ts'
change(p,'"session_schema_unknown" | "capture_ambiguous"', '"session_schema_unknown" | "session_flag_missing" | "session_flag_invalid" | "capture_ambiguous"')
change(p,'export interface NativeSessionObservation {','''export type NativeSessionFieldType = "missing" | "null" | "boolean" | "number" | "zero" | "negative" | "non_finite" | "string" | "other";
function safeFields(raw: unknown): { sessionFlagType?: NativeSessionFieldType; sessionExpiryType?: NativeSessionFieldType; uiKeepSignedIn?: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return {};
  const allowed = ["missing", "null", "boolean", "number", "zero", "negative", "non_finite", "string", "other"];
  return { ...(allowed.includes(r.sessionFlagType as string) ? { sessionFlagType: r.sessionFlagType as NativeSessionFieldType } : {}),
    ...(allowed.includes(r.sessionExpiryType as string) ? { sessionExpiryType: r.sessionExpiryType as NativeSessionFieldType } : {}),
    ...(typeof r.uiKeepSignedIn === "boolean" ? { uiKeepSignedIn: r.uiKeepSignedIn } : {}) };
}
export interface NativeSessionObservation {
  sessionFlagType?: NativeSessionFieldType;
  sessionExpiryType?: NativeSessionFieldType;''')
change(p,'const unknown = (reason: NativeSessionReason = "unsupported"): NativeMaintenanceResult =>\n      ({ handled: false, observation: { state: "unknown", reason } });','''const unknown = (reason: NativeSessionReason = "unsupported", raw?: unknown): NativeMaintenanceResult =>
      ({ handled: false, observation: { state: "unknown", reason, ...safeFields(raw) } });''')
change(p,'"socket_not_ready", "session_schema_unknown", "capture_ambiguous", "invalid_target"];','"socket_not_ready", "session_schema_unknown", "session_flag_missing", "session_flag_invalid", "capture_ambiguous", "invalid_target"];')
change(p,'diagnostic as NativeSessionReason : "unsupported");','diagnostic as NativeSessionReason : "unsupported", raw);')
change(p,'state: "checking", reason: "setting_pending", uiKeepSignedIn: snapshot.uiKeepSignedIn,','state: "checking", reason: "setting_pending", ...safeFields(raw), uiKeepSignedIn: snapshot.uiKeepSignedIn,')
change(p,'const expired = snapshot.expiresInMs !== undefined && snapshot.expiresInMs <= 0;', '''// This is the web logout deadline, not independent evidence that the
    // server rejected authentication. The native app disables this timer for
    // effective stayLoggedIn=ON; require protected proof instead.
    const expired = !snapshot.sessionKeepSignedIn && snapshot.expiresInMs !== undefined && snapshot.expiresInMs <= 0;''')
change(p,'(snapshot.expiresInMs !== undefined && snapshot.expiresInMs <= 5 * 60_000)', '(snapshot.expiresInMs !== undefined && snapshot.expiresInMs > 0 && snapshot.expiresInMs <= 5 * 60_000)')
p='bridge/src/browser/native-login-policy.ts'
change(p,'| "ambiguous" | "blocked" | "state_unknown"', '| "ambiguous" | "blocked" | "auth_input_present" | "challenge_present" | "other_dialog_present" | "control_disabled" | "command_busy" | "state_unknown"')
change(p,'; native?: boolean };','; native?: boolean; reason?: NativeLoginPolicyReason };')
change(p,'  } catch { return undefined; }\n}\n\n/** This runs ONLY', '''  } catch { /* Try read-only application preference below. */ }
  // UI preference is readable independently of the effective session schema.
  // This never dispatches, clicks, navigates, or labels a session as verified.
  if (!page.evaluate || page.isClosed() || page.url() !== target) return undefined;
  try {
    const value = await bounded(page.evaluate(({ target }) => {
      if (location.href !== target || location.origin !== "https://my.smartthings.com") return undefined;
      const api = (window as unknown as Record<symbol, {read(): Record<string, unknown>}>)[Symbol.for("smartthings_web_bridge.native_session")];
      const s = typeof api?.read === "function" ? api.read() : undefined;
      return s?.schema === 1 && typeof s.uiKeepSignedIn === "boolean" ? s.uiKeepSignedIn : undefined;
    }, { target }), 1_500);
    if (page.isClosed() || page.url() !== target) return undefined;
    if (typeof value === "boolean") return { state: value ? "enabled" : "attention",
      reason: value ? "observed_enabled" : "observed_disabled" };
  } catch { /* Observation is optional and must not interrupt the live tab. */ }
  return undefined;
}

/** This runs ONLY''')
change(p,'    return undefined;\n  } catch { /* Try read-only application', '  } catch { /* Try read-only application')
change(p,'  const marker = randomUUID();','''  const existingPreference = await readNativeKeepSignedIn(page);
  if (page.isClosed() || page.url() !== target) return report("attention", "page_changed", false);
  if (!(options.canContinue?.() ?? true)) return report("attention", "command_busy", false);
  // Already ON is read-only evidence of a preference, not of server expiry
  // extension or persistence after restart. Do not reload it just to re-read.
  // The caller still verifies the candidate's application authentication.
  if (existingPreference?.state === "enabled") return { report: existingPreference, clean: true };
  const marker = randomUUID();''')
change(p,'return !state.busy && state.uiKeepSignedIn === true && state.sessionKeepSignedIn === true &&\n          state.socketConnected === true && state.socketAuthenticated === true &&\n          typeof state.expiresInMs === "number" && state.expiresInMs > 0 ? "applied" : "pending";', 'return !state.busy && state.uiKeepSignedIn === true && state.sessionKeepSignedIn === true &&\n          state.socketConnected === true && state.socketAuthenticated === true ? "applied" : "pending";')
change(p,'state.result === "blocked" ? "blocked" :','state.result === "blocked" ? state.reason ?? "blocked" :')
change(p,'found.result === "ambiguous" ? "ambiguous" : "blocked";', 'found.result === "ambiguous" ? "ambiguous" : found.reason ?? "blocked";')
change(p,'return report("attention", valid() ? "ui_timeout" : "page_changed", false);', '''return report("attention", page.isClosed() || page.url() !== target ? "page_changed" :
      !(options.canContinue?.() ?? true) ? "command_busy" : "ui_timeout", false);''')
change(p,'    return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden" &&', '''    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
      (typeof element.checkVisibility !== "function" || element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) &&
      style.display !== "none" && style.visibility !== "hidden" &&''')
old='''  if (all.some(element => visible(element) && element.matches(
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
  ))) return { result: "blocked" };'''
new='''  if (all.some(element => visible(element) && element.matches(
    'input[type="password"], input[autocomplete="one-time-code"], input[name="loginId"]'
  ))) return { result: "blocked", reason: "auth_input_present" };
  if (all.some(element => visible(element) && element.matches('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')))
    return { result: "blocked", reason: "challenge_present" };'''
change(p,old,new)
change(p,'return { result: "blocked" };\n  const mark', 'return { result: "blocked", reason: "other_dialog_present" };\n  const mark')
change(p,'if (element instanceof HTMLInputElement && element.readOnly) return { result: "blocked" };', 'if (element instanceof HTMLInputElement && element.readOnly) return { result: "blocked", reason: "control_disabled" };')
change(p,'element.closest(\'[aria-disabled="true"], [inert]\')) return { result: "blocked" };','element.closest(\'[aria-disabled="true"], [inert]\')) return { result: "blocked", reason: "control_disabled" };')
p='bridge/src/state/runtime-state.ts'
change(p,'  nativeSessionState?:', '''  nativeSessionFlagType?: "missing" | "null" | "boolean" | "number" | "zero" | "negative" | "non_finite" | "string" | "other";
  nativeSessionExpiryType?: RuntimeStatusSnapshot["nativeSessionFlagType"];
  nativeSessionState?:''')
change(p,'  "nativeSessionState",','  "nativeSessionFlagType",\n  "nativeSessionExpiryType",\n  "nativeSessionState",')
change(p,'"session_schema_unknown" | "capture_ambiguous"','"session_schema_unknown" | "session_flag_missing" | "session_flag_invalid" | "capture_ambiguous"')
change(p,'"session_schema_unknown", "capture_ambiguous"','"session_schema_unknown", "session_flag_missing", "session_flag_invalid", "capture_ambiguous"')
change(p,'"control_not_found", "ambiguous", "blocked", "state_unknown",','"control_not_found", "ambiguous", "blocked", "auth_input_present", "challenge_present", "other_dialog_present", "control_disabled", "command_busy", "state_unknown",')
change(p,'    if (key === "nativeSessionState"', '''    if ((key === "nativeSessionFlagType" || key === "nativeSessionExpiryType") && value !== undefined &&
        !["missing", "null", "boolean", "number", "zero", "negative", "non_finite", "string", "other"].includes(value as string)) throw new Error("invalid native session field type");
    if (key === "nativeSessionState"''')
p='bridge/src/server/health.ts'
change(p,'  nativeSessionState?:', '''  nativeSessionFlagType?: RuntimeStatusSnapshot["nativeSessionFlagType"];
  nativeSessionExpiryType?: RuntimeStatusSnapshot["nativeSessionExpiryType"];
  nativeSessionState?:''')
change(p,'      nativeSessionState: snapshot.nativeSessionState,','''      nativeSessionFlagType: snapshot.nativeSessionFlagType,
      nativeSessionExpiryType: snapshot.nativeSessionExpiryType,
      nativeSessionState: snapshot.nativeSessionState,''')
p='bridge/src/runtime.ts'
change(p,'status.update({ nativeSessionState: n.state, nativeSessionReason: n.reason,','''status.update({ nativeSessionState: n.state, nativeSessionReason: n.reason,
          nativeSessionFlagType: n.sessionFlagType, nativeSessionExpiryType: n.sessionExpiryType,''')
change(p,'if (old.nativeSessionState !== n.state || old.nativeSessionReason !== n.reason) {','''if (old.nativeSessionState !== n.state || old.nativeSessionReason !== n.reason ||
            old.nativeSessionFlagType !== n.sessionFlagType || old.nativeSessionExpiryType !== n.sessionExpiryType) {''')
change(p,'{state:n.state,reason:n.reason}', '{state:n.state,reason:n.reason,sessionFlagType:n.sessionFlagType,sessionExpiryType:n.sessionExpiryType}')
change(p,'nativeSessionUiKeepSignedIn: undefined, nativeSessionKeepSignedIn: undefined,','nativeSessionFlagType: undefined, nativeSessionExpiryType: undefined,\n            nativeSessionUiKeepSignedIn: undefined, nativeSessionKeepSignedIn: undefined,')
change(p,'        if (native.authenticationRejected) {','''        if (typeof n.uiKeepSignedIn === "boolean" && !native.authenticationRejected) {
          const policy: NativeLoginPolicyReport = { state: n.uiKeepSignedIn ? "enabled" : "attention",
            reason: n.uiKeepSignedIn ? "observed_enabled" : "observed_disabled" };
          nativePolicyReports.set(beforeRefresh, policy); lastNativePolicy = policy;
          status.update({ nativeLoginPolicyState: policy.state, nativeLoginPolicyReason: policy.reason });
        }
        if (native.authenticationRejected) {''')
p='bridge/src/server/status-page.ts'
change(p,'  nativeSessionReason: "실제 세션 확인 결과",', '''  nativeSessionReason: "실제 세션 확인 결과",
  nativeSessionFlagType: "로그인 유지 필드 형식",
  nativeSessionExpiryType: "세션 종료 시각 필드 형식",''')
change(p,'현재 브릿지 브라우저에 열린 SmartThings 설정에서 로그인 유지 켜짐을 확인했습니다.', '현재 브릿지의 SmartThings 웹 설정에서 로그인 유지 켜짐을 읽었습니다. 실제 세션 적용은 아래에서 별도로 확인합니다.')
change(p,'현재 브릿지 브라우저에 열린 SmartThings 설정에서 로그인 유지가 꺼져 있습니다.', '현재 브릿지의 SmartThings 웹 설정에서 로그인 유지 꺼짐을 읽었습니다.')
change(p,'  state_unknown: "스위치의 켜짐 여부를 판독하지 못했습니다.",', '''  auth_input_present: "비밀번호 또는 인증번호 입력 화면이 있어 자동 설정을 보류했습니다. 입력창을 변경하거나 닫지 않았습니다.",
  challenge_present: "보안 확인 화면이 감지되어 자동 설정을 보류했습니다. 보안 확인을 임의로 통과하거나 닫지 않습니다.",
  other_dialog_present: "SmartThings 설정 이외의 대화상자가 열려 있어 자동 설정을 보류했습니다.",
  control_disabled: "로그인 유지 컨트롤이 비활성 또는 읽기 전용이어서 변경하지 않았습니다.",
  command_busy: "기기 명령 처리가 시작되어 설정 작업을 보류했습니다. 페이지 변경이나 로그아웃을 뜻하지 않습니다.",
  state_unknown: "스위치의 켜짐 여부를 판독하지 못했습니다.",''')
change(p,'      session_schema_unknown:"실제 세션 값의 형식 확인 필요",', '      session_flag_missing:"실제 세션에 로그인 유지 필드 없음", session_flag_invalid:"실제 세션 로그인 유지 값의 형식 확인 필요",\n      session_schema_unknown:"실제 세션 값의 형식 확인 필요",')
change(p,'    session_schema_unknown: "웹 앱이 제공한 세션 정보의 형식을 확인하지 못했습니다. 현재 로그인을 임의로 변경하지 않습니다.",', '''    session_flag_missing: "실제 세션에 로그인 유지 값이 제공되지 않았습니다. 화면 설정을 실제 세션 값으로 대신 사용하지 않습니다.",
    session_flag_invalid: "실제 세션의 로그인 유지 값이 지원하는 참·거짓 형식이 아닙니다. 임의로 켜짐으로 변환하지 않습니다.",
    session_schema_unknown: "웹 앱이 제공한 세션 정보의 형식을 확인하지 못했습니다. 현재 로그인을 임의로 변경하지 않습니다.",''')
change(p,'  const remaining = current && d.nativeSessionRemainingMs !== undefined','''  const fieldLabels: Record<string, string> = { missing: "미제공", null: "빈 값(null)", boolean: "참·거짓", number: "숫자", zero: "0", negative: "음수", non_finite: "유효하지 않은 숫자", string: "문자열", other: "지원하지 않는 형식" };
  const shape = current && (d.nativeSessionFlagType || d.nativeSessionExpiryType)
    ? `<p class="hc-muted">필드 형식: 로그인 유지 ${fieldLabels[d.nativeSessionFlagType ?? "missing"] ?? "확인 대기"} · 종료 시각 ${fieldLabels[d.nativeSessionExpiryType ?? "missing"] ?? "확인 대기"}</p>` : "";
  const remaining = current && d.nativeSessionRemainingMs !== undefined''')
change(p,'· 현재 유효 시간 ${remaining}</p>', '· 웹 세션 종료 시각까지 ${remaining}</p>${shape}')
change(p,'? `${Math.ceil(d.nativeSessionRemainingMs / 60000)}분` : state === "active" ? "웹 앱에서 제공하지 않음" : "확인 대기";', '? `${Math.ceil(d.nativeSessionRemainingMs / 60000)}분` : state === "active" ? "웹 앱에서 제공하지 않음 또는 판독 불가" : "확인 대기";')
(root/'docs/native-session-maintenance.md').write_text((root/'docs/native-session-maintenance.md').read_text()+'''
## 1.8.55: field-level observation and non-mutating preference inspection

A 1.8.54 user log proves authenticated probes succeed while `session_schema_unknown`,
`blocked` and `page_changed` recur. It does not contain the actual session field
values or DOM blocker; do not claim which field value or modal the user has.

Observe a boolean effective flag independently from optional expiry. A null,
string, zero or otherwise unreadable deadline is not a server auth rejection and
never authorizes supplemental renewal. Missing/non-boolean flags remain unknown.
The Web 2.57.0 native setLogoutTimer uses the deadline only when the effective
stayLoggedIn flag is OFF. ON plus an elapsed deadline still requires a fresh
protected Location read; 401 still invalidates authentication.

Read the app preference without opening a modal/reloading an already-ON page.
UI preference alone is never effective-session or persistence proof. Explicit
blocker reasons preserve credential/challenge/modal protection. Diagnostic field
TYPE enums only (no values, account IDs, storage, cookie or token data) cross the
page boundary. Unit and browser fixtures cover variants, not live account state.
''')
