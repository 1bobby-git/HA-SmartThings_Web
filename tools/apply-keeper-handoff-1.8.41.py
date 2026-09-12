from pathlib import Path


def edit(path, old, new, count=1):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != count:
        raise SystemExit(f'{path}: expected {count} anchors, got {text.count(old)}: {old[:90]!r}')
    p.write_text(text.replace(old, new))


keeper = 'bridge/src/browser/keeper-page.ts'
edit(keeper, 'export interface KeeperPageManagerOptions {', '''export interface KeeperPageManagerOptions {
  verifyRefreshCandidate?: (page: BrowserPageLike, expectedUrl: string) => Promise<boolean>;
  onLoginPage?: (page: BrowserPageLike, stage: "refresh" | "recovery" | "sso") => Promise<void>;''')
edit(keeper, '    | "refresh_verified"', '    | "refresh_verified"\n    | "refresh_handoff_verified"')
edit(keeper, '  readonly #onSessionProbe: KeeperPageManagerOptions["onSessionProbe"];', '''  readonly #onSessionProbe: KeeperPageManagerOptions["onSessionProbe"];
  readonly #verifyRefreshCandidate: KeeperPageManagerOptions["verifyRefreshCandidate"];
  readonly #onLoginPage: KeeperPageManagerOptions["onLoginPage"];''')
edit(keeper, '    this.#onSessionProbe = options.onSessionProbe;', '''    this.#onSessionProbe = options.onSessionProbe;
    this.#verifyRefreshCandidate = options.verifyRefreshCandidate;
    this.#onLoginPage = options.onLoginPage;''')
edit(keeper, '  authenticationRecoveryPending(): boolean {', '''  private async recordLoginPage(page: BrowserPageLike, stage: "refresh" | "recovery" | "sso"): Promise<void> {
    try { await this.#onLoginPage?.(page, stage); } catch { /* Diagnostic only. */ }
  }

  authenticationRecoveryPending(): boolean {''')
edit(keeper, '''      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitForSettledKeeperPage(probe);
      if (isSamsungLoginUrl(probe.url())) {
        this.recoveryDiagnostic("refresh_login_required");''', '''      const target = this.#verifyRefreshCandidate && isConcreteLocationUrl(expectedUrl) ? expectedUrl : KEEPER_URL;
      await probe.goto(target, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitForSettledKeeperPage(probe);
      if (isSamsungLoginUrl(probe.url())) {
        await this.recordLoginPage(probe, "refresh");
        this.recoveryDiagnostic("refresh_login_required");''')
edit(keeper, '''      this.#lastProactiveRefreshAtMs = this.#now();
      this.#lastProactiveRefreshAttemptAtMs = undefined;''', '''      if (this.#verifyRefreshCandidate) {
        // The fresh app has its own in-memory auth lifecycle. Verify its native
        // Location connection, then keep THAT document running instead of
        // discarding it and leaving the old keeper's stale timers/client alive.
        if (!(await this.#verifyRefreshCandidate(candidate, expectedUrl))) {
          this.recoveryDiagnostic("refresh_failed");
          return "failed";
        }
        if (!this.#canNavigate() || this.currentKeeper() !== expectedKeeper ||
            expectedKeeper.isClosed() || expectedKeeper.url() !== expectedUrl ||
            candidate.isClosed() || !isKeeperSettledUrl(candidate.url())) {
          this.recoveryDiagnostic("refresh_stale");
          return "stale";
        }
        if (!(await this.promoteVerifiedKeeper(candidate))) {
          this.recoveryDiagnostic("refresh_stale");
          return "stale";
        }
        probe = undefined;
        this.recoveryDiagnostic("refresh_handoff_verified");
      }
      this.#lastProactiveRefreshAtMs = this.#now();
      this.#lastProactiveRefreshAttemptAtMs = undefined;''')
edit(keeper, '''      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic(isSamsungLoginUrl(probe.url()) ? "login_required" : "failed");''', '''      if (!isKeeperSettledUrl(probe.url())) {
        await this.recordLoginPage(probe, "recovery");
        this.recoveryDiagnostic(isSamsungLoginUrl(probe.url()) ? "login_required" : "failed");''')
