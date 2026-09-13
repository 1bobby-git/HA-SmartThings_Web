import { describe, expect, test, vi } from "vitest";
import { KEEPER_URL, KeeperPageManager, type BrowserPageLike } from "../../src/browser/keeper-page.js";
import type { ApplicationSessionProof } from "../../src/browser/session-application-proof.js";

async function setup(probe: (page: BrowserPageLike, url: string) => Promise<ApplicationSessionProof>) {
  let url = `${KEEPER_URL}/fixture-home`;
  const evaluate = vi.fn(async () => "ok");
  const page: BrowserPageLike = {
    url: () => url, isClosed: () => false, close: async () => undefined,
    goto: async target => { url = target; }, evaluate: evaluate as NonNullable<BrowserPageLike["evaluate"]>
  };
  const manager = new KeeperPageManager({ pages: () => [page], newPage: async () => page }, {
    probeApplicationSession: probe
  });
  await manager.reconcileRestoredPages();
  return { manager, page, evaluate };
}

describe("periodic native application session proof", () => {
  test("Advanced HTTP 200 cannot mask a Location-client 401 or clear a prior rejection", async () => {
    const native = vi.fn(async (): Promise<ApplicationSessionProof> => ({ outcome: "reauth", reason: "http_401" }));
    const f = await setup(native);
    expect(await f.manager.touchAuthenticatedSession()).toBe("reauth");
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
    expect(await f.manager.touchAuthenticatedSession()).toBe("reauth");
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
    native.mockResolvedValue({ outcome: "ok", reason: "verified" });
    expect(await f.manager.touchAuthenticatedSession()).toBe("ok");
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
    expect(native).toHaveBeenCalledWith(f.page, `${KEEPER_URL}/fixture-home`);
  });
  test("a generic application root cannot bypass a configured native proof", async () => {
    const native = vi.fn(async (): Promise<ApplicationSessionProof> => ({ outcome: "failed", reason: "invalid_target" }));
    const f = await setup(native);
    await f.page.goto(KEEPER_URL);
    expect(await f.manager.touchAuthenticatedSession()).toBe("failed");
    expect(native).toHaveBeenCalledWith(f.page, KEEPER_URL);
  });
  test("reauth recovery retains the known Location target for native verification", async () => {
    vi.useFakeTimers();
    try {
      const native = vi.fn(async (): Promise<ApplicationSessionProof> => ({ outcome: "ok", reason: "verified" }));
      const f = await setup(native);
      await f.manager.touchAuthenticatedSession();
      f.manager.reportAuthenticationFailure(f.page, f.page.url());
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await f.manager.ensureKeeper()).toBe(f.page);
      expect(f.page.url()).toBe(`${KEEPER_URL}/fixture-home`);
      expect(f.manager.authenticationRecoveryPending()).toBe(false);
      expect(native).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  test("a transient native error is not declared session expiry", async () => {
    const f = await setup(async () => ({ outcome: "failed", reason: "read_failed" }));
    expect(await f.manager.touchAuthenticatedSession()).toBe("failed");
    expect(f.manager.authenticationRecoveryPending()).toBe(false);
  });
  test("coalesces requests through BOTH protected and native proof", async () => {
    let resolve!: (proof: ApplicationSessionProof) => void;
    const native = vi.fn(() => new Promise<ApplicationSessionProof>(done => { resolve = done; }));
    const f = await setup(native);
    const first = f.manager.touchAuthenticatedSession();
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    const second = f.manager.touchAuthenticatedSession();
    resolve({ outcome: "ok", reason: "verified" });
    expect(await first).toBe("ok"); expect(await second).toBe("ok");
    expect(f.evaluate).toHaveBeenCalledOnce(); expect(native).toHaveBeenCalledOnce();
  });
  test("late native success cannot override a newer command 401", async () => {
    let resolve!: (proof: ApplicationSessionProof) => void;
    const native = vi.fn(() => new Promise<ApplicationSessionProof>(done => { resolve = done; }));
    const f = await setup(native);
    const touch = f.manager.touchAuthenticatedSession();
    await vi.waitFor(() => expect(native).toHaveBeenCalledOnce());
    f.manager.reportAuthenticationFailure(f.page, f.page.url());
    resolve({ outcome: "ok", reason: "verified" });
    expect(await touch).toBe("stale");
    expect(f.manager.authenticationRecoveryPending()).toBe(true);
  });
});
