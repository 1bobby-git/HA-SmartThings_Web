from pathlib import Path

p = Path('tests/addon-config.test.ts')
s = p.read_text(encoding='utf-8')
assert 'expect(config.version).toBe("1.8.11")' in s
s = s.replace('1.8.11', '1.8.12')
s = s.replace('    expect(changelog).toContain("## 1.8.12");',
              '    expect(changelog).toContain("## 1.8.12");\n    expect(changelog).toContain("## 1.8.11");')
p.write_text(s, encoding='utf-8')

p = Path('bridge/tests/runtime.test.ts')
s = p.read_text(encoding='utf-8')
old = '    expect(log.info.mock.calls.slice(0, 13)).toEqual([\n      ["bridge_init:data_paths"],'
new = '    expect(log.info.mock.calls.slice(0, 14)).toEqual([\n      ["bridge_init:version:1.8.12:home_monitor_direct"],\n      ["bridge_init:data_paths"],'
assert s.count(old) == 1
p.write_text(s.replace(old, new), encoding='utf-8')
print('Updated active release expectations and added the exact new marker to the ordered startup assertion.')
