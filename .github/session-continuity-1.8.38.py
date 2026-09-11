from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


keeper = "bridge/src/browser/keeper-page.ts"
replace_once(
    keeper,
    'const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;\n',
    'const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;\n'
    'const SESSION_PROACTIVE_REFRESH_INTERVAL_MS = 15 * 60_000;\n'
    'const SESSION_PROACTIVE_REFRESH_RETRY_MS = 2 * 60_000;\n',
)
replace_once(
    keeper,
    'export type SessionTouchOutcome = "ok" | "reauth" | "failed" | "stale";\n',
    'export type SessionTouchOutcome = "ok" | "reauth" | "failed" | "stale";\n'
    'export type ProactiveSessionRefreshOutcome =\n'
    '  | "verified"\n'
    '  | "login_required"\n'
    '  | "failed"\n'
    '  | "stale"\n'
    '  | "skipped";\n',
)
replace_once(
    keeper,
    '  sessionRecoveryRetryMs?: number;\n'
    '  onRecovery?: (phase: "attempt" | "verified" | "login_required" | "failed" | "stale") => void;\n',
    '  sessionRecoveryRetryMs?: number;\n'
    '  proactiveRefreshIntervalMs?: number;\n'
    '  proactiveRefreshRetryMs?: number;\n'
    '  onRecovery?: (phase:\n'
    '    | "attempt"\n'
    '    | "verified"\n'
    '    | "login_required"\n'
    '    | "failed"\n'
    '    | "stale"\n'
    '    | "refresh_attempt"\n'
    '    | "refresh_verified"\n'
    '    | "refresh_login_required"\n'
    '    | "refresh_failed"\n'
    '    | "refresh_stale"\n'
    '  ) => void;\n',
)
replace_once(
    keeper,
    '  #sessionRecoveryInFlight: Promise<void> | undefined;\n'
    '  #touchInFlight: { page: BrowserPageLike; url: string; result: Promise<SessionTouchOutcome> } | undefined;\n',
    '  #sessionRecoveryInFlight: Promise<void> | undefined;\n'
    '  readonly #proactiveRefreshIntervalMs: number;\n'
    '  readonly #proactiveRefreshRetryMs: number;\n'
    '  #lastProactiveRefreshAtMs: number | undefined;\n'
    '  #lastProactiveRefreshAttemptAtMs: number | undefined;\n'
    '  #proactiveRefreshInFlight: Promise<ProactiveSessionRefreshOutcome> | undefined;\n'
    '  #touchInFlight: { page: BrowserPageLike; url: string; result: Promise<SessionTouchOutcome> } | undefined;\n',
)
replace_once(
    keeper,
    '    this.#sessionRecoveryRetryMs = validDelay(\n'
    '      options.sessionRecoveryRetryMs,\n'
    '      SESSION_RECOVERY_RETRY_MS\n'
    '    );\n',
    '    this.#sessionRecoveryRetryMs = validDelay(\n'
    '      options.sessionRecoveryRetryMs,\n'
    '      SESSION_RECOVERY_RETRY_MS\n'
    '    );\n'
    '    this.#proactiveRefreshIntervalMs = validDelay(\n'
    '      options.proactiveRefreshIntervalMs,\n'
    '      SESSION_PROACTIVE_REFRESH_INTERVAL_MS\n'
    '    );\n'
    '    this.#proactiveRefreshRetryMs = validDelay(\n'
    '      options.proactiveRefreshRetryMs,\n'
    '      SESSION_PROACTIVE_REFRESH_RETRY_MS\n'
    '    );\n',
)

