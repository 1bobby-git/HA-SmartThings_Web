from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


# Restore the pre-1.8.51 rounded structure, keep every shadow disabled,
# and reduce non-semantic corner radii slightly.
status = Path("bridge/src/server/status-page.ts")
text = status.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''    *, *::before, *::after {\n      border-radius: 0 !important;\n      box-shadow: none !important;\n    }''',
    '''    *, *::before, *::after { box-shadow: none !important; }''',
    "status global flat override",
)
replacements = [
    ("      border-radius: 10px;\n      background: #ffffff;\n      color: #191f28;", "      border-radius: 8px;\n      background: #ffffff;\n      color: #191f28;", "skip link radius"),
    ("      border-radius: 6px;\n      background: #f1f3f6;", "      border-radius: 5px;\n      background: #f1f3f6;", "version radius"),
    ("      border-radius: 12px;\n      background: #ffffff;\n      color: #2563eb;", "      border-radius: 10px;\n      background: #ffffff;\n      color: #2563eb;", "login radius"),
    ("      border-radius: 99px 99px 0 0;", "      border-radius: 2px 2px 0 0;", "tab indicator radius"),
    ("      border-radius: 24px;\n      background: var(--hc-surface);", "      border-radius: 18px;\n      background: var(--hc-surface);", "hero radius"),
    ("border-radius: 16px; }\n    .hc-state-icon svg", "border-radius: 12px; }\n    .hc-state-icon svg", "state icon radius"),
    ("border-radius: 14px; background: var(--hc-soft);", "border-radius: 10px; background: var(--hc-soft);", "status item radius"),
    ("border-radius: 9px; }\n    .hc-status-leading-icon svg", "border-radius: 7px; }\n    .hc-status-leading-icon svg", "status leading radius"),
    ("border-radius: 19px; background: var(--hc-surface);", "border-radius: 14px; background: var(--hc-surface);", "card radius"),
    ("border-radius: 12px; font-weight: 760; cursor: pointer;", "border-radius: 10px; font-weight: 760; cursor: pointer;", "button radius"),
    ("border-radius: 12px; background: var(--hc-soft); color: var(--hc-muted);", "border-radius: 10px; background: var(--hc-soft); color: var(--hc-muted);", "pairing radius"),
    ("border-radius: 12px; background: var(--hc-danger-soft);", "border-radius: 10px; background: var(--hc-danger-soft);", "protocol alert radius"),
    (".hc-hero { padding: 22px 20px; border-radius: 20px; }", ".hc-hero { padding: 22px 20px; border-radius: 16px; }", "mobile hero radius"),
]
for old, new, label in replacements:
    text = replace_once(text, old, new, label)
status.write_text(text, encoding="utf-8")

fallback = Path("addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html")
text = fallback.read_text(encoding="utf-8")
text = replace_once(
    text,
    '''    *, *::before, *::after {\n      border-radius: 0 !important;\n      box-shadow: none !important;\n    }''',
    '''    *, *::before, *::after { box-shadow: none !important; }''',
    "fallback global flat override",
)
fallback_replacements = [
    ("border-radius: 99px 99px 0 0;", "border-radius: 2px 2px 0 0;", "fallback tab radius"),
    ("border-radius: 24px; background: var(--hc-surface);", "border-radius: 18px; background: var(--hc-surface);", "fallback hero radius"),
    ("border-radius: 14px; background: var(--hc-warning-soft);", "border-radius: 11px; background: var(--hc-warning-soft);", "fallback status icon radius"),
    ("border-radius: 19px; background: var(--hc-surface);", "border-radius: 14px; background: var(--hc-surface);", "fallback card radius"),
    ("code { padding: 2px 5px; border-radius: 6px;", "code { padding: 2px 5px; border-radius: 4px;", "fallback code radius"),
    ("padding: 0 18px; border-radius: 12px; background: #2563eb;", "padding: 0 18px; border-radius: 10px; background: #2563eb;", "fallback button radius"),
    ("padding: 12px 14px; border-radius: 12px; background: var(--hc-warning-soft);", "padding: 12px 14px; border-radius: 10px; background: var(--hc-warning-soft);", "fallback note radius"),
    (".hc-hero { padding: 22px 20px; border-radius: 20px; }", ".hc-hero { padding: 22px 20px; border-radius: 16px; }", "fallback mobile hero radius"),
]
for old, new, label in fallback_replacements:
    text = replace_once(text, old, new, label)
fallback.write_text(text, encoding="utf-8")

# Replace the 1.8.51 flat-corner regression test with the intended soft-radius contract.
test_path = Path("bridge/tests/server/status-page.test.ts")
tests = test_path.read_text(encoding="utf-8")
old_test = '''  test("uses a flat visual system without shadows or rounded corners", () => {\n    const html = renderStatusPage(reportFor({\n      state: "CONNECTED",\n      protocolVersion: "1:abcdef1234567890",\n      dbAvailable: true,\n      authenticated: true\n    }));\n\n    expect(html).toContain("border-radius: 0 !important");\n    expect(html).toContain("box-shadow: none !important");\n    expect(html).toContain("--hc-shadow: none");\n    expect(html).not.toContain("box-shadow: 0 8px 24px #19243b20");\n  });'''
new_test = '''  test("keeps shadows disabled while restoring compact rounded corners", () => {\n    const html = renderStatusPage(reportFor({\n      state: "CONNECTED",\n      protocolVersion: "1:abcdef1234567890",\n      dbAvailable: true,\n      authenticated: true\n    }));\n\n    expect(html).toContain("box-shadow: none !important");\n    expect(html).toContain("--hc-shadow: none");\n    expect(html).not.toContain("border-radius: 0 !important");\n    expect(html).toContain("border-radius: 18px");\n    expect(html).toContain("border-radius: 14px");\n    expect(html).toContain("border-radius: 10px");\n    expect(html).not.toContain("box-shadow: 0 8px 24px #19243b20");\n  });'''
tests = replace_once(tests, old_test, new_test, "soft radius regression test")
test_path.write_text(tests, encoding="utf-8")

old_v, new_v = "1.8.51", "1.8.52"
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

notes = """- 1.8.51에서 제거한 그림자 효과는 그대로 유지합니다. 브릿지 상태 페이지와 시작/대기 페이지는 계속 `box-shadow` 없이 표시됩니다.
- 1.8.51에서 모든 모서리를 직각으로 강제했던 변경은 되돌리고, 카드·버튼·배지·안내 영역의 둥근 모서리를 복원했습니다. 다만 1.8.50보다 radius를 조금 줄여 더 단정한 형태로 조정했습니다.
- 상태 점과 원형 프로토콜 아이콘처럼 의미가 있는 원형 요소는 원형을 유지하며, 상태 색상·한글 UI·로그인 유지 안내·noVNC·페어링 기능은 변경하지 않습니다.
"""
for name in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    path = Path(name)
    body = path.read_text(encoding="utf-8")
    heading = "## 1.8.52\n\n"
    if not body.startswith(heading):
        path.write_text(heading + notes + "\n" + body, encoding="utf-8")
Path("release-notes/1.8.52.md").write_text(notes, encoding="utf-8")
