import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { ensureNativeKeepSignedIn, readVisibleNativeLoginPolicy } from '../dist/bridge/src/browser/native-login-policy.js';
import { createBridgeHttpServer } from '../dist/bridge/src/server/http-server.js';
import { RuntimeStatusStore } from '../dist/bridge/src/state/runtime-state.js';

// Synthetic layouts only. No real Samsung account or private browser profile.
const target = 'https://my.smartthings.com/location/fixture-recheck';
let mode = {};
let localOrigin;
let server;
let passed = 0;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext();
function fixture() {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><body><div id="host"></div><script>
    const mode = ${JSON.stringify(mode)};
    const host = document.getElementById('host');
    const root = mode.shadow ? host.attachShadow({mode:'open'}) : host;
    const icon = mode.icon ? '<img alt="설정" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">' : '설정';
    root.innerHTML = '<header>' + (mode.noOpener ? '' : mode.menu ? '<button id="menu" aria-label="더보기">⋮</button><ul role="menu" id="menu-items" hidden><li><span role="menuitem" id="open" tabindex="0">설정</span></li></ul>' : '<button id="open">'+icon+'</button>') + '</header><main>Fixture devices</main>';
    const count = key => localStorage.setItem(key, String(Number(localStorage.getItem(key)||0)+1));
    const open = () => {
      if (root.querySelector('aside')) return;
      const menu = root.querySelector('#menu-items'); if(menu) menu.hidden = true;
      const keep = mode.custom ? '<button role="switch" id="keep" aria-checked="false" style="width:32px;height:24px"></button>' : '<input type="checkbox" id="keep">';
      root.insertAdjacentHTML('beforeend','<aside role="dialog" aria-modal="true"><h2>SmartThings 설정</h2><h3>SmartThings 웹</h3><div><label for="keep">로그인 유지</label>'+keep+'</div><h3>SmartThings Support</h3><label>Account data access<input id="support" type="checkbox"></label><button id="logout">로그아웃</button></aside>');
      const control = root.querySelector('#keep');
      let checked = localStorage.getItem('fixture-keep') === 'true';
      const display = () => mode.custom ? control.setAttribute('aria-checked', String(checked)) : control.checked = checked;
      display();
      control[mode.custom ? 'onclick' : 'onchange'] = () => { checked = mode.custom ? !checked : control.checked; count('keep-writes'); localStorage.setItem('fixture-keep', String(checked)); display(); };
      root.querySelector('#support').onchange = () => count('support-writes');
      root.querySelector('#logout').onclick = () => count('logout-writes');
    };
    root.querySelector('#open')?.addEventListener('click', open);
    root.querySelector('#menu')?.addEventListener('click', () => { root.querySelector('#menu-items').hidden = false; });
    window.openFixtureSettings = open;
  </script></body></html>`;
}
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin === localOrigin) return route.continue();
  if (route.request().url() === target && route.request().method() === 'GET') return route.fulfill({ contentType:'text/html; charset=utf-8', body: fixture() });
  return route.abort();
});
async function newFixture(opts) {
  mode = opts;
  const page = await context.newPage();
  await page.goto(target);
  await page.evaluate(() => localStorage.clear());
  return page;
}
async function counters(page) {
  return page.evaluate(() => ({ keep: Number(localStorage.getItem('keep-writes')||0), support: Number(localStorage.getItem('support-writes')||0), logout: Number(localStorage.getItem('logout-writes')||0) }));
}
try {
  for (const opts of [{menu:true}, {icon:true}, {shadow:true, menu:true}, {shadow:true, custom:true}]) {
    const page = await newFixture(opts);
    const result = await ensureNativeKeepSignedIn(page, target, {enabled:true});
    assert.equal(result.report.state, 'enabled', JSON.stringify({opts,result}));
    assert.deepEqual(await counters(page), {keep:1,support:0,logout:0});
    assert.equal((await ensureNativeKeepSignedIn(page,target,{enabled:true})).report.reason,'already_enabled');
    assert.deepEqual(await counters(page), {keep:1,support:0,logout:0}, 'ON must not be toggled twice');
    await page.close();
    console.log(`PASS ${++passed} automatic settings lookup ${JSON.stringify(opts)}`);
  }
  const page = await newFixture({noOpener:true});
  assert.equal((await ensureNativeKeepSignedIn(page,target,{enabled:true,timeoutMs:150})).report.reason, 'settings_not_found');
  await page.evaluate(() => window.openFixtureSettings());
  assert.equal((await readVisibleNativeLoginPolicy(page)).result, 'off');
  await page.locator('#keep').setChecked(true); // explicit manual user action
  const before = await page.content();
  assert.equal((await readVisibleNativeLoginPolicy(page)).result, 'on');
  assert.equal(await page.content(), before, 'read-only detection must not mark or close live settings');
  assert.deepEqual(await counters(page), {keep:1,support:0,logout:0});
  console.log(`PASS ${++passed} manual ON is readable even when opener lookup failed`);

  const store = new RuntimeStatusStore({initial:{authenticated:true,nativeLoginPolicyState:'attention',nativeLoginPolicyReason:'settings_not_found'}});
  let requests = 0;
  server = await createBridgeHttpServer({host:'127.0.0.1',port:0,store,maintenance:{
    reloadInventory:async()=>{}, reconnectRealtime:async()=>{},
    checkNativeLoginPolicy:async()=>{
      requests++;
      const observed = await readVisibleNativeLoginPolicy(page);
      assert.equal(observed.result,'on');
      store.update({nativeLoginPolicyState:'enabled',nativeLoginPolicyReason:'already_enabled'});
      return {queued:false};
    }
  }});
  localOrigin = `http://127.0.0.1:${server.port}`;
  const ui = await context.newPage();
  await ui.goto(localOrigin);
  assert.equal(requests,0,'GET must never change or recheck settings');
  await ui.getByRole('button',{name:'설정 다시 확인'}).click();
  await ui.waitForSelector('[data-native-login-policy="enabled"]');
  assert.equal(requests,1,'button must call the actual backend recheck');
  assert.equal(await ui.locator('#native-login-check-result').textContent(),'최신 검사 결과를 표시했습니다.');
  assert.equal(await page.content(),before,'recheck must preserve the manually open settings');
  assert.equal(page.isClosed(),false);
  assert.deepEqual(await counters(page),{keep:1,support:0,logout:0});
  assert.equal(await ui.locator('.hc-card').first().evaluate(element=>getComputedStyle(element).boxShadow),'none');
  console.log(`PASS ${++passed} real UI -> protected POST -> live DOM read -> updated card, without a full reload`);
  await ui.close(); await page.close();

  const shadow = await newFixture({shadow:true,noOpener:true});
  await shadow.evaluate(() => window.openFixtureSettings());
  await shadow.locator('#keep').setChecked(true);
  assert.equal((await readVisibleNativeLoginPolicy(shadow)).result,'on');
  await shadow.evaluate(() => { document.getElementById('host').setAttribute('aria-hidden','true'); });
  assert.notEqual((await readVisibleNativeLoginPolicy(shadow)).result,'on','hidden shadow host is not visible proof');
  await shadow.close();
  console.log(`PASS ${++passed} manual shadow-root observation respects hidden ancestors`);
  console.log(JSON.stringify({suite:'native-login-recheck',passed,scope:'isolated synthetic Chromium; real Samsung DOM and long-duration login not verified'}));
} finally { await server?.close(); await browser.close(); }
