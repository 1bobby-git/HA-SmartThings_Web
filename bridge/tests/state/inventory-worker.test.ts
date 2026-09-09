import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { DeviceStore, type BridgeInventory } from "../../src/state/device-store.js";
import { ThreadedInventoryWriter, inventoryCachePath, readInventoryCache,
  type InventoryWriter, type InventoryWriteResult } from "../../src/state/inventory-writer.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.useRealTimers(); });
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "stw-worker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "bridge.sqlite") };
}
function update(store: DeviceStore, level: number) {
  store.observeAdvancedDeviceSnapshot({ items: [{ deviceId: "dev_001", locationId: "loc_001", label: "Light fixture",
    status: { components: { main: { switchLevel: { level: { value: level, timestamp: `2026-09-09T00:00:${String(level).padStart(2,"0")}.000Z` } } } } }
  }] });
}
function inventory(level: number): BridgeInventory {
  const store = new DeviceStore(); update(store, level); return store.snapshot();
}
function controlled() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  const { path } = temp();
  const pending: ((v: InventoryWriteResult) => void)[] = [];
  const submitted: BridgeInventory[] = [];
  const writer: InventoryWriter = { write: vi.fn(async (value) => {
    submitted.push(value); return await new Promise<InventoryWriteResult>(resolve => pending.push(resolve));
  }), close: vi.fn(async () => undefined) };
  const errors = vi.fn(), timing = vi.fn();
  const store = new DeviceStore({ sqlitePath: path, persistenceWriter: writer, onPersistenceError: errors, onPersistenceTiming: timing });
  return { store, submitted, writer, errors, timing, finish(outcome: InventoryWriteResult["outcome"] = "persisted") {
    const done = pending.shift(); if (!done) throw new Error("no pending write");
    done({ outcome, serializeMs: 5, writeMs: 1242 });
  } };
}

