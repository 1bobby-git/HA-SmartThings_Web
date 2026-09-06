"""Reconcile release-version assertions and one stale regression fixture."""
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
