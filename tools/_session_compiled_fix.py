from pathlib import Path

def replace(path, old, new):
 p=Path(path);s=p.read_text();assert s.count(old)==1,(path,old[:100],s.count(old));p.write_text(s.replace(old,new))

replace('bridge/src/browser/cake-client-capture.ts', '      if (!kind) continue;\n      const captureClient:', '''      if (!kind) continue;
      // Babel's public method is a small delegate; the auth implementation
      // lives in this naturally loaded factory, not in method.toString().
      const authFactoryVerified = kind === "client" && source.includes('"api/auth"') &&
        source.includes("reauthenticate=") && source.includes("sessionLength") && source.includes("stayLoggedIn");
      const captureClient:''')
replace('bridge/src/browser/cake-client-capture.ts', 'sink(kind, module.exports);', 'sink(kind, module.exports, authFactoryVerified);')
replace('bridge/src/browser/cake-client-capture.ts', 'queue.push([kind, module.exports]);', 'queue.push([kind, module.exports, authFactoryVerified]);')
replace('bridge/src/browser/native-session-observer.ts', 'function capture(kind: string, exports: unknown): void {', 'function capture(kind: string, exports: unknown, authFactoryVerified = false): void {')
replace('bridge/src/browser/native-session-observer.ts', '''          if (!source.includes('"api/auth"') || !source.includes("stayLoggedIn") || !source.includes("sessionLength")) {''', r'''          const inlineContract = source.includes('"api/auth"') && source.includes("stayLoggedIn") && source.includes("sessionLength");
          // Observed Web 2.57.0: function(t){return e.apply(this,arguments)}.
          // Accept that delegate only with the independently matched factory;
          // arbitrary methods or an unverified generic wrapper remain unknown.
          const compiledDelegate = authFactoryVerified && /^function(?:\s+[$\w]+)?\s*\(\s*[$\w]+\s*\)\s*\{\s*return\s+[$\w]+\.apply\(\s*this\s*,\s*arguments\s*\)\s*;?\s*\}$/.test(source);
          if (!inlineContract && !compiledDelegate) {''')
replace('bridge/src/browser/native-session-observer.ts', 'host[captureKey] = (kind: string, exports: unknown) => { try { capture(kind, exports); }', 'host[captureKey] = (kind: string, exports: unknown, verified = false) => { try { capture(kind, exports, verified === true); }')
replace('bridge/src/browser/native-session-observer.ts', 'host[captureKey](entry[0], entry[1]);', 'host[captureKey](entry[0], entry[1], entry[2]);')
p=Path('tools/ci-native-session-smoke.mjs');s=p.read_text()
start=s.index('client.reauthenticate=async function(args){')
end=s.index('\nfunction openDialog()',start)
old=s[start:end]
inner=old.replace('client.reauthenticate=async function(args){','const implementation=async function(args){',1)
new=inner+'''\nclient.reauthenticate=(function(){return function(args){return implementation.apply(this,arguments);};})();'''
s=s[:start]+'initializeClient();'+s[end:]
anchor='''    // cake_session api/device api/subscription
    exports.renamed='''
assert s.count(anchor)==1
s=s.replace(anchor,'''    // cake_session api/device api/subscription
    exports.initialize=()=>{'''+new+'''\n    };
    exports.renamed=''',1)
anchor="const store=require('random-store').renamed,client=require('random-client').renamed,renew=require('random-user').renamed,pref=require('random-settings').renamed;"
assert s.count(anchor)==1
s=s.replace(anchor,anchor+"\nconst initializeClient=require('random-client').initialize;")
s=s.replace('<meta charset="utf-8"><button id="settings"','<meta charset="utf-8"><style>[data-testid="toggle-switch-stayLoggedIn"]{width:40px;height:24px;display:inline-block}</style><button id="settings"')
s=s.replace("assert.equal(result.clean,true);assert.equal(result.report.state,'enabled');assert.ok(reloads>=1);","assert.equal(result.clean,true,JSON.stringify({result,reloads,evidence:await data()}));assert.equal(result.report.state,'enabled');assert.ok(reloads>=1);")
p.write_text(s)
replace('bridge/tests/browser/native-session-maintenance.test.ts', 'initial = false) {', 'initial = false, authFactoryVerified = false) {')
replace('bridge/tests/browser/native-session-maintenance.test.ts', 'capture("client",{renamedClient:client});', 'capture("client",{renamedClient:client},authFactoryVerified);')
anchor='  test("ambiguous store capture does not modify either store",()=>{'
new='''  test.each([false,true])("compiled auth delegate requires matched factory evidence (%s)",async verified=>{
    const f=nativeFixture("normal",false,verified);
    const delegate=f.client.reauthenticate;
    f.client.reauthenticate=function(arg:any){return delegate.apply(this,arguments);};
    expect(f.api.read().available).toBe(verified);
    expect(f.api.begin(true)).toBe(verified ? "requested" : "unsupported");
    await vi.advanceTimersByTimeAsync(600);
    expect(f.mutations).toHaveBeenCalledTimes(verified ? 1 : 0);
    if(verified) expect(f.api.read()).toMatchObject({sessionKeepSignedIn:true,outcome:"renewed"});
  });
'''
replace('bridge/tests/browser/native-session-maintenance.test.ts',anchor,new+anchor)
