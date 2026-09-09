import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { DeviceStore } from "../../src/state/device-store.js";

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); });
function fixture(deferPersistenceWhile?: () => boolean) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  const dir = mkdtempSync(join(tmpdir(), "stw-interactive-persist-"));
  const path = join(dir, "bridge.sqlite");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const timing = vi.fn();
  const failed = vi.fn();
  const store = new DeviceStore({ sqlitePath: path, onPersistenceTiming: timing,
    onPersistenceError: failed, ...(deferPersistenceWhile ? { deferPersistenceWhile } : {}) });
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  cleanup.push(close);
  const db = new DatabaseSync(path);
  cleanup.push(() => db.close());
  const update = (level: number) => store.observeAdvancedDeviceSnapshot({ items: [{
    deviceId: "dev_001", locationId: "loc_001", label: "Fixture light",
    status: { components: { main: { switchLevel: { level: { value: level } } } } }
  }] });
  const persisted = () => {
    const row = db.prepare("SELECT inventory_json AS json FROM normalized_inventory WHERE schema_version=1").get() as {json: string} | undefined;
    return row ? JSON.parse(row.json) : undefined;
  };
  return {store, db, close, update, persisted, timing, failed};
}

describe("Bounded interaction-aware inventory durability", () => {
  test("unchanged default five-second persistence and actual latest values", async () => {
    const f = fixture(); f.update(10);
    await vi.advanceTimersByTimeAsync(4999); expect(f.persisted()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.persisted()).toEqual(f.store.snapshot());
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({outcome: "persisted", deferredMs: 0}));
  });
  test("does not snapshot or write in the middle of control, then saves the newest state once idle", async () => {
    let busy = true;
    const f = fixture(() => busy); f.update(10);
    const full = vi.spyOn(f.store, "snapshot");
    const events = vi.fn(); f.store.subscribe(events);
    await vi.advanceTimersByTimeAsync(5000);
    expect(full).not.toHaveBeenCalled(); expect(f.persisted()).toBeUndefined();
    f.update(31); expect(events).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); expect(full).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(full).toHaveBeenCalledTimes(1);
    expect(f.persisted().devices[0].states[0].value).toBe(31);
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({outcome: "persisted", deferredMs: 1250}));
  });
  test("continuous control cannot starve durability beyond the 30-second deferral budget", async () => {
    const f = fixture(() => true); f.update(10);
    await vi.advanceTimersByTimeAsync(34999); expect(f.persisted()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.persisted()).toEqual(f.store.snapshot());
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({outcome: "persisted", deferredMs: 30000}));
  });
  test("shutdown flushes even during an active command and cancels the deferred timer", async () => {
    const f = fixture(() => true); f.update(10);
    await vi.advanceTimersByTimeAsync(5000); f.update(89);
    const expected = f.store.snapshot(); f.close();
    expect(f.persisted()).toEqual(expected);
    const writes = f.timing.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(f.timing).toHaveBeenCalledTimes(writes);
  });
  test("a broken optional scheduler fails open for durability", async () => {
    const f = fixture(() => { throw new Error("synthetic scheduler failure"); }); f.update(10);
    await vi.advanceTimersByTimeAsync(5000); expect(f.persisted()).toEqual(f.store.snapshot());
  });
  test("timing observers cannot cause retries or suppress committed values", async () => {
    const f = fixture(); f.timing.mockImplementation(() => { throw new Error("synthetic observer failure"); });
    f.update(10); await vi.advanceTimersByTimeAsync(5000);
    expect(f.failed).not.toHaveBeenCalled(); expect(f.persisted()).toEqual(f.store.snapshot());
    await vi.advanceTimersByTimeAsync(5000); expect(f.timing).toHaveBeenCalledTimes(1);
  });
  test("SQLite failure retains pending data and retries, including changes made after failure", async () => {
    const f = fixture(); f.update(10);
    f.db.exec("BEGIN IMMEDIATE");
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.failed).toHaveBeenCalledTimes(1);
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({outcome: "failed"}));
    f.db.exec("ROLLBACK"); f.update(97);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.persisted()).toEqual(f.store.snapshot());
    expect(f.persisted().devices[0].states[0].value).toBe(97);
  });
});
