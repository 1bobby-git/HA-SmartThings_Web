import { afterEach, describe, expect, test, vi } from "vitest";
import { NativeSessionMaintenance } from "../../src/browser/native-session-maintenance.js";
import { installNativeSessionObserver } from "../../src/browser/native-session-observer.js";
import { createHealthReport } from "../../src/server/health.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { renderStatusPage } from "../../src/server/status-page.js";

const url = "https://my.smartthings.com/location/fixture-home";
const snapshot = (patch: Record<string, unknown> = {}) => ({ schema: 1, available: true,
  instance: "00000000-0000-4000-8000-000000000001", revision: 1,
  uiKeepSignedIn: true, sessionKeepSignedIn: true, expiresInMs: 3600_000,
  socketConnected: true, socketAuthenticated: true, busy: false, busyAgeMs: 0, outcome: "idle", ...patch });
const options = () => ({ enabled: true, canRun: () => true, current: () => true, force: true });
const makePage = (read: () => unknown) => ({url: () => url, isClosed: () => false,
  goto: vi.fn(), close: vi.fn(), evaluate: vi.fn(async (_fn: unknown, arg: any): Promise<any> => arg.action === "read" ? read() : "requested")});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("native session maintenance evidence", () => {
  test("healthy effective session requires protected proof and does not navigate or renew", async () => {
    const page = makePage(() => snapshot());
    const proof = vi.fn(async () => ({outcome:"ok",reason:"verified"} as const));
    const result = await new NativeSessionMaintenance(proof).run(page, options());
    expect(result).toMatchObject({handled:true,observation:{state:"active",reason:"session_verified"}});
    expect(proof).toHaveBeenCalledOnce();
    expect(page.evaluate.mock.calls.every(([,arg])=>arg.action === "read")).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
  });
  test.each([{uiKeepSignedIn:true,sessionKeepSignedIn:false},{uiKeepSignedIn:false,sessionKeepSignedIn:false}, {expiresInMs:120_000}])("requests native maintenance only for mismatch or near expiry %j", async patch => {
    const page=makePage(()=>snapshot(patch));
    const controller=new NativeSessionMaintenance(vi.fn(async()=>({outcome:"ok",reason:"verified"} as const)));
    expect(await controller.run(page,options())).toMatchObject({handled:true,observation:{state:"renewing"}});
    expect(page.evaluate.mock.calls.filter(([,arg])=>arg.action === "begin")).toHaveLength(1);
    expect(page.goto).not.toHaveBeenCalled();
  });
  test.each(["unconfirmed","stale"])("native %s is not proof even with a resolved Promise", async outcome => {
    const proof=vi.fn(); const page=makePage(()=>snapshot({outcome}));
    expect(await new NativeSessionMaintenance(proof).run(page,options())).toMatchObject({handled:false,observation:{state:"attention"}});
    expect(proof).not.toHaveBeenCalled();
  });
  test("degraded connectivity does not invent a login rejection", async()=>{
    const result=await new NativeSessionMaintenance(vi.fn()).run(makePage(()=>snapshot({socketConnected:false})),options());
    expect(result).toMatchObject({handled:false}); expect(result.authenticationRejected).not.toBe(true);
  });
  test("401 proof is reported independently of Advanced success", async()=>{
    const result=await new NativeSessionMaintenance(vi.fn(async()=>({outcome:"reauth",reason:"http_401"} as const))).run(makePage(()=>snapshot()),options());
    expect(result).toMatchObject({handled:false,authenticationRejected:true,observation:{reason:"reauth"}});
  });
  test("busy native renewal is observed rather than duplicated; stuck busy falls back", async()=>{
    const page=makePage(()=>snapshot({busy:true,busyAgeMs:5_000})); const controller=new NativeSessionMaintenance(vi.fn());
    expect(await controller.run(page,options())).toMatchObject({handled:true,observation:{state:"renewing"}});
    page.evaluate.mockImplementation(async()=>snapshot({busy:true,busyAgeMs:65_000}));
    expect(await controller.run(page,options())).toMatchObject({handled:false});
    expect(page.goto).not.toHaveBeenCalled();
  });
  test.each([false,true])("no supplemental requests while command gate is closed (enabled=%s)",async enabled=>{
    const page=makePage(()=>snapshot({sessionKeepSignedIn:false})); const proof=vi.fn();
    await new NativeSessionMaintenance(proof).run(page,{...options(),enabled,canRun:()=>false});
    expect(proof).not.toHaveBeenCalled();
    expect(page.evaluate.mock.calls.every(([,arg])=>arg.action === "read")).toBe(true);
  });
  test.each([undefined, {schema:1,available:false}, snapshot({instance:"account@example.test"}), snapshot({expiresInMs:Infinity}), snapshot({outcome:"credential"})])("unknown or malformed shape safely falls back",async raw=>{
    expect(await new NativeSessionMaintenance(vi.fn()).run(makePage(()=>raw),options())).toMatchObject({handled:false,observation:{state:"unknown"}});
  });
  test("page replacement during proof discards the result and sends no mutation",async()=>{
    let valid=true;
    const proof=vi.fn(async()=>{valid=false;return {outcome:"ok",reason:"verified"} as const;});
    const page=makePage(()=>snapshot({sessionKeepSignedIn:false}));
    expect(await new NativeSessionMaintenance(proof).run(page,{...options(),current:()=>valid})).toMatchObject({handled:false,observation:{reason:"stale"}});
    expect(page.evaluate.mock.calls.every(([,arg])=>arg.action === "read")).toBe(true);
  });
  test("same-URL document reload cannot reuse earlier protected proof",async()=>{
    let reads=0;
    const page=makePage(()=>snapshot({instance:++reads>1 ? "00000000-0000-4000-8000-000000000002" : "00000000-0000-4000-8000-000000000001"}));
    expect(await new NativeSessionMaintenance(vi.fn(async()=>({outcome:"ok",reason:"verified"} as const))).run(page,options())).toMatchObject({handled:false,observation:{reason:"stale"}});
  });
  test.each(["applied","renewed"])("keeps %s distinct after independent auth verification",async outcome=>{
    const result=await new NativeSessionMaintenance(vi.fn(async()=>({outcome:"ok",reason:"verified"} as const))).run(makePage(()=>snapshot({outcome})),options());
    expect(result.observation).toMatchObject({state:"active",reason:outcome});
  });
  test("safe projection never forwards extra account or credential fields",async()=>{
    const result=await new NativeSessionMaintenance(vi.fn(async()=>({outcome:"ok",reason:"verified"} as const))).run(makePage(()=>snapshot({email:"fixture@example.test",token:"fixture-sensitive"})),options());
    expect(JSON.stringify(result)).not.toMatch(/fixture-sensitive|fixture@example|instance|revision/);
  });
  test("single-flight and read cadence do not refresh the cached observation timestamp",async()=>{
    let now=100; const page=makePage(()=>snapshot()); const controller=new NativeSessionMaintenance(vi.fn(async()=>({outcome:"ok",reason:"verified"} as const)),()=>now);
    const a=controller.run(page,options()), b=controller.run(page,options()); expect(a).toBe(b); await a;
    const at=controller.lastReadAtMs; now+=5000; await controller.run(page,{...options(),force:false});
    expect(controller.lastReadAtMs).toBe(at); expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
  test("health rejects unallowlisted native data and hides stale active state",()=>{
    const store=new RuntimeStatusStore();
    expect(()=>store.update({nativeSessionReason:"fixture@email.test" as any})).toThrow();
    expect(()=>store.update({nativeSessionRemainingMs:Infinity})).toThrow();
    store.update({authenticated:true,nativeSessionState:"active",nativeSessionReason:"session_verified",nativeSessionRemainingMs:3600_000,nativeSessionObservedAtMs:Date.now()-120_000});
    const report=createHealthReport(store.getSnapshot());
    expect(renderStatusPage(report)).toContain('data-native-session-state="unknown"');
    expect(report.details.nativeSessionRemainingMs).toBeLessThanOrEqual(3480_000);
  });
});

function nativeFixture(mode: "normal" | "no_ack" | "same_exp" = "normal", initial = false, authFactoryVerified = false) {
  vi.useFakeTimers(); vi.setSystemTime(1000_000);
  const host: Record<PropertyKey,any>={};
  vi.stubGlobal("window",host); vi.stubGlobal("location",new URL(url));
  vi.stubGlobal("document",{querySelectorAll:()=>[]});
  let root:any={user:{user:{uuid:"fixture-user",session:{stayLoggedIn:initial,exp:5000}}},ui:{settings:{user:{stayLoggedIn:initial,sessionLength:28800}},cookieConsent:{functionality_settings:false}},client:{socketConnected:true,socketAuthenticated:true}};
  const mutations=vi.fn();
  const client:any={service:()=>({})};
  const store={getState:()=>root,subscribe:vi.fn(),dispatch:(thunk:any)=>thunk()};
  const renewal=Object.assign((arg:any)=>()=>{client.reauthenticate({...root.ui.settings.user,extend:arg.extend});},{typePrefix:"user/reauthenticate"});
  const preference=Object.assign((arg:any)=>()=>{root.ui.settings.user.stayLoggedIn=arg.enabled; store.dispatch(renewal({extend:false}));},{typePrefix:"ui.slice.actions/updateStayLoggedIn"});
  installNativeSessionObserver();
  const capture=host[Symbol.for("smartthings_web_bridge.native_session_capture")];
  capture("store",{renamedStoreExport:store}); capture("user",{renamedAction:renewal}); capture("settings",{renamedAction:preference}); capture("client",{renamedClient:client},authFactoryVerified);
  client.reauthenticate=async function nativeReauthentication(args:any) {
    void "api/auth"; void "sessionLength"; void "stayLoggedIn";
    mutations(args);
    if (mode !== "no_ack") setTimeout(()=>{root.user.user={uuid:"fixture-user",session:{stayLoggedIn:args.stayLoggedIn,exp:mode==="same_exp"?5000:6000}};},500);
    // Fulfilled immediately: final authenticate callback has not happened.
  };
  const api=host[Symbol.for("smartthings_web_bridge.native_session")];
  return {api,mutations,root,client,capture};
}
describe("in-page native action lifecycle",()=>{
  test("observes without storage writes, and awaits server evidence rather than thunk completion",async()=>{
    const f=nativeFixture(); expect(f.api.read()).toMatchObject({available:true,uiKeepSignedIn:false,sessionKeepSignedIn:false,storageAllowed:false});
    expect(f.mutations).not.toHaveBeenCalled();
    expect(f.api.begin(true)).toBe("requested"); await vi.advanceTimersByTimeAsync(1);
    expect(f.api.read()).toMatchObject({uiKeepSignedIn:true,sessionKeepSignedIn:false,busy:true,outcome:"requested"});
    expect(f.api.begin(true)).toBe("busy");
    await vi.advanceTimersByTimeAsync(600);
    expect(f.api.read()).toMatchObject({sessionKeepSignedIn:true,busy:false,outcome:"renewed"});
    expect(f.mutations).toHaveBeenCalledOnce();
  });
  test("resolved auth with no callback is unconfirmed, never a verified renewal",async()=>{
    const f=nativeFixture("no_ack"); f.api.begin(true); await vi.advanceTimersByTimeAsync(36_000);
    expect(f.api.read()).toMatchObject({outcome:"unconfirmed",sessionKeepSignedIn:false,busy:false});
  });
  test("a new effective session with unchanged expiry is applied, not renewed",async()=>{
    const f=nativeFixture("same_exp"); f.api.begin(true); await vi.advanceTimersByTimeAsync(600);
    expect(f.api.read()).toMatchObject({outcome:"applied",sessionKeepSignedIn:true});
  });
  test("opt-out leaves OFF unchanged and never dispatches",()=>{
    const f=nativeFixture(); expect(f.api.begin(false)).toBe("disabled"); expect(f.mutations).not.toHaveBeenCalled();
  });
  test("native auto renewal is not duplicated",async()=>{
    const f=nativeFixture(); f.client.reauthenticate({stayLoggedIn:true,sessionLength:28800});
    expect(f.api.begin(true)).toBe("busy"); await vi.advanceTimersByTimeAsync(600); expect(f.mutations).toHaveBeenCalledOnce();
  });
  test("user/session change while awaiting callback is stale",async()=>{
    const f=nativeFixture("no_ack"); f.api.begin(true); f.root.user.user={uuid:"different-fixture",session:{stayLoggedIn:true,exp:6000}};
    expect(f.api.read().outcome).toBe("stale");
  });
  test("expired session and unrelated modal are not automatically changed",()=>{
    const f=nativeFixture(); f.root.user.user.session.exp=900; expect(f.api.begin(true)).toBe("blocked");
    expect(f.mutations).not.toHaveBeenCalled();
  });
  test("healthy effective ON state does not periodically dispatch",()=>{
    const f=nativeFixture("normal",true); expect(f.api.begin(true)).toBe("healthy"); expect(f.mutations).not.toHaveBeenCalled();
  });
  test("unknown native method contract fails closed",()=>{
    const f=nativeFixture(); f.client.reauthenticate=()=>Promise.resolve(); expect(f.api.read()).toMatchObject({available:true,renewalSupported:false}); expect(f.api.begin(true)).toBe("unsupported");
  });
  test.each([false,true])("compiled auth delegate requires matched factory evidence (%s)",async verified=>{
    const f=nativeFixture("normal",false,verified);
    const delegate=f.client.reauthenticate;
    f.client.reauthenticate=function(arg:any){return delegate.apply(this,arguments);};
    expect(f.api.read()).toMatchObject({available:true,renewalSupported:verified});
    expect(f.api.begin(true)).toBe(verified ? "requested" : "unsupported");
    await vi.advanceTimersByTimeAsync(600);
    expect(f.mutations).toHaveBeenCalledTimes(verified ? 1 : 0);
    if(verified) expect(f.api.read()).toMatchObject({sessionKeepSignedIn:true,outcome:"renewed"});
  });
  test("ambiguous store capture does not modify either store",()=>{
    const f=nativeFixture(); f.capture("store",{getState:()=>f.root,dispatch:vi.fn(),subscribe:vi.fn()});
    expect(f.api.begin(true)).toBe("unsupported"); expect(f.mutations).not.toHaveBeenCalled();
  });
});
