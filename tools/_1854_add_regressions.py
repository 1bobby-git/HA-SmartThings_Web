from pathlib import Path
r=Path('.')
probes=r.parent/'probes'; probes.mkdir(exist_ok=True)
for p in r.glob('probe-*.mjs'): p.rename(probes/p.name)
p=r/'extract-modules.cjs'
if p.exists(): p.rename(probes/p.name)
p=r/'tools/ci-native-login-dom-regression.mjs'
s=p.read_text()
s=s.replace('<main>Fixture dashboard</main><script>', '<main>Fixture dashboard${mode.large ? "<span>Device</span>".repeat(20_000) : ""}</main><script>')
anchor="  console.log(JSON.stringify({ suite: 'native-login-real-dom-regression'"
assert s.count(anchor)==1
s=s.replace(anchor,"""  await scenario('20,000 dashboard elements cannot block the known settings dialog', { on: true, large: true }, async page => {
    assert.equal(await readNativeKeepSignedIn(page), undefined, 'closed dialog remains unknown');
    await openSettings(page);
    await page.locator('#toggle').focus();
    const before = await page.content();
    assert.deepEqual(await readNativeKeepSignedIn(page), { state: 'enabled', reason: 'observed_enabled' });
    assert.equal(await page.content(), before, 'read-only observation does not mutate a large dashboard');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'toggle');
    assert.equal(await toggles(page), 0);
  });
  await scenario('large dashboard OFF -> ON uses only the actual switch once', { large: true }, async page => {
    assert.deepEqual(await ensureNativeKeepSignedIn(page, target, { enabled: true }), {
      report: { state: 'enabled', reason: 'enabled_and_verified' }, clean: true
    });
    assert.equal(await toggles(page), 1);
  });
  await scenario('large dashboard still protects real authentication challenges', { on: true, large: true }, async page => {
    await openSettings(page);
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-label="Verification"><input autocomplete="one-time-code"></div>'));
    const before = await page.content();
    assert.equal(await readNativeKeepSignedIn(page), undefined);
    const result = await ensureNativeKeepSignedIn(page, target, { enabled: true });
    assert.equal(result.report.reason, 'blocked');
    assert.equal(result.clean, false);
    assert.equal(await page.content(), before);
    assert.equal(await toggles(page), 0);
  });
"""+anchor)
p.write_text(s)
p=r/'tools/ci-native-session-smoke.mjs'
s=p.read_text()
s=s.replace("const calls={renew:0,proof:0,logout:0,support:0,unrelated:0};", """if(mode.noDuration) delete root.ui.settings.user.sessionLength;
if(mode.noExpiry) delete root.user.user.session.exp;
const calls={renew:0,proof:0,logout:0,support:0,unrelated:0};""")
s=s.replace('// serializableCheck deviceHealth: socketAuthenticated','// serializableCheck deviceHealth: reducer: client: user:')
s=s.replace("exports.renamed={getState:()=>root,subscribe:()=>()=>{},dispatch:action=>action()};", """if(mode.cyclicExport) Object.defineProperty(exports,'uninitializedSibling',{enumerable:true,get(){throw new ReferenceError('cyclic fixture');}});
    exports.renamed={getState:()=>root,subscribe:()=>()=>{},dispatch:action=>action()};""")
anchor=" console.log(JSON.stringify({suite:'verified-native-session'"
assert s.count(anchor)==1
s=s.replace(anchor,""" await scenario('actual session can be read before the optional duration preference initializes',{noDuration:true},async({maintain,data})=>{
   assert.equal((await data()).snapshot.renewalSupported,false);
   assert.equal((await maintain()).observation.state,'active');
   const result=await data();assert.equal(result.calls.renew,0);assert.equal(result.calls.proof,1);
 });
 await scenario('absent expiry is not fabricated and does not hide verified native session',{noExpiry:true},async({maintain,data})=>{
   const result=await maintain();assert.equal(result.observation.state,'active');assert.equal(result.observation.remainingMs,undefined);
   assert.equal((await data()).snapshot.renewalSupported,false);assert.equal((await data()).calls.renew,0);
 });
 await scenario('read support never authorizes renewal with uninitialized arguments',{noDuration:true,effective:false},async({maintain,data})=>{
   const result=await maintain();assert.equal(result.handled,false);assert.equal(result.observation.reason,'renewal_unsupported');
   assert.equal((await data()).calls.renew,0);
 });
 await scenario('cyclic sibling export cannot hide the naturally loaded Redux store',{cyclicExport:true},async({maintain,data})=>{
   assert.equal((await maintain()).observation.state,'active');assert.equal((await data()).calls.renew,0);
 });
"""+anchor)
p.write_text(s)
p=r/'bridge/src/server/status-page.ts'
s=p.read_text().replace('reauth:"재로그인 필요", stale:"이전 페이지 결과 폐기" }', '''reauth:"재로그인 필요", stale:"이전 페이지 결과 폐기", observer_missing:"현재 문서의 세션 관찰기 없음",
      store_missing:"웹 앱 상태 저장소 연결 대기", session_not_ready:"실제 세션 데이터 준비 대기",
      preference_not_ready:"설정값 준비 대기", socket_not_ready:"소켓 인증 상태 준비 대기",
      session_schema_unknown:"실제 세션 값의 형식 확인 필요", capture_ambiguous:"상태 저장소 중복 감지",
      invalid_target:"기기 페이지 확인 필요", renewal_unsupported:"읽기 가능 · 자동 갱신 기능 확인 불가" }''')
p.write_text(s)
