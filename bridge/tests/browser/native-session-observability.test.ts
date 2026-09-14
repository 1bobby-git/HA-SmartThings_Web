import { afterEach, describe, expect, test, vi } from "vitest";
import { installNativeSessionObserver } from "../../src/browser/native-session-observer.js";
import { NativeSessionMaintenance } from "../../src/browser/native-session-maintenance.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { createHealthReport } from "../../src/server/health.js";
import { renderStatusPage } from "../../src/server/status-page.js";
const url = "https://my.smartthings.com/location/fixture";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const host: Record<PropertyKey, any> = {};
  vi.stubGlobal("window", host); vi.stubGlobal("location", new URL(url));
  vi.stubGlobal("document", { querySelectorAll: () => [] });
  const root: any = { user: { user: { uuid: "synthetic-user", session: { stayLoggedIn: true, exp: Date.now()/1000 + 7200 } } },
    ui: { settings: { user: { stayLoggedIn: true } }, cookieConsent: { functionality_settings: false } },
    client: { socketConnected: true, socketAuthenticated: true } };
  const store = {getState: () => root, dispatch: vi.fn(), subscribe: vi.fn()};
  installNativeSessionObserver();
  const capture = host[Symbol.for("smartthings_web_bridge.native_session_capture")];
  const api = host[Symbol.for("smartthings_web_bridge.native_session")];
  const page = {url: () => url, isClosed: () => false, goto: vi.fn(), close: vi.fn(),
    evaluate: vi.fn(async (_fn: any, args: any) => args.action === "read" ? api.read() : api.begin(true))};
  return {root, store, capture, api, page};
}
const opts = {enabled:true, canRun:()=>true, current:()=>true, force:true};
describe("read capability is independent of native renewal capability", () => {
  test("store-only session with missing optional duration is observable and independently verified", async () => {
    const f=fixture(); f.capture("store", { exported: f.store });
    expect(f.api.read()).toMatchObject({available:true,renewalSupported:false,sessionKeepSignedIn:true});
    const proof=vi.fn(async()=>({outcome:"ok",reason:"verified"} as const));
    const result=await new NativeSessionMaintenance(proof).run(f.page,opts);
    expect(result).toMatchObject({handled:true,observation:{state:"active",sessionKeepSignedIn:true}});
    expect(proof).toHaveBeenCalledOnce(); expect(f.store.dispatch).not.toHaveBeenCalled();
    expect(f.api.begin(true)).toBe("unsupported");
  });
  test("missing expiry is not infinity and never authorizes supplemental auth", async () => {
    const f=fixture(); delete f.root.user.user.session.exp; f.capture("store", f.store);
    expect(f.api.read().expiresInMs).toBeUndefined(); expect(f.api.begin(true)).toBe("unsupported");
    const result=await new NativeSessionMaintenance(async()=>({outcome:"ok",reason:"verified"})).run(f.page,opts);
    expect(result.observation.state).toBe("active"); expect(result.observation.remainingMs).toBeUndefined();
    const status=new RuntimeStatusStore({initial:{authenticated:true,nativeSessionState:"active",nativeSessionReason:"session_verified",nativeSessionObservedAtMs:Date.now()}});
    expect(renderStatusPage(createHealthReport(status.getSnapshot()))).toContain("웹 앱에서 제공하지 않음");
  });
  test.each(["invalid", null, Infinity, NaN, -1])("malformed expiry fails closed (%s)", exp=>{
    const f=fixture();f.root.user.user.session.exp=exp;f.capture("store",f.store);
    expect(f.api.read()).toMatchObject({available:false,diagnostic:"session_schema_unknown"});
    expect(f.api.begin(true)).toBe("unsupported");
  });
  test("effective OFF plus unknown native mutation still uses recovery, never reports ON", async()=>{
    const f=fixture(); f.root.user.user.session.stayLoggedIn=false; f.capture("store",f.store);
    const result=await new NativeSessionMaintenance(async()=>({outcome:"ok",reason:"verified"})).run(f.page,opts);
    expect(result).toMatchObject({handled:false,observation:{state:"attention",reason:"renewal_unsupported",sessionKeepSignedIn:false}});
    expect(f.store.dispatch).not.toHaveBeenCalled();
  });
  test("observable ON cannot override a real 401", async()=>{
    const f=fixture();f.capture("store",f.store);
    expect(await new NativeSessionMaintenance(async()=>({outcome:"reauth",reason:"http_401"})).run(f.page,opts))
      .toMatchObject({handled:false,authenticationRejected:true,observation:{state:"attention"}});
  });
  test("a throwing sibling ESM getter cannot drop valid exports", ()=>{
    const f=fixture();const exports={get notInitialized(){throw new ReferenceError("synthetic");},ready:f.store};
    f.capture("store",exports);expect(f.api.read().available).toBe(true);
  });
  test("late ESM store export is retried without evaluating a module or dispatching",()=>{
    const f=fixture();let initialized=false;
    f.capture("store",{get exported(){if(!initialized)throw new ReferenceError("synthetic");return f.store;}});
    expect(f.api.read()).toMatchObject({available:false,diagnostic:"store_missing"});
    initialized=true;expect(f.api.read()).toMatchObject({available:true});
    expect(f.store.dispatch).not.toHaveBeenCalled();
  });
  test.each(["store_missing","session_not_ready","preference_not_ready","socket_not_ready","session_schema_unknown","capture_ambiguous"])
    ("diagnostic %s survives only the safe health projection", async reason=>{
      const f=fixture(); f.page.evaluate.mockResolvedValue({schema:1,available:false,diagnostic:reason,email:"sensitive@example.test"});
      const result=await new NativeSessionMaintenance(vi.fn()).run(f.page,opts);
      expect(result.observation.reason).toBe(reason);expect(JSON.stringify(result)).not.toContain("sensitive");
      const status=new RuntimeStatusStore({initial:{nativeSessionReason:result.observation.reason}});
      expect(createHealthReport(status.getSnapshot()).details.nativeSessionReason).toBe(reason);
    });
  test("unallowlisted diagnostic cannot become a log or health string",async()=>{
    const f=fixture();f.page.evaluate.mockResolvedValue({schema:1,available:false,diagnostic:"secret@example.test"});
    expect((await new NativeSessionMaintenance(vi.fn()).run(f.page,opts)).observation.reason).toBe("unsupported");
  });
});
