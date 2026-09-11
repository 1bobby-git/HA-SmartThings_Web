from pathlib import Path
import re


def edit(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f'{path}: expected {count} anchors, found {actual}: {old[:80]!r}')
    p.write_text(text.replace(old, new))


keeper = 'bridge/src/browser/keeper-page.ts'
edit(keeper, '  bringToFront?(): Promise<unknown>;', '''  waitForURL?(url: (url: URL) => boolean, options?: { waitUntil?: "domcontentloaded" | "load"; timeout?: number }): Promise<unknown>;
  bringToFront?(): Promise<unknown>;''')
edit(keeper, 'export interface KeeperPageManagerOptions {', '''export interface SessionProbeDiagnostic {
  outcome: SessionTouchOutcome;
  reason: string;
  status?: number;
}

export interface KeeperPageManagerOptions {
  onSessionProbe?: (diagnostic: SessionProbeDiagnostic) => void;''')
edit(keeper, '  #authenticatedOnce = false;', '''  readonly #onSessionProbe: KeeperPageManagerOptions["onSessionProbe"];
  #authenticatedOnce = false;''')
edit(keeper, '    this.#onRecovery = options.onRecovery;', '''    this.#onRecovery = options.onRecovery;
    this.#onSessionProbe = options.onSessionProbe;''')
edit(keeper, '    if (!this.#canNavigate() || (current && isSamsungLoginUrl(current.url()))) {', '''    if (this.#proactiveRefreshInFlight || this.#sessionRecoveryInFlight ||
        !this.#canNavigate() || (current && isSamsungLoginUrl(current.url()))) {''')

