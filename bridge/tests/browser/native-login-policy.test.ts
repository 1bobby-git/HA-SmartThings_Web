import { describe, test, expect, vi } from "vitest";
import { ensureNativeKeepSignedIn, readNativeKeepSignedIn, nativeLoginTarget } from "../../src/browser/native-login-policy.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";
import { createHealthReport } from "../../src/server/health.js";
import { renderStatusPage } from "../../src/server/status-page.js";
import { readBridgeConfig } from "../../src/config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = "https://my.smartthings.com/location/fixture";
const page = () => ({url: () => target, isClosed: () => false, goto: vi.fn(), close: vi.fn(), evaluate: vi.fn()});
describe("native login preference safety and integration contracts", () => {
  test("observes an open setting without locator clicks, navigation or auth proof", async () => {
    const browser = page();
    browser.evaluate.mockResolvedValue({ result: "on" });
    expect(await readNativeKeepSignedIn(browser)).toEqual({ state: "enabled", reason: "observed_enabled" });
    browser.evaluate.mockResolvedValue({ result: "off" });
    expect(await readNativeKeepSignedIn(browser)).toEqual({ state: "attention", reason: "observed_disabled" });
    browser.evaluate.mockResolvedValue({ result: "missing" });
    expect(await readNativeKeepSignedIn(browser)).toBeUndefined();
    expect(browser.goto).not.toHaveBeenCalled();
    expect(browser.close).not.toHaveBeenCalled();
    const store = new RuntimeStatusStore({initial:{authenticated:false}});
    store.update({nativeLoginPolicyState:"enabled",nativeLoginPolicyReason:"observed_enabled"});
    expect(createHealthReport(store.getSnapshot()).ready).toBe(false);
  });
  test("discards observed state after navigation", async () => {
    let url = target;
    const browser = {...page(),url: () => url};
    browser.evaluate.mockImplementation(async () => { url = "https://account.samsung.com/"; return {result:"on"}; });
    expect(await readNativeKeepSignedIn(browser)).toBeUndefined();
    expect(browser.goto).not.toHaveBeenCalled();
  });

  test("opt-out is side effect free", async () => {
    const browser = page();
    expect(await ensureNativeKeepSignedIn(browser, target, {enabled:false})).toEqual({report:{state:"disabled",reason:"automation_disabled"},clean:true});
    expect(browser.evaluate).not.toHaveBeenCalled(); expect(browser.goto).not.toHaveBeenCalled();
  });
  test.each(["blocked", "ambiguous", "unknown"])("pre-existing %s UI is not a clean keeper candidate", async result => {
    const browser = { ...page(), locator: vi.fn() };
    browser.evaluate.mockResolvedValue({result});
    const outcome = await ensureNativeKeepSignedIn(browser, target, {enabled:true});
    expect(outcome.report.state).toBe("attention");
    expect(outcome.clean).toBe(false);
    expect(browser.goto).not.toHaveBeenCalled();
    expect(browser.locator).not.toHaveBeenCalled();
  });
  test("unsupported browser is not reported as enabled", async () => {
    expect((await ensureNativeKeepSignedIn(page(), target, {enabled:true})).report.state).toBe("attention");
  });
  test.each([
    "http://my.smartthings.com/location/fixture", "https://my.smartthings.com.evil.test/location/fixture",
    "https://account.samsung.com/", "https://v3.account.samsung.com/", "https://my.smartthings.com/advanced",
    "https://my.smartthings.com/location", `${target}?code=fixture`, `${target}#fixture`,
    "https://fixture@my.smartthings.com/location/fixture"
  ])("rejects noncanonical target %s", url => expect(nativeLoginTarget(url)).toBe(false));
  test("new option defaults to enabled for the dedicated bridge and respects env/HA opt-out", () => {
    const dir = mkdtempSync(join(tmpdir(),"policy-options-"));
    const path = join(dir,"options.json");
    try {
      expect(readBridgeConfig({},path).keepSignedInEnabled).toBe(true);
      writeFileSync(path, JSON.stringify({keep_signed_in_enabled:false}));
      expect(readBridgeConfig({},path).keepSignedInEnabled).toBe(false);
      expect(readBridgeConfig({STW_KEEP_SIGNED_IN_ENABLED:"true"},path).keepSignedInEnabled).toBe(true);
      expect(() => readBridgeConfig({STW_KEEP_SIGNED_IN_ENABLED:"yes"},path)).toThrow();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test("health surfaces preference separately and never authenticates a logged-out browser", () => {
    const store = new RuntimeStatusStore({initial:{nativeLoginPolicyState:"enabled",nativeLoginPolicyReason:"enabled_and_verified",authenticated:false}});
    const report = createHealthReport(store.getSnapshot());
    expect(report.ready).toBe(false);
    expect(renderStatusPage(report)).toContain('data-native-login-policy="pending"');
    expect(report.details.nativeLoginPolicyState).toBe("enabled");
  });
  test("status rejects unallowlisted DOM/credential data", () => {
    const store = new RuntimeStatusStore();
    expect(() => store.update({nativeLoginPolicyReason:"user@example.test"})).toThrow();
    expect(() => store.update({nativeLoginPolicyState:"false_positive" as "enabled"})).toThrow();
  });
});
