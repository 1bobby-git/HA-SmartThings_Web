import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { ensureNativeKeepSignedIn, readNativeKeepSignedIn } from '../dist/bridge/src/browser/native-login-policy.js';

// Synthetic reproduction of the reported ReactModal + readonly input + ARIA
// button and the public 2.57.0 App settings -> Settings menu. No user data,
// credentials, Samsung code or real network requests are included in fixtures.
const target = 'https://my.smartthings.com/location/fixture-dom';
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']
});
let passed = 0;
function fixture(mode) {
  return `<!doctype html><html><meta charset="utf-8"><style>
    button { min-height: 36px; } .switch { position: relative; }
    .switch-input { position: absolute; opacity: 0; }
    .switch-paddle { width: 39px; height: 20px; }
    .user-settings { background: #fff; padding: 16px; }
    [hidden] { display: none !important; }
  </style><body><header data-testid="header"><button id="menu" aria-label="App settings">Menu</button></header>
  <main>Fixture dashboard${mode.large ? "<span>Device</span>".repeat(20_000) : ""}</main><script>
    const mode = ${JSON.stringify(mode)};
    let checked = localStorage.getItem('fixture-preference') === null ? !!mode.on : localStorage.getItem('fixture-preference') === 'true';
    const count = key => localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0) + 1));
    document.querySelector('#menu').onclick = () => {
      if (document.querySelector('#settings')) return;
      count('menuClicks');
      setTimeout(() => {
        document.querySelector('header').insertAdjacentHTML('beforeend', '<div role="menu"><button id="manage">Manage location</button><button id="settings">' + (mode.english ? 'Settings' : '설정') + '</button></div>');
        document.querySelector('#manage').onclick = () => count('unsafeClicks');
        document.querySelector('#settings').onclick = () => {
          count('settingsClicks');
          document.querySelector('[role="menu"]').remove();
          document.querySelector('header').setAttribute('aria-hidden', 'true');
          document.body.insertAdjacentHTML('beforeend', '<div class="ReactModalPortal"><div class="user-settings modal" role="dialog" aria-modal="true" aria-label="' + (mode.english ? 'SmartThings Settings' : 'SmartThings 설정') + '"><h1 class="modal-header">' + (mode.english ? 'SmartThings Settings' : 'SmartThings 설정') + '</h1><div class="section-label">' + (mode.english ? 'SmartThings for Web' : 'SmartThings 웹') + '</div><div class="card"><div class="form-field"><div id="keep-signed-in-lb">' + (mode.english ? 'Keep me signed in' : '로그인 유지') + '</div><div id="keep-signed-in-desc">Synthetic session guidance</div><div class="switch form-field-input"><input type="checkbox" tabindex="-1" class="switch-input" id="stayLoggedIn" readonly checked><button id="toggle" data-testid="toggle-switch-stayLoggedIn" class="switch-paddle" aria-labelledby="keep-signed-in-lb" aria-describedby="keep-signed-in-desc" role="switch" aria-checked="false"></button></div></div></div><div>SmartThings Support</div><label>Account data access<input id="support" type="checkbox"></label><button id="logout">로그아웃</button></div></div>');
          const input = document.querySelector('#stayLoggedIn');
          const toggle = document.querySelector('#toggle');
          const render = () => {
            input.checked = mode.disagree ? !checked : checked;
            toggle.setAttribute('aria-checked', String(checked));
          };
          render();
          input.onclick = () => count('mirrorClicks');
          document.querySelector('#support').onclick = () => count('unsafeClicks');
          document.querySelector('#logout').onclick = () => count('unsafeClicks');
          toggle.onclick = () => {
            count('toggleClicks'); checked = !checked;
            if (!mode.notSaved) localStorage.setItem('fixture-preference', String(checked));
            render();
          };
          if (mode.disabled) toggle.disabled = true;
          if (mode.duplicate) toggle.after(toggle.cloneNode(true));
          if (mode.unknown) toggle.removeAttribute('aria-checked');
        };
      }, mode.delay || 0);
    };
  </script></body></html>`;
}
async function scenario(name, mode, check) {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    assert.equal(route.request().method(), 'GET');
    if (route.request().url() !== target) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture(mode) });
  });
  const page = await context.newPage();
  await page.goto(target);
  try {
    await check(page);
    const counters = await page.evaluate(() => ({
      unsafe: Number(localStorage.getItem('unsafeClicks') || 0),
      mirror: Number(localStorage.getItem('mirrorClicks') || 0)
    }));
    assert.deepEqual(counters, { unsafe: 0, mirror: 0 });
    console.log(`PASS DOM ${++passed} ${name}`);
  } finally { await context.close(); }
}
const toggles = page => page.evaluate(() => Number(localStorage.getItem('toggleClicks') || 0));
const openSettings = async page => { await page.locator('#menu').click(); await page.locator('#settings').click(); };
try {
  await scenario('two-step Korean menu and screenshot switch OFF -> ON exactly once', {}, async page => {
    assert.deepEqual(await ensureNativeKeepSignedIn(page, target, { enabled: true }), {
      report: { state: 'enabled', reason: 'enabled_and_verified' }, clean: true
    });
    assert.equal(await toggles(page), 1);
    assert.equal((await ensureNativeKeepSignedIn(page, target, { enabled: true })).report.reason, 'already_enabled');
    assert.equal(await toggles(page), 1);
  });
  await scenario('English SmartThings for Web and delayed menu rendering', { english: true, delay: 250 }, async page => {
    assert.equal((await ensureNativeKeepSignedIn(page, target, { enabled: true })).report.state, 'enabled');
    assert.equal(await toggles(page), 1);
  });
  await scenario('already ON has no toggle mutations', { on: true }, async page => {
    assert.equal((await ensureNativeKeepSignedIn(page, target, { enabled: true })).report.reason, 'already_enabled');
    assert.equal(await toggles(page), 0);
  });
  await scenario('readonly observation keeps live modal, focus, URL and DOM intact', { on: true }, async page => {
    assert.equal(await readNativeKeepSignedIn(page), undefined);
    await openSettings(page);
    await page.locator('#toggle').focus();
    const before = await page.content();
    assert.deepEqual(await readNativeKeepSignedIn(page), { state: 'enabled', reason: 'observed_enabled' });
    assert.equal(await page.content(), before);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'toggle');
    assert.equal(page.url(), target);
    assert.equal(await toggles(page), 0);
    // A later user change must supersede cached ON; stale checked HTML is not proof.
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#stayLoggedIn').getAttribute('checked'), '');
    assert.deepEqual(await readNativeKeepSignedIn(page), { state: 'attention', reason: 'observed_disabled' });
  });
  for (const [name, mode, expected] of [
    ['conflicting live checkbox / ARIA values', { disagree: true }, 'state_unknown'],
    ['ambiguous duplicate switch', { duplicate: true }, 'ambiguous'],
    ['missing ARIA state', { unknown: true }, 'state_unknown'],
    ['disabled real button', { disabled: true }, 'control_disabled']
  ]) await scenario(name, mode, async page => {
    const result = await ensureNativeKeepSignedIn(page, target, { enabled: true });
    assert.equal(result.report.state, 'attention');
    assert.equal(result.report.reason, expected);
    assert.equal(await toggles(page), 0);
  });
  await scenario('unpersisted optimistic ON never becomes verified', { notSaved: true }, async page => {
    const result = await ensureNativeKeepSignedIn(page, target, { enabled: true });
    assert.equal(result.report.reason, 'not_saved');
    assert.equal(await toggles(page), 1);
  });
  await scenario('opt-out leaves menu and setting untouched', { on: true }, async page => {
    assert.equal((await ensureNativeKeepSignedIn(page, target, { enabled: false })).report.state, 'disabled');
    assert.equal(await page.evaluate(() => localStorage.getItem('menuClicks')), null);
  });
  await scenario('20,000 dashboard elements cannot block the known settings dialog', { on: true, large: true }, async page => {
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
    assert.equal(result.report.reason, 'auth_input_present');
    assert.equal(result.clean, false);
    assert.equal(await page.content(), before);
    assert.equal(await toggles(page), 0);
  });

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
  console.log(JSON.stringify({ suite: 'native-login-real-dom-regression', passed, scope: 'synthetic Chromium, no live Samsung account' }));
} finally { await browser.close(); }
