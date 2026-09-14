from pathlib import Path
r=Path('.')
p=r/'bridge/src/state/runtime-state.ts';s=p.read_text().replace('"non_finite" | "string" | "other";', '"non_finite" | "string" | "other" | undefined;');p.write_text(s)
p=r/'bridge/src/browser/native-login-policy.ts';s=p.read_text();s=s.replace('"opener" | "menu" | "on"', '"clear" | "opener" | "menu" | "on"');s=s.replace('  const existingPreference = await readNativeKeepSignedIn(page);','''  try {
    const guard = await bounded(page.evaluate!(inspectLoginSettingsDom, { action: "guard", marker: "", target }), 1_500);
    if (guard.result === "blocked" || guard.result === "ambiguous") return report("attention", guard.reason ?? (guard.result === "ambiguous" ? "ambiguous" : "blocked"), false);
  } catch { return report("attention", "ui_timeout", false); }
  const existingPreference = await readNativeKeepSignedIn(page);''');s=s.replace('action: "opener" | "control" | "read";', 'action: "opener" | "control" | "read" | "guard";');s=s.replace('  const mark = (element: HTMLElement, result: DomProbe)', '  if (action === "guard") return { result: "clear" };\n  const mark = (element: HTMLElement, result: DomProbe)');p.write_text(s)