describe("Inventory worker scheduling and shutdown", () => {
  test("continues delivering state while a slow write is pending and coalesces newer updates", async () => {
    const f = controlled(); update(f.store, 1);
    const events = vi.fn(); f.store.subscribe(events);
    await vi.advanceTimersByTimeAsync(5000); expect(f.submitted).toHaveLength(1);
    for (let level = 2; level <= 59; level++) update(f.store, level);
    expect(events).toHaveBeenCalled(); expect(f.store.device("dev_001")!.states[0]!.value).toBe(59);
    await vi.advanceTimersByTimeAsync(30000); expect(f.submitted).toHaveLength(1);
    f.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(f.submitted[0]!.devices[0]!.states[0]!.value).toBe(1); // detached snapshot
    await vi.advanceTimersByTimeAsync(5000); expect(f.submitted).toHaveLength(2);
    expect(f.submitted[1]!.devices[0]!.states[0]!.value).toBe(59);
    f.finish(); await vi.advanceTimersByTimeAsync(0); await f.store.close();
    expect(f.timing).toHaveBeenCalledWith(expect.objectContaining({ mode: "worker", writeMs: 1242 }));
  });
  test("shutdown drains old write then saves latest state once, even while busy", async () => {
    const f = controlled(); update(f.store, 1); await vi.advanceTimersByTimeAsync(5000); update(f.store, 2);
    let closed = false; const close = Promise.resolve(f.store.close()).then(() => { closed = true; });
    expect(f.store.close()).toBeInstanceOf(Promise); expect(closed).toBe(false);
    f.finish(); await vi.advanceTimersByTimeAsync(0); expect(f.submitted).toHaveLength(2);
    expect(f.submitted[1]!.devices[0]!.states[0]!.value).toBe(2);
    expect(closed).toBe(false); f.finish(); await close;
    expect(f.writer.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(f.submitted).toHaveLength(2);
  });
  test("failure retries latest values without falling back to the main-thread SQLite write", async () => {
    const f = controlled(); update(f.store, 1); await vi.advanceTimersByTimeAsync(5000);
    f.errors.mockImplementation(() => { throw new Error("observer"); }); f.finish("failed");
    await vi.advanceTimersByTimeAsync(0); update(f.store, 2);
    await vi.advanceTimersByTimeAsync(5000); expect(f.submitted).toHaveLength(2);
    f.finish(); await vi.advanceTimersByTimeAsync(0); await f.store.close();
    expect(f.errors).toHaveBeenCalledTimes(1);
    expect(f.submitted[1]!.devices[0]!.states[0]!.value).toBe(2);
  });
  test("diagnostic failure cannot turn a committed inventory into another write", async () => {
    const f = controlled(); f.timing.mockImplementation(() => { throw new Error("observer"); });
    update(f.store, 1); await vi.advanceTimersByTimeAsync(5000); f.finish();
    await vi.advanceTimersByTimeAsync(10000); expect(f.submitted).toHaveLength(1); expect(f.errors).not.toHaveBeenCalled();
    await f.store.close();
  });
});

describe("Real SQLite inventory worker", () => {
  test("persists the same schema privately, deduplicates, and closes without losing the last write", async () => {
    const { path } = temp(); const cache = inventoryCachePath(path); const writer = new ThreadedInventoryWriter(cache, "fixture-identity");
    cleanups.push(() => writer.close());
    const value = inventory(31);
    expect(await writer.write(value)).toMatchObject({ outcome: "persisted" });
    expect(await writer.write(value)).toMatchObject({ outcome: "unchanged" });
    const last = writer.write(inventory(59)); const done = writer.close();
    expect(await last).toMatchObject({ outcome: "persisted" }); await done;
    expect(JSON.parse(readInventoryCache(cache, "fixture-identity")!.json)).toEqual(inventory(59));
    if (process.platform !== "win32") expect(statSync(cache).mode & 0o777).toBe(0o600);
    await expect(writer.write(value)).rejects.toThrow("inventory_worker_unavailable");
  });
  test("upgrades legacy inventory without changing entity aliases/mappings or destroying the old cache", async () => {
    const { path } = temp(); const legacy = new DeviceStore({ sqlitePath: path });
    update(legacy, 1); legacy.rememberComponentChildMappings("dev_001", [{ component: "main", childDeviceId: "dev_002" }]);
    const before = legacy.snapshot(); legacy.close();
    const store = new DeviceStore({ sqlitePath: path, backgroundPersistence: true });
    expect(store.snapshot()).toEqual(before); expect(store.componentChildMappings("dev_001")?.get("main")).toBe("dev_002");
    update(store, 2); const final = store.snapshot(); await store.close();
    const restored = new DeviceStore({ sqlitePath: path, backgroundPersistence: true });
    expect(restored.snapshot()).toEqual(final); await restored.close();
    const rollback = new DeviceStore({ sqlitePath: path }); expect(rollback.snapshot()).toEqual(before); rollback.close();
  });
  test("recreated identity database never restores a cache belonging to old device aliases", async () => {
    const { path } = temp();
    const first = new DeviceStore({ sqlitePath: path, backgroundPersistence: true }); update(first, 1); await first.close();
    rmSync(path); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
    const fresh = new DeviceStore({ sqlitePath: path, backgroundPersistence: true });
    expect(fresh.snapshot().devices).toHaveLength(0); update(fresh, 9); await fresh.close();
    const restart = new DeviceStore({ sqlitePath: path, backgroundPersistence: true });
    expect(restart.device("dev_001")!.states[0]!.value).toBe(9); await restart.close();
  });
  test("re-upgrade prefers a newer valid legacy snapshot saved after rollback", async () => {
    const { path } = temp();
    const first = new DeviceStore({ sqlitePath: path, backgroundPersistence: true }); update(first, 1); await first.close();
    const older = new DeviceStore({ sqlitePath: path }); update(older, 7); older.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE normalized_inventory SET persisted_at=?").run("2099-01-01T00:00:00.000Z"); db.close();
    const upgraded = new DeviceStore({ sqlitePath: path, backgroundPersistence: true });
    expect(upgraded.device("dev_001")!.states[0]!.value).toBe(7); await upgraded.close();
  });
  test("a blocked inventory writer does not block the event loop or alias/capture database", async () => {
    const { path } = temp(); const cache = inventoryCachePath(path); const writer = new ThreadedInventoryWriter(cache, "fixture-identity");
    cleanups.push(() => writer.close()); await writer.write(inventory(1));
    const lock = new DatabaseSync(cache); cleanups.push(() => lock.close()); lock.exec("BEGIN IMMEDIATE");
    let finished = false;
    const write = writer.write(inventory(2)).then(result => { finished = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(finished).toBe(false);
    const identity = new DatabaseSync(path); identity.exec("CREATE TABLE aliases_fixture(value); INSERT INTO aliases_fixture VALUES (1)"); identity.close();
    // The timeout occurs inside the real worker, while this thread can run.
    expect((await write).outcome).toBe("failed"); lock.exec("ROLLBACK");
    expect((await writer.write(inventory(3))).outcome).toBe("persisted");
  });
  test("bounds a stalled worker request and starts a clean replacement before retrying", async () => {
    const { path } = temp(); const writer = new ThreadedInventoryWriter(inventoryCachePath(path), "fixture-identity");
    cleanups.push(() => writer.close()); await writer.write(inventory(1));
    const blocked = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => undefined);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = writer.write(inventory(2));
    await vi.advanceTimersByTimeAsync(15000);
    expect((await pending).outcome).toBe("failed");
    blocked.mockRestore(); vi.useRealTimers();
    expect((await writer.write(inventory(3))).outcome).toBe("persisted");
    expect(JSON.parse(readInventoryCache(inventoryCachePath(path), "fixture-identity")!.json)).toEqual(inventory(3));
  });
  test("contains worker posting failure and allows the next bounded save to recover", async () => {
    const { path } = temp(); const writer = new ThreadedInventoryWriter(inventoryCachePath(path), "fixture-identity");
    cleanups.push(() => writer.close()); await writer.write(inventory(1));
    const posting = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => { throw new Error("private path must not escape"); });
    expect((await writer.write(inventory(2))).outcome).toBe("failed"); posting.mockRestore();
    expect((await writer.write(inventory(3))).outcome).toBe("persisted");
  });
  test("does not accumulate concurrent inventory messages", async () => {
    const { path } = temp(); const writer = new ThreadedInventoryWriter(inventoryCachePath(path), "fixture-identity");
    cleanups.push(() => writer.close()); const first = writer.write(inventory(1));
    await expect(writer.write(inventory(2))).rejects.toThrow("inventory_worker_unavailable");
    expect((await first).outcome).toBe("persisted");
    expect((await writer.write(inventory(3))).outcome).toBe("persisted");
  });
  test("rejects a private cache symlink and never overwrites the target", async () => {
    const { path, dir } = temp(); const target = join(dir, "preserve"); writeFileSync(target, "keep");
    symlinkSync(target, inventoryCachePath(path));
    const writer = new ThreadedInventoryWriter(inventoryCachePath(path), "fixture-identity"); cleanups.push(() => writer.close());
    expect((await writer.write(inventory(1))).outcome).toBe("failed");
    expect(statSync(target).size).toBe(4);
  });
  test("corrupt new cache falls back to valid legacy data without claiming persistence succeeded", async () => {
    const { path } = temp(); const original = new DeviceStore({ sqlitePath: path }); update(original, 5); original.close();
    writeFileSync(inventoryCachePath(path), "broken-cache");
    const failed = vi.fn(); const store = new DeviceStore({ sqlitePath: path, backgroundPersistence: true, onPersistenceError: failed });
    expect(store.device("dev_001")!.states[0]!.value).toBe(5); expect(failed).toHaveBeenCalled();
    await store.close(); expect(failed.mock.calls.length).toBeGreaterThan(1);
  });
});
