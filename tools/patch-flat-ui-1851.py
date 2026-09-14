from pathlib import Path

OLD = "1.8.50"
NEW = "1.8.51"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


def add_flat_override(path_name: str) -> None:
    path = Path(path_name)
    text = path.read_text(encoding="utf-8")
    marker = "    * { box-sizing: border-box; }"
    replacement = """    * { box-sizing: border-box; }
    *, *::before, *::after {
      border-radius: 0 !important;
      box-shadow: none !important;
    }"""
    if marker not in text:
        marker = "    *{box-sizing:border-box;}"
        replacement = """    *{box-sizing:border-box;}
    *,*::before,*::after{border-radius:0 !important;box-shadow:none !important;}"""
    text = replace_once(text, marker, replacement, f"flat CSS in {path_name}")
    text = text.replace("--hc-shadow: 0 8px 32px #19243b08;", "--hc-shadow: none;")
    text = text.replace("box-shadow: 0 8px 24px #19243b20;", "box-shadow: none;")
    path.write_text(text, encoding="utf-8")


add_flat_override("bridge/src/server/status-page.ts")
add_flat_override("addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html")

# Add regression coverage for the flat visual contract.
test_path = Path("bridge/tests/server/status-page.test.ts")
tests = test_path.read_text(encoding="utf-8")
marker = '  test("localizes runtime and diagnostic labels", () => {'
addition = '''  test("uses a flat visual system without shadows or rounded corners", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      dbAvailable: true,
      authenticated: true
    }));

    expect(html).toContain("border-radius: 0 !important");
    expect(html).toContain("box-shadow: none !important");
    expect(html).toContain("--hc-shadow: none");
    expect(html).not.toContain("box-shadow: 0 8px 24px #19243b20");
  });

'''
if "uses a flat visual system without shadows or rounded corners" not in tests:
    tests = replace_once(tests, marker, addition + marker, "status-page test insertion")
test_path.write_text(tests, encoding="utf-8")

# Keep synchronized release/version metadata.
for name in [
    "package.json",
    "package-lock.json",
    "custom_components/smartthings_web/manifest.json",
    "addon/smartthings_web_bridge/config.yaml",
    "protocol/version.json",
    "bridge/src/runtime.ts",
    "tests/addon-config.test.ts",
    "tests/protocol-version-contract.test.ts",
    "bridge/tests/runtime.test.ts",
]:
    path = Path(name)
    body = path.read_text(encoding="utf-8")
    if OLD not in body:
        raise SystemExit(f"{OLD} not found in {name}")
    path.write_text(body.replace(OLD, NEW), encoding="utf-8")

notes = """- 브릿지 웹페이지의 모든 카드, 상태 영역, 버튼, 배지, 안내 영역에서 그림자 효과를 제거했습니다.
- 모든 CSS border-radius를 0으로 강제해 둥근 모서리 없이 평면적인 직각 디자인으로 통일했습니다. 상태 색상, 체크/경고 아이콘, 한글 안내, 로그인 유지 상태 표현과 기능 동작은 그대로 유지합니다.
- 브릿지 시작/대기 화면에도 동일한 평면 스타일을 적용해 정상 상태 페이지와 시각 체계를 맞췄습니다.
"""
for name in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    path = Path(name)
    body = path.read_text(encoding="utf-8")
    heading = f"## {NEW}\n\n"
    if not body.startswith(heading):
        path.write_text(heading + notes + "\n" + body, encoding="utf-8")

Path(f"release-notes/{NEW}.md").write_text(notes, encoding="utf-8")

# Temporary patching files must not remain in the candidate commit.
for name in [
    ".github/workflows/patch-flat-ui-1851.yml",
    ".patch-trigger-1851",
    "tools/patch-flat-ui-1851.py",
]:
    path = Path(name)
    if path.exists():
        path.unlink()