p = Path(keeper)
text = p.read_text()
start = text.index('  async touchAuthenticatedSession(\n')
end = text.index('  async refreshAuthenticatedSessionIfDue()', start)
text = text[:start] + '''  private reportProbe(outcome: SessionTouchOutcome, value?: unknown): void {
    const record = typeof value === "object" && value !== null
      ? value as Record<string, unknown> : undefined;
    // Only fixed categories and an HTTP status are allowed into diagnostics.
    const reasons = ["verified", "http_401", "auth_redirect", "http_error",
      "unexpected_content_type", "invalid_json", "invalid_collection",
      "network_or_timeout", "evaluation_failed", "renderer_timeout", "adapter_result"];
    const reason = typeof record?.reason === "string" && reasons.includes(record.reason)
      ? record.reason : "adapter_result";
    const status = typeof record?.status === "number" && Number.isInteger(record.status) &&
      record.status >= 100 && record.status <= 599 ? record.status : undefined;
    try {
      this.#onSessionProbe?.({ outcome, reason, ...(status === undefined ? {} : { status }) });
    } catch { /* Diagnostics cannot change authentication. */ }
  }

  async touchAuthenticatedSession(
    timeoutMs = SESSION_TOUCH_TIMEOUT_MS
  ): Promise<SessionTouchOutcome> {
    const keeper = this.currentKeeper() ?? await this.reconcileRestoredPages();
    if (!keeper) return "failed";
    const url = keeper.url();
    if (isSamsungLoginUrl(url)) {
      this.observeSessionTouchOutcome("reauth", url);
      return "reauth";
    }
    if (!isKeeperSettledUrl(url) || !keeper.evaluate) return "failed";
    const running = this.#touchInFlight;
    if (running?.page === keeper && running.url === url) return running.result;
    const timeout = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.min(SESSION_TOUCH_TIMEOUT_MS, Math.floor(timeoutMs))) : SESSION_TOUCH_TIMEOUT_MS;
    const generation = this.#touchGeneration;
    const flight = { page: keeper, url, result: Promise.resolve("failed" as SessionTouchOutcome) };
    this.#touchInFlight = flight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Keep the evaluate lease after a renderer timeout until it actually settles.
    const operation = Promise.resolve().then(() => keeper.evaluate!<
      SessionProbeDiagnostic | SessionTouchOutcome, { path: string; authPath: string; timeout: number }
    >(
      async ({ path, authPath, timeout }) => {
        const request = async (target: string, budget: number, verify: boolean): Promise<SessionProbeDiagnostic> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), budget);
          try {
            // api-free-audit: authenticated-page-same-origin-read-only-session-touch
            const response = await fetch(target, {
              cache: "no-store", credentials: "same-origin", method: "GET",
              redirect: "manual", signal: controller.signal
            });
            const status = response.status;
            if (status === 401) return { outcome: "reauth", reason: "http_401", status };
            if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
              return { outcome: "reauth", reason: "auth_redirect", status };
            }
            if (!response.ok) return { outcome: "failed", reason: "http_error", status };
            if (!verify) {
              await response.body?.cancel().catch(() => undefined);
              return { outcome: "ok", reason: "verified", status };
            }
            if (!/^application\\/(?:[a-z0-9.+-]+\\+)?json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
              await response.body?.cancel().catch(() => undefined);
              return { outcome: "failed", reason: "unexpected_content_type", status };
            }
            let value: unknown;
            try { value = await response.json(); }
            catch { return { outcome: "failed", reason: "invalid_json", status }; }
            const record = typeof value === "object" && value !== null && !Array.isArray(value)
              ? value as Record<string, unknown> : undefined;
            const rows = Array.isArray(value) ? value :
              ["items", "locations", "data", "results"].map((key) => record?.[key]).find(Array.isArray);
            if (!Array.isArray(rows) || (record && (record.error || record.errors))) {
              return { outcome: "failed", reason: "invalid_collection", status };
            }
            const valid = rows.every((row: unknown) => {
              if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
              const item = row as Record<string, unknown>;
              const id = item.locationId ?? item.id;
              return typeof id === "string" && id.length > 0 && id.length <= 512 && !/[\\u0000-\\u001f\\u007f]/u.test(id);
            });
            return { outcome: valid ? "ok" : "failed", reason: valid ? "verified" : "invalid_collection", status };
          } catch { return { outcome: "failed", reason: "network_or_timeout" }; }
          finally { controller.abort(); clearTimeout(timer); }
        };
        const pageBudget = Math.max(1, Math.min(3_000, Math.floor(timeout / 4)));
        await request(path, pageBudget, false);
        return request(authPath, Math.max(1, timeout - pageBudget), true);
      }, { path: SESSION_TOUCH_PATH, authPath: SESSION_TOUCH_AUTH_PATH, timeout }
    )).catch(() => ({ outcome: "failed", reason: "evaluation_failed" } as const)).finally(() => {
      if (this.#touchInFlight === flight) this.#touchInFlight = undefined;
    });
    flight.result = Promise.race([
      operation,
      new Promise<SessionProbeDiagnostic>((resolve) => {
        timer = setTimeout(() => resolve({ outcome: "failed", reason: "renderer_timeout" }), timeout + 1_000);
        timer.unref?.();
      })
    ]).then((value) => {
      if (generation !== this.#touchGeneration || this.currentKeeper() !== keeper || keeper.isClosed() || keeper.url() !== url) return "stale";
      const outcome = typeof value === "string" ? value : value?.outcome;
      const result: SessionTouchOutcome = outcome === "ok" || outcome === "reauth" ? outcome : "failed";
      this.reportProbe(result, value);
      this.observeSessionTouchOutcome(result, url);
      return result;
    }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    return flight.result;
  }

''' + text[end:]
# All three separate-tab probes must allow client-side SSO redirects to settle.
anchor = '      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });'
assert text.count(anchor) == 3
text = text.replace(anchor, anchor + '\n      await waitForSettledKeeperPage(probe);')
text = text.replace('{ canNavigate: () => false }', '{ canNavigate: () => false, onSessionProbe: this.#onSessionProbe }')
text = text.replace('const verifier = new KeeperPageManager({ pages: () => [candidate], newPage: async () => candidate });', 'const verifier = new KeeperPageManager({ pages: () => [candidate], newPage: async () => candidate }, { onSessionProbe: this.#onSessionProbe });')
marker = 'function validDelay(value: number | undefined, fallback: number): number {'
assert text.count(marker) == 1
text = text.replace(marker, '''/** A DOMContentLoaded on Samsung Account can be an intermediate SSO page.
 * Wait for the final SmartThings URL; never submit or replace a sign-in form.
 * A timeout is not evidence of server-enforced expiry or an MFA requirement.
 */
export async function waitForSettledKeeperPage(
  page: BrowserPageLike,
  timeoutMs = 20_000
): Promise<boolean> {
  if (page.isClosed()) return false;
  if (isKeeperSettledUrl(page.url())) return true;
  if (!page.waitForURL) return false;
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(20_000, timeoutMs)) : 20_000;
  try {
    await page.waitForURL((url) => isKeeperSettledUrl(url.toString()), {
      waitUntil: "domcontentloaded", timeout
    });
  } catch { /* Preserve the current page for recovery or user interaction. */ }
  return !page.isClosed() && isKeeperSettledUrl(page.url());
}

''' + marker)
p.write_text(text)

