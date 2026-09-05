import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { SmartThingsWebUiCommandExecutor } from '../dist/bridge/src/browser/command-page.js';

// Synthetic local HTML only. No Samsung account, network API or live alarm is used.
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
const html = `<!doctype html><meta charset="utf-8">
<style>section{width:440px;padding:20px}button{padding:20px}</style>
<section><h2>SmartThings Home Monitor</h2>
<button id="stay">보안(실내)</button><button id="away">보안(외출)</button></section>
<script>window.actions=[];window.completed=false;
for(const id of ['stay','away']) document.getElementById(id).onclick=e=>{
  window.actions.push({id,trusted:e.isTrusted});
  setTimeout(()=>{window.completed=true},400);
};</script>`;
let passed = 0;
try {
  for (const [action, id] of [['armAway','away'], ['armStay','stay']]) {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ status:200,
      contentType:'text/html; charset=utf-8', body:html }));
    await page.goto('https://my.smartthings.com/location/test-office');
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: async () => page }), value => value
    );
    let verified = false, closes = 0;
    page.on('close', () => { closes++; });
    await executor.executeLocationAction({ locationId:'test-office', action,
      waitForConfirmation: async () => {
        assert.equal(page.isClosed(), false);
        await page.waitForFunction(() => window.completed === true, undefined, { timeout:3000 });
        assert.deepEqual(await page.evaluate(() => window.actions), [{id,trusted:true}]);
        verified = true;
      }
    });
    assert.equal(verified,true,'production executor must propagate and await the hook');
    assert.equal(page.isClosed(),true);
    assert.equal(closes,1);
    passed++;
    console.log(`PASS ${action}: delayed page work completes before page close`);
  }
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html}));
  await page.goto('https://my.smartthings.com/location/test-office');
  const executor = new SmartThingsWebUiCommandExecutor(
    () => ({openCommandPage:async()=>page}), value=>value
  );
  const expected = new Error('command_confirmation_timeout');
  await assert.rejects(executor.executeLocationAction({locationId:'test-office',action:'armAway',
    waitForConfirmation:async()=>{assert.equal(page.isClosed(),false);throw expected;}
  }), error=>error===expected);
  assert.equal(page.isClosed(),true);
  passed++;
  console.log('PASS failed confirmation closes the actual command page without hiding the error');
  console.log(`Home Monitor real-browser lifecycle fixtures: ${passed} passed`);
} finally { await browser.close(); }
