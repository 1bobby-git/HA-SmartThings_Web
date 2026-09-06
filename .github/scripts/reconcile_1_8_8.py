"""Reconcile exact-channel guards, release assertions and browser fixtures."""
from pathlib import Path
import hashlib

path = Path('tests/addon-config.test.ts')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == '67c9815230cb60a29eb367c4c8b525bd5e0fe91ff90f7c6c66755f87bbcc459d', str(path)
updated = original.replace("as version 1.8.7", "as version 1.8.8")
updated = updated.replace('toBe("1.8.7")', 'toBe("1.8.8")')
updated = updated.replace('const bridgeVersion = "1.8.7";', 'const bridgeVersion = "1.8.8";')
updated = updated.replace('    expect(changelog).toContain("## 1.8.7");', '    expect(changelog).toContain("## 1.8.8");\n    expect(changelog).toContain("## 1.8.7");')
assert hashlib.sha256(updated.encode()).hexdigest() == '7ef2bd5ce1928522f7fbba82d8473033a882032319ea33ddbd8f2dcf29c8929d', str(path)
path.write_text(updated, encoding="utf-8")

path = Path('bridge/tests/command/command-service.test.ts')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == 'd7cd7e9cb09167581e37b8af6731589e18d2c5684d30f9fb48c925b433358e88', str(path)
old = '    configureChildMappedSwitch(fixture.store, { ambiguous: true });\n    const result = await fixture.service.execute({'
new = '    configureChildMappedSwitch(fixture.store, { ambiguous: true });\n    // The child fixture starts at 02:01; the default 01:00 event is stale.\n    // Supply fresh evidence for only the explicitly requested parent channel.\n    fixture.executeDeviceAction.mockImplementation(async (input) => {\n      fixture.store.observe(received(deviceEventFrame("off", "2026-09-01T03:00:00.000Z", "switch",\n        "dev_001", "identifier_switch", undefined, input.component)));\n      return undefined;\n    });\n    const result = await fixture.service.execute({'
assert original.count(old) == 1
updated = original.replace(old, new, 1)
assert hashlib.sha256(updated.encode()).hexdigest() == 'e2fc854c85a8f1fb88adea2dcd95dcf8eb76d0ef5c41aebbc9b5b68a68fa6333', str(path)
path.write_text(updated, encoding="utf-8")

path = Path('bridge/src/command/command-service.ts')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == '598570244533bb21ce16ff6c6d3bf1063f31664f18286faebb4884a613584c08', str(path)
edits = [(409, 412, '    if (effective.confirm !== false && state) {\n'), (418, 419, '        locationNames,\n        // Use the original request: resolution can infer a controlId too.\n        !request.controlId\n'), (1381, 1382, '  locationNames: Readonly<Record<string, string>>,\n  allowAggregate = true\n'), (1400, 1400, '  // Explicit HA controls stay on one channel, after the existing device guard.\n  // Do not infer child mappings or expand into sibling channels for that request.\n  if (!allowAggregate) return undefined;\n')]
lines = original.splitlines(keepends=True)
for start, stop, replacement in reversed(edits):
    lines[start:stop] = replacement.splitlines(keepends=True)
updated = "".join(lines)
assert hashlib.sha256(updated.encode()).hexdigest() == '15427bbb645d52e25c8739fac4e5cb1602ed79f87ddf87c25e01e459a2e9a128', str(path)
path.write_text(updated, encoding="utf-8")

path = Path('bridge/tests/command/command-service.test.ts')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == 'e2fc854c85a8f1fb88adea2dcd95dcf8eb76d0ef5c41aebbc9b5b68a68fa6333', str(path)
edits = [(73, 73, '    expect(fixture.executeComponentTransaction).not.toHaveBeenCalled();\n    fixture.store.close();\n  });\n\n  test.each(["door lock", "valve", "garage door"])("a concrete control retains the multi-component %s device guard", async (deviceType) => {\n    const fixture = multiSwitchFixture(["main", "switch2"], { deviceType });\n    await expect(fixture.service.execute({\n      targetType: "device", targetId: "dev_001", component: "identifier_main",\n      capability: "identifier_switch", attribute: "switch", controlId: "identifier_toggle_aggregate",\n      command: "off", arguments: [], clientRequestId: `request_concrete_blocked_${deviceType.replaceAll(" ", "_")}`\n    })).rejects.toMatchObject({ code: "unsupported_command" });\n    expect(fixture.executeDeviceAction).not.toHaveBeenCalled();\n')]
lines = original.splitlines(keepends=True)
for start, stop, replacement in reversed(edits):
    lines[start:stop] = replacement.splitlines(keepends=True)
updated = "".join(lines)
assert hashlib.sha256(updated.encode()).hexdigest() == 'a2bb7495f79961379ab5f898c200393affbee265bbfecc90cbfde3632e621a8d', str(path)
path.write_text(updated, encoding="utf-8")

path = Path('tools/ci-home-monitor-dialog-smoke.mjs')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == '7e6e5ba260483bf9fbbe10633b4e29995b5996dbc9a214f8ada2888fe200424d', str(path)
edits = [(94, 95, '      `<section class="monitor-card"><h2>SmartThings Home Monitor</h2><button id="current">Disarmed</button></section>\n')]
lines = original.splitlines(keepends=True)
for start, stop, replacement in reversed(edits):
    lines[start:stop] = replacement.splitlines(keepends=True)
updated = "".join(lines)
assert hashlib.sha256(updated.encode()).hexdigest() == '1fedba7dc4e02204135aa1889a58a75dd54617f94d7abe7113bb2fe4e1b172cf', str(path)
path.write_text(updated, encoding="utf-8")

path = Path('tools/home-monitor-selector-regression.mjs')
original = path.read_text(encoding="utf-8")
assert hashlib.sha256(original.encode()).hexdigest() == 'cd66f6c9eeb3296f57a05fbc9ea5d75040233c00aea53f36e45243ccc49cf90e', str(path)
edits = [(43, 43, ' [\'unscoped page caption is not a local monitor card\',\'<h2>Home Monitor</h2><button id="a">Disarmed</button><script>window.clicks=[];a.onclick=()=>window.clicks.push("a")</script>\',\'not_found\'],\n')]
lines = original.splitlines(keepends=True)
for start, stop, replacement in reversed(edits):
    lines[start:stop] = replacement.splitlines(keepends=True)
updated = "".join(lines)
assert hashlib.sha256(updated.encode()).hexdigest() == '979a987e5a1f3fc55aa23dd76a65b1d899c129a45fcfdf8b055e2d55ed18f0b4', str(path)
path.write_text(updated, encoding="utf-8")
