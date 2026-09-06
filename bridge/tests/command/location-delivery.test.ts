import { afterEach, describe, expect, test, vi } from "vitest";
import { scheduleLocationRechecks, boundedLocationRead } from "../../src/command/location-rechecks.js";
import { verifyLocationRead } from "../../src/state/location-read-proof.js";
import { DeviceStore } from "../../src/state/device-store.js";
import { SafeCommandService } from "../../src/command/command-service.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

afterEach(() => vi.useRealTimers());
function fixture(armState = "AWAY") {
  const devices = new DeviceStore();
  function frame(direction: "sent" | "received", text: string) {
    devices.observe({ __sanitized: true, source: "playwright-websocket-frame", receivedAt: new Date().toISOString(),
      payload: { direction, frame: { payload: text, truncated: false } }, payloadHash: `${direction}:${text}` });
  }
  frame("sent", '4225["find","api/location",{}]');
  frame("received", `4325${JSON.stringify([null, [{ locationId: "loc_001", name: "Synthetic home", armState,
    updatedAt: "2026-09-01T00:00:00Z" }]])}`);
  const now = Date.now();
  const status = new RuntimeStatusStore({ now: () => now, initial: {
    state: "CONNECTED", chromiumRunning: true, keeperPresent: true, authenticated: true,
    pushConnected: true, parserHealthy: true, initialSnapshotComplete: true, dbAvailable: true,
    heartbeatAtMs: now, initialSnapshotCompletedAtMs: now, lastSnapshotAtMs: now,
    lastParserSuccessAtMs: now, lastPushAtMs: now } });
  return { devices, status, frame };
}
const request = (command = "armAway") => ({ targetType: "location", targetId: "loc_001", command,
  arguments: [], clientRequestId: `location_delivery_${command}` });
const row = (armState = "STAY", locationId = "loc_001", updatedAt: string | null = null) => ({ locationId, armState, updatedAt });

