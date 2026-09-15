"""Align verified-control fixtures and explicit version contracts after application."""
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
payload = Path(__file__).resolve().parent
changes = {}
for name in ['protocol/version.json', 'tests/protocol-version-contract.test.ts', 'tests/addon-config.test.ts', 'bridge/tests/runtime.test.ts']:
    text = (root / name).read_text()
    if '1.8.55' not in text:
        raise SystemExit(f'Unexpected version contract: {name}')
    changes[name] = text.replace('1.8.55', '1.8.56')

name = 'bridge/tests/command/command-service.test.ts'
text = (root / name).read_text()
old = (payload / 'service-regression.insert.ts').read_text()
new = old.replace('new DeviceStore()', 'readyDeviceStore()')
new = new.replace('"dev_120"', '"dev_001"')
new = new.replace('capability: "switch"', 'capability: "identifier_switch"')
new = new.replace('main: { switch: { switch:', 'main: { identifier_switch: { switch:')
new = new.replace('"main", "switch", "switch"', '"main", "identifier_switch", "switch"')
old_rejection = '''      const rejection = expect(service.execute(switchRequest())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
      await vi.advanceTimersByTimeAsync(400);
      await rejection;'''
new_rejection = '''      const pending = service.execute(switchRequest()).then(value => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }));
      await vi.advanceTimersByTimeAsync(400);
      const outcome = await pending;
      expect(outcome.error).toMatchObject({ code: "command_confirmation_timeout" });'''
assert new.count(old_rejection) == 1
new = new.replace(old_rejection, new_rejection)
indent = lambda value: ''.join('  ' + line if line.strip() else line for line in value.splitlines(keepends=True))
assert text.count(indent(old)) == 1
text = text.replace(indent(old), indent(new))
for title in [
    'requires the requested push state to remain stable after browser interaction',
    'accepts matching state from the one-shot Advanced snapshot refresh',
]:
    anchor = f'  test("{title}",'
    assert text.count(anchor) == 1
    start = text.index(anchor)
    end = text.find('\n  test', start + len(anchor))
    assert end > start
    section = text[start:end]
    previous = 'expect(resync).toHaveBeenCalledWith({ deviceId: "dev_001" });'
    assert section.count(previous) == 1
    section = section.replace(previous, 'expect(resync).toHaveBeenCalledWith({ deviceId: "dev_001",\n        switchTarget: { component: "main", capability: "identifier_switch" } });')
    text = text[:start] + section + text[end:]
changes[name] = text
for name, text in changes.items():
    (root / name).write_text(text, encoding='utf-8')
print('Updated real observed-control fixture and five explicit contract files; no production guard weakened.')