Path('bridge/src/browser/session-maintenance.ts').write_text('''/** Coalesce the entire maintenance transaction, not only its individual steps.
 * No backlog is accumulated while a slow SSO redirect or browser call is pending.
 */
export class SessionMaintenanceGate {
  #pending: Promise<void> | undefined;

  isRunning(): boolean { return this.#pending !== undefined; }

  run(operation: () => Promise<void>): Promise<void> {
    if (this.#pending) return this.#pending;
    const pending = Promise.resolve().then(operation).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }
}
''')

storage = 'bridge/src/security/session-state.ts'
edit(storage, 'export type SessionStorageRestoreMode', '''/** Only a genuinely empty profile may be replaced with an older backup.
 * Unknown/corrupt state fails closed; it is not proof that a profile is empty.
 */
export function isEmptySessionStorageState(value: unknown): boolean {
  const state = normalizeSessionStorageState(value);
  if (!state || state.cookies.length !== 0) return false;
  return state.origins.every((origin) => {
    const record = origin as Record<string, unknown>;
    return ["localStorage", "indexedDB"].every((key) =>
      record[key] === undefined || (Array.isArray(record[key]) && record[key].length === 0)
    );
  });
}

export type SessionStorageRestoreMode''')

runtime = 'bridge/src/runtime.ts'
edit(runtime, '  fetchAdvancedDeviceSnapshots\n', '  fetchAdvancedDeviceSnapshots,\n  waitForSettledKeeperPage\n')
edit(runtime, 'import { BrowserSupervisor }', 'import { SessionMaintenanceGate } from "./browser/session-maintenance.js";\nimport { BrowserSupervisor }')
edit(runtime, 'import { EncryptedSessionStateStore, restoreSessionStorageState }', 'import { EncryptedSessionStateStore, restoreSessionStorageState, isEmptySessionStorageState }')
edit(runtime, '  const keeperInterval = setInterval(() => {\n    const snapshot', '''  const sessionMaintenance = new SessionMaintenanceGate();
  const keeperInterval = setInterval(() => {
    if (stopped || sessionMaintenance.isRunning()) return;
    const snapshot''')
