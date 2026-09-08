import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { launchSmartThingsPersistentContext } from '../dist/bridge/src/browser/persistent-context.js';
import { KeeperPageManager, KEEPER_URL, SESSION_TOUCH_AUTH_PATH } from '../dist/bridge/src/browser/keeper-page.js';

// Only a new temporary profile and synthetic values. No real Samsung traffic:
// all page traffic is fulfilled locally; even pre-route restore/background
// traffic is blocked by an unreachable loopback proxy and DNS mapping.
const root = await mkdtemp(join(tmpdir(), 'stw-session-fixture-'));
await mkdir(join(root, 'downloads'));
let context;
let phase = 'initial';
let responseStatus = 200;
let htmlAuth = false;
let touches = 0;
const paths = { dataDir: root, profileDir: join(root, 'chromium-profile'), downloadDir: join(root, 'downloads') };
const launch = async () => {
  context = await launchSmartThingsPersistentContext({
    launchPersistentContext: (profile, options) => chromium.launchPersistentContext(profile, {
      ...options,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [...options.args, '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']
    })
  }, paths);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(route.request().method(), 'GET');
    if (url.origin !== 'https://my.smartthings.com') return route.abort();
    if (url.pathname === new URL(SESSION_TOUCH_AUTH_PATH, KEEPER_URL).pathname) {
      touches++;
      await route.fulfill({ status: responseStatus,
        contentType: htmlAuth ? 'text/html' : 'application/json',
        ...(responseStatus === 200 && !htmlAuth ? {
          headers: { 'set-cookie': 'fixture_session=rotated; Path=/; HttpOnly; Secure; SameSite=Lax' }
        } : {}),
        body: htmlAuth ? '<html>Sign in</html>' : JSON.stringify({ items: [{ locationId: 'fixture-home' }] }) });
      return;
    }
    await route.fulfill({ contentType: 'text/html',
      ...(phase === 'initial' ? { headers: { 'set-cookie': 'fixture_session=first; Path=/; HttpOnly; Secure; SameSite=Lax' } } : {}),
      body: '<!doctype html><title>Fixture</title><p>Fixture home</p>' });
  });
};
try {
  await launch();
  let keeper = new KeeperPageManager(context);
  let page = await keeper.ensureKeeper();
  await page.evaluate(() => localStorage.setItem('fixture-state', 'preserved'));
  phase = 'touch';
  assert.equal(await keeper.touchAuthenticatedSession(), 'ok');
  const count = context.pages().length;
  for (let i = 0; i < 5; i++) assert.equal(await keeper.touchAuthenticatedSession(), 'ok');
  assert.equal(context.pages().length, count);
  assert.equal(touches, 6);
  await context.close(); context = undefined;
  await launch();
  const saved = (await context.cookies(KEEPER_URL)).find(cookie => cookie.name === 'fixture_session');
  assert.equal(saved?.value, 'rotated');
  assert.equal(saved?.expires, -1); // Session cookie, not artificially extended.
  keeper = new KeeperPageManager(context);
  page = await keeper.ensureKeeper();
  // A restored error tab is allowed; load the intercepted application afresh.
  await page.goto(KEEPER_URL, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => localStorage.getItem('fixture-state')), 'preserved');
  assert.equal(await keeper.touchAuthenticatedSession(), 'ok');
  responseStatus = 503;
  assert.equal(await keeper.touchAuthenticatedSession(), 'failed');
  assert.equal(keeper.authenticationRecoveryPending(), false);
  responseStatus = 403;
  assert.equal(await keeper.touchAuthenticatedSession(), 'failed');
  responseStatus = 200; htmlAuth = true;
  assert.equal(await keeper.touchAuthenticatedSession(), 'failed');
  htmlAuth = false; responseStatus = 401;
  assert.equal(await keeper.touchAuthenticatedSession(), 'reauth');
  assert.equal(keeper.authenticationRecoveryPending(), true);
  responseStatus = 200;
  assert.equal(await keeper.touchAuthenticatedSession(), 'ok');
  assert.equal(keeper.authenticationRecoveryPending(), false);
  console.log('PASS session continuity: cookie rotation, persistent session-cookie/localStorage restore, bounded tab count, auth proof and transient failure classification (synthetic only)');
} finally {
  await context?.close();
  await rm(root, { recursive: true, force: true });
}