edit(keeper, '''      if (isSamsungLoginUrl(probe.url())) {
        if (''', '''      if (isSamsungLoginUrl(probe.url())) {
        await this.recordLoginPage(probe, "sso");
        if (''')
# Retain ownership hygiene for unsuccessful login recovery tabs.
edit(keeper, '''    } finally {
      await probe?.close().catch(() => undefined);
    }
  }

  private observeSessionTouchOutcome''', '''    } finally {
      if (probe) this.#commandPages.delete(probe);
      await probe?.close().catch(() => undefined);
    }
  }

  private observeSessionTouchOutcome''')

runtime = 'bridge/src/runtime.ts'
edit(runtime, 'import { SessionMaintenanceGate }', 'import { verifyLocationApplicationSession, inspectAuthenticationPage } from "./browser/session-application-proof.js";\nimport { SessionMaintenanceGate }')
edit(runtime, '''          onRecovery: (phase) => log.info(`session_recovery:${JSON.stringify({ phase })}`),''', '''          verifyRefreshCandidate: async (candidate, target) => {
            const proof = await verifyLocationApplicationSession(candidate, target);
            log.info(`session_application_probe:${JSON.stringify(proof)}`);
            return proof.outcome === "ok";
          },
          onLoginPage: async (page, stage) => {
            const diagnostic = await inspectAuthenticationPage(page);
            log.info(`session_login_page:${JSON.stringify({ stage, ...diagnostic })}`);
          },
          onRecovery: (phase) => log.info(`session_recovery:${JSON.stringify({ phase })}`),''')
edit(runtime, '''      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&''', '''      const beforeRefresh = manager.currentKeeper();
      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&''')
edit(runtime, '''        await persistSessionStateIfHealthy(context, sessionStateStore, status, log, "proactive_refresh");''', '''        await reconcileActiveKeeper();
        await persistSessionStateIfHealthy(context, sessionStateStore, status, log, "proactive_refresh");
        if (beforeRefresh !== manager.currentKeeper()) {
          void reconciliation.request("reconnect").catch(() => log.warn("session_handoff_inventory_sync_failed"));
        }''')

for name in ['package.json', 'package-lock.json', 'protocol/version.json',
             'custom_components/smartthings_web/manifest.json',
             'addon/smartthings_web_bridge/config.yaml', 'bridge/src/runtime.ts',
             'tests/addon-config.test.ts', 'tests/protocol-version-contract.test.ts',
             'bridge/tests/runtime.test.ts']:
    p = Path(name)
    text = p.read_text()
    if '1.8.40' not in text:
        raise SystemExit(f'missing release anchor: {name}')
    p.write_text(text.replace('1.8.40', '1.8.41'))

notes = '''## 1.8.41

- 사용자 로그의 `session_probe:ok`, `refresh_verified` 뒤 `attempt -> login_required` 반복을 기준으로 선제 갱신을 재설계합니다. 단순 Advanced HTTP 200과 실행 중인 Location 웹앱 연결의 인증 상태를 분리합니다. 로그에는 이번 실패의 서버 측 원인이나 구체적인 로그인 폼이 없으므로 강제 만료/MFA로 단정하지 않습니다.
- 실제 Bridge에서는 선제 갱신 탭을 현재 keeper와 같은 구체적인 Location URL로 열고, 기존 Advanced 보호된 조회에 더해 이미 웹앱이 생성한 Cake `api/location.get`의 해당 위치 응답을 검증합니다. 새 인증 클라이언트·토큰 입력·기기 쓰기는 없습니다.
- 두 검증이 모두 성공한 새 문서를 keeper로 승격하고 기존 문서는 닫습니다. 과거처럼 갱신 탭을 버리고 오래된 메모리 인증/타이머를 가진 탭만 계속 쓰지 않습니다. 명령 실행·사용자 이동·다른 위치·검증 실패 시에는 기존 keeper를 보존합니다. 프로필이나 쿠키/스토리지 전체를 덮어쓰지 않습니다.
- 성공 시 `session_application_probe`의 native 검증과 `refresh_handoff_verified`를 구분해 기록합니다. 전환 후 기존 인벤토리 재동기화를 요청하며 기기 제어·protocol 5·엔티티 ID는 유지합니다.
- `session_login_page`는 실제 복구 탭의 페이지 종류와 보이는 표준 비밀번호/일회용 코드/이메일 입력의 존재만 기록합니다. 입력값·계정명·쿠키·토큰·본문·URL 파라미터는 기록하지 않고 폼도 제출하지 않습니다. `no_visible_auth_input`은 인증 요구가 없다는 증거가 아니며 iframe/커스텀 UI를 판독하지 못했을 수 있습니다.
- 실제 삼성 계정에서 장기 로그인 유지나 서버 측 세션 갱신이 보장된다는 의미는 아닙니다. 회귀 테스트/실 Chromium 합성 시험과 사용자 운영 계정의 장기 유지 검증은 구분합니다.

'''
for name in ['CHANGELOG.md', 'addon/smartthings_web_bridge/CHANGELOG.md']:
    p = Path(name)
    p.write_text(notes + p.read_text())