p=r/'bridge/src/server/status-page.ts';s=p.read_text().replace('    <p>브라우저 종료 후 영구 로그인을 보장하는 설정은 아닙니다.', '    <p>로그인 유지가 켜지면 웹의 자동 로그아웃 타이머와 서버 인증 유효성은 별도로 확인합니다. 브라우저 종료 후 영구 로그인을 보장하는 설정은 아닙니다.');p.write_text(s)
p=r/'bridge/tests/browser/native-session-observability.test.ts';s=p.read_text();s=s.replace('test.each(["invalid", null, Infinity, NaN, -1])("malformed expiry fails closed (%s)", exp=>{','test.each(["invalid", null, Infinity, NaN, -1, 0])("unreadable optional expiry preserves observation but never permits renewal (%s)", exp=>{');s=s.replace('expect(f.api.read()).toMatchObject({available:false,diagnostic:"session_schema_unknown"});','expect(f.api.read()).toMatchObject({available:true,sessionKeepSignedIn:true,renewalSupported:false});\n    expect(f.api.read().expiresInMs).toBeUndefined();');s += '''

describe("1.8.54 log field-shape regressions", () => {
  test.each([undefined, null, 0, "1789370000", "invalid", NaN])("ON with unknown expiry still requires protected proof (%s)", async exp => {
    const f=fixture(); f.root.user.user.session.exp=exp; f.capture("store",f.store);
    const proof=vi.fn(async()=>({outcome:"ok",reason:"verified"} as const));
    const result=await new NativeSessionMaintenance(proof).run(f.page,opts);
    expect(result).toMatchObject({handled:true,observation:{state:"active",sessionKeepSignedIn:true}});
    expect(result.observation.remainingMs).toBeUndefined(); expect(proof).toHaveBeenCalledOnce();
    expect(f.store.dispatch).not.toHaveBeenCalled(); expect(f.api.begin(true)).toBe("unsupported");
  });
  test.each([undefined,null,0,1,"true","false",{},[]])("never coerce an unknown effective flag into ON (%s)", async flag=>{
    const f=fixture();f.root.user.user.session.stayLoggedIn=flag;f.capture("store",f.store);
    const proof=vi.fn(); const result=await new NativeSessionMaintenance(proof).run(f.page,opts);
    expect(result.observation).toMatchObject({state:"unknown",uiKeepSignedIn:true,
      reason:flag==null?"session_flag_missing":"session_flag_invalid"});
    expect(result.observation.sessionKeepSignedIn).toBeUndefined();
    expect(proof).not.toHaveBeenCalled(); expect(f.api.begin(true)).toBe("unsupported");
  });
  test("an elapsed web logout deadline with effective ON is not a server rejection", async()=>{
    const f=fixture(); f.root.user.user.session.exp=Date.now()/1000-60;f.capture("store",f.store);
    const proof=vi.fn(async()=>({outcome:"ok",reason:"verified"} as const));
    expect(await new NativeSessionMaintenance(proof).run(f.page,opts)).toMatchObject({handled:true,observation:{state:"active"}});
    expect(proof).toHaveBeenCalledOnce();expect(f.store.dispatch).not.toHaveBeenCalled();
  });
  test("401 remains authentication rejection with null expiry",async()=>{
    const f=fixture(); f.root.user.user.session.exp=null;f.capture("store",f.store);
    expect(await new NativeSessionMaintenance(async()=>({outcome:"reauth",reason:"http_401"})).run(f.page,opts))
      .toMatchObject({handled:false,authenticationRejected:true,observation:{reason:"reauth"}});
  });
  test("only field-type enums survive unknown-state logging and health",async()=>{
    const f=fixture();f.page.evaluate.mockResolvedValue({schema:1,available:false,diagnostic:"session_flag_invalid",sessionFlagType:"string",sessionExpiryType:"secret",uiKeepSignedIn:true,token:"secret"});
    const result=await new NativeSessionMaintenance(vi.fn()).run(f.page,opts);
    expect(result.observation).toMatchObject({sessionFlagType:"string",uiKeepSignedIn:true});
    expect(result.observation.sessionExpiryType).toBeUndefined();expect(JSON.stringify(result)).not.toContain("secret");
    const status=new RuntimeStatusStore({initial:{nativeSessionFlagType:"string",nativeSessionExpiryType:"null"}});
    expect(createHealthReport(status.getSnapshot()).details).toMatchObject({nativeSessionFlagType:"string",nativeSessionExpiryType:"null"});
    expect(()=>status.update({nativeSessionFlagType:"secret" as any})).toThrow();
  });
});
''';p.write_text(s)
p=r/'tools/ci-native-login-dom-regression.mjs';s=p.read_text().replace("{ disabled: true }, 'blocked'", "{ disabled: true }, 'control_disabled'").replace("assert.equal(result.report.reason, 'blocked');", "assert.equal(result.report.reason, 'auth_input_present');")
insert='''
  await scenario('native preference ON can be read without effective session schema or UI navigation', { on: true }, async page => {
    await page.evaluate(() => Object.defineProperty(window, Symbol.for('smartthings_web_bridge.native_session'), {value:{read:()=>({schema:1,available:false,diagnostic:'session_flag_missing',uiKeepSignedIn:true})}}));
    const before=await page.content(); const href=page.url();
    assert.deepEqual(await readNativeKeepSignedIn(page), {state:'enabled',reason:'observed_enabled'});
    assert.deepEqual(await ensureNativeKeepSignedIn(page,target,{enabled:true}), {report:{state:'enabled',reason:'observed_enabled'},clean:true});
    assert.equal(await page.content(),before);assert.equal(page.url(),href);assert.equal(await toggles(page),0);
  });
  await scenario('native ON preference cannot dismiss a visible OTP challenge', { on: true }, async page => {
    await page.evaluate(() => {
      Object.defineProperty(window,Symbol.for('smartthings_web_bridge.native_session'),{value:{read:()=>({schema:1,available:false,uiKeepSignedIn:true})}});
      document.body.insertAdjacentHTML('beforeend','<div role="dialog"><input autocomplete="one-time-code"></div>');
    });
    const before=await page.content();
    assert.deepEqual(await ensureNativeKeepSignedIn(page,target,{enabled:true}),{report:{state:'attention',reason:'auth_input_present'},clean:false});
    assert.equal(await page.content(),before);
  });
  await scenario('transparent inactive challenge container does not block inspection', { on: true }, async page => {
    await openSettings(page);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend','<div style="opacity:0"><iframe src="https://www.google.com/recaptcha/api2/bframe"></iframe></div>'));
    const before=await page.content();
    assert.deepEqual(await readNativeKeepSignedIn(page),{state:'enabled',reason:'observed_enabled'});
    assert.equal(await page.content(),before);assert.equal(await toggles(page),0);
  });
  await scenario('other modal has its own diagnostic and is preserved', { on: true }, async page => {
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend','<div role="dialog">Device operation</div>'));
    const before=await page.content();
    assert.deepEqual(await ensureNativeKeepSignedIn(page,target,{enabled:true}),{report:{state:'attention',reason:'other_dialog_present'},clean:false});
    assert.equal(await page.content(),before);
  });
  await scenario('command gate is not reported as a changed page', { on: true }, async page => {
    assert.equal((await ensureNativeKeepSignedIn(page,target,{enabled:true,canContinue:()=>false})).report.reason,'command_busy');
    assert.equal(await page.evaluate(()=>localStorage.getItem('menuClicks')),null);
  });
'''
s=s.replace("  console.log(JSON.stringify({ suite: 'native-login-real-dom-regression'",insert+"  console.log(JSON.stringify({ suite: 'native-login-real-dom-regression'");p.write_text(s)
