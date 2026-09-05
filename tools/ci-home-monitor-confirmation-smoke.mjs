import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { SmartThingsWebUiCommandExecutor } from "../dist/bridge/src/browser/command-page.js";
import { SafeCommandService } from "../dist/bridge/src/command/command-service.js";
import { DeviceStore } from "../dist/bridge/src/state/device-store.js";
import { RuntimeStatusStore } from "../dist/bridge/src/state/runtime-state.js";

// Every browser request is intercepted. No Samsung account, API, device or credential is used.
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
let passed = 0;
function capture(store, direction, text) {
  store.observe({ __sanitized: true, source: "playwright-websocket-frame", receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload: text, truncated: false } }, payloadHash: `${direction}:${text}` });
}
function makeStore() {
  const store = new DeviceStore();
  capture(store, "sent", '4225["find","api/location",{}]');
  capture(store, "received", '4325[null,[{"locationId":"loc_001","name":"Synthetic home","armState":"DISARMED","updatedAt":"2026-09-01T00:00:00Z"}]]');
  return store;
}
function connected() {
  const now = Date.now();
  return new RuntimeStatusStore({ now: () => now, initial: {
    state: "CONNECTED", chromiumRunning: true, keeperPresent: true, authenticated: true,
    pushConnected: true, parserHealthy: true, initialSnapshotComplete: true, dbAvailable: true,
    heartbeatAtMs: now, initialSnapshotCompletedAtMs: now, lastSnapshotAtMs: now,
    lastParserSuccessAtMs: now, lastPushAtMs: now
  } });
}
const html = (delay, eventMode) => `<meta charset="utf-8"><style>section{width:420px;padding:20px}button{padding:16px}</style>
<section><h2>SmartThings Home Monitor</h2><p>System ready to arm</p>
<button id="stay">보안(실내)</button><button id="away">보안(외출)</button></section>
<script>
for (const id of ['away', 'stay']) document.getElementById(id).addEventListener('click', (event) => {
  if (!event.isTrusted) throw new Error('untrusted click');
  const mode = id === 'away' ? 'ARMED_AWAY' : 'ARMED_STAY';
  window.syntheticClick(mode);
  ${eventMode === "none" ? "" : `setTimeout(() => window.syntheticSecurity(${eventMode === "wrong" ? "'DISARMED'" : "mode"}), ${delay});`}
});
</script>`;

async function run(name, { ignoreLifetimeHook = false, mode = "correct", action = "armAway" } = {}) {
  const store = makeStore();
  const order = [];
  const pages = [];
  const cards = [];
  const diagnostics = [];
  let clicks = 0;
  let events = 0;
  const manager = { openCommandPage: async () => {
    const page = await browser.newPage();
    pages.push(page);
    await page.route("**/*", (route) => route.fulfill({ status: 200,
      contentType: "text/html; charset=utf-8", body: html(150, mode) }));
    await page.exposeFunction("syntheticClick", () => { clicks++; order.push("click"); });
    await page.exposeFunction("syntheticSecurity", (state) => {
      events++; order.push("event");
      capture(store, "received", `42${JSON.stringify(["api/subscription SECURITY_ARM_STATE_EVENT", {
        data: { location_id: "loc_001", arm_state: state, event_time: "2026-09-01T00:00:01Z" }
      }])}`);
    });
    page.on("close", () => order.push("close"));
    await page.goto("https://my.smartthings.com/location/synthetic-home-monitor");
    return page;
  } };
  const executor = new SmartThingsWebUiCommandExecutor(() => manager, () => "loc_001", {
    onHomeMonitorCardDiagnostic: (item) => cards.push(item)
  });
  const service = new SafeCommandService({ devices: store, status: connected(), timeoutMs: 700,
    resyncAfterMs: 10, resync: () => new Promise(() => undefined),
    executor: { executeLocationAction: async (input) => {
      // Reproduce the old contract with the real page.close() path, not a stubbed close.
      if (ignoreLifetimeHook) {
        const { waitForConfirmation: _unused, ...legacyInput } = input;
        await executor.executeLocationAction(legacyInput);
      } else await executor.executeLocationAction(input);
    } }, onLocationDiagnostic: (item) => diagnostics.push(item) });
  try {
    const command = { targetType: "location", targetId: "loc_001", command: action,
      arguments: [], clientRequestId: `request_${passed}_browser_lifecycle` };
    if (!ignoreLifetimeHook && mode === "correct") {
      assert.equal((await service.execute(command)).status, "confirmed");
      assert.deepEqual(order, ["click", "event", "close"], name);
      assert.equal(events, 1);
      assert.equal(diagnostics.at(-1).observedStateMatches, true);
    } else {
      await assert.rejects(service.execute(command), (error) => error.code === "command_confirmation_timeout", name);
      assert.equal(diagnostics.at(-1).phase, "failed");
      assert.equal(diagnostics.at(-1).observedStateMatches, false);
      if (ignoreLifetimeHook) {
        assert.deepEqual(order, ["click", "close"], "premature close cancels the delayed browser event");
        assert.equal(events, 0);
      }
    }
    assert.equal(clicks, 1, "never retry a potentially dispatched security command");
    assert.equal(cards.at(-1).outcome, "clicked");
    assert.equal(cards.at(-1).htmlModes, 2);
    assert.equal(cards.at(-1).targets, 1);
    assert.ok(pages.every((page) => page.isClosed()), "all command pages closed after settling");
    assert.doesNotMatch(JSON.stringify(diagnostics), /Synthetic|loc_001|cookie|token/u);
    passed++;
    console.log(`PASS ${name}`);
  } finally {
    for (const page of pages) await page.close().catch(() => undefined);
  }
}
try {
  await run("old immediate-close contract reproduces the lost delayed event", { ignoreLifetimeHook: true });
  await run("production service + HTML card keeps page until away event");
  await run("production service + HTML card keeps page until stay event", { action: "armStay" });
  await run("no security event remains a failure and closes the page", { mode: "none" });
  await run("wrong security state remains a failure and closes the page", { mode: "wrong" });
  console.log(`Home Monitor real-browser confirmation fixtures: ${passed} passed`);
} finally { await browser.close(); }
