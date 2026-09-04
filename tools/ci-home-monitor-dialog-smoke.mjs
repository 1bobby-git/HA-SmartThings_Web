import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { clickHomeMonitorDialogAction, probeHomeMonitorDialog } from "../dist/bridge/src/browser/home-monitor-dialog.js";

// Synthetic DOM fixtures exercised in real Chromium, not a live Samsung account.
const groups = [["Arm away", "Armed (Away)", "Away", "보안(외출)", "외출"],
  ["Arm stay", "Armed (Stay)", "Stay", "보안(실내)", "재실"],
  ["Disarm", "Disarmed", "Off", "해제"]];
const monitor = ["SmartThings Home Monitor", "홈 모니터"];
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
let passed = 0;
async function run(name, html, action, expected, check) {
  const page = await browser.newPage();
  const diagnostics = [];
  try {
    await page.setContent(`<style>dialog{display:block}button,label,[role=radio]{display:block;padding:8px}</style>${html}`);
    const result = await clickHomeMonitorDialogAction(page, monitor, groups[action], groups, 350, true,
      (entry) => diagnostics.push(entry));
    assert.equal(result, expected, name);
    await check?.(page, diagnostics);
    assert.equal(await page.locator('[data-stw-hm-target],[data-stw-hm-dialog]').count(), 0, "temporary markers removed");
    assert.doesNotMatch(JSON.stringify(diagnostics), /SmartThings|PRIVATE|secret|customer|外/u);
    passed++;
    console.log(`PASS ${name}`);
  } finally { await page.close(); }
}
try {
  for (const [index, value] of ["armedAway", "armedStay", "disarmed"].entries()) {
    await run(`native select mode ${index}`, `<div role="dialog"><h2>SmartThings Home Monitor</h2>
      <select id="m"><option value="disarmed">해제</option><option value="armedAway">보안 ( 외출 )</option>
      <option value="armedStay">보안 ( 실내 )</option></select><button id="apply">적용</button></div>
      <script>window.saved=null;apply.onclick=e=>{window.trusted=e.isTrusted;window.saved=m.value}</script>`, index, "clicked",
      async (page, diag) => {
        assert.equal(await page.evaluate(() => window.saved), value);
        assert.equal(await page.evaluate(() => window.trusted), true);
        assert.equal(diag[0].selects, 1);
        assert.equal(diag[0].options, 3);
        assert.equal(diag.at(-1).outcome, "submitted");
      });
  }
  await run("labelled radio with description", `<div role="dialog"><h2>홈 모니터</h2>
    <label><input type="radio" name="mode"><span>보안 ( 외출 )</span><p>PRIVATE description</p></label>
    <label><input type="radio" name="mode"><span>보안 ( 실내 )</span><p>PRIVATE description</p></label>
    <button id="save">저장</button></div><script>window.saved=false;save.onclick=()=>window.saved=document.querySelector('input').checked</script>`,
    0, "clicked", async (page) => assert.equal(await page.evaluate(() => window.saved), true));
  await run("split inline label and hidden duplicate", `<button id="outside">Away</button>
    <div role="dialog"><h2>SmartThings Home Monitor</h2>
    <button style="display:none">Arm away</button><button id="away"><span>Arm </span><b>away</b></button></div>
    <script>window.clicked=0;away.onclick=e=>{if(e.isTrusted)window.clicked++};outside.onclick=()=>window.clicked=99</script>`,
    0, "clicked", async (page) => assert.equal(await page.evaluate(() => window.clicked), 1));
  await run("aria-labelledby on a role control", `<div role="dialog"><h2>홈 모니터</h2>
    <span id="label" hidden>Arm stay</span><div role="radio" aria-labelledby="label" id="mode">PRIVATE content</div></div>
    <script>window.clicked=false;mode.onclick=e=>window.clicked=e.isTrusted</script>`,
    1, "clicked", async (page) => assert.equal(await page.evaluate(() => window.clicked), true));
  await run("portaled listbox belongs to the dialog", `<div role="dialog"><h2>홈 모니터</h2>
    <div role="combobox" aria-expanded="false" aria-controls="choices" id="combo">해제</div></div>
    <div role="listbox" id="choices" style="display:none"><div role="option" id="away">보안 ( 외출 )</div>
    <div role="option">보안 ( 실내 )</div><div role="option">해제</div></div>
    <script>window.clicked=false;combo.onclick=()=>{combo.setAttribute('aria-expanded','true');choices.style.display='block'};
    away.onclick=e=>window.clicked=e.isTrusted</script>`,
    0, "clicked", async (page) => assert.equal(await page.evaluate(() => window.clicked), true));
  await run("text-only delegated pill", `<div role="dialog"><h2>홈 모니터</h2>
    <div id="pill"><span>보안 ( 외출 )</span><p>PRIVATE explanation</p></div></div>
    <script>window.clicked=0;pill.onclick=e=>{if(e.isTrusted)window.clicked++}</script>`,
    0, "clicked", async (page) => assert.equal(await page.evaluate(() => window.clicked), 1));
  await run("unknown dialog does not click background away", `<button id="away">Away</button>
    <div role="dialog"><h2>로그인 확인</h2><button>확인</button></div>
    <script>window.clicked=false;away.onclick=()=>window.clicked=true</script>`,
    0, "not_found", async (page, diag) => {
      assert.equal(await page.evaluate(() => window.clicked), false);
      assert.equal(diag.at(-1).outcome, "unrecognized");
    });
  await run("ambiguous mode buttons", `<div role="dialog"><h2>홈 모니터</h2><button>외출</button><button>외출</button></div>`, 0, "ambiguous");
  await run("competing modes in one control", `<div role="dialog"><h2>홈 모니터</h2>
    <button><span>외출</span><span>재실</span></button></div>`, 0, "not_found");
  await run("disabled native option", `<div role="dialog"><h2>홈 모니터</h2><select>
    <option>해제</option><option disabled>외출</option><option>재실</option></select></div>`, 0, "not_found");
  await run("disabled labelled radio", `<div role="dialog"><h2>홈 모니터</h2>
    <label><input disabled type="radio"><span>외출</span></label></div>`, 0, "not_found");
  await run("multiple visible dialogs", `<div role="dialog"><h2>홈 모니터</h2><button>외출</button></div>
    <div role="dialog"><h2>다른 설정</h2></div>`, 0, "ambiguous");
  await run("no dialog leaves existing card path unchanged", `<h2>SmartThings Home Monitor</h2><button>해제</button>`, 0, "unavailable");
  await run("unrelated on-off select is not a security mode", `<div role="dialog"><h2>홈 모니터</h2><select id="setting"><option value="on">On</option><option value="off">Off</option></select></div>
    <script>window.changed=false;setting.onchange=()=>window.changed=true</script>`,
    2, "not_found", async (page) => assert.equal(await page.evaluate(() => window.changed), false));
  await run("duplicate form value is ambiguous", `<div role="dialog"><h2>홈 모니터</h2><select>
    <option value="shared">해제</option><option value="shared">외출</option><option value="stay">재실</option></select></div>`,
    0, "ambiguous");
  // Also exercise the production command-page orchestration with all network requests fulfilled locally.
  const { SmartThingsWebUiCommandExecutor } = await import("../dist/bridge/src/browser/command-page.js");
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body:
      `<h2>SmartThings Home Monitor</h2><button id="current">Disarmed</button>
       <script>window.saved=null;current.onclick=()=>{
         const modal=document.createElement('div');modal.setAttribute('role','dialog');
         modal.innerHTML='<h2>SmartThings Home Monitor</h2><select id="mode"><option>Disarmed</option><option>Armed ( Away )</option><option>Armed ( Stay )</option></select><button id="apply">Apply</button>';
         document.body.append(modal);document.getElementById('apply').onclick=e=>{window.saved=document.getElementById('mode').value;window.trusted=e.isTrusted};
       }</script>`
    }));
    await page.goto("https://my.smartthings.com/location/test-home");
    const diagnostics = [];
    // Keep the page alive for assertions; the real executor still invokes its close callback.
    const wrapped = new Proxy(page, { get(target, property) {
      if (property === "close") return async () => undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const executor = new SmartThingsWebUiCommandExecutor(
      () => ({ openCommandPage: async () => wrapped }), (id) => id,
      { onHomeMonitorDialogDiagnostic: (entry) => diagnostics.push(entry) }
    );
    await executor.executeLocationAction({ locationId: "test-home", action: "armAway" });
    assert.equal(await page.evaluate(() => window.saved), "Armed ( Away )");
    assert.equal(await page.evaluate(() => window.trusted), true);
    assert.equal(diagnostics.at(-1).outcome, "submitted");
    passed++;
    console.log("PASS complete command-page dialog orchestration");
  } finally { await page.close(); }
  console.log(`Home Monitor real-browser dialog fixtures: ${passed} passed`);
} finally { await browser.close(); }
