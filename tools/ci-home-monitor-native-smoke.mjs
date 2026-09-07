import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { SmartThingsWebUiCommandExecutor } from "../dist/bridge/src/browser/command-page.js";
import { SafeCommandService } from "../dist/bridge/src/command/command-service.js";
import { DeviceStore } from "../dist/bridge/src/state/device-store.js";
import { RuntimeStatusStore } from "../dist/bridge/src/state/runtime-state.js";

// The shape/labels mirror the user-supplied card. No account IDs, camera images,
// network credentials or real SmartThings requests are included in this fixture.
const browser = await chromium.launch({ headless: true,
  ...(process.env.STW_TEST_CHROMIUM ? { executablePath: process.env.STW_TEST_CHROMIUM } : {}) });
const context = await browser.newContext();
await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
const modeToCommand = { DISARMED: "disarm", ARMED_STAY: "armStay", ARMED_AWAY: "armAway" };
const allModes = Object.keys(modeToCommand);
let passed = 0;
const timings = [];
function frame(store, direction, payload) {
  store.observe({ __sanitized: true, source: "playwright-websocket-frame", receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload, truncated: false } }, payloadHash: `${direction}:${payload}` });
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
function html(initial, options) {
  return `<!doctype html><meta charset="utf-8"><style>
  section{display:block;width:350px;padding:18px}button{padding:12px;margin:4px}div.status{padding:10px}
  </style><nav><button id="home">Home</button></nav><main><section class="homecard security"></section>
  <section><h2>Other device</h2><button id="other">Disarm</button></section></main><script>
  window.commands=[];window.decorations=0;window.badClicks=0;
  const options=${JSON.stringify(options)};
  const captions={DISARMED:'System ready to arm',ARMED_AWAY:'System armed (away)',ARMED_STAY:'System armed (stay)'};
  const labels=options.language==='ko'?{DISARMED:'보안 해제',ARMED_STAY:'보안(실내)',ARMED_AWAY:'보안(외출)'}:
    {DISARMED:'Disarm',ARMED_STAY:'Arm (stay)',ARMED_AWAY:'Arm (away)'};
  window.render=(mode)=>{
    const choices=mode==='DISARMED'?['ARMED_STAY','ARMED_AWAY']:['DISARMED'];
    document.querySelector('section.homecard.security').innerHTML='<h2>SmartThings Home Monitor</h2>'+
      '<div class="status-container '+(mode==='DISARMED'?'':'armed')+'"><div class="status">'+captions[mode]+
      '</div><svg class="icon" width="40" height="40"><path d="M1 1 L20 20"/></svg><div class="actions">'+
      choices.map(m=>'<button '+(options.noArmingAttributes&&m!=='DISARMED'?'':'data-armstate="'+m+'" data-testid="button-'+m+'"')+
        (options.disabled?' disabled':'')+' data-fixture-mode="'+m+'"><span>'+labels[m]+'</span></button>').join('')+'</div></div>';
  };
  window.render(${JSON.stringify(initial)});
  document.querySelector('#home').onclick=()=>window.badClicks++;
  document.querySelector('#other').onclick=()=>window.badClicks++;
  document.addEventListener('click',async (event)=>{
    if(event.target.closest('.status,svg'))window.decorations++;
    const target=event.target.closest('section.homecard.security > .status-container > .actions > button');
    if(!target||!event.isTrusted)return;
    const mode=target.dataset.fixtureMode;window.commands.push(mode);await window.issued(mode);
    if(!options.freezeUi||mode!=='DISARMED')window.render(mode);
    setTimeout(()=>window.security(mode),60);
  });
  </script>`;
}
async function fixture(initial, options = {}) {
  const store = new DeviceStore();
  frame(store, "sent", '4225["find","api/location",{}]');
  frame(store, "received", `4325[null,${JSON.stringify([
    { locationId: "loc_001", name: "Synthetic Office", armState: initial, updatedAt: "2026-09-01T00:00:00Z" },
    { locationId: "loc_002", name: "Other", armState: "ARMED_AWAY", updatedAt: "2026-09-01T00:00:00Z" }
  ])}]`);
  const actual = await context.newPage();
  await actual.goto("https://my.smartthings.com/location/synthetic-office");
  await actual.setContent(html(initial, options));
  let serial = 0, reads = 0, opens = 0;
  const issued = [], diagnostics = [], observedAtIssue = [];
  const publish = (mode, locationId = "loc_001") => {
    serial++;
    frame(store, "received", `42${JSON.stringify(["api/subscription SECURITY_ARM_STATE_EVENT", {
      data: { location_id: locationId, arm_state: mode,
        event_time: new Date(Date.parse("2026-09-01T00:00:00Z") + serial * 1000).toISOString() }
    }])}`);
  };
  await actual.exposeFunction("issued", (mode) => {
    issued.push(mode); observedAtIssue.push(store.location("loc_001")?.armState);
  });
  await actual.exposeFunction("security", (mode) => {
    if (options.skipEvidence === mode) return;
    publish(mode, options.wrongEvidenceLocation && mode === "DISARMED" ? "loc_002" : "loc_001");
  });
  let keeper = actual;
  if (options.wrongKeeper) {
    keeper = await context.newPage();
    await keeper.goto("https://my.smartthings.com/location/other-office");
    await keeper.setContent(html(initial, {}));
  }
  const manager = { currentKeeper: () => options.owned ? undefined : keeper,
    openCommandPage: async () => { opens++; return actual; } };
  const executor = new SmartThingsWebUiCommandExecutor(() => manager,
    (raw) => raw === "synthetic-office" ? "loc_001" : "loc_002", {
      resolveRawLocationId: (id) => id === "loc_001" ? "synthetic-office" : "other-office",
      onDiagnostic: (value) => diagnostics.push(value)
    });
  const resync = async (request) => {
    reads++;
    if (!options.readProof || request?.locationId !== "loc_001") return undefined;
    return { source: "location_status", locationId: "loc_001", armState: store.location("loc_001")?.armState,
      authoritativeSnapshot: false, startedAtMs: Date.now() };
  };
  const service = new SafeCommandService({ devices: store, status: connected(), timeoutMs: options.timeoutMs ?? 1_500,
    resyncAfterMs: 250, resync, executor,
    onLocationDiagnostic: (value) => diagnostics.push(value.phase) });
  const run = async (target) => service.execute({ targetType: "location", targetId: "loc_001",
    command: modeToCommand[target], arguments: [], clientRequestId: `request_native_${passed}_${target}` });
  return { store, actual, keeper, issued, observedAtIssue, diagnostics, run, publish,
    get reads() { return reads; }, get opens() { return opens; },
    close: async () => { await actual.close().catch(()=>{}); if (keeper !== actual) await keeper.close(); store.close(); } };
}
async function test(name, fn) { await fn(); console.log(`PASS ${++passed} ${name}`); }
try {
  for (const language of ["en", "ko"]) {
    for (const from of allModes) for (const to of allModes.filter((mode) => mode !== from)) {
      await test(`${language} ${from} -> ${to} uses actual buttons and verified stages`, async () => {
        const f = await fixture(from, { language });
        try {
          const time = performance.now();
          const result = await f.run(to);
          const elapsedMs = Math.round(performance.now() - time);
          timings.push({ language, from, to, elapsedMs });
          const expected = from !== "DISARMED" && to !== "DISARMED" ? ["DISARMED", to] : [to];
          assert.equal(result.status, "confirmed"); assert.deepEqual(f.issued, expected);
          assert.equal(f.store.location("loc_001")?.armState, to);
          assert.equal(f.actual.isClosed(), false); assert.equal(f.opens, 0);
          assert.equal(await f.actual.evaluate(()=>window.decorations + window.badClicks), 0);
          if (expected.length === 2) {
            assert.equal(f.observedAtIssue[1], "DISARMED", "rearm requires authoritative intermediate evidence");
            assert(f.diagnostics.includes("transition_disarmed"));
            assert(f.diagnostics.indexOf("transition_disarmed") < f.diagnostics.indexOf("waiting"));
          }
          assert(elapsedMs < 4_000, JSON.stringify(timings.at(-1)));
        } finally { await f.close(); }
      });
    }
  }
  await test("arming labels work without assuming unobserved data-armstate attributes", async () => {
    const f = await fixture("ARMED_AWAY", { noArmingAttributes: true });
    try { await f.run("ARMED_STAY"); assert.deepEqual(f.issued, ["DISARMED", "ARMED_STAY"]); }
    finally { await f.close(); }
  });
  for (const from of allModes) await test(`verified same-state ${from} does not disarm or click`, async()=> {
    const f = await fixture(from, { readProof: true });
    try { assert.equal((await f.run(from)).status,"already_confirmed"); assert.deepEqual(f.issued,[]); assert.equal(f.reads,1); }
    finally { await f.close(); }
  });
  for (const [name, options, code, expected] of [
    ["missing intermediate evidence", { skipEvidence:"DISARMED" }, "command_transition_disarm_failed", ["DISARMED"]],
    ["wrong-location intermediate evidence", { wrongEvidenceLocation:true }, "command_transition_disarm_failed", ["DISARMED"]],
    ["missing final evidence", { skipEvidence:"ARMED_STAY" }, "command_transition_rearm_failed", ["DISARMED","ARMED_STAY"]],
    ["UI does not render target after confirmed disarm", { freezeUi:true }, "command_transition_rearm_failed", ["DISARMED"]]
  ]) await test(name,async()=> {
    const f=await fixture("ARMED_AWAY",{...options,timeoutMs:700,owned:true});
    try {
      const start=performance.now();
      await assert.rejects(f.run("ARMED_STAY"),new RegExp(code));
      assert.deepEqual(f.issued,expected); assert(f.actual.isClosed());
      assert(performance.now()-start<3_000,"two stages must share the confirmation window");
      if(code==="command_transition_rearm_failed") assert.equal(f.store.location("loc_001")?.armState,"DISARMED");
      await new Promise(r=>setTimeout(r,120)); assert.deepEqual(f.issued,expected,"no late replay");
    }finally{await f.close();}
  });
  for(const [name,mutate,code] of [
    ["duplicate native cards",()=>document.querySelector('main').append(document.querySelector('section.security').cloneNode(true)),"command_control_ambiguous"],
    ["blocking modal",()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.textContent='Other dialog';document.body.append(d);},"command_control_not_found"],
    ["unknown state caption",()=>document.querySelector('.status').textContent='System transitioning',"command_control_not_found"],
    ["conflicting action attribute",()=>document.querySelector('[data-armstate]').setAttribute('data-armstate','ARMED_STAY'),"command_control_not_found"],
    ["disabled disarm",()=>document.querySelector('[data-armstate]').disabled=true,"command_transition_disarm_failed"]
  ]) await test(name+" never sends a speculative control",async()=>{
    const f=await fixture("ARMED_AWAY");
    try {await f.actual.evaluate(mutate);await assert.rejects(f.run("ARMED_STAY"),new RegExp(code));assert.deepEqual(f.issued,[]);}
    finally{await f.close();}
  });
  await test("wrong-location keeper is untouched and owned transition tab is cleaned up",async()=>{
    const f=await fixture("ARMED_AWAY",{wrongKeeper:true});
    try {await f.run("ARMED_STAY");assert.equal(f.opens,1);assert(f.actual.isClosed());assert(!f.keeper.isClosed());
      assert.deepEqual(await f.keeper.evaluate(()=>window.commands),[]);assert.deepEqual(f.issued,["DISARMED","ARMED_STAY"]);}
    finally{await f.close();}
  });
  console.log(JSON.stringify({suite:"native-security-card",passed,timings,scope:"synthetic Chromium and real command service; not Samsung live account"}));
} finally { await context.close(); await browser.close(); }


// Verify the production direct-only Home Monitor route as well.
await import("./ci-home-monitor-direct-smoke.mjs");
