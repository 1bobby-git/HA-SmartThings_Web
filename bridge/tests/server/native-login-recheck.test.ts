import { afterEach, describe, expect, test, vi } from "vitest";
import { createBridgeHttpServer, type BridgeHttpServer } from "../../src/server/http-server.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { readVisibleNativeLoginPolicy } from "../../src/browser/native-login-policy.js";
import { renderStatusPage } from "../../src/server/status-page.js";
import { createHealthReport } from "../../src/server/health.js";

const servers: BridgeHttpServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function fixture(check?: () => Promise<{ queued: boolean }>) {
  const store = new RuntimeStatusStore({ initial: { authenticated: true, nativeLoginPolicyState: "attention", nativeLoginPolicyReason: "settings_not_found" } });
  const callback = check ?? vi.fn(async () => {
    store.update({ nativeLoginPolicyState: "enabled", nativeLoginPolicyReason: "already_enabled" });
    return { queued: false };
  });
  const server = await createBridgeHttpServer({ host: "127.0.0.1", port: 0, store,
    maintenance: { checkNativeLoginPolicy: callback, reloadInventory: async () => {}, reconnectRealtime: async () => {} } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const html = await (await fetch(base)).text();
  const csrf = html.match(/data-check-token="([a-f0-9-]+)"/u)?.[1];
  expect(csrf).toBeTruthy();
  return { base, store, callback, csrf: csrf!, html };
}
const request = (csrf: string) => ({ method: "POST", headers: { "content-type": "application/json", "x-stw-ui-csrf": csrf }, body: "{}" });

describe("native login setting recheck UI", () => {
  test("POST runs the check; GET only displays the latest result", async () => {
    const f = await fixture();
    expect(f.callback).not.toHaveBeenCalled();
    const response = await fetch(`${f.base}/api/v1/native-login-policy/check`, request(f.csrf));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, queued: false });
    expect(f.callback).toHaveBeenCalledTimes(1);
    expect(await (await fetch(f.base)).text()).toContain('data-native-login-policy="enabled"');
    expect(f.callback).toHaveBeenCalledTimes(1);
  });
  test("queued browser work is explicitly asynchronous, not reported as enabled", async () => {
    const f = await fixture(vi.fn(async () => ({ queued: true })));
    const response = await fetch(`${f.base}/api/v1/native-login-policy/check`, request(f.csrf));
    expect(response.status).toBe(202);
    expect((await response.json()).queued).toBe(true);
    expect(f.store.getSnapshot().nativeLoginPolicyState).toBe("attention");
  });
  test("requires POST, fresh CSRF nonce, same-site request and empty JSON body", async () => {
    const f = await fixture();
    const endpoint = `${f.base}/api/v1/native-login-policy/check`;
    expect((await fetch(endpoint)).status).toBe(405);
    expect((await fetch(endpoint, request("invalid"))).status).toBe(403);
    const cross = request(f.csrf);
    expect((await fetch(endpoint, { ...cross, headers: { ...cross.headers, "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(endpoint, { ...request(f.csrf), headers: { "x-stw-ui-csrf": f.csrf, "content-type": "text/plain" } })).status).toBe(415);
    expect((await fetch(endpoint, { ...request(f.csrf), body: '{"set":false}' })).status).toBe(400);
    expect(f.callback).not.toHaveBeenCalled();
  });
  test("rate limits repeated requests without repeating browser work", async () => {
    const f = await fixture();
    const endpoint = `${f.base}/api/v1/native-login-policy/check`;
    expect((await fetch(endpoint, request(f.csrf))).status).toBe(200);
    expect((await fetch(endpoint, request(f.csrf))).status).toBe(429);
    expect(f.callback).toHaveBeenCalledTimes(1);
  });
  test("browser failures are safe errors, never leaked details or false success", async () => {
    const f = await fixture(vi.fn(async () => { throw new Error("private-page-content"); }));
    const response = await fetch(`${f.base}/api/v1/native-login-policy/check`, request(f.csrf));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("private-page-content");
    expect(text).toContain("native_policy_unavailable");
  });
  test("unreadable setting is not a logout or an instruction to toggle it off", () => {
    const store = new RuntimeStatusStore({ initial: { authenticated: true, nativeLoginPolicyState: "attention", nativeLoginPolicyReason: "settings_not_found" } });
    const html = renderStatusPage(createHealthReport(store.getSnapshot()));
    expect(html).toContain("로그인 유지가 꺼졌다는 뜻은 아닙니다");
    expect(html).toContain("이미 켜 두셨다면 그대로 두세요");
    expect(html).toContain("설정을 끄거나 로그아웃할 필요가 없습니다");
    expect(html).toContain('id="native-login-check"');
    expect(html).not.toContain('href=".">상태 다시 확인');
    expect(html).toContain('api/v1/native-login-policy/check');
  });
});

describe("read-only manual setting observation", () => {
  const target = "https://my.smartthings.com/location/fixture";
  test.each(["on", "off", "missing", "ambiguous", "blocked", "unknown"])("reads %s without navigation, clicks or DOM markers", async result => {
    const page = { url: () => target, isClosed: () => false, evaluate: vi.fn().mockResolvedValue({ result }),
      locator: vi.fn(), goto: vi.fn(), close: vi.fn(), bringToFront: vi.fn() };
    expect(await readVisibleNativeLoginPolicy(page)).toEqual({ result });
    expect(page.evaluate.mock.calls[0]?.[1]).toEqual({ action: "control", marker: "", target });
    for (const action of [page.locator, page.goto, page.close, page.bringToFront]) expect(action).not.toHaveBeenCalled();
  });
  test("rejects stale results after navigation", async () => {
    let url = target;
    const page = { url: () => url, isClosed: () => false, locator: vi.fn(), close: vi.fn(), goto: vi.fn(),
      evaluate: vi.fn(async () => { url = "https://account.samsung.com/"; return { result: "on" }; }) };
    expect((await readVisibleNativeLoginPolicy(page)).result).toBe("blocked");
  });
});
