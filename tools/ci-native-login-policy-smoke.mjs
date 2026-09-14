import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ensureNativeKeepSignedIn } from '../dist/bridge/src/browser/native-login-policy.js';
import { KeeperPageManager, SESSION_TOUCH_AUTH_PATH } from '../dist/bridge/src/browser/keeper-page.js';
import { verifyLocationApplicationSession } from '../dist/bridge/src/browser/session-application-proof.js';
import { launchSmartThingsPersistentContext } from '../dist/bridge/src/browser/persistent-context.js';

// Temporary synthetic profile ONLY; every request is fulfilled locally. No
// Samsung account, credentials, private DOM or real account network is used.
const root = await mkdtemp(join(tmpdir(), 'stw-native-policy-'));
await mkdir(join(root, 'downloads'));
const target = 'https://my.smartthings.com/location/fixture-home';
let context;
let mode = {};
let passed = 0;
function html() {
  const label = mode.english ? 'Keep me signed in' : '로그인 유지';
  const title = mode.wrongDialog ? '기기 설정' : mode.english ? 'SmartThings settings' : 'SmartThings 설정';
  const web = mode.english ? 'SmartThings web' : 'SmartThings 웹';
  const initial = mode.initial ?? false;
  let control = mode.custom
    ? `<button id="keep" role="switch" ${mode.unknown ? '' : 'aria-checked="false"'} ${mode.disabled ? 'aria-disabled="true"' : ''}></button>`
    : `<input id="keep" type="checkbox" ${mode.disabled ? 'disabled' : ''}>`;
  const row = mode.unlabelled ? `<div><p>${label}</p>${control}</div>` : `<label for="keep">${label}${control}</label>`;
  const dialog = `<aside ${mode.roleless ? '' : 'role="dialog" aria-modal="true"'}>
    <h2>${title}</h2><h3>${web}</h3>
    ${mode.noKeep ? '' : row}${mode.duplicateControl ? row.replaceAll('keep"','keep-other"') : ''}
    <p id="duration">세션 길이 2시간 8시간 24시간</p>
    <h3>SmartThings Support</h3><label>Account data access<input id="support" type="checkbox"></label>
    <button id="logout">로그아웃</button></aside>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Synthetic settings</title></head><body>
    <button aria-label="${mode.english ? 'Settings' : '설정'}" id="open">Settings</button>
    ${mode.duplicateOpener ? '<button aria-label="Settings">Other settings</button>' : ''}
    ${mode.blocked ? '<div role="dialog"><h2>User modal</h2><input autocomplete="one-time-code" value="fixture-only"></div>' : ''}
    <main>Fixture device dashboard</main>
    <script>
      const mode = ${JSON.stringify(mode)};
      let checked = localStorage.getItem('fixture-native-keep') === null ? ${initial} : localStorage.getItem('fixture-native-keep') === 'true';
      const client = { service: () => ({ get: async () => ({locationId:'fixture-home'}) }) };
      window[Symbol.for('smartthings_web_bridge.cake_client')] = client;
      const increment = key => localStorage.setItem(key, String(Number(localStorage.getItem(key) || 0)+1));
      document.querySelector('#open').onclick = () => {
        if (document.querySelector('aside')) return;
        document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(dialog)});
        document.querySelector('#support').onchange = () => increment('fixture-support-writes');
        document.querySelector('#logout').onclick = () => increment('fixture-logout-writes');
        const keep = document.querySelector('#keep');
        if (!keep) return;
        const display = () => {
          if (mode.custom) { if (!mode.unknown) keep.setAttribute('aria-checked', String(checked)); }
          else keep.checked = checked;
          document.querySelector('#duration').hidden = checked;
        };
        display();
        const change = () => {
          if (mode.disabled || mode.unknown) return;
          checked = mode.custom ? !checked : keep.checked;
          increment('fixture-keep-writes');
          if (!mode.notSaved) localStorage.setItem('fixture-native-keep', String(checked));
          display();
          if (mode.navigate) location.href = 'https://account.samsung.com/fixture';
        };
        keep[mode.custom ? 'onclick' : 'onchange'] = change;
      };
    </script></body></html>`;
}
async function launch() {
  context = await launchSmartThingsPersistentContext({
    launchPersistentContext: (profile, options) => chromium.launchPersistentContext(profile, {
      ...options,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [...options.args, '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']
    })
  }, { dataDir: root, profileDir: join(root, 'chromium-profile'), downloadDir: join(root, 'downloads') });
  await context.route('**/*', route => {
    assert.equal(route.request().method(), 'GET', 'no background mutations, support access or logout requests');
    const url = new URL(route.request().url());
    if (url.origin === 'https://account.samsung.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<input type="password">' });
    if (url.origin !== 'https://my.smartthings.com') return route.abort();
    if (url.pathname === new URL(SESSION_TOUCH_AUTH_PATH, target).pathname) return route.fulfill({ json: {items:[{locationId:'fixture-home'}]} });
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html() });
  });
}
const readCounters = page => page.evaluate(() => ({
  enabled: localStorage.getItem('fixture-native-keep'),
  keep: Number(localStorage.getItem('fixture-keep-writes') || 0),
  support: Number(localStorage.getItem('fixture-support-writes') || 0),
  logout: Number(localStorage.getItem('fixture-logout-writes') || 0),
  modal: !!document.querySelector('aside')
}));
async function scenario(name, opts, assertion) {
  mode = opts;
  const page = await context.newPage();
  await page.goto(target);
  await page.evaluate(() => localStorage.clear());
  await page.goto(target);
  assert.equal(await page.locator('#open').getAttribute('aria-label'), opts.english ? 'Settings' : '설정', 'fixture labels must retain their UTF-8 encoding');
  // Use the production timeout; headed Chromium needs real stable frames.
  const result = await ensureNativeKeepSignedIn(page, target, { enabled: !opts.optOut });
  try {
    await assertion(result, page);
    if (page.url() === target) {
      const evidence = await readCounters(page);
      assert.equal(evidence.support, 0, 'Support data access must remain untouched');
      assert.equal(evidence.logout, 0, 'Logout must remain untouched');
    }
    console.log(`PASS ${++passed} ${name}`);
  } finally { await page.close(); }
}
try {
  await launch();
  await scenario('Korean checkbox OFF -> ON, reload verification and idempotence', {}, async (result, page) => {
    assert.deepEqual(result, {report:{state:'enabled', reason:'enabled_and_verified'}, clean:true});
    assert.deepEqual(await readCounters(page), {enabled:'true',keep:1,support:0,logout:0,modal:false});
    assert.equal((await ensureNativeKeepSignedIn(page, target, {enabled:true})).report.reason, 'already_enabled');
    assert.equal((await readCounters(page)).keep, 1);
  });
  await scenario('English already ON is never toggled', {english:true, initial:true}, async (result, page) => {
    assert.equal(result.report.reason, 'already_enabled');
    assert.equal((await readCounters(page)).keep, 0);
  });
  await scenario('Korean unlabelled ARIA switch in bounded row', {custom:true, unlabelled:true, roleless:true}, async (result, page) => {
    assert.equal(result.report.state, 'enabled'); assert.equal((await readCounters(page)).keep, 1);
  });
  for (const [name, opts] of [
    ['Support-only settings', {noKeep:true}],
    ['ambiguous duplicate setting', {duplicateControl:true}],
    ['unknown checked state', {custom:true, unknown:true}],
    ['disabled checkbox', {disabled:true}],
    ['disabled ARIA switch', {custom:true, disabled:true}],
    ['unrelated OTP modal', {blocked:true}],
    ['device settings is not global SmartThings settings', {wrongDialog:true}],
    ['ambiguous openers', {duplicateOpener:true}]
  ]) await scenario(name, opts, async (result, page) => {
    assert.equal(result.report.state, 'attention'); assert.equal((await readCounters(page)).keep, 0);
    if (opts.blocked) assert.equal(result.clean, false, 'pre-existing challenge must prevent keeper promotion');
  });
  await scenario('optimistic UI without persisted preference is not success', {notSaved:true}, async (result, page) => {
    assert.equal(result.report.reason, 'not_saved'); assert.equal((await readCounters(page)).keep, 1);
  });
  await scenario('opt-out performs no clicks and does not turn native setting off', {optOut:true, initial:true}, async (result, page) => {
    assert.equal(result.report.state, 'disabled'); assert.equal((await readCounters(page)).keep, 0);
    assert.equal((await readCounters(page)).modal, false);
  });
  await scenario('navigation to login aborts without follow-up writes', {navigate:true}, async result => {
    assert.equal(result.report.state, 'attention'); assert.equal(result.clean, false);
  });
  mode = {};
  let page = await context.newPage(); await page.goto(target); await page.evaluate(() => localStorage.clear()); await page.goto(target);
  assert.equal((await ensureNativeKeepSignedIn(page, target, {enabled:true})).report.state, 'enabled');
  await context.close(); context = undefined;
  await launch();
  page = await context.newPage(); await page.goto(target);
  assert.equal((await ensureNativeKeepSignedIn(page, target, {enabled:true})).report.reason, 'already_enabled');
  assert.equal((await readCounters(page)).keep, 1);
  console.log(`PASS ${++passed} native preference survives real persistent Chromium restart (synthetic setting)`);
  // Headed persistent Chromium exits when its last window is closed. Open
  // the next fixture before retiring the previous pages; this is test setup,
  // not a production session workaround or a retry that hides an assertion.
  const previousPages = context.pages();
  page = await context.newPage();
  for (const previous of previousPages) await previous.close();
  await page.goto(target); await page.evaluate(() => localStorage.clear()); await page.goto(target);
  const manager = new KeeperPageManager(context, {
    probeApplicationSession: verifyLocationApplicationSession,
    verifyRefreshCandidate: async (candidate, expected) => {
      const policy = await ensureNativeKeepSignedIn(candidate, expected, {enabled:true});
      return policy.clean && policy.report.state === 'enabled' && (await verifyLocationApplicationSession(candidate, expected)).outcome === 'ok';
    }
  });
  await manager.reconcileRestoredPages();
  assert.equal(await manager.touchAuthenticatedSession(), 'ok');
  manager.requestProactiveRefresh();
  assert.equal(await manager.refreshAuthenticatedSessionIfDue(), 'verified');
  assert.equal(manager.currentKeeper() !== page, true, 'only configured and authenticated candidate is promoted');
  assert.equal(page.isClosed(), true);
  assert.equal((await readCounters(manager.currentKeeper())).enabled, 'true');
  assert.equal(context.pages().length, 1);
  console.log(`PASS ${++passed} existing keeper handoff verifies configured candidate before promotion`);
  mode = {navigate:true};
  await manager.currentKeeper().evaluate(() => localStorage.clear());
  const healthy = manager.currentKeeper();
  manager.requestProactiveRefresh();
  assert.equal(await manager.refreshAuthenticatedSessionIfDue(), 'failed');
  assert.equal(manager.currentKeeper() === healthy, true, 'failed settings must preserve working keeper');
  assert.equal(healthy.isClosed(), false);
  assert.equal(context.pages().length, 1);
  console.log(`PASS ${++passed} failed candidate preserves working keeper and cleans owned tab`);
  console.log(JSON.stringify({suite:'native-keep-signed-in',passed,scope:'isolated synthetic Chromium, not a live Samsung account or 8/24-hour soak'}));
} finally {
  await context?.close(); await rm(root, {recursive:true, force:true});
}
