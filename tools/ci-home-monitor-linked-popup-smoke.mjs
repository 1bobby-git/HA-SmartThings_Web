import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { SmartThingsWebUiCommandExecutor } from '../dist/bridge/src/browser/command-page.js';
import { clickCurrentHomeMonitorMode } from '../dist/bridge/src/browser/home-monitor-dom.js';
import { clickHomeMonitorDialogAction, probeHomeMonitorDialog } from '../dist/bridge/src/browser/home-monitor-dialog.js';
const titles=['SmartThings Home Monitor','Home Monitor'];
const groups=[['Arm away','Armed away','Away','보안(외출)'],['Arm stay','Armed stay','Stay','보안(실내)'],['Disarm','Disarmed','Off','해제']];
const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext();
// Every request is intercepted. No Samsung account or physical device is used.
await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
let passed=0;
const fixture=({role='listbox',stay='보안(실내)',current='Armed away',from='armAway',link='controls',disabled=false}={})=>`<!doctype html><style>section,div{padding:8px}button,span{display:inline-block}</style>
<nav><button id="unrelated-home">Home</button></nav><main><section><h2>Home Monitor</h2><button id="mode" aria-haspopup="${role==='dialog'?'dialog':'listbox'}" aria-expanded="false" ${link==='controls'?'aria-controls="choices"':''}>${current}</button></section><section><h2>Devices</h2><button>Off</button></section></main>
<script>window.actions=[];window.opens=0;document.querySelector('#mode').onclick=()=>{
 window.opens++;document.querySelector('#mode').setAttribute('aria-expanded','true');
 const p=document.createElement('div');p.id='choices';${role?`p.setAttribute('role',${JSON.stringify(role)});`:''}
 ${link==='labelledby'?`p.setAttribute('aria-labelledby','mode');`:''}
 p.innerHTML=${JSON.stringify([['armAway','Arm away'],['armStay',stay],['disarm','Disarm']].filter(([cmd])=>cmd!==from).map(([cmd,label])=>`<button data-mode="${cmd}" ${disabled&&cmd==='armStay'?'disabled':''}><span>${label}</span></button>`).join(''))};
 p.onclick=e=>{const b=e.target.closest('[data-mode]');if(b){window.actions.push(b.dataset.mode);p.remove();document.querySelector('#mode').setAttribute('aria-expanded','false');}};document.body.appendChild(p);
};document.querySelector('#unrelated-home').onclick=()=>window.actions.push('WRONG_NAVIGATION');</script>`;
async function test(name,run){await run();passed++;console.log('PASS '+name);}
async function execute(html,action='armStay'){
 let page;const traces=[];
 const manager={openCommandPage:async()=>{const native=await context.newPage();await native.setContent(html);page=new Proxy(native,{get(target,key){if(key==='url')return ()=> 'https://my.smartthings.com/location/synthetic-location';const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});return page;}};
 const executor=new SmartThingsWebUiCommandExecutor(()=>manager,()=> 'loc_001',{
  resolveRawLocationId:()=> 'synthetic-location',onDiagnostic:s=>traces.push(s)
 });
 const start=Date.now();let evidence;
 await executor.executeLocationAction({action,locationId:'loc_001',waitForConfirmation:async()=>{
  evidence=await page.evaluate(()=>({actions:window.actions,opens:window.opens}));assert.deepEqual(evidence.actions,[action]);
 }});
 assert(page.isClosed());return {evidence,elapsed:Date.now()-start,traces};
}
try{
 for(const role of ['dialog','listbox','menu','']){
  await test(`linked two-alternative ${role||'roleless'} popup runs Stay once`,async()=>{
   const r=await execute(fixture({role}));assert.equal(r.evidence.opens,1);assert(r.elapsed<4000,JSON.stringify(r));
  });
 }
 for(const stay of ['Home','Arm home','Armed (Home)','집','보안(실내)']){
  await test(`scoped localized Stay alias: ${stay}`,async()=>{
   const r=await execute(fixture({stay}));assert.equal(r.evidence.opens,1);assert(r.elapsed<4000,JSON.stringify(r));
  });
 }
 await test('reverse aria-labelledby relationship is followed',async()=>{
  assert.equal((await execute(fixture({link:'labelledby'}))).evidence.opens,1);
 });
 for(const [from,current] of [['armAway','Armed away'],['armStay','Armed stay'],['disarm','Disarmed']]){
  for(const to of ['armAway','armStay','disarm'].filter(a=>a!==from)){
   await test(`${from} -> ${to} never sends an intermediate mode`,async()=>{
    const r=await execute(fixture({from,current}),to);assert.equal(r.evidence.opens,1);
   });
  }
 }
 for(const [name,html,kind] of [
  ['titleless two-mode unlinked modal is rejected','<div role="dialog"><button>Arm stay</button><button>Disarm</button></div>','unrecognized'],
  ['unlinked listbox is not a monitor selector','<div role="listbox"><button>Arm stay</button><button>Disarm</button></div>','missing'],
 ]){
  await test(name,async()=>{const p=await context.newPage();await p.setContent(html);
   const r=await p.evaluate(probeHomeMonitorDialog,{markerId:'test',monitorLabels:titles,modeLabelGroups:groups,requestedGroup:1,phase:'select'});
   assert.equal(r.kind,kind);await p.close();
  });
 }
 for(const [name,alter,expected] of [
  ['other dialog blocks a linked menu',()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.textContent='Unrelated confirmation';document.body.append(d);},'ambiguous'],
  ['two distinct Stay buttons remain ambiguous',()=>{const b=document.createElement('button');b.textContent='Arm stay';document.querySelector('#choices').append(b);},'ambiguous'],
  ['disabled Stay is not clicked',()=>document.querySelector('[data-mode="armStay"]').disabled=true,'not_found'],
  ['closed owner rejects stale popup',()=>document.querySelector('#mode').setAttribute('aria-expanded','false'),'unavailable'],
 ]){
  await test(name,async()=>{const p=await context.newPage();await p.setContent(fixture());
   assert.equal(await clickCurrentHomeMonitorMode(p,titles,groups,500,'test-owner'),'clicked');
   await p.evaluate(alter);
   const result=await clickHomeMonitorDialogAction(p,titles,groups[1],groups,250,false,undefined,'test-owner');
   assert.equal(result,expected);assert.deepEqual(await p.evaluate(()=>window.actions),[]);await p.close();
  });
 }
 console.log(`Home Monitor linked popup smoke: ${passed} passed; synthetic browser only`);
}finally{await browser.close();}
