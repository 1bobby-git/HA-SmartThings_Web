from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


status = Path("bridge/src/server/status-page.ts")
text = status.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''  const tone: StatusTone = effective === "enabled" ? "ready" : "warning";
  return `<section class="hc-section" aria-labelledby="native-login-heading">''',
    '''  const tone: StatusTone = effective === "enabled" ? "ready" : "warning";
  const importantGuidance = effective === "enabled"
    ? "중요 설정 확인됨: SmartThings 웹의 ‘로그인 유지’가 켜져 있습니다. 브릿지를 장시간 연결할 때 권장되는 상태입니다."
    : "중요: 브릿지의 장기 로그인 유지를 위해 반드시 브릿지 내부 브라우저(noVNC)의 SmartThings 설정에서 ‘로그인 유지’를 켜 주세요. 꺼져 있으면 2시간·8시간·24시간으로 선택한 세션 길이에 따라 자동 로그아웃될 수 있습니다.";
  return `<section class="hc-section" aria-labelledby="native-login-heading">''',
    "native policy function",
)
text = replace_once(
    text,
    '''        <p>브릿지 내부 브라우저의 웹 설정입니다. 브라우저 종료 후 인증 복원과는 별개이며, 재시작 후 다시 확인합니다.</p>
      </div>''',
    '''        <p>브릿지 내부 브라우저의 웹 설정입니다. 휴대폰이나 다른 브라우저의 설정과는 별개이며, 브라우저 종료 후 인증 복원과도 별도로 재확인합니다.</p>
        <p role="note"><strong>${escapeHtml(importantGuidance.split(":")[0] + ":")}</strong>${escapeHtml(importantGuidance.slice(importantGuidance.indexOf(":") + 1))}</p>
      </div>''',
    "native policy guidance",
)
status.write_text(text, encoding="utf-8")


test_path = Path("bridge/tests/server/status-page.test.ts")
tests = test_path.read_text(encoding="utf-8")
marker = '  test("localizes runtime and diagnostic labels", () => {'
addition = '''  test("marks native login maintenance as an important bridge-browser instruction", () => {
    const pending = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true,
      nativeLoginPolicyState: "pending",
      nativeLoginPolicyReason: "not_checked"
    }));
    const enabled = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true,
      nativeLoginPolicyState: "enabled",
      nativeLoginPolicyReason: "already_enabled"
    }));

    expect(pending).toContain("중요:");
    expect(pending).toContain("반드시 브릿지 내부 브라우저(noVNC)");
    expect(pending).toContain("‘로그인 유지’를 켜 주세요");
    expect(pending).toContain("2시간·8시간·24시간");
    expect(pending).toContain('role="note"');
    expect(enabled).toContain("중요 설정 확인됨:");
    expect(enabled).not.toContain("2시간·8시간·24시간");
  });

'''
if "marks native login maintenance as an important bridge-browser instruction" not in tests:
    tests = replace_once(tests, marker, addition + marker, "status-page test")
test_path.write_text(tests, encoding="utf-8")


old_v, new_v = "1.8.49", "1.8.50"
for name in [
    "package.json",
    "package-lock.json",
    "custom_components/smartthings_web/manifest.json",
    "addon/smartthings_web_bridge/config.yaml",
    "protocol/version.json",
    "bridge/src/runtime.ts",
    "bridge/tests/runtime.test.ts",
    "tests/addon-config.test.ts",
    "tests/protocol-version-contract.test.ts",
]:
    path = Path(name)
    body = path.read_text(encoding="utf-8")
    if old_v not in body:
        raise SystemExit(f"{old_v} not found in {name}")
    path.write_text(body.replace(old_v, new_v), encoding="utf-8")


notes = """- 브릿지 상태 페이지의 `SmartThings 로그인 유지` 영역에 **중요 지침**을 추가했습니다. 장기 로그인 유지를 위해 반드시 브릿지 내부 브라우저(noVNC)의 SmartThings 설정에서 `로그인 유지`를 켜도록 명확히 안내합니다.
- 로그인 유지가 아직 확인되지 않았거나 꺼진 경우, 2시간·8시간·24시간으로 선택한 세션 길이에 따라 자동 로그아웃될 수 있음을 함께 설명합니다. 휴대폰이나 다른 브라우저에서 켠 설정과 브릿지 내부 Chromium 설정은 별개임을 명시합니다.
- 로그인 유지가 실제로 켜져 있음이 확인되면 `중요 설정 확인됨`으로 표시하여 불필요한 로그인 경고를 만들지 않습니다.
"""
for name in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    path = Path(name)
    body = path.read_text(encoding="utf-8")
    heading = "## 1.8.50\n\n"
    if not body.startswith(heading):
        path.write_text(heading + notes + "\n" + body, encoding="utf-8")
Path("release-notes/1.8.50.md").write_text(notes, encoding="utf-8")