describe("bounded Home Monitor state delivery", () => {
  test("schedules at most five command-local reads, including the final read", async () => {
    vi.useFakeTimers(); const times: number[] = []; const start = Date.now();
    scheduleLocationRechecks(async () => { times.push(Date.now() - start); }, { timeoutMs: 15_000, firstDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(times).toEqual([1_000, 2_000, 4_000, 7_000, 10_000]);
  });
  test("does not poll early when status rechecking is disabled", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => undefined);
    scheduleLocationRechecks(read, { timeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(9_999); expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001); expect(read).toHaveBeenCalledOnce();
  });
  test("never overlaps a slow or hung read, including at the final window", async () => {
    vi.useFakeTimers(); let finish: () => void = () => undefined;
    const read = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const cancel = scheduleLocationRechecks(read, { timeoutMs: 15_000, firstDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(12_000); expect(read).toHaveBeenCalledOnce();
    cancel(); finish(); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledOnce();
  });
  test("cancels future reads immediately on push confirmation", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => undefined);
    const cancel = scheduleLocationRechecks(read, { timeoutMs: 15_000, firstDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500); cancel();
    await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledOnce();
  });
  test("a rejected read cannot leave an unhandled promise or cancel the bounded retries", async () => {
    vi.useFakeTimers(); const read = vi.fn(async () => { throw new Error("offline"); });
    scheduleLocationRechecks(read, { timeoutMs: 15_000, firstDelayMs: 1_000 });
    await vi.advanceTimersByTimeAsync(30_000); expect(read).toHaveBeenCalledTimes(5);
  });
  test("a no-op verification has a hard bound even if a custom reader hangs", async () => {
    vi.useFakeTimers(); const result = boundedLocationRead(() => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(2_250); expect(await result).toBeUndefined();
  });
  test("a cached match without a fresh read is not silently returned as already_confirmed", async () => {
    const { devices, status } = fixture();
    const execute = vi.fn(async () => { throw new Error("command_control_not_found"); });
    const service = new SafeCommandService({ devices, status, executor: { executeLocationAction: execute },
      timeoutMs: 100, resync: async () => undefined });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_control_not_found" });
    expect(execute).toHaveBeenCalledOnce(); devices.close();
  });
  test("a current exact-location read permits a no-op without clicking again", async () => {
    const { devices, status } = fixture(); const execute = vi.fn();
    const service = new SafeCommandService({ devices, status, executor: { executeLocationAction: execute }, timeoutMs: 100,
      resync: async () => ({ source: "location_status", locationId: "loc_001", armState: "AWAY", authoritativeSnapshot: false, startedAtMs: Date.now() }) });
    await expect(service.execute(request())).resolves.toMatchObject({ status: "already_confirmed" });
    expect(execute).not.toHaveBeenCalled(); devices.close();
  });
  test("another location's proof cannot approve a cached no-op", async () => {
    const { devices, status } = fixture(); const execute = vi.fn(async () => { throw new Error("command_control_not_found"); });
    const service = new SafeCommandService({ devices, status, executor: { executeLocationAction: execute }, timeoutMs: 100,
      resync: async () => ({ source: "location_status", locationId: "loc_002", armState: "AWAY", authoritativeSnapshot: false, startedAtMs: Date.now() }) });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_control_not_found" }); devices.close();
  });
  test("unrelated inventory cannot turn a stale cached match into fresh confirmation", async () => {
    const { devices, status } = fixture();
    const service = new SafeCommandService({ devices, status, timeoutMs: 30, resync: async () => undefined,
      executor: { executeLocationAction: async () => {
        devices.observeAdvancedInventorySnapshot({ locations: [{ locationId: "loc_001", name: "Renamed only" }] });
      } } });
    await expect(service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" }); devices.close();
  });
  test("a missing push is recovered by the second read rather than waiting for the final window", async () => {
    vi.useFakeTimers(); const { devices, status } = fixture("DISARMED"); let reads = 0;
    const service = new SafeCommandService({ devices, status, timeoutMs: 15_000, resyncAfterMs: 1_000,
      executor: { executeLocationAction: async () => undefined }, resync: async () => {
        reads++; if (reads === 1) return undefined;
        devices.observeLocationStatusSnapshot(row("AWAY", "loc_001", "2026-09-01T00:00:01Z"), "loc_001");
        return { source: "location_status", locationId: "loc_001", armState: "AWAY", authoritativeSnapshot: false, startedAtMs: Date.now() };
      } });
    const result = service.execute(request());
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(result).resolves.toMatchObject({ status: "confirmed" }); expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000); expect(reads).toBe(2); devices.close();
  });
});

describe("fresh undated status proof", () => {
  const before = { armState: "AWAY", updatedAt: "2026-09-01T00:00:00Z" };
  test("requires two agreeing independent reads for contrary undated state", async () => {
    const read = vi.fn(async () => row());
    expect(await verifyLocationRead(read, "loc_001", before)).toMatchObject({ undatedConfirmed: true });
    expect(read).toHaveBeenCalledTimes(2);
  });
  test.each([row("AWAY"), row("STAY", "loc_002"), row("ARMING"), undefined])("rejects disagreement, another location and transient state (%j)", async (second) => {
    const read = vi.fn().mockResolvedValueOnce(row()).mockResolvedValueOnce(second);
    expect(await verifyLocationRead(read, "loc_001", before)).toBeUndefined();
  });
  test("dated or already matching reads do not require a second request", async () => {
    for (const value of [row("AWAY"), row("STAY", "loc_001", "2026-09-01T00:00:01Z")]) {
      const read = vi.fn(async () => value);
      expect(await verifyLocationRead(read, "loc_001", before)).toMatchObject({ undatedConfirmed: false });
      expect(read).toHaveBeenCalledOnce();
    }
  });
  test("repairs a dropped push without inventing a timestamp or enabling ordinary undated writes", () => {
    const { devices } = fixture(); const old = devices.location("loc_001")!;
    expect(devices.observeLocationStatusSnapshot(row(), "loc_001")).toBe(false);
    const sequence = devices.currentSequence();
    expect(devices.observeLocationStatusSnapshot(row(), "loc_001", { before: old, undatedConfirmed: true })).toBe(true);
    expect(devices.location("loc_001")).toMatchObject({ armState: "STAY", updatedAt: old.updatedAt });
    expect(devices.currentSequence()).toBeGreaterThan(sequence); devices.close();
  });
  test("rejects an in-flight read overtaken by a newer security event", () => {
    const { devices } = fixture(); const old = devices.location("loc_001")!;
    devices.observeLocationStatusSnapshot(row("DISARMED", "loc_001", "2026-09-01T00:00:02Z"), "loc_001");
    expect(devices.observeLocationStatusSnapshot(row(), "loc_001", { before: old, undatedConfirmed: true })).toBe(false);
    expect(devices.location("loc_001")?.armState).toBe("DISARMED"); devices.close();
  });
  test("proof does not allow explicitly older or equal-time contradictory responses", () => {
    const { devices } = fixture(); const old = devices.location("loc_001")!;
    expect(devices.observeLocationStatusSnapshot(row("STAY", "loc_001", old.updatedAt!), "loc_001",
      { before: old, undatedConfirmed: true })).toBe(false); devices.close();
  });
});
