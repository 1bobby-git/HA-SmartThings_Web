#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"Expected exactly one match in {path}, found {count}: {old[:120]!r}"
        )
    write(path, text.replace(old, new, 1))


def replace_count(path: str, old: str, new: str, expected: int) -> None:
    text = read(path)
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"Expected {expected} matches in {path}, found {count}: {old[:120]!r}"
        )
    write(path, text.replace(old, new))


replace_once("package.json", '"version": "0.1.176",', '"version": "0.1.177",')
replace_once(
    "package-lock.json",
    '"version": "0.1.176",\n  "lockfileVersion": 3,',
    '"version": "0.1.177",\n  "lockfileVersion": 3,',
)
replace_once(
    "package-lock.json",
    '"name": "ha-smartthings-web",\n      "version": "0.1.176",',
    '"name": "ha-smartthings-web",\n      "version": "0.1.177",',
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    "version: 0.1.176",
    "version: 0.1.177",
)
replace_once(
    "custom_components/smartthings_web/manifest.json",
    '"version": "0.1.176"',
    '"version": "0.1.177"',
)
replace_once(
    "protocol/version.json",
    '"bridge_version": "0.1.176"',
    '"bridge_version": "0.1.177"',
)
replace_once(
    "bridge/src/runtime.ts",
    'const bridgeVersion = "0.1.176";',
    'const bridgeVersion = "0.1.177";',
)
replace_once(
    "tests/protocol-version-contract.test.ts",
    "keeps every Bridge and integration release surface on the packaged 0.1.176 candidate",
    "keeps every Bridge and integration release surface on the packaged 0.1.177 candidate",
)
replace_once(
    "tests/protocol-version-contract.test.ts",
    'const expectedBridgeVersion = "0.1.176";',
    'const expectedBridgeVersion = "0.1.177";',
)
replace_once(
    "tests/addon-config.test.ts",
    'test("packages nonblocking startup recovery as version 0.1.176", () => {',
    'test("packages HAOS runtime recovery as version 0.1.177", () => {',
)
replace_count(
    "tests/addon-config.test.ts",
    'toBe("0.1.176")',
    'toBe("0.1.177")',
    3,
)
replace_once(
    "tests/addon-config.test.ts",
    "expect(runtime).toContain('const bridgeVersion = \"0.1.176\";');",
    "expect(runtime).toContain('const bridgeVersion = \"0.1.177\";');",
)
replace_once(
    "tests/addon-config.test.ts",
    'expect(changelog).toContain("## 0.1.176");',
    'expect(changelog).toContain("## 0.1.177");\n'
    '    expect(changelog).toContain("## 0.1.176");',
)

replace_once(
    "bridge/src/runtime.ts",
    "  });\n\n  let activeContextGeneration = 0;",
    "  });\n  log.info(`bridge_init:http_server_ready:${server.port}`);\n\n"
    "  let activeContextGeneration = 0;",
)
replace_once(
    "bridge/src/runtime.ts",
    "      context = (await launchSmartThingsPersistentContext(deps.chromium, paths)) as ObservableContext;",
    "      context = (await launchSmartThingsPersistentContext(deps.chromium, paths, {\n"
    '        onSandboxFallback: () => log.warn("browser_launch:sandbox_fallback")\n'
    "      })) as ObservableContext;",
)

changelog_path = "addon/smartthings_web_bridge/CHANGELOG.md"
changelog = read(changelog_path)
if not changelog.startswith("## 0.1.176\n"):
    raise SystemExit("Unexpected changelog head; refusing to prepend 0.1.177")
