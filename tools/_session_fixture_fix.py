from pathlib import Path
p = Path('tools/ci-native-session-smoke.mjs')
s = p.read_text()
old = '<meta charset="utf-8"><button id="settings"'
new = '<meta charset="utf-8"><style>[data-testid="toggle-switch-stayLoggedIn"]{width:40px;height:24px;display:inline-block}</style><button id="settings"'
assert s.count(old) == 1
s = s.replace(old, new)
old = "assert.equal(result.clean,true);assert.equal(result.report.state,'enabled');assert.ok(reloads>=1);"
new = "assert.equal(result.clean,true,JSON.stringify({result,reloads,evidence:await data()}));assert.equal(result.report.state,'enabled');assert.ok(reloads>=1);"
assert s.count(old) == 1
p.write_text(s.replace(old, new))