marker = '  async openAdvancedPage(\n'
method = '''  async refreshAuthenticatedSessionIfDue(): Promise<ProactiveSessionRefreshOutcome> {
    const keeper = this.currentKeeper();
    if (
      !keeper ||
      !this.#authenticatedOnce ||
      this.authenticationRecoveryPending() ||
      !this.#canNavigate() ||
      !isKeeperSettledUrl(keeper.url())
    ) {
      return "skipped";
    }

    const now = this.#now();
    this.#lastProactiveRefreshAtMs ??= now;
    if (now - this.#lastProactiveRefreshAtMs < this.#proactiveRefreshIntervalMs) {
      return "skipped";
    }
    if (
      this.#lastProactiveRefreshAttemptAtMs !== undefined &&
      now - this.#lastProactiveRefreshAttemptAtMs < this.#proactiveRefreshRetryMs
    ) {
      return "skipped";
    }
    if (this.#proactiveRefreshInFlight) return this.#proactiveRefreshInFlight;

    this.#lastProactiveRefreshAttemptAtMs = now;
    const expectedKeeper = keeper;
    const expectedUrl = keeper.url();
    const operation = this.refreshAuthenticatedSessionProbe(expectedKeeper, expectedUrl);
    this.#proactiveRefreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#proactiveRefreshInFlight === operation) {
        this.#proactiveRefreshInFlight = undefined;
      }
    }
  }

  private async refreshAuthenticatedSessionProbe(
    expectedKeeper: BrowserPageLike,
    expectedUrl: string
  ): Promise<ProactiveSessionRefreshOutcome> {
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("refresh_attempt");
    try {
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      if (isSamsungLoginUrl(probe.url())) {
        this.recoveryDiagnostic("refresh_login_required");
        return "login_required";
      }
      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic("refresh_failed");
        return "failed";
      }

      const candidate = probe;
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(
          outcome === "reauth" ? "refresh_login_required" : "refresh_failed"
        );
        return outcome === "reauth" ? "login_required" : "failed";
      }
      if (
        !this.#canNavigate() ||
        this.currentKeeper() !== expectedKeeper ||
        expectedKeeper.isClosed() ||
        expectedKeeper.url() !== expectedUrl
      ) {
        this.recoveryDiagnostic("refresh_stale");
        return "stale";
      }

      this.#lastProactiveRefreshAtMs = this.#now();
      this.#lastProactiveRefreshAttemptAtMs = undefined;
      this.recoveryDiagnostic("refresh_verified");
      return "verified";
    } catch {
      this.recoveryDiagnostic("refresh_failed");
      return "failed";
    } finally {
      if (probe) {
        this.#commandPages.delete(probe);
        await probe.close().catch(() => undefined);
      }
    }
  }

'''
replace_once(keeper, marker, method + marker)
replace_once(
    keeper,
    '    if (outcome === "ok") {\n'
    '      this.#authenticatedOnce = true;\n'
    '      this.clearRecoveryState();\n'
    '      return;\n'
    '    }\n',
    '    if (outcome === "ok") {\n'
    '      this.#authenticatedOnce = true;\n'
    '      this.#lastProactiveRefreshAtMs ??= this.#now();\n'
    '      this.clearRecoveryState();\n'
    '      return;\n'
    '    }\n',
)

runtime = "bridge/src/runtime.ts"
replace_once(runtime, 'const bridgeVersion = "1.8.37";\n', 'const bridgeVersion = "1.8.38";\n')
replace_once(
    runtime,
    '    // Serial maintenance avoids an SSO navigation racing its own auth probe.\n'
    '    void reconcileActiveKeeper().then(touchAuthenticatedSessionIfDue).catch(() => {\n'
    '      log.warn("session_maintenance_failed");\n'
    '    });\n',
    '    // Serial maintenance avoids SSO refresh navigation racing its own auth probe.\n'
    '    void reconcileActiveKeeper()\n'
    '      .then(touchAuthenticatedSessionIfDue)\n'
    '      .then(async () => {\n'
    '        const manager = currentKeeperManager;\n'
    '        if (!manager) return;\n'
    '        if (await manager.refreshAuthenticatedSessionIfDue() === "verified") {\n'
    '          await persistSessionStateIfHealthy(\n'
    '            currentContext,\n'
    '            sessionStateStore,\n'
    '            status,\n'
    '            log,\n'
    '            "proactive_refresh"\n'
    '          );\n'
    '        }\n'
    '      })\n'
    '      .catch(() => {\n'
    '        log.warn("session_maintenance_failed");\n'
    '      });\n',
)

replace_once(
    "bridge/tests/runtime.test.ts",
    'bridge_init:version:1.8.37:home_monitor_direct',
    'bridge_init:version:1.8.38:home_monitor_direct',
)