p = Path(runtime)
text = p.read_text()
start = text.index('    // Serial maintenance avoids')
end = text.index('  }, deps.config.heartbeatIntervalMs);', start)
text = text[:start] + '''    void sessionMaintenance.run(async () => {
      if (stopped) return;
      await reconcileActiveKeeper();
      if (stopped) return;
      await touchAuthenticatedSessionIfDue();
      const manager = currentKeeperManager;
      const context = currentContext;
      const generation = activeContextGeneration;
      if (stopped || !manager || !context) return;
      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&
          !stopped && generation === activeContextGeneration &&
          manager === currentKeeperManager && context === currentContext) {
        await persistSessionStateIfHealthy(context, sessionStateStore, status, log, "proactive_refresh");
      }
    }).catch(() => { log.warn("session_maintenance_failed"); });
''' + text[end:]
start = text.index('      let effectiveOutcome = outcome;')
end = text.index('      const finished = Date.now();', start)
text = text[:start] + '''      const effectiveOutcome = outcome;
      // A live 401 must use the current profile's SSO flow. Replacing shared
      // storage here could roll back freshly rotated cookies in other tabs.
      const sessionStateRecovered = false;
''' + text[end:]
text = re.sub(r'^.*sessionStateRecoveryAttemptAtMs.*\n', '', text, flags=re.M)
start = text.index('async function restorePersistedSessionIfAvailable(')
end = text.index('async function persistSessionStateIfHealthy(', start)
text = text[:start] + '''async function restorePersistedSessionIfAvailable(
  context: ObservableContext,
  store: EncryptedSessionStateStore,
  log: BridgeRuntimeLog
): Promise<BrowserPageLike | undefined> {
  const state = store.load();
  if (!state || (state.cookies.length === 0 && state.origins.length === 0)) return undefined;
  // Startup-only disaster recovery. Existing tabs/profile state always win over
  // a backup; especially preserve the current Samsung sign-in/challenge state.
  const pages = context.pages().filter((page) => !page.isClosed());
  if (pages.some((page) => page.url() !== "about:blank")) return undefined;
  let page: BrowserPageLike | undefined;
  let created = false;
  try {
    if (!context.storageState) return undefined;
    const currentState = await context.storageState({ indexedDB: true });
    if (!isEmptySessionStorageState(currentState)) {
      log.info("session_state_restore_skipped:profile_present");
      return undefined;
    }
    if (context.pages().some((candidate) => !candidate.isClosed() && candidate.url() !== "about:blank")) return undefined;
    page = pages.find((candidate) => !candidate.isClosed() && candidate.url() === "about:blank");
    if (!page) { page = await context.newPage(); created = true; }
    const restoreMode = await restoreSessionStorageState(context, state);
    if (restoreMode === "legacy" && state.cookies.length > 0) {
      if (!context.addCookies) throw new Error("session_state_restore_unavailable");
      // api-free-audit: encrypted-session-restore
      await context.addCookies(state.cookies);
    }
    await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 12_000 });
    if (!(await waitForSettledKeeperPage(page))) throw new Error("session_state_restore_not_settled");
    if (restoreMode === "legacy" && page.evaluate && state.origins.length > 0) {
      await page.evaluate((origins: unknown[]) => {
        for (const origin of origins) {
          if (typeof origin !== "object" || origin === null || Array.isArray(origin)) continue;
          const record = origin as Record<string, unknown>;
          if (record.origin !== location.origin || !Array.isArray(record.localStorage)) continue;
          for (const entry of record.localStorage) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
            const item = entry as Record<string, unknown>;
            if (typeof item.name === "string" && typeof item.value === "string") {
              window.localStorage.setItem(item.name, item.value);
            }
          }
        }
      }, state.origins);
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 12_000 });
      if (!(await waitForSettledKeeperPage(page))) throw new Error("session_state_restore_not_settled");
    }
    const candidate = page;
    const verifier = new KeeperPageManager({ pages: () => [candidate], newPage: async () => candidate }, {
      canNavigate: () => false,
      onSessionProbe: (diagnostic) => log.info(`session_probe:${JSON.stringify(diagnostic)}`)
    });
    await verifier.reconcileRestoredPages();
    if (await verifier.touchAuthenticatedSession() !== "ok") throw new Error("session_state_restore_not_verified");
    log.info("session_state_restored");
    return page;
  } catch {
    if (created) await page?.close().catch(() => undefined);
    log.warn("session_state_restore_failed");
    return undefined;
  }
}

''' + text[end:]
needle = '          onRecovery: (phase) => log.info(`session_recovery:${JSON.stringify({ phase })}`),'
assert text.count(needle) == 1
text = text.replace(needle, needle + '\n          onSessionProbe: (diagnostic) => log.info(`session_probe:${JSON.stringify(diagnostic)}`),')
needle = '    const state = await context.storageState({ indexedDB: true });\n    store.save(state);'
assert text.count(needle) == 1
text = text.replace(needle, '''    const state = await context.storageState({ indexedDB: true });
    const latest = status.getSnapshot();
    if (!latest.authenticated || latest.sessionTouchLastOutcome !== "ok") return;
    store.save(state);''')
