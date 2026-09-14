import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { installCakeClientCapture } from '../dist/bridge/src/browser/cake-client-capture.js';
import { NativeSessionMaintenance } from '../dist/bridge/src/browser/native-session-maintenance.js';
import { ensureNativeKeepSignedIn } from '../dist/bridge/src/browser/native-login-policy.js';

// Original synthetic application only: no Samsung account, captured credentials,
// third-party bundle copies or real upstream requests. Exercise the actual init
// scripts, naturally loaded webpack capture, Redux action and delayed callback.
const target = 'https://my.smartthings.com/location/fixture-home';
const browser = await chromium.launch({headless:true,
  ...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),
  args:['--no-sandbox','--proxy-server=http://127.0.0.1:9','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost']});
let passed = 0;
const source = mode => `<!doctype html><meta charset="utf-8"><style>[data-testid="toggle-switch-stayLoggedIn"]{width:40px;height:24px;display:inline-block}</style><button id="settings" aria-label="App settings">Menu</button><main>Fixture</main><script>
const mode=${JSON.stringify(mode)};
const epochNow=Date.now()/1000;
const root={user:{user:{uuid:'fixture-user',session:{stayLoggedIn:mode.effective??true,exp:epochNow+(mode.near?120:3600)}}},
  ui:{settings:{user:{stayLoggedIn:mode.ui??true,sessionLength:28800}},cookieConsent:{functionality_settings:false}},
  client:{socketConnected:true,socketAuthenticated:true}};
const calls={renew:0,proof:0,logout:0,support:0,unrelated:0};
const originalNow=performance.now.bind(performance); let shift=0; performance.now=()=>originalNow()+shift;
const factories={
  'random-store':function(module,exports,require) {
    // serializableCheck deviceHealth: socketAuthenticated
    exports.renamed={getState:()=>root,subscribe:()=>()=>{},dispatch:action=>action()};
  },
  'random-client':function(module,exports,require) {
    // cake_session api/device api/subscription
    exports.initialize=()=>{const implementation=async function(args){
  // The production method is assigned during initClient, after module exports.
  // It catches errors and returns before the authenticate acknowledgement.
  const {sessionLength,stayLoggedIn}=args;calls.renew++;
  try{await client.service("api/auth").create({sessionLength,stayLoggedIn,extend:args.extend});
    if(!mode.noAck)setTimeout(()=>{
      root.user.user={uuid:'fixture-user',session:{stayLoggedIn,exp:mode.sameExpiry?root.user.user.session.exp:Date.now()/1000+7200}};
      root.client.socketAuthenticated=true;
    },mode.delay??500);
  }catch{}
};
client.reauthenticate=(function(){return function(args){return implementation.apply(this,arguments);};})();
    };
    exports.renamed={service:name=>name==='api/location'?{get:async(id)=>{calls.proof++;if(mode.proof401)throw{code:401};return{locationId:id};}}:
      {create:async(args)=>{if(mode.swallow)throw{code:401};return args;}}};
  },
  'random-user':function(module,exports,require) {
    // user/setLogoutTimer user/reauthenticate
    exports.renamed=Object.assign(args=>()=>{client.reauthenticate({...root.ui.settings.user,extend:args.extend});},{typePrefix:'user/reauthenticate'});
  },
  'random-settings':function(module,exports,require) {
    // ui.slice.actions/updateStayLoggedIn functionality_settings
    exports.renamed=Object.assign(args=>()=>{root.ui.settings.user.stayLoggedIn=args.enabled;store.dispatch(renew({extend:false}));},{typePrefix:'ui.slice.actions/updateStayLoggedIn'});
  },
  unrelated:function(module){calls.unrelated++;module.exports={};}
};
const cache={};function require(id){if(!cache[id]){const module={exports:{}};cache[id]=module;require.m[id](module,module.exports,require);}return cache[id].exports;}
require.m=factories;
const chunks=window.webpackChunk_smartthings_cake;
chunks.push=function(entry){Object.assign(require.m,entry[1]);if(entry[2])entry[2](require);return 1;};
const store=require('random-store').renamed,client=require('random-client').renamed,renew=require('random-user').renamed,pref=require('random-settings').renamed;
const initializeClient=require('random-client').initialize;
initializeClient();
function openDialog(){if(document.querySelector('[role=dialog]'))return;
 document.body.insertAdjacentHTML('beforeend','<div role="dialog" aria-modal="true" aria-label="SmartThings 설정"><h1>SmartThings 설정</h1><div>SmartThings 웹</div><div><span id="keep-signed-in-lb">로그인 유지</span><input type="checkbox" id="stayLoggedIn" readonly style="opacity:0;position:absolute"><button data-testid="toggle-switch-stayLoggedIn" role="switch" aria-labelledby="keep-signed-in-lb"></button></div><div>SmartThings Support</div><label>Account data access<input id="support" type="checkbox"></label><button id="logout">로그아웃</button></div>');
 const toggle=document.querySelector('[data-testid=toggle-switch-stayLoggedIn]');
 const display=()=>{toggle.setAttribute('aria-checked',String(root.ui.settings.user.stayLoggedIn));document.querySelector('#stayLoggedIn').checked=root.ui.settings.user.stayLoggedIn;};
 display();toggle.onclick=()=>{store.dispatch(pref({enabled:!root.ui.settings.user.stayLoggedIn}));display();};
 document.querySelector('#support').onchange=()=>calls.support++;document.querySelector('#logout').onclick=()=>calls.logout++;
}
document.querySelector('#settings').onclick=()=>{const b=document.createElement('button');b.setAttribute('role','menuitem');b.textContent='Settings';b.onclick=openDialog;document.body.append(b);};
window.fixture={root,calls,renew:()=>client.reauthenticate({...root.ui.settings.user,extend:true}),advance:ms=>shift+=ms,open:openDialog};
</script>`;
async function scenario(name, mode, run) {
  const context=await browser.newContext();
  await installCakeClientCapture(context);
  await context.route('**/*',route=>{
    assert.equal(route.request().method(),'GET');
    return route.request().url()===target?route.fulfill({contentType:'text/html; charset=utf-8',body:source(mode)}):route.abort();
  });
  const page=await context.newPage();await page.goto(target);
  const controller=new NativeSessionMaintenance();
  const options={enabled:true,canRun:()=>true,current:()=>!page.isClosed(),force:true};
  const maintain=()=>controller.run(page,options);
  const data=()=>page.evaluate(()=>({calls:window.fixture.calls,snapshot:window[Symbol.for('smartthings_web_bridge.native_session')].read()}));
  try{
    assert.equal((await data()).snapshot.available,true,'natural webpack capture must supply validated native capabilities');
    await run({page,context,maintain,data,controller,options});
    const d=await data();assert.equal(d.calls.support,0);assert.equal(d.calls.logout,0);assert.equal(d.calls.unrelated,0,'do not execute unrelated webpack factories');
    assert.equal(context.pages().length,1,'normal native work must not create tabs');
    console.log('PASS',++passed,name);
  }finally{await context.close();}
}
try{
 await scenario('healthy effective state verifies native Location without renewing or replacing document',{},async({maintain,data})=>{
   assert.equal((await maintain()).observation.state,'active');assert.equal((await data()).calls.renew,0);assert.equal((await data()).calls.proof,1);
 });
 await scenario('UI ON/effective OFF waits for final acknowledgement and independent proof',{effective:false},async({page,maintain,data})=>{
   assert.equal((await maintain()).observation.state,'renewing');
   assert.equal((await data()).snapshot.sessionKeepSignedIn,false);
   assert.equal((await maintain()).observation.state,'renewing');assert.equal((await data()).calls.renew,1);
   await page.waitForTimeout(650);assert.equal((await maintain()).observation.state,'active');assert.equal((await data()).snapshot.sessionKeepSignedIn,true);
 });
 await scenario('real setting action is used despite functionality-storage consent OFF',{ui:false,effective:false},async({page,maintain,data})=>{
   await maintain();assert.equal((await data()).snapshot.uiKeepSignedIn,true);await page.waitForTimeout(650);
   assert.equal((await maintain()).observation.state,'active');assert.equal((await data()).snapshot.storageAllowed,false);
 });
 await scenario('same expiry is applied, never falsely called an extension',{effective:false,sameExpiry:true},async({page,maintain})=>{
   await maintain();await page.waitForTimeout(650);assert.equal((await maintain()).observation.reason,'applied');
 });
 await scenario('near expiry uses native extension and verifies a newer expiry',{near:true},async({page,maintain,data})=>{
   await maintain();await page.waitForTimeout(650);assert.equal((await maintain()).observation.reason,'renewed');assert.equal((await data()).calls.renew,1);
 });
 await scenario('resolved native Promise without authenticate callback is not success',{effective:false,noAck:true},async({page,maintain})=>{
   await maintain();await page.evaluate(()=>window.fixture.advance(36_000));
   assert.deepEqual((await maintain()).observation.reason,'unconfirmed');
 });
 await scenario('swallowed native service error is not a successful renewal',{effective:false,swallow:true},async({page,maintain})=>{
   await maintain();await page.evaluate(()=>window.fixture.advance(36_000));assert.equal((await maintain()).handled,false);
 });
 await scenario('native automatic renewal is not duplicated',{near:true},async({page,maintain,data})=>{
   await page.evaluate(()=>window.fixture.renew());assert.equal((await maintain()).observation.state,'renewing');
   assert.equal((await data()).calls.renew,1);await page.waitForTimeout(650);assert.equal((await maintain()).observation.state,'active');
 });
 await scenario('401 proof remains an auth rejection even with ON indicators',{proof401:true},async({maintain,data})=>{
   assert.equal((await maintain()).authenticationRejected,true);assert.equal((await data()).calls.renew,0);
 });
 await scenario('pending commands and visible settings modal defer supplemental work',{effective:false},async({page,maintain,data,controller,options})=>{
   assert.equal((await controller.run(page,{...options,canRun:()=>false})).observation.reason,'deferred');
   await page.evaluate(()=>window.fixture.open());assert.equal((await maintain()).observation.reason,'deferred');assert.equal((await data()).calls.renew,0);
 });
 await scenario('DOM fallback waits for native apply before any cleanup reload',{ui:false,effective:false,delay:650},async({page,data})=>{
   let reloads=0;
   const proxy=new Proxy(page,{get(target,key){if(key==='goto')return async()=>{
     assert.equal((await data()).snapshot.sessionKeepSignedIn,true,'optimistic UI ON must not authorize premature reload');
     reloads++;await page.evaluate(()=>document.querySelector('[role=dialog]')?.remove());
   };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   const result=await ensureNativeKeepSignedIn(proxy,target,{enabled:true});
   assert.equal(result.clean,true,JSON.stringify({result,reloads,evidence:await data()}));assert.equal(result.report.state,'enabled');assert.ok(reloads>=1);
 });
 await scenario('late renderer operation cannot perform an expired begin request',{effective:false},async({page,controller,options,data})=>{
   const proxy=new Proxy(page,{get(target,key){if(key==='evaluate')return (fn,args)=>{
     if(args?.action==='begin')return target.evaluate(fn,{...args,deadline:Date.now()-1});
     return target.evaluate(fn,args);
   };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   assert.equal((await controller.run(proxy,options)).handled,false);assert.equal((await data()).calls.renew,0);
 });
 console.log(JSON.stringify({suite:'verified-native-session',passed,scope:'isolated synthetic Chromium; no live Samsung account or wall-clock 8/24-hour soak'}));
}finally{await browser.close();}