notes = """## 0.1.177

- Chromium을 기존처럼 sandbox 활성 상태로 먼저 실행하되, HAOS/AppArmor 또는 컨테이너 런타임이 SUID·user namespace sandbox를 차단한 것으로 확인된 경우에만 sandbox 비활성 상태로 정확히 한 번 재시도합니다. 관련 없는 브라우저 오류에는 fallback하지 않으며, 검은 noVNC 화면 대신 실제 Chromium 창이 열리도록 복구합니다.
- `/data`의 `bridge.sqlite`, sidecar, 설정·마커 또는 런타임 디렉터리가 잘못된 파일 형식·심볼릭 링크·손상된 SQLite 헤더로 남아 있어도 Bridge 전체 시작을 중단하지 않습니다. 문제 항목은 원본 이름을 포함한 고유 이름으로 root 전용 `/data/recovery`에 격리하고 새 런타임 파일을 생성하며, Chromium 로그인 프로필과 Samsung 쿠키 저장소는 삭제하지 않습니다.
- 비어 있거나 허용 길이를 벗어난 Bridge secret은 안전하게 새 64자리 secret으로 복구하고, 기존의 유효한 secret은 바이트 단위로 유지합니다. secret이 복구된 설치는 기존 Home Assistant 통합에서 한 번 다시 인증해야 합니다.
- Openbox의 임시 HOME·캐시 디렉터리를 시작 전에 생성하고 `bridge_init:http_server_ready:<port>` 및 `browser_launch:sandbox_fallback` 진단을 추가했습니다.
- 실제 배포용 앱 패키지를 Docker로 빌드해 깨끗한 데이터, root 소유 프로필, 잘못된 SQLite 디렉터리·헤더, 빈 secret에서 8098 응답·Chromium 프로세스·X11 창까지 확인하는 영구 CI smoke test를 추가했습니다.

"""
write(changelog_path, notes + changelog)

replace_once(
    "addon/smartthings_web_bridge/DOCS.md",
    "Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.\n",
    "Keep backup copies outside `/addons`. Supervisor scans child folders there as local apps, so a backup containing the same slug can make an older version appear current.\n\n"
    "Version 0.1.177 quarantines recoverable malformed Bridge files under root-only `/data/recovery` instead of blocking port 8098. It never quarantines the dedicated Chromium profile merely because nested ownership migration is pending, and it preserves valid Samsung login stores. If `bridge-secret` was empty or invalid and had to be regenerated, reauthenticate the existing Home Assistant integration once because its previous bearer token can no longer match.\n",
)
replace_once(
    "addon/smartthings_web_bridge/DOCS.md",
    "Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed that the Supervisor-loaded AppArmor profile is enforced, the add-on remains non-privileged with bridge networking, and sandboxed Chromium 151 starts as the non-root browser user. The status page and noVNC Ingress rendered the Samsung Account login page.",
    "Live Home Assistant OS 18.2 validation on 2026-08-24 confirmed that the Supervisor-loaded AppArmor profile is enforced and the add-on remains non-privileged with bridge networking. Version 0.1.177 still attempts sandboxed Chromium 151 first as the non-root browser user, but performs one narrowly classified compatibility retry without the Chromium sandbox when the host runtime blocks both the pinned SUID helper and user namespaces. The packaged runtime smoke test requires the status endpoint, Chromium process, and mapped X11 window before passing.",
)

for obsolete in (
    ".github/workflows/apply-low-write-0.1.173.yml",
    "tools/apply-low-write-0.1.173.py",
    ".github/workflows/finalize-haos-runtime-0.1.177.yml",
    "tools/finalize-haos-runtime-0.1.177.py",
):
    (ROOT / obsolete).unlink(missing_ok=True)

assert '"version": "0.1.177"' in read("package.json")
assert 'version: 0.1.177' in read("addon/smartthings_web_bridge/config.yaml")
assert '"version": "0.1.177"' in read("custom_components/smartthings_web/manifest.json")
assert '"bridge_version": "0.1.177"' in read("protocol/version.json")
assert 'const bridgeVersion = "0.1.177";' in read("bridge/src/runtime.ts")
print("Finalized HAOS runtime recovery 0.1.177")