Path("bridge/tests/browser/session-proactive-refresh.test.ts").write_text(
    '''import { describe, expect, test } from "vitest";

import {
  KEEPER_URL,
  KeeperPageManager,
  type BrowserContextLike,
  type BrowserPageLike,
  type SessionTouchOutcome
} from "../../src/browser/keeper-page.js";

class FakePage implements BrowserPageLike {
  readonly gotoCalls: Array<{ url: string; options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number } }> = [];
  closeCount = 0;

  constructor(
    public currentUrl: string,
    private readonly touchOutcome: SessionTouchOutcome = "ok",
    private readonly redirectOnGoto?: string,
    public closed = false
  ) {}

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async goto(
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }
  ): Promise<void> {
    this.gotoCalls.push({ url, options });
    this.currentUrl = this.redirectOnGoto ?? url;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
  }

  async evaluate<Result, Argument>(
    _pageFunction: (argument: Argument) => Result | Promise<Result>,
    _argument: Argument
  ): Promise<Result> {
    return this.touchOutcome as Result;
  }
}

class FakeContext implements BrowserContextLike {
  readonly created: FakePage[] = [];

  constructor(
    readonly existing: FakePage[],
    private readonly createPage: () => FakePage = () => new FakePage("about:blank")
  ) {}

  pages(): FakePage[] {
    return [...this.existing, ...this.created];
  }

  async newPage(): Promise<FakePage> {
    const page = this.createPage();
    this.created.push(page);
    return page;
  }
}

describe("KeeperPageManager proactive session refresh", () => {
  test("refreshes the shared session in a disposable tab without navigating the keeper", async () => {
    let now = 10_000;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const context = new FakeContext([keeper]);
    const phases: string[] = [];
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      proactiveRefreshRetryMs: 5_000,
      onRecovery: (phase) => phases.push(phase)
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("verified");
    expect(context.created).toHaveLength(1);
    expect(context.created[0]?.gotoCalls).toEqual([{
      url: KEEPER_URL,
      options: { waitUntil: "domcontentloaded", timeout: 10_000 }
    }]);
    expect(context.created[0]?.closed).toBe(true);
    expect(keeper.gotoCalls).toHaveLength(0);
    expect(keeper.closed).toBe(false);
    expect(manager.currentKeeper()).toBe(keeper);
    expect(phases).toEqual(["refresh_attempt", "refresh_verified"]);
  });

  test("preserves the active keeper when the proactive refresh reaches Samsung login", async () => {
    let now = 20_000;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const loginUrl = "https://account.samsung.com/accounts/v1/ST/signInGate";
    const context = new FakeContext(
      [keeper],
      () => new FakePage("about:blank", "ok", loginUrl)
    );
    const phases: string[] = [];
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      proactiveRefreshRetryMs: 5_000,
      onRecovery: (phase) => phases.push(phase)
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("login_required");
    expect(context.created).toHaveLength(1);
    expect(context.created[0]?.closed).toBe(true);
    expect(keeper.gotoCalls).toHaveLength(0);
    expect(keeper.closed).toBe(false);
    expect(manager.currentKeeper()).toBe(keeper);
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(phases).toEqual(["refresh_attempt", "refresh_login_required"]);
  });

  test("skips the refresh while foreground navigation is unsafe", async () => {
    let now = 30_000;
    let canNavigate = true;
    const keeper = new FakePage(`${KEEPER_URL}/home`);
    const context = new FakeContext([keeper]);
    const manager = new KeeperPageManager(context, {
      now: () => now,
      proactiveRefreshIntervalMs: 1_000,
      canNavigate: () => canNavigate
    });

    await manager.reconcileRestoredPages();
    await expect(manager.touchAuthenticatedSession()).resolves.toBe("ok");
    now += 1_000;
    canNavigate = false;

    await expect(manager.refreshAuthenticatedSessionIfDue()).resolves.toBe("skipped");
    expect(context.created).toHaveLength(0);
  });
});
''',
    encoding="utf-8",
)

for path, old, new in [
    ("custom_components/smartthings_web/manifest.json", '"version": "1.8.37"', '"version": "1.8.38"'),
    ("addon/smartthings_web_bridge/config.yaml", "version: 1.8.37", "version: 1.8.38"),
    ("package.json", '"version": "1.8.37"', '"version": "1.8.38"'),
]:
    replace_once(path, old, new)

lock = Path("package-lock.json")
lock_text = lock.read_text(encoding="utf-8")
if lock_text.count('"version": "1.8.37"') < 2:
    raise SystemExit("package-lock.json: expected at least two root version matches")
lock.write_text(
    lock_text.replace('"version": "1.8.37"', '"version": "1.8.38"', 2),
    encoding="utf-8",
)

notes = '''## 1.8.38

- 기존 5분 보호된 조회 keepalive에 더해, 인증이 정상인 동안 15분마다 같은 persistent Chromium context의 **별도 임시 탭**에서 `/location`을 새 문서로 부트스트랩하고 보호된 위치 조회까지 다시 검증합니다. SmartThings 웹앱의 정상 SSO/세션 갱신 흐름을 선제적으로 실행해 API GET만 반복하던 1.8.37보다 갱신 가능한 웹 세션을 오래 유지하도록 보강합니다.
- 선제 갱신 탭은 keeper·Home Monitor·기기 명령 탭으로 승격하지 않고 항상 닫습니다. 로그인/MFA 화면으로 전환되거나 검증이 실패하면 현재 keeper를 그대로 보존하고 2분 이상 간격으로만 다시 시도하므로 사용자 로그인 화면이나 진행 중인 제어를 덮어쓰지 않습니다.
- 선제 갱신이 성공하면 갱신된 공유 쿠키/스토리지 상태를 즉시 기존 AES-256-GCM `/data/session-state.json`에도 다시 저장합니다. `session_recovery` 로그에 `refresh_attempt`, `refresh_verified`, `refresh_login_required`, `refresh_failed`, `refresh_stale` 단계가 추가되어 실제 유지 여부를 구분할 수 있습니다.
- Samsung 서버가 세션을 절대 만료시키거나 MFA/비밀번호 재입력을 요구하는 정책 자체를 우회하지는 않습니다. 그런 경우에는 기존 수동 로그인 화면을 보존합니다. 기기 제어 요청을 재전송하거나 SmartThings 공개/비공개 API를 새로 호출하는 방식은 추가하지 않습니다.

'''
for changelog in ["CHANGELOG.md", "addon/smartthings_web_bridge/CHANGELOG.md"]:
    p = Path(changelog)
    p.write_text(notes + p.read_text(encoding="utf-8"), encoding="utf-8")
