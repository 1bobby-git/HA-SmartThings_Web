import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { SmartThingsWebUiCommandExecutor } from "../dist/bridge/src/browser/command-page.js";
import { SafeCommandService } from "../dist/bridge/src/command/command-service.js";
import { DeviceStore } from "../dist/bridge/src/state/device-store.js";
import { RuntimeStatusStore } from "../dist/bridge/src/state/runtime-state.js";
import { readLocationSecurityStatus } from "../dist/bridge/src/browser/location-status.js";

// All pages and requests are synthetic; no Samsung credentials, devices or public services are used.
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
let passed = 0;
function frame(store, direction, text) {
  store.observe({ __sanitized: true, source: "playwright-websocket-frame", receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload: text, truncated: false } }, payloadHash: `${direction}:${text}` });
}
function storeFixture() {
  const store = new DeviceStore();
  frame(store, "sent", '4225["find","api/location",{}]');
  frame(store, "received", '4325[null,[{"locationId":"loc_001","name":"Office","armState":"DISARMED","updatedAt":"2026-09-01T00:00:00Z"}]]');
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
const html = `<meta charset="utf-8"><style>section{width:440px;padding:20px}button{padding:16px}</style>
<section><h2>SmartThings Home Monitor</h2><p>System ready to arm</p>
<button id="stay">보안(실내)</button><button id="away">보안(외출)</button><button id="off">보안 해제</button></section>
<script>for (const [id, mode] of [['stay','STAY'],['away','AWAY'],['off','OFF']]) {
 document.getElementById(id).onclick = (event) => { if (event.isTrusted) {
  window.clicked(mode); setTimeout(() => window.security(mode), 60);
 }};
}</script>`;
async function syntheticPage(body = html, path = "office-001") {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body }));
  if (process.env.STW_TEST_OFFLINE === "1") {
    // Local DOM-only harness for environments that disallow all URL navigation.
    // CI uses intercepted navigation above; this does not access the real origin.
    await page.setContent(body);
    page.url = () => `https://my.smartthings.com/location/${path}`;
  } else await page.goto(`https://my.smartthings.com/location/${path}`);
  return page;
}
const timings = [];
async function keeperCommands() {
  const store = storeFixture();
  const page = await syntheticPage();
  let clicks = 0, serial = 0, opens = 0;
  const diagnostics = [];
  await page.exposeFunction("clicked", () => { clicks++; });
  await page.exposeFunction("security", (value) => {
    serial++;
    frame(store, "received", `42${JSON.stringify(["api/subscription SECURITY_ARM_STATE_EVENT", {
      data: { location_id: "loc_001", arm_state: value,
        event_time: new Date(Date.parse("2026-09-01T00:00:00Z") + serial * 1000).toISOString() }
    }])}`);
    // Reproduce the real command-status resync race: metadata must not clear the event.
    store.observeAdvancedInventorySnapshot({ locations: [{ locationId: "loc_001", name: "Office" }] });
  });
  const executor = new SmartThingsWebUiCommandExecutor(() => ({ currentKeeper: () => page,
    openCommandPage: async () => { opens++; throw new Error("unexpected fresh page"); }
  }), (raw) => raw === "office-001" ? "loc_001" : "loc_002", {
    onDiagnostic: (value) => diagnostics.push(value)
  });
  let rechecks = 0;
  const service = new SafeCommandService({ devices: store, status: connected(), timeoutMs: 1200,
    resyncAfterMs: 300, resync: async () => { rechecks++; return undefined; }, executor });
  for (const action of ["armAway", "disarm", "armStay", "disarm", "armAway", "armStay"]) {
    const start = performance.now();
    const result = await service.execute({ targetType: "location", targetId: "loc_001", command: action,
      arguments: [], clientRequestId: `request_reused_${serial}_${action}` });
    timings.push({ action, elapsedMs: Math.round(performance.now() - start) });
    assert.equal(result.status, "confirmed");
    assert.equal(page.isClosed(), false, "borrowed keeper is never closed");
  }
  assert.equal(clicks, 6); assert.equal(opens, 0); assert.equal(rechecks, 0);
  assert.equal(diagnostics.filter((v) => v === "home_monitor_keeper_reused").length, 6);
  console.log(`ok ${++passed} - six consecutive real-pointer commands reuse the exact keeper and confirm enum variants`);
  await page.close(); store.close();
}
async function otherLocation() {
  const keeper = await syntheticPage(html, "other-location");
  let keeperClicks = 0, opens = 0, commandClicks = 0;
  await keeper.exposeFunction("clicked", () => { keeperClicks++; });
  await keeper.exposeFunction("security", () => undefined);
  let owned;
  const executor = new SmartThingsWebUiCommandExecutor(() => ({ currentKeeper: () => keeper,
    openCommandPage: async () => { opens++; owned = await syntheticPage();
      await owned.exposeFunction("clicked", () => { commandClicks++; });
      await owned.exposeFunction("security", () => undefined); return owned; }
  }), (id) => id === "office-001" ? "loc_001" : "loc_002");
  await executor.executeLocationAction({ locationId: "loc_001", action: "armAway", waitForConfirmation: async () => undefined });
  assert.equal(keeperClicks, 0); assert.equal(opens, 1); assert.equal(commandClicks, 1);
  assert.equal(keeper.isClosed(), false); assert.equal(owned.isClosed(), true);
  console.log(`ok ${++passed} - wrong-location keeper is neither clicked nor navigated; owned fallback is cleaned up`);
  await keeper.close();
}
async function reader() {
  const page = await syntheticPage("<p>Synthetic location status reader</p>");
  await page.evaluate(() => {
    window.reads = 0; window.writes = 0;
    window.response = { id: "office-001", armState: "STAY", updatedAt: "2026-09-01T00:00:01Z", secret: "must-not-leave-page" };
    window[Symbol.for("smartthings_web_bridge.cake_client")] = { service: (name) => {
      if (name !== "api/location") throw Error("wrong service");
      return { get: async (id) => { window.reads++; if (id !== "office-001") throw Error("wrong id"); return window.response; },
        patch: () => { window.writes++; throw Error("write attempted"); } };
    } };
  });
  assert.deepEqual(await readLocationSecurityStatus(page, "office-001"), {
    locationId: "office-001", armState: "STAY", updatedAt: "2026-09-01T00:00:01Z"
  });
  assert.equal(await page.evaluate(() => window.writes), 0);
  console.log(`ok ${++passed} - scoped native read returns only exact location security data`);
  await page.evaluate(() => { window.response.id = "other-location"; });
  assert.equal(await readLocationSecurityStatus(page, "office-001"), undefined);
  console.log(`ok ${++passed} - wrong location response is rejected`);
  await page.evaluate(() => { window.response.id = "office-001"; window.response.armState = "ARMING"; });
  assert.equal(await readLocationSecurityStatus(page, "office-001"), undefined);
  console.log(`ok ${++passed} - pending mode is not a completed security mode`);
  await page.evaluate(() => {
    window[Symbol.for("smartthings_web_bridge.cake_client")] = { service: () => ({ get: () => new Promise(() => {}) }) };
  });
  const start = performance.now();
  assert.equal(await readLocationSecurityStatus(page, "office-001", 30), undefined);
  assert.ok(performance.now() - start < 1000, "hung read must remain bounded");
  console.log(`ok ${++passed} - hung read does not block command confirmation`);
  await page.evaluate(() => { delete window[Symbol.for("smartthings_web_bridge.cake_client")]; });
  assert.equal(await readLocationSecurityStatus(page, "office-001"), undefined);
  console.log(`ok ${++passed} - unavailable existing client is not replaced with a new connection`);
  await page.close();
}
try {
  await keeperCommands(); await otherLocation(); await reader();
  console.log(JSON.stringify({ syntheticOnly: true, passed, timings, freshPageOpensForSixCommands: 0 }));
} finally { await browser.close(); }
