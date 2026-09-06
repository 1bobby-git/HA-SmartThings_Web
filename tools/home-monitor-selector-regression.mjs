import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright-core');
const baseline=undefined;
const oldExecutor=undefined;
const candidate=await import('../dist/bridge/src/browser/home-monitor-dom.js');
const newExecutor=await import('../dist/bridge/src/browser/command-page.js');
// All requests are intercepted. No Samsung account or physical commands are used.
const groups=[['Arm away','Armed away','Armed (Away)','Away','보안(외출)'],['Arm stay','Armed stay','Armed (Stay)','Stay','보안(실내)'],['Off','Disarm','Disarmed','Not armed','Security off','해제','해제됨']];
const titles=['SmartThings Home Monitor','Home Monitor'];
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext();
// The tests never contact a real SmartThings endpoint.
await context.route('**/*', route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
const page=await context.newPage();
const shell=(inner,other='')=>`<style>button{cursor:pointer} span{display:inline-block} section{padding:10px}</style><main><section class="monitor-card"><h2>Home Monitor</h2>${inner}</section>${other}</main><script>window.clicks=[];document.addEventListener('click',e=>window.clicks.push(e.target.closest('[id]')?.id||e.target.tagName));</script>`;
const other=(html)=>`<section><h2>Devices</h2>${html}</section>`;
const results=[];
async function test(name,work){const start=performance.now();try{const detail=await work();results.push({name,status:'passed',ms:Math.round(performance.now()-start),...detail});console.log('PASS',name,JSON.stringify(detail??{}));}catch(e){results.push({name,status:'failed',error:String(e)});console.error('FAIL',name,e.stack);}}
async function click(mod,html){await page.setContent(html);const start=performance.now();const result=await mod.clickCurrentHomeMonitorMode(page,titles,groups,150);return {result,clicks:await page.evaluate(()=>window.clicks),ms:Math.round(performance.now()-start)};}
await test('ignores same mode labels on other dashboard cards',async()=>{
 const html=shell('<button role="combobox" id="current">Off</button>',other('<button id="other-off">Off</button>'));
 const old=baseline ? await click(baseline,html) : undefined;const fixed=await click(candidate,html);
 if(old)assert.equal(old.result,'ambiguous');assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return {baseline:old,candidate:fixed};
});
await test('deduplicates spans on one current-mode button',async()=>{
 const html=shell('<button id="current" aria-haspopup="listbox"><span>Armed (Away)</span><span>Armed away</span></button>');
 const old=baseline ? await click(baseline,html) : undefined;const fixed=await click(candidate,html);
 if(old)assert.equal(old.result,'ambiguous');assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return {baseline:old,candidate:fixed};
});
await test('foreign Off labels do not conflict with an armed-away state caption',async()=>{
 const fixed=await click(candidate,shell('<button id="current"><span>Armed (Away)</span></button>',other('<button>Off</button><button>Off</button>')));
 assert.equal(fixed.result,'clicked');assert.deepEqual(fixed.clicks,['current']);return fixed;
});
for(const [name,html,expected] of [
 ['two distinct current-mode controls remain ambiguous',shell('<button id="a">Armed away</button><button id="b">Armed away</button>'),'ambiguous'],
 ['two monitor cards remain ambiguous',shell('<button id="a">Armed away</button>')+'<section><h2>Home Monitor</h2><button id="b">Armed away</button></section>','ambiguous'],
 ['unknown modal blocks dashboard click',shell('<button id="a">Armed away</button>')+'<div role="dialog">Other dialog</div>','blocked'],
 ['no expansion into foreign widget',shell('<p>Unknown state</p>',other('<button id="b">Armed away</button>')),'not_found'],
 ['unscoped page caption is not a local monitor card','<h2>Home Monitor</h2><button id="a">Disarmed</button><script>window.clicks=[];a.onclick=()=>window.clicks.push("a")</script>','not_found'],
 ['never use Disarm action to open selector',shell('<button id="disarm">Disarm</button>'),'not_found'],
 ['never use Off action to open selector',shell('<button id="off">Off</button>'),'not_found'],
 ['disabled current-mode control is not clicked',shell('<button id="a" disabled>Armed away</button>'),'blocked'],
 ['disabled ancestor is not clicked',shell('<div aria-disabled="true"><button id="a">Armed away</button></div>'),'blocked'],
 ['direct two-mode row is not treated as selector',shell('<button id="a">보안(실내)</button><button id="b">보안(외출)</button>'),'not_found'],
]) {await test(name,async()=>{const result=await click(candidate,html);assert.equal(result.result,expected);assert.deepEqual(result.clicks,[]);return result;});}
await test('hidden ancestor does not add a duplicate candidate',async()=>{
 const result=await click(candidate,shell('<button id="a">Armed away</button><div aria-hidden="true"><button id="b">Armed away</button></div>'));
 assert.equal(result.result,'clicked');assert.deepEqual(result.clicks,['a']);return result;
});
await test('roleless current-state caption retains delegated click',async()=>{
 const result=await click(candidate,shell('<div id="current" style="cursor:pointer"><span>Armed ( Away )</span></div>'));
 assert.equal(result.result,'clicked');assert.deepEqual(result.clicks,['current']);return result;
});
await test('open shadow root selector and cleanup',async()=>{
 await page.setContent('<div id="host"></div><script>window.clicks=[];host.attachShadow({mode:"open"}).innerHTML=`<section><h2>Home Monitor</h2><button id="current">Armed away</button></section>`;host.shadowRoot.addEventListener("click",()=>window.clicks.push("current"));</script>');
 assert.equal(await candidate.clickCurrentHomeMonitorMode(page,titles,groups,200),'clicked');
 assert.deepEqual(await page.evaluate(()=>window.clicks),['current']);
 assert.equal(await page.evaluate(()=>document.querySelector('#host').shadowRoot.querySelectorAll('[data-stw-hm-selector]').length),0);
});
function transitionFixture(current,duplicates=true){
 return shell(`<button id="current" aria-haspopup="listbox">${duplicates?`<span>${current}</span><span>${current}</span>`:current}</button>`,other('<button id="other-off">Off</button>'))+`<script>
 window.actions=[];window.openerClicks=0;
 document.querySelector('#current').addEventListener('click',()=>{
  window.openerClicks++;
  if(document.querySelector('[role="dialog"]'))return;
  const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<h2>Home Monitor</h2><button data-mode="armAway">보안(외출)</button><button data-mode="armStay">보안(실내)</button><button data-mode="disarm">Disarm</button>';
  d.addEventListener('click',e=>{if(e.target.dataset.mode){window.actions.push(e.target.dataset.mode);d.remove();}});document.body.appendChild(d);
 });</script>`;
}
async function execute(mod,action,html){
 const diagnostics=[];let commandPage;
 const manager={openCommandPage:async()=>{const native=await context.newPage();await native.setContent(html);commandPage=new Proxy(native,{get(target,key){if(key==='url')return ()=> 'https://my.smartthings.com/location/raw-test-location';const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});return commandPage;}};
 const executor=new mod.SmartThingsWebUiCommandExecutor(()=>manager,()=> 'loc_test_location',{resolveRawLocationId:()=> 'raw-test-location',onDiagnostic:s=>diagnostics.push(s)});
 const start=performance.now();let evidence;
 try{
 await executor.executeLocationAction({action,locationId:'loc_test_location',locationNames:{loc_test_location:'Test'},waitForConfirmation:async()=>{
  evidence=await commandPage.evaluate(()=>({actions:window.actions,openerClicks:window.openerClicks}));
  assert.deepEqual(evidence.actions,[action]);
 }});return {outcome:'confirmed_fixture',ms:Math.round(performance.now()-start),diagnostics,evidence};
 }catch(error){return {outcome:error.message,ms:Math.round(performance.now()-start),diagnostics,evidence};}
}
await test('full executor uses the bounded selector fast path',async()=>{
 const html=transitionFixture('Armed (Away)');const old=oldExecutor ? await execute(oldExecutor,'armStay',html) : undefined;const fixed=await execute(newExecutor,'armStay',html);
 if(old)assert.equal(old.outcome,'command_control_ambiguous');assert.equal(fixed.outcome,'confirmed_fixture');assert(fixed.ms<3000);assert.equal(fixed.evidence.openerClicks,1);
 return {baseline:old,candidate:fixed};
});
for(const [current,action] of [['Armed (Away)','armStay'],['Armed (Away)','disarm'],['Armed (Stay)','armAway'],['Armed (Stay)','disarm'],['Disarmed','armStay'],['Disarmed','armAway']]){
 await test(`selector ${current} -> ${action} dispatches only requested mode`,async()=>{const result=await execute(newExecutor,action,transitionFixture(current));assert.equal(result.outcome,'confirmed_fixture');assert.equal(result.evidence.openerClicks,1);return result;});
}
for(const action of ['armAway','armStay','disarm']){
 await test(`existing direct dashboard ${action} remains one-click`,async()=>{
 const html=shell('<button data-mode="armAway">보안(외출)</button><button data-mode="armStay">보안(실내)</button><button data-mode="disarm">Disarm</button>')+'<script>window.actions=[];document.addEventListener("click",e=>{if(e.target.dataset.mode)window.actions.push(e.target.dataset.mode)});</script>';
 const result=await execute(newExecutor,action,html);assert.equal(result.outcome,'confirmed_fixture');return result;
 });
}
const browserVersion=browser.version();
await browser.close();
fs.writeFileSync(path.resolve(process.env.OUTPUT_PATH ?? 'home-monitor-selector-results.json'),JSON.stringify({scope:'Synthetic local Chromium fixtures, no Samsung account or physical commands',runtime:{node:process.version,playwright:require('playwright-core/package.json').version,chromium:browserVersion},results},null,2));
console.log(`${results.filter(r=>r.status==='passed').length}/${results.length} passed`);
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
