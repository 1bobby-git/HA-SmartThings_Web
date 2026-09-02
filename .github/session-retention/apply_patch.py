from __future__ import annotations

import json
from pathlib import Path

OLD = "0.1.159"
NEW = "0.1.160"


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def replace_all_required(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise SystemExit(f"{path}: missing required token {old!r}")
    write(path, text.replace(old, new))


def copy_staged(path: str, staged_name: str) -> None:
    staged = Path(".github/session-retention") / staged_name
    Path(path).write_bytes(staged.read_bytes())


copy_staged("bridge/src/browser/keeper-page.ts", "keeper-page.ts")
copy_staged("bridge/src/browser/persistent-context.ts", "persistent-context.ts")

replace_once(
    "bridge/src/runtime.ts",
    f'const bridgeVersion = "{OLD}";',
    f'const bridgeVersion = "{NEW}";',
)
replace_once(
    "bridge/src/runtime.ts",
    "        const keeperStatus = statusForKeeperUrl(keeper.url());",
    """        const keeperStatus: RuntimeStatusPatch =
          keeperManager.authenticationRecoveryPending()
            ? {
                authenticated: false,
                state: "LOGIN_REQUIRED",
                urlCategory: classifySmartThingsUrl(keeper.url())
              }
            : statusForKeeperUrl(keeper.url());""",
)
replace_once(
    "bridge/src/runtime.ts",
    """      createHealthReport(snapshot).ready &&
      snapshot.state === "CONNECTED" &&
      snapshot.authenticated &&""",
    "      snapshot.authenticated &&",
)
replace_once(
    "bridge/src/runtime.ts",
    '''      sessionTouchInFlight ||
      legacyCommandExecutor.hasForegroundOperation() ||
      legacyCommandExecutor.hasWarmCommandPage() ||
      detailDiscovery.isRunning() ||
      !isProbeBrowserIsolated(context, keeperManager) ||
      physicalActionProbe.snapshot(getProbeEvidence()).state === "armed"''',
    "      sessionTouchInFlight",
)
replace_once(
    "bridge/src/runtime.ts",
    """  const context = options.getContext();
  await Promise.allSettled([
    context?.close?.(),
    options.server.close(),""",
    """  const context = options.getContext();
  if (context) {
    await closeContextQuietly(context);
  }
  await Promise.allSettled([
    options.server.close(),""",
)

replace_once(
    "bridge/src/main.ts",
    """  processLike.once("SIGTERM", shutdown);
  processLike.once("SIGINT", shutdown);""",
    """  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    processLike.once(signal, shutdown);
  }""",
)

replace_once(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/bridge/run",
    """export XDG_CONFIG_HOME=/data/chromium-profile/.config
exec s6-setuidgid""",
    """export XDG_CONFIG_HOME=/data/chromium-profile/.config
export XDG_DATA_HOME=/data/chromium-profile/.local/share
export XDG_STATE_HOME=/data/chromium-profile/.local/state
exec s6-setuidgid""",
)

replace_once(
    "bridge/tests/browser/persistent-context.test.ts",
    """    expect(launch.options.chromiumSandbox).toBe(true);
    expect(launch.options.downloadsPath).toBe("/data/downloads");""",
    """    expect(launch.options.chromiumSandbox).toBe(true);
    expect(launch.options.handleSIGHUP).toBe(false);
    expect(launch.options.handleSIGINT).toBe(false);
    expect(launch.options.handleSIGTERM).toBe(false);
    expect(launch.options.downloadsPath).toBe("/data/downloads");""",
)
replace_once(
    "bridge/tests/browser/persistent-context.test.ts",
    """    expect(launch.options.args).toContain("--restore-last-session");
    expect(launch.options.args).toContain("--hide-crash-restore-bubble");""",
    """    expect(launch.options.args).toContain("--profile-directory=Default");
    expect(launch.options.args).toContain("--password-store=basic");
    expect(launch.options.args).toContain("--restore-last-session");
    expect(launch.options.args).toContain("--hide-crash-restore-bubble");
    expect(launch.options.args).toContain("--disable-session-crashed-bubble");""",
)

replace_once(
    "bridge/tests/browser/keeper-page.test.ts",
    """  KEEPER_URL,
  KeeperPageManager,""",
    """  KEEPER_URL,
  SESSION_TOUCH_AUTH_PATH,
  KeeperPageManager,""",
)
replace_once(
    "bridge/tests/browser/keeper-page.test.ts",
    """    expect(fetchMock).toHaveBeenCalledWith("/location", {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal)
    });
    expect(String(keeper.evaluateCalls[0]?.[0])).not.toMatch(""",
    """    expect(fetchMock).toHaveBeenCalledWith("/location", {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal)
    });
    expect(fetchMock).toHaveBeenCalledWith(SESSION_TOUCH_AUTH_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      redirect: "manual",
      signal: expect.any(AbortSignal)
    });
    expect(String(keeper.evaluateCalls[0]?.[0])).not.toMatch(""",
)
recovery_test = r'''

  test("re-enters SmartThings with the remembered Samsung session after reauthentication", async () => {
    let now = 10_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, type: "basic" })
      .mockResolvedValueOnce({ ok: false, status: 302, type: "opaqueredirect" });
    vi.stubGlobal("fetch", fetchMock);
    const keeper = new FakePage("https://my.smartthings.com/location/loc-synthetic-001");
    keeper.executeEvaluate = true;
    const manager = new KeeperPageManager(new FakeContext([keeper]), {
      now: () => now,
      sessionReauthRecoveryDelayMs: 30_000,
      loginRecoveryDelayMs: 900_000,
      sessionRecoveryRetryMs: 300_000
    });

    await expect(manager.touchAuthenticatedSession()).resolves.toBe("reauth");
    expect(manager.authenticationRecoveryPending()).toBe(true);
    await manager.ensureKeeper();
    expect(keeper.goto).not.toHaveBeenCalled();

    now += 30_001;
    await manager.ensureKeeper();

    expect(keeper.goto).toHaveBeenCalledWith(KEEPER_URL, {
      waitUntil: "domcontentloaded"
    });
    expect(manager.authenticationRecoveryPending()).toBe(false);
  });
'''
replace_once(
    "bridge/tests/browser/keeper-page.test.ts",
    '\n  test("does not touch a Samsung login page", async () => {',
    recovery_test + '\n  test("does not touch a Samsung login page", async () => {',
)

replace_once(
    "bridge/tests/runtime.test.ts",
    'import { ADVANCED_DEVICE_SNAPSHOT_URLS } from "../src/browser/keeper-page.js";',
    '''import {
  ADVANCED_DEVICE_SNAPSHOT_URLS,
  SESSION_TOUCH_AUTH_PATH
} from "../src/browser/keeper-page.js";''',
)

degraded_test = r'''

  test("keeps an authenticated session warm while realtime health is degraded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const root = createTempRoot();
    const keeper = new FakePage("https://my.smartthings.com/location/loc-synthetic-001");
    const context = new FakeContext([keeper]);
    const runtime = await createBridgeRuntime(
      createDeps(root, {
        config: {
          dataDir: root,
          host: "127.0.0.1",
          port: 0,
          heartbeatIntervalMs: 1_000,
          browserMaxRestarts: 2,
          browserRetryDelayMs: 0
        },
        chromium: { launchPersistentContext: vi.fn(async () => context) }
      })
    );
    runtimes.push(runtime);
    await runtime.browserStartup;
    keeper.goto.mockClear();
    keeper.evaluate.mockClear();
    keeper.evaluateCalls.length = 0;
    runtime.status.update({
      authenticated: true,
      keeperPresent: true,
      pushConnected: false,
      parserHealthy: false,
      initialSnapshotComplete: false,
      state: "STALE"
    });

    await vi.advanceTimersByTimeAsync(301_000);

    expect(keeper.goto).not.toHaveBeenCalled();
    expect(keeper.evaluateCalls).toHaveLength(1);
    expect(keeper.evaluateCalls[0]?.[1]).toMatchObject({
      path: "/location",
      authPath: SESSION_TOUCH_AUTH_PATH
    });
    expect(runtime.status.getSnapshot()).toMatchObject({
      authenticated: true,
      state: "STALE"
    });
  });
'''
replace_once(
    "bridge/tests/runtime.test.ts",
    '\n  test("skips periodic touch while the keeper is on Samsung login", async () => {',
    degraded_test + '\n  test("skips periodic touch while the keeper is on Samsung login", async () => {',
)

replace_once(
    "bridge/tests/runtime.test.ts",
    '  test("skips periodic touch while browser isolation is busy", async () => {',
    '  test("keeps the session warm while another browser page is open", async () => {',
)
replace_once(
    "bridge/tests/runtime.test.ts",
    '''    expect(keeper.evaluateCalls).toEqual([]);
    expect(runtime.status.getSnapshot()).toMatchObject({
      authenticated: true,
      state: "CONNECTED"
    });
  });

  test("marks snapshot complete only after all real ACK categories''',
    '''    expect(keeper.evaluateCalls).toHaveLength(1);
    expect(runtime.status.getSnapshot()).toMatchObject({
      authenticated: true,
      state: "CONNECTED"
    });
  });

  test("marks snapshot complete only after all real ACK categories''',
)

replace_once(
    "bridge/tests/main.test.ts",
    """    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));""",
    """    expect(handlers.has("SIGHUP")).toBe(true);
    handlers.get("SIGTERM")?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));""",
)

for path in (
    "package.json",
    "package-lock.json",
    "protocol/version.json",
    "custom_components/smartthings_web/manifest.json",
):
    payload = json.loads(read(path))
    if path == "package.json":
        if payload.get("version") != OLD:
            raise SystemExit(f"{path}: unexpected version")
        payload["version"] = NEW
    elif path == "package-lock.json":
        if (
            payload.get("version") != OLD
            or payload.get("packages", {}).get("", {}).get("version") != OLD
        ):
            raise SystemExit(f"{path}: unexpected version")
        payload["version"] = NEW
        payload["packages"][""]["version"] = NEW
    elif path == "protocol/version.json":
        if payload.get("bridge_version") != OLD:
            raise SystemExit(f"{path}: unexpected version")
        payload["bridge_version"] = NEW
    else:
        if payload.get("version") != OLD:
            raise SystemExit(f"{path}: unexpected version")
        payload["version"] = NEW
    write(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")

replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    f"version: {OLD}",
    f"version: {NEW}",
)
replace_all_required("tests/addon-config.test.ts", OLD, NEW)
replace_all_required("tests/protocol-version-contract.test.ts", OLD, NEW)

changelog_path = "addon/smartthings_web_bridge/CHANGELOG.md"
changelog = read(changelog_path)
if f"## {NEW}" in changelog:
    raise SystemExit(f"{changelog_path}: {NEW} already exists")
entry = f'''## {NEW}

- `/location` 정적 GET뿐 아니라 로그인된 동일 브라우저의 경량 Advanced location GET도 5분마다 호출해 실제 SmartThings 인증 세션을 갱신합니다.
- realtime 상태가 `STALE`·동기화 중이거나 명령/상세 페이지가 열려 있어도 인증된 keeper가 있으면 세션 유지를 계속하고, 인증 만료가 확인되면 30초 뒤 저장된 Samsung SSO 세션으로 `/location` 재진입을 시도합니다. 로그인 화면이 계속되면 15분 간격으로 재시도합니다.
- Chromium은 항상 `Default` 프로필과 `/data/chromium-profile`의 basic password store·XDG data/state 경로를 사용하며, 종료 신호는 Bridge가 직접 처리해 브라우저 프로필을 먼저 정상 종료합니다.
- 비밀번호·MFA·쿠키를 별도 파일이나 로그로 복사하지 않으며 기존 config entry, entity ID, unique ID, 장치/영역 이름과 명령 구조는 변경하지 않습니다.

'''
write(changelog_path, entry + changelog)

readme_path = "README.md"
readme = read(readme_path)
readme = readme.replace("버전 0.1.158은", f"버전 {NEW}은", 1)
anchor = "`/location` 페이지는 제거하지 않습니다. Socket.IO realtime keeper로 계속 유지되며 물리 조작, SmartThings 앱, 외부 자동화의 변경을 HA에 전달합니다. 재연결 후 첫 수신 프레임이 확인되면 Advanced 전체 snapshot을 다시 동기화합니다. 쿠키·토큰·CSRF·원본 device/location ID는 서비스, 로그, diagnostics에 노출하지 않습니다.\n"
session_note = "\n로그인 세션은 `/data/chromium-profile`의 고정 `Default` 프로필에 보존합니다. Bridge는 5분마다 `/location`과 경량 인증 endpoint를 함께 확인하고, realtime이 일시적으로 끊기거나 명령/상세 페이지가 열려 있어도 세션 유지 요청은 계속합니다. 인증 redirect가 감지되면 저장된 Samsung SSO 쿠키로 자동 재진입을 시도하며, SSO 자체가 만료된 경우에만 noVNC에서 다시 로그인해야 합니다.\n"
if anchor not in readme:
    raise SystemExit("README session-retention anchor not found")
write(readme_path, readme.replace(anchor, anchor + session_note, 1))
