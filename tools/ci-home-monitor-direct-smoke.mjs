import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { LocationSecurityCommandExecutor } from "../dist/bridge/src/browser/location-security-command.js";
import { AdvancedFirstCommandExecutor } from "../dist/bridge/src/command/advanced-first-executor.js";
import { SafeCommandService } from "../dist/bridge/src/command/command-service.js";
import { DeviceStore } from "../dist/bridge/src/state/device-store.js";
import { RuntimeStatusStore } from "../dist/bridge/src/state/runtime-state.js";

const browser = await chromium.launch({headless:true,
  ...(process.env.STW_TEST_CHROMIUM ? {executablePath:process.env.STW_TEST_CHROMIUM} : {})});
const modes = {DISARMED:"disarm",ARMED_STAY:"armStay",ARMED_AWAY:"armAway"};
let passed=0;
const timings=[];
const frame=(store,direction,payload)=>store.observe({__sanitized:true,source:"playwright-websocket-frame",
  receivedAt:new Date().toISOString(),payload:{direction,frame:{payload,truncated:false}},payloadHash:`${direction}:${payload}`});
function connected() {
  const now=Date.now();
  return new RuntimeStatusStore({now:()=>now,initial:{state:"CONNECTED",chromiumRunning:true,keeperPresent:true,
    authenticated:true,pushConnected:true,parserHealthy:true,initialSnapshotComplete:true,dbAvailable:true,
    heartbeatAtMs:now,initialSnapshotCompletedAtMs:now,lastSnapshotAtMs:now,lastParserSuccessAtMs:now,lastPushAtMs:now}});
}
async function fixture(initial,options={}) {
  const context=await browser.newContext();
  // Every request is intercepted. No real account, cookie or SmartThings network is used.
  await context.route("**/*",route=>route.fulfill({contentType:"text/html",body:"<!doctype html><body>No Home Monitor markup</body>"}));
  const store=new DeviceStore();
  frame(store,"sent",'4225["find","api/location",{}]');
  frame(store,"received",`4325[null,${JSON.stringify([{locationId:"loc_001",name:"Synthetic",armState:initial,updatedAt:"2026-09-01T00:00:00Z"},
    {locationId:"loc_002",name:"Other",armState:initial,updatedAt:"2026-09-01T00:00:00Z"}])}]`);
  let serial=0,request=0,opens=0,reads=0;
  const issued=[],diagnostics=[],pages=[];
  function publish(mode,locationId="loc_001") {
    frame(store,"received",`42${JSON.stringify(["api/subscription SECURITY_ARM_STATE_EVENT",{data:{location_id:locationId,arm_state:mode,
      event_time:new Date(Date.parse("2026-09-01T00:00:00Z")+(++serial)*1000).toISOString()}}])}`);
  }
  await context.exposeFunction("issued",(id,body)=>issued.push({id,body}));
  await context.exposeFunction("security",(mode,wrong)=>publish(mode,wrong?"loc_002":"loc_001"));
  async function makePage(owned=false) {
    const page=await context.newPage();pages.push(page);
    await page.goto(options.invalidOrigin?"https://example.invalid/location/test":"https://my.smartthings.com/location/other-visible-location");
    await page.evaluate(({options,owned})=>{
      window.badClicks=0;document.addEventListener("click",()=>window.badClicks++);
      const install=()=>{
        window[Symbol.for("smartthings_web_bridge.cake_client")]= {service:(name)=>{
          if(name!=="api/location")throw new Error("incorrect service");
          return {patch:async (id,body)=>{
            if(id!=="synthetic-office"||JSON.stringify(Object.keys(body).sort())!==JSON.stringify(["armState","patchType"])||body.patchType!=="armStateChange")
              throw new Error("incorrect request contract");
            await window.issued(id,body);
            if(options.rejectCode)throw {code:options.rejectCode,message:"DO_NOT_LOG_PRIVATE_RESPONSE"};
            if(options.noReceipt){
              if(options.eventWithoutReceipt)setTimeout(()=>window.security(body.armState,false),30);
              return await new Promise(resolve=>{window.finishRequest=resolve;});
            }
            if(!options.noEvent)setTimeout(()=>window.security(body.armState,options.wrongEvent),30);
            return {}; // Acknowledgement alone is deliberately not final state evidence.
          }};
        }};
      };
      if(!options.noClient && !(options.bootstrap && !owned)) {
        if(options.lateClient)setTimeout(install,options.lateClient);else install();
      }
    },{options,owned});
    return page;
  }
  const keeper=options.noKeeper?undefined:await makePage();
  const manager={currentKeeper:()=>keeper,openCommandPage:async (id)=>{assert.equal(id,"synthetic-office");opens++;return await makePage(true);}};
  const direct=new LocationSecurityCommandExecutor({getManager:()=>manager,
    resolveRawLocationId:()=>options.badRawId?"../not-a-location":"synthetic-office",
    requestTimeoutMs:options.requestMs??500,onDiagnostic:value=>diagnostics.push(value)});
  let dom=0,advanced=0;
  const executor=new AdvancedFirstCommandExecutor({name:"advanced",execute:async()=>{advanced++;throw new Error("device path forbidden");}},
    {executeDeviceAction:async()=>{dom++;},executeLocationAction:async()=>{dom++;throw new Error("DOM fallback forbidden");}},
    {locationExecutor:direct});
  const service=new SafeCommandService({devices:store,status:connected(),timeoutMs:options.confirmMs??700,resyncAfterMs:80,
    resync:async (input)=>{reads++;return options.readProof&&input?.locationId==="loc_001"?
      {source:"location_status",locationId:"loc_001",armState:store.location("loc_001")?.armState,authoritativeSnapshot:false,startedAtMs:Date.now()}:undefined;},executor});
  const run=(mode)=>service.execute({targetType:"location",targetId:"loc_001",command:modes[mode],arguments:[],clientRequestId:`request_direct_${++request}`});
  return {store,keeper,context,pages,issued,diagnostics,run,publish,direct,
    get opens(){return opens;},get reads(){return reads;},get dom(){return dom;},get advanced(){return advanced;},
    async close(){await context.close();store.close();}};
}
async function test(name,fn){await fn();console.log(`PASS direct ${++passed} ${name}`);}
try {
  for(const from of Object.keys(modes))for(const to of Object.keys(modes).filter(m=>m!==from)) {
    await test(`${from} -> ${to}: one direct request, no intermediate disarm or markup`,async()=>{
      const f=await fixture(from);
      try {
        const start=performance.now();const result=await f.run(to);
        timings.push({from,to,elapsedMs:Math.round(performance.now()-start)});
        assert.equal(result.status,"confirmed");assert.equal(result.transport,"location_native");
        assert.deepEqual(f.issued,[{id:"synthetic-office",body:{patchType:"armStateChange",armState:to}}]);
        assert.equal(f.store.location("loc_001")?.armState,to);assert.equal(f.store.location("loc_002")?.armState,from);
        assert.equal(f.opens,0);assert.equal(f.dom+f.advanced,0);assert.equal(f.keeper.isClosed(),false);
        assert.equal(await f.keeper.evaluate(()=>window.badClicks),0);assert(timings.at(-1).elapsedMs<2000);
      }finally{await f.close();}
    });
  }
  for(const mode of Object.keys(modes))await test(`fresh ${mode} proof skips redundant write`,async()=>{
    const f=await fixture(mode,{readProof:true});
    try{assert.equal((await f.run(mode)).status,"already_confirmed");assert.equal(f.issued.length,0);assert.equal(f.reads,1);}
    finally{await f.close();}
  });
  for(const options of [{bootstrap:true},{noKeeper:true},{bootstrap:true,lateClient:450}])await test(`client bootstrap ${JSON.stringify(options)} without DOM`,async()=>{
    const f=await fixture("ARMED_AWAY",options);
    try{assert.equal((await f.run("ARMED_STAY")).status,"confirmed");assert.equal(f.opens,1);assert.equal(f.issued.length,1);
      assert(f.pages.at(-1).isClosed());if(f.keeper)assert(!f.keeper.isClosed());assert.equal(f.dom,0);}
    finally{await f.close();}
  });
  for(const [name,options,code,count] of [
    ["no event",{noEvent:true},"command_confirmation_timeout",1],
    ["wrong-location event",{wrongEvent:true},"command_confirmation_timeout",1],
    ["authentication refusal",{rejectCode:401},"command_login_required",1],
    ["permission refusal",{rejectCode:403},"command_security_permission_denied",1],
    ["server validation refusal",{rejectCode:422},"command_execution_failed",1],
    ["missing captured client",{noClient:true},"command_security_unavailable",0],
    ["invalid raw identity",{badRawId:true},"command_location_unknown",0],
    ["untrusted origin",{invalidOrigin:true},"command_security_unavailable",0]
  ])await test(name+" never falls back to a click or second write",async()=>{
    const f=await fixture("ARMED_AWAY",options);
    try{await assert.rejects(f.run("ARMED_STAY"),new RegExp(code));assert.equal(f.issued.length,count);
      assert.equal(f.dom+f.advanced,0);assert.equal(f.store.location("loc_001")?.armState,"ARMED_AWAY");
      assert(!f.diagnostics.join(" ").includes("DO_NOT_LOG_PRIVATE_RESPONSE"));}
    finally{await f.close();}
  });
  await test("unresolved mutation blocks replay even after timeout",async()=>{
    const f=await fixture("ARMED_AWAY",{noReceipt:true,requestMs:100,confirmMs:150});
    try{await assert.rejects(f.run("ARMED_STAY"),/command_security_dispatch_uncertain/);
      await assert.rejects(f.run("DISARMED"),/command_security_busy/);assert.equal(f.issued.length,1);assert.equal(f.opens,0);}
    finally{await f.close();}
  });
  await test("fresh event confirms a lost acknowledgement without replay",async()=>{
    const f=await fixture("ARMED_AWAY",{noReceipt:true,eventWithoutReceipt:true,requestMs:100});
    try{assert.equal((await f.run("ARMED_STAY")).status,"confirmed");assert.equal(f.issued.length,1);assert.equal(f.opens,0);}
    finally{await f.close();}
  });
  await test("queued opposite requests preserve order and do not introduce disarm",async()=>{
    const f=await fixture("DISARMED");
    try{await Promise.all([f.run("ARMED_STAY"),f.run("ARMED_AWAY")]);
      assert.deepEqual(f.issued.map(x=>x.body.armState),["ARMED_STAY","ARMED_AWAY"]);assert.equal(f.store.location("loc_001")?.armState,"ARMED_AWAY");}
    finally{await f.close();}
  });
  console.log(JSON.stringify({suite:"direct-location-security",passed,timings,scope:"synthetic Chromium, actual router and command confirmation; not live Samsung account"}));
}finally{await browser.close();}
