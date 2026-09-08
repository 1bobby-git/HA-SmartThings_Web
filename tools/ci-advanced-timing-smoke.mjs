import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { AuthenticatedSmartThingsSession } from '../dist/bridge/src/advanced/authenticated-session.js';
// Synthetic only. All traffic is intercepted; no Samsung session or physical commands.
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const context = await browser.newContext();
  let posts = 0, accepted = true;
  await context.route('**/*', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      assert.equal(route.request().headers()['x-csrf-token'], 'synthetic-timing-csrf');
      await new Promise(resolve => setTimeout(resolve, 80));
      return route.fulfill({ status: accepted ? 200 : 403, contentType: 'application/json', body: JSON.stringify({ results: [{ status: 'ACCEPTED' }] }) });
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><script>window._app={csrfToken:"synthetic-timing-csrf"}</script>' });
  });
  const page = await context.newPage();
  await page.goto('https://my.smartthings.com/location/synthetic-fixture');
  const timings = [];
  const session = new AuthenticatedSmartThingsSession({ currentKeeper: () => page,
    openAdvancedPage: async () => { throw new Error('unexpected fallback'); },
    onRequestTiming: event => timings.push(event) });
  const request = { endpoint: 'commands', method: 'POST', path: '/advanced/cupcake-api/api/devices/synthetic-private-id/commands',
    body: { commands: [{ component: 'main', capability: 'colorControl', command: 'setColor', arguments: [{ hue: 34, saturation: 96 }] }] } };
  assert.deepEqual(await session.request(request, v => v), { results: [{ status: 'ACCEPTED' }] });
  assert.equal(posts, 1); assert.equal(timings.length, 1);
  for (const field of ['totalMs', 'browserMs', 'fetchMs', 'bodyMs', 'bridgeOverheadMs']) {
    assert(Number.isFinite(timings[0][field]) && timings[0][field] >= 0, field);
  }
  assert(timings[0].fetchMs >= 60);
  assert(!/csrf|private-id|hue|saturation/.test(JSON.stringify(timings)));
  accepted = false;
  await assert.rejects(session.request(request, v => v), /advanced_permission_denied/);
  assert.equal(posts, 2); assert.equal(timings.length, 2); assert.equal(timings[1].status, 403);
  console.log('PASS real Chromium: numeric transport timings, original payload, CSRF preserved, no POST replay');
} finally { await browser.close(); }
