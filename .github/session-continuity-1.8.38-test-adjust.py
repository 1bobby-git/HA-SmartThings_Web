from pathlib import Path

path = Path("bridge/tests/runtime.test.ts")
text = path.read_text(encoding="utf-8")
replacements = [
    (
        'test("maintains a quiet session over a synthetic day without accumulating pages or navigation", async () => {',
        'test("maintains a quiet session over a synthetic day without accumulating open pages or keeper navigation", async () => {',
    ),
    (
        '    expect(context.pages()).toHaveLength(pages);\n',
        '    expect(context.pages().filter((page) => !page.isClosed())).toHaveLength(pages);\n',
    ),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"runtime test adjustment expected one match, found {count}: {old}")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")

path = Path("bridge/tests/browser/session-proactive-refresh.test.ts")
text = path.read_text(encoding="utf-8")
old = '    this.gotoCalls.push({ url, options });\n'
new = '    this.gotoCalls.push(options ? { url, options } : { url });\n'
count = text.count(old)
if count != 1:
    raise SystemExit(f"session refresh test adjustment expected one match, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
