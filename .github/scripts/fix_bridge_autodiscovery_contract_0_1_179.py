from pathlib import Path

path = Path("tests/bridge-autodiscovery-contract.test.ts")
content = path.read_text(encoding="utf-8")
old = 'expect(readme).toContain("Bridge 주소가 자동 입력");'
new = 'expect(readme).toContain("칸에 자동 입력");'
if content.count(old) != 1:
    raise SystemExit("autodiscovery documentation assertion anchor mismatch")
path.write_text(content.replace(old, new, 1), encoding="utf-8")