p.write_text(text)

# Preserve all non-version expectations and the existing protocol 5 contract.
for path in ['package.json', 'package-lock.json', 'protocol/version.json',
             'custom_components/smartthings_web/manifest.json',
             'addon/smartthings_web_bridge/config.yaml', 'bridge/src/runtime.ts',
             'tests/addon-config.test.ts', 'tests/protocol-version-contract.test.ts',
             'bridge/tests/runtime.test.ts']:
    p = Path(path)
    text = p.read_text()
    assert '1.8.39' in text, path
    p.write_text(text.replace('1.8.39', '1.8.40'))

notes = '''## 1.8.40

- v1.8.39 이후 로그인 유지 재발 보고에 따라 코드에서 확인한 세 가지 결함을 수정합니다. 이번 재발 시점의 새 운영 로그는 확보되지 않았으므로 실제 발생 원인이나 무중단 장기 유지를 검증했다고 주장하지 않습니다.
- 실행 중 401/인증 리다이렉트에 대해 과거 백업을 `setStorageState()`로 덮어쓰던 경로를 제거합니다. 이 메서드는 현재 쿠키·localStorage·IndexedDB를 먼저 지우므로 다른 탭에서 갱신한 인증 정보를 과거로 되돌릴 수 있었습니다. 실행 중에는 현재 persistent profile의 정상 SSO를 사용하고, 백업 전체 복원은 기존 탭과 저장 상태가 없는 빈 프로필의 시작 시점으로 제한합니다. 기존 프로필·설정·엔티티를 삭제하지 않습니다.
- 선제 갱신·로그인 복구·Samsung SSO 복구 탭에서 DOMContentLoaded 직후 실패로 끝내지 않고 최종 SmartThings 위치 URL까지 최대 20초 대기합니다. 이동 완료 후에도 보호된 조회를 통과해야 성공입니다. `sso_login_required`는 여전히 로그인 화면에 있다는 의미이며 서버 강제 만료나 MFA를 확정하는 증거가 아닙니다.
- heartbeat마다 시작되는 유지 작업 전체에 single-flight 잠금을 적용해 느린 복구 도중 다음 유지 작업이 겹치거나 대기열에 쌓이지 않게 합니다. 선제 갱신/인증 복구 중에는 소켓 재연결의 keeper 재탐색도 연기합니다.
- `session_probe` 로그에 401, 리다이렉트, 403/429/5xx, HTML 응답, JSON/스키마 오류, 네트워크·렌더러 시간초과를 구분하는 고정 원인과 HTTP 상태만 남깁니다. 쿠키·토큰·본문·계정 식별자는 기록하지 않으며 403/429/네트워크 실패를 로그아웃으로 판정하지 않습니다.
- 기존 기기 제어·명령 중복 방지·protocol 5·암호화 백업 형식은 유지합니다. 적용 대상은 Bridge 앱이며 HACS 통합만 갱신해서는 브라우저 코드가 바뀌지 않습니다.

'''
for path in ['CHANGELOG.md', 'addon/smartthings_web_bridge/CHANGELOG.md']:
    p = Path(path)
    p.write_text(notes + p.read_text())