# Enable a real-runtime-equivalent native verifier in the isolated browser test.
smoke = 'tools/ci-session-continuity-smoke.mjs'
edit(smoke, "import { isEmptySessionStorageState }", "import { verifyLocationApplicationSession, inspectAuthenticationPage } from '../dist/bridge/src/browser/session-application-proof.js';\nimport { isEmptySessionStorageState }")
edit(smoke, '''  console.log('PASS session continuity: cookie rotation, persistent session-cookie/localStorage restore, bounded tab count, auth proof and transient failure classification (synthetic only)');''', '''  console.log('PASS session continuity: cookie rotation, persistent session-cookie/localStorage restore, bounded tab count, auth proof and transient failure classification (synthetic only)');

  // Install only a synthetic counterpart of the already-captured native client.
  // Its get() is intentionally separate from the successful Advanced HTTP probe.
  await context.addInitScript(() => {
    const native = { service: name => ({ get: async id => {
      if (name !== 'api/location') throw new Error('unexpected native service');
      if (sessionStorage.getItem('fixture-native-denied') === 'yes') throw { code: 401 };
      return { locationId: id };
    } }) };
    Object.defineProperty(window, Symbol.for('smartthings_web_bridge.cake_client'), { value: native });
  });
  const documentBeforeHandoff = delayedRecovery;
  const handoffPhases = [];
  const handoff = new KeeperPageManager(managedContext(), {
    now: () => clock, proactiveRefreshIntervalMs: 100,
    onRecovery: phase => handoffPhases.push(phase),
    verifyRefreshCandidate: async (candidate, target) =>
      (await verifyLocationApplicationSession(candidate, target)).outcome === 'ok'
  });
  await handoff.reconcileRestoredPages();
  assert.equal(await handoff.touchAuthenticatedSession(), 'ok');
  clock += 101;
  assert.equal(await handoff.refreshAuthenticatedSessionIfDue(), 'verified');
  const freshDocument = handoff.currentKeeper();
  assert.notEqual(freshDocument, documentBeforeHandoff);
  assert.equal(documentBeforeHandoff.isClosed(), true);
  assert.equal(freshDocument.isClosed(), false);
  assert.equal(freshDocument.url(), `${KEEPER_URL}/fixture-home`);
  assert.equal(context.pages().length, 1);
  assert.ok(handoffPhases.includes('refresh_handoff_verified'));
  // Native auth rejection remains a failure even while Advanced HTTP returns 200.
  await freshDocument.evaluate(() => sessionStorage.setItem('fixture-native-denied', 'yes'));
  assert.deepEqual(await verifyLocationApplicationSession(freshDocument, freshDocument.url()), { outcome: 'reauth', reason: 'http_401' });
  await freshDocument.goto('https://account.samsung.com/accounts/v1/ST/signInGate');
  await freshDocument.setContent('<input type="password" value="private-not-logged">');
  assert.deepEqual(await inspectAuthenticationPage(freshDocument), { page: 'samsung_account', surface: 'password_input' });
  await freshDocument.setContent('<input autocomplete="one-time-code" value="private-not-logged">');
  assert.deepEqual(await inspectAuthenticationPage(freshDocument), { page: 'samsung_account', surface: 'otp_input' });
  console.log('PASS verified running-document handoff: actual Chromium page promotion, old document retired, native 401 separated from Advanced 200, password/OTP presence diagnostics (synthetic only)');''')
print('Applied verified keeper handoff 1.8.41')
