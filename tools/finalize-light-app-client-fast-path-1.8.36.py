from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace(path: str, old: str, new: str, expected: int | None = None) -> None:
    p = ROOT / path
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if expected is not None and count != expected:
        raise SystemExit(f"{path}: expected {expected} occurrences of {old!r}, got {count}")
    if count == 0:
        raise SystemExit(f"{path}: missing {old!r}")
    p.write_text(text.replace(old, new), encoding="utf-8", newline="\n")


# Keep the protocol wire contract at 5; synchronize only the release version.
replace("protocol/version.json", '"bridge_version": "1.8.35"', '"bridge_version": "1.8.36"', 1)

# Version-contract tests deliberately pin the current release and must move with it.
replace("tests/addon-config.test.ts", "1.8.35", "1.8.36")
replace("tests/protocol-version-contract.test.ts", "1.8.35", "1.8.36")
replace(
    "bridge/tests/runtime.test.ts",
    'bridge_init:version:1.8.35:home_monitor_direct',
    'bridge_init:version:1.8.36:home_monitor_direct',
    1,
)

# The runtime FakePage models page.evaluate by returning the Advanced result
# directly instead of actually executing the browser callback. Accepting that
# shape in the helper keeps this integration test at one keeper evaluation and
# does not alter real-browser behavior, where the callback returns kind/result.
p = ROOT / "bridge/src/advanced/app-client-command.ts"
text = p.read_text(encoding="utf-8")

anchors = [
    (
        '((globalThis as { window?: PageRecord }).window ?? globalThis) as PageRecord',
        '((globalThis as unknown as { window?: PageRecord }).window ?? globalThis) as unknown as PageRecord',
    ),
    (
        '''        function asClient(value: unknown): NativeClient | undefined {\n          return record(value) && typeof value.service === "function"\n            ? (value as NativeClient)\n            : undefined;\n        }''',
        '''        function asClient(value: unknown): NativeClient | undefined {\n          const candidate = record(value);\n          return candidate && typeof candidate.service === "function"\n            ? (candidate as unknown as NativeClient)\n            : undefined;\n        }''',
    ),
    (
        '''        function asService(value: unknown): NativeService | undefined {\n          return record(value) && typeof value.patch === "function"\n            ? (value as NativeService)\n            : undefined;\n        }''',
        '''        function asService(value: unknown): NativeService | undefined {\n          const candidate = record(value);\n          return candidate && typeof candidate.patch === "function"\n            ? (candidate as unknown as NativeService)\n            : undefined;\n        }''',
    ),
]
for old, new in anchors:
    if text.count(old) != 1:
        raise SystemExit(f"app-client strict-type anchor mismatch: {old[:70]!r}")
    text = text.replace(old, new, 1)

old = '    return outcome.kind === "unavailable" ? undefined : outcome.result;\n'
new = '''    if (\n      typeof outcome === "object" && outcome !== null &&\n      typeof (outcome as { ok?: unknown }).ok === "boolean" &&\n      typeof (outcome as { status?: unknown }).status === "number"\n    ) {\n      return outcome as unknown as AppClientCommandResult;\n    }\n    return outcome.kind === "unavailable" ? undefined : outcome.result;\n'''
if text.count(old) != 1:
    raise SystemExit("app-client helper result anchor mismatch")
text = text.replace(old, new, 1)
p.write_text(text, encoding="utf-8", newline="\n")

print("Finalized SmartThings Web 1.8.36 release/version fixtures")