Path('bridge/tests/browser/session-lifecycle.test.ts').write_text('''import { afterEach, describe, expect, test, vi } from "vitest";
import { KeeperPageManager, KEEPER_URL, SESSION_TOUCH_AUTH_PATH, waitForSettledKeeperPage, type BrowserPageLike } from "../../src/browser/keeper-page.js";
import { SessionMaintenanceGate } from "../../src/browser/session-maintenance.js";
import { isEmptySessionStorageState } from "../../src/security/session-state.js";
import { readFileSync } from "node:fs";

const login = "https://account.samsung.com/accounts/v1/ST/signInGate";
class Page implements BrowserPageLike {
  address = `${KEEPER_URL}/fixture`;
  closed = false;
  url = () => this.address;
  isClosed = () => this.closed;
  goto = vi.fn(async (url: string) => { this.address = url; });
  close = vi.fn(async () => { this.closed = true; });
  evaluate = vi.fn(async (_fn: any, _arg: any): Promise<any> => "ok");
  waitForURL = vi.fn(async (predicate: (url: URL) => boolean, _options?: { timeout?: number }) => {
    this.address = `${KEEPER_URL}/fixture`;
    expect(predicate(new URL(this.address))).toBe(true);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("session lifecycle regressions", () => {
  test("waits through an intermediate Samsung SSO page without navigating it again", async () => {
    const page = new Page(); page.address = login;
    expect(await waitForSettledKeeperPage(page)).toBe(true);
    expect(page.waitForURL).toHaveBeenCalledOnce();
    expect(page.goto).not.toHaveBeenCalled(); expect(page.close).not.toHaveBeenCalled();
  });
  test("a redirect timeout preserves the sign-in page and is not verified authentication", async () => {
    const page = new Page(); page.address = login;
    page.waitForURL.mockRejectedValue(new Error("synthetic timeout"));
    expect(await waitForSettledKeeperPage(page, Number.POSITIVE_INFINITY)).toBe(false);
    expect(page.waitForURL.mock.calls[0]![1]?.timeout).toBe(20_000);
    expect(page.close).not.toHaveBeenCalled(); expect(page.goto).not.toHaveBeenCalled();
  });
  test("a closed redirect target is never accepted", async () => {
    const page = new Page(); page.closed = true;
    expect(await waitForSettledKeeperPage(page)).toBe(false);
    expect(page.waitForURL).not.toHaveBeenCalled();
  });
  test("a delayed SSO redirect is verified and promoted instead of closed as login_required", async () => {
    let now = 1_000;
    const original = new Page(), candidate = new Page();
    const pages = [original]; const phases = vi.fn();
    const manager = new KeeperPageManager({ pages: () => pages, newPage: async () => { pages.push(candidate); return candidate; } }, { now: () => now, onRecovery: phases });
    await manager.ensureKeeper(); await manager.touchAuthenticatedSession();
    original.address = login; await manager.ensureKeeper(); now += 30_001;
    candidate.goto.mockImplementation(async () => { candidate.address = login; });
    expect(await manager.ensureKeeper()).toBe(candidate);
    expect(candidate.waitForURL).toHaveBeenCalledOnce();
    expect(candidate.evaluate).toHaveBeenCalledOnce();
    expect(candidate.close).not.toHaveBeenCalled();
    expect(phases).toHaveBeenCalledWith("verified");
    expect(phases).not.toHaveBeenCalledWith("login_required");
  });
  test("proactive refresh waits for SSO and does not replace the healthy keeper", async () => {
    let now = 1_000;
    const original = new Page(), candidate = new Page();
    const manager = new KeeperPageManager({ pages: () => [original], newPage: async () => candidate }, { now: () => now, proactiveRefreshIntervalMs: 10 });
    await manager.ensureKeeper(); await manager.touchAuthenticatedSession(); now += 11;
    candidate.goto.mockImplementation(async () => { candidate.address = login; });
    expect(await manager.refreshAuthenticatedSessionIfDue()).toBe("verified");
    expect(candidate.waitForURL).toHaveBeenCalledOnce();
    expect(manager.currentKeeper()).toBe(original);
    expect(original.close).not.toHaveBeenCalled(); expect(candidate.close).toHaveBeenCalledOnce();
  });
  test("all maintenance stages share one lease and do not build a backlog", async () => {
    const gate = new SessionMaintenanceGate(); let release!: () => void;
    const task = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const first = gate.run(task);
    expect(gate.isRunning()).toBe(true);
    const repeats = Array.from({ length: 100 }, () => gate.run(task));
    expect(repeats.every(value => value === first)).toBe(true);
    await Promise.resolve(); expect(task).toHaveBeenCalledOnce(); release();
    await first; expect(gate.isRunning()).toBe(false);
    await gate.run(async () => undefined); expect(task).toHaveBeenCalledOnce();
  });
  test("a failed maintenance stage releases the lease for the next attempt", async () => {
    const gate = new SessionMaintenanceGate();
    await expect(gate.run(async () => { throw new Error("synthetic"); })).rejects.toThrow("synthetic");
    expect(gate.isRunning()).toBe(false);
    await gate.run(async () => undefined); expect(gate.isRunning()).toBe(false);
  });
  test.each([
    { cookies: [{ name: "rotated", value: "never-overwrite" }], origins: [] },
    { cookies: [], origins: [{ origin: "https://my.smartthings.com", localStorage: [{ name: "auth", value: "current" }] }] },
    { cookies: [], origins: [{ origin: "https://my.smartthings.com", indexedDB: [{ name: "current-db" }] }] },
    { cookies: [], origins: [{ indexedDB: "invalid" }] },
    null,
    {}
  ])("does not replace a nonempty or unknown profile with an old backup", value => {
    expect(isEmptySessionStorageState(value)).toBe(false);
  });
  test("an actually empty profile remains eligible for startup backup recovery", () => {
    expect(isEmptySessionStorageState({ cookies: [], origins: [] })).toBe(true);
  });
  test("live runtime no longer calls the destructive forced backup restore", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).not.toContain("recoverWithPersistedSession");
    expect(runtime).toContain("if (!isEmptySessionStorageState(currentState))");
    expect(runtime).toContain("sessionMaintenance.isRunning()");
  });
  test.each([401, 403, 429, 503])("diagnostics distinguish protected HTTP %i without emitting response data", async status => {
    const page = new Page(); const diagnostic = vi.fn();
    page.evaluate.mockImplementation(async (fn: any, arg: any) => fn(arg));
    vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify({ secret: "not-for-logs" }), {
      status: path === SESSION_TOUCH_AUTH_PATH ? status : 200,
      headers: { "content-type": "application/json" }
    })));
    const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => page }, { onSessionProbe: diagnostic });
    await manager.ensureKeeper();
    expect(await manager.touchAuthenticatedSession()).toBe(status === 401 ? "reauth" : "failed");
    expect(diagnostic).toHaveBeenCalledWith({ outcome: status === 401 ? "reauth" : "failed", reason: status === 401 ? "http_401" : "http_error", status });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("not-for-logs");
  });
  test("diagnostics distinguish an HTML shell without calling it confirmed server logout", async () => {
    const page = new Page(); const diagnostic = vi.fn();
    page.evaluate.mockImplementation(async (fn: any, arg: any) => fn(arg));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private-body", { headers: { "content-type": "text/html" } })));
    const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => page }, { onSessionProbe: diagnostic });
    await manager.ensureKeeper(); expect(await manager.touchAuthenticatedSession()).toBe("failed");
    expect(diagnostic).toHaveBeenCalledWith({ outcome: "failed", reason: "unexpected_content_type", status: 200 });
    expect(manager.authenticationRecoveryPending()).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-body");
  });
});
''')
print('Session lifecycle 1.8.40 patch applied')
