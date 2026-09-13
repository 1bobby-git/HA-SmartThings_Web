from pathlib import Path

def replace(path, old, new, count=1):
    p=Path(path); t=p.read_text(); assert t.count(old)==count,(path,t.count(old));p.write_text(t.replace(old,new))
replace('bridge/tests/runtime.test.ts', '    this.evaluateCalls.push([pageFunction, argument]);', '''    if (typeof argument === "object" && argument !== null &&
        typeof (argument as { id?: unknown }).id === "string" &&
        typeof (argument as { budget?: unknown }).budget === "number") {
      this.applicationProbeCalls.push(argument);
      return this.applicationProbeOutcome;
    }
    this.evaluateCalls.push([pageFunction, argument]);''')
replace('bridge/tests/runtime.test.ts','  readonly evaluateCalls: unknown[][] = [];','''  readonly applicationProbeCalls: unknown[] = [];
  applicationProbeOutcome = { outcome: "ok", reason: "verified" };
  readonly evaluateCalls: unknown[][] = [];''')
replace('bridge/tests/runtime.test.ts','    expect(keeper.evaluateCalls[0]?.[1]).toMatchObject({ path: "/location" });','''    expect(keeper.evaluateCalls[0]?.[1]).toMatchObject({ path: "/location" });
    expect(keeper.applicationProbeCalls).toEqual([{ id: "loc-synthetic-001", budget: 10_000 }]);''')
replace('bridge/tests/runtime.test.ts','  test("reauth recovery verifies the protected endpoint again before permitting authentication", async () => {', '''  test("Advanced success cannot hide the native application's authentication rejection", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const keeper = new FakePage("https://my.smartthings.com/location/loc-synthetic-001");
    keeper.applicationProbeOutcome = { outcome: "reauth", reason: "http_401" };
    const root = createTempRoot();
    const runtime = await createBridgeRuntime(createDeps(root, {
      chromium: { launchPersistentContext: vi.fn(async () => new FakeContext([keeper])) },
      config: { dataDir: root, host: "127.0.0.1", port: 0, browserMaxRestarts: 0, heartbeatIntervalMs: 1_000, browserRetryDelayMs: 0 }
    }));
    runtimes.push(runtime); await runtime.browserStartup;
    runtime.status.update({ authenticated: true, keeperPresent: true, state: "STALE" });
    await vi.advanceTimersByTimeAsync(301_000);
    expect(keeper.sessionTouchOutcome).toBe("ok");
    expect(keeper.applicationProbeCalls).toHaveLength(1);
    expect(runtime.status.getSnapshot()).toMatchObject({ authenticated: false, sessionTouchLastOutcome: "reauth" });
  });

  test("reauth recovery verifies the protected endpoint again before permitting authentication", async () => {''')
replace('bridge/tests/browser/session-lifecycle.test.ts', '    expect(candidate.waitForURL).toHaveBeenCalledTimes(2);', '''    expect(candidate.goto).toHaveBeenCalledExactlyOnceWith(`${KEEPER_URL}/fixture`, { waitUntil: "domcontentloaded", timeout: 10_000 });
    expect(candidate.waitForURL).toHaveBeenCalledOnce();''')
replace('tools/ci-session-continuity-smoke.mjs', 'let completedRelayPages = 0;', 'let completedRelayPages = 0;\nlet relayDelayMs = 250;')
replace('tools/ci-session-continuity-smoke.mjs', '''        '<!doctype html><title>Fixture SSO relay</title><script>setTimeout(() => location.replace("https://my.smartthings.com/location/fixture-home"), 250);</script>' });''', '''        `<!doctype html><title>Fixture SSO relay</title><script>setTimeout(() => location.replace("https://my.smartthings.com/location/fixture-home"), ${relayDelayMs});</script>` });''')
replace('tools/ci-session-continuity-smoke.mjs', '''  await freshDocument.goto('https://account.samsung.com/accounts/v1/ST/signInGate');''', '''  // Regression: the same SSO document must survive beyond the old 20s cutoff.
  const longPhases = [];
  const longKeeper = new KeeperPageManager(managedContext(), {
    now: () => clock, onRecovery: phase => longPhases.push(phase),
    probeApplicationSession: (candidate, target) => verifyLocationApplicationSession(candidate, target),
    verifyRefreshCandidate: async (candidate, target) => (await verifyLocationApplicationSession(candidate, target)).outcome === 'ok'
  });
  await longKeeper.reconcileRestoredPages();
  assert.equal(await longKeeper.touchAuthenticatedSession(), 'ok');
  await freshDocument.goto('https://account.samsung.com/accounts/v1/ST/signInGate');
  await freshDocument.setContent('<p>Authorization processing</p>');
  await longKeeper.ensureKeeper(); clock += 30_001;
  delayedRedirectsRemaining = 1; relayDelayMs = 25_000;
  const relaysBefore = completedRelayPages;
  assert.equal(await longKeeper.ensureKeeper(), freshDocument);
  assert.ok(longPhases.includes('login_page_pending'));
  assert.equal(context.pages().length, 2);
  const retainedRelay = context.pages().find(candidate => candidate !== freshDocument);
  assert.equal(retainedRelay.url(), 'https://account.samsung.com/fixture-relay');
  await longKeeper.ensureKeeper();
  assert.equal(completedRelayPages, relaysBefore + 1);
  assert.equal(retainedRelay.isClosed(), false);
  await retainedRelay.waitForURL(`${KEEPER_URL}/fixture-home`, { timeout: 15_000 });
  assert.equal(await longKeeper.ensureKeeper(), retainedRelay);
  assert.equal(freshDocument.isClosed(), true);
  assert.equal(context.pages().length, 1);
  assert.equal(longKeeper.authenticationRecoveryPending(), false);
  relayDelayMs = 250;
  const diagnosticPage = retainedRelay;
  console.log('PASS real 25-second relay: one authorization page retained past 20-second wait, verified and promoted, no competing SSO attempt');
  await diagnosticPage.goto('https://account.samsung.com/accounts/v1/ST/signInGate');''')
p=Path('tools/ci-session-continuity-smoke.mjs');t=p.read_text();a,b=t.split('  const diagnosticPage = retainedRelay;',1);b=b.replace('freshDocument.', 'diagnosticPage.').replace('inspectAuthenticationPage(freshDocument)', 'inspectAuthenticationPage(diagnosticPage)');p.write_text(a+'  const diagnosticPage = retainedRelay;'+b)
