from pathlib import Path
p=Path('bridge/src/runtime.ts');s=p.read_text()
old='const observedPolicy = nativePolicyEnabled && !keeperManager.authenticationRecoveryPending()';new='const observedPolicy = nativePolicyEnabled && status.getSnapshot().authenticated && status.getSnapshot().sessionTouchLastOutcome === "ok" && !keeperManager.authenticationRecoveryPending()';assert s.count(old)==1;s=s.replace(old,new)
old='!status.getSnapshot().authenticated || manager.authenticationRecoveryPending()';new='!status.getSnapshot().authenticated || status.getSnapshot().sessionTouchLastOutcome !== "ok" || manager.authenticationRecoveryPending()';assert s.count(old)==2;s=s.replace(old,new)
p.write_text(s)
p=Path('bridge/tests/runtime.test.ts');s=p.read_text()
old='  nativePolicyOn = false;';new='  nativePolicyOn = false;\n  nativePolicyObserved: "on" | "off" | undefined;';assert s.count(old)==1;s=s.replace(old,new)
old='''    if (this.nativePolicyOn && typeof argument === "object" && argument !== null &&''';new='''    if (typeof argument === "object" && argument !== null && (argument as {action?:string}).action === "read" && this.nativePolicyObserved !== undefined) {
      return { result: this.nativePolicyObserved };
    }
    if (this.nativePolicyOn && typeof argument === "object" && argument !== null &&''';assert s.count(old)==1;s=s.replace(old,new)
anchor='  test("recognizes the fallback whole Advanced device snapshot URL", () => {';assert s.count(anchor)==1
s=s.replace(anchor,'''  test("manual native recheck reads the active modal and coalesces closed-modal refresh requests", async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const original = new FakePage("https://my.smartthings.com/location/loc-synthetic-001");
    const context = new FakeContext([original]);
    const createPage = context.newPage.bind(context);
    const newPage = vi.spyOn(context, "newPage").mockImplementation(async () => {
      const page = await createPage(); page.nativePolicyOn = true; return page;
    });
    const deps = createDeps(createTempRoot(), {chromium:{launchPersistentContext:vi.fn(async () => context)}});
    deps.config.keepSignedInEnabled = true;
    const runtime = await createBridgeRuntime(deps);
    runtimes.push(runtime); await runtime.browserStartup;
    const check = () => fetch(`http://127.0.0.1:${runtime.port}/api/v1/native-login-policy/check`, {
      method:"POST",headers:{"content-type":"application/json","x-stw-ui-action":"native-login-policy"},body:"{}"
    });
    // URL-only authentication at startup cannot authorize settings inspection.
    expect((await check()).status).toBe(409);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.status.getSnapshot().sessionTouchLastOutcome).toBe("ok");
    const active = context.pages().find(page => !page.isClosed())!;
    active.goto.mockClear(); active.nativePolicyObserved = "on";
    expect(await (await check()).json()).toEqual({outcome:"observed"});
    expect(runtime.status.getSnapshot()).toMatchObject({authenticated:true,nativeLoginPolicyState:"enabled",nativeLoginPolicyReason:"observed_enabled"});
    expect(active.goto).not.toHaveBeenCalled();
    expect(newPage).toHaveBeenCalledTimes(1);
    active.nativePolicyObserved = "off";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runtime.status.getSnapshot()).toMatchObject({authenticated:true,nativeLoginPolicyState:"attention",nativeLoginPolicyReason:"observed_disabled"});
    expect(active.goto).not.toHaveBeenCalled();
    active.nativePolicyObserved = undefined;
    expect(await (await check()).json()).toEqual({outcome:"queued"});
    expect(await (await check()).json()).toEqual({outcome:"queued"});
    expect(newPage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(newPage).toHaveBeenCalledTimes(2);
    expect(runtime.status.getSnapshot()).toMatchObject({nativeLoginPolicyState:"enabled",nativeLoginPolicyReason:"already_enabled"});
  });

'''+anchor)
p.write_text(s)
p=Path('tools/ci-native-login-policy-smoke.mjs');s=p.read_text()
old='''  for (const p of context.pages()) await p.close();
  page = await context.newPage(); await page.goto(target); await page.evaluate(() => localStorage.clear()); await page.goto(target);'''
new='''  // Headed persistent Chromium exits when its last window is closed. Open
  // the next fixture before retiring the previous pages; this is test setup,
  // not a production session workaround or a retry that hides an assertion.
  const previousPages = context.pages();
  page = await context.newPage();
  for (const previous of previousPages) await previous.close();
  await page.goto(target); await page.evaluate(() => localStorage.clear()); await page.goto(target);'''
assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
