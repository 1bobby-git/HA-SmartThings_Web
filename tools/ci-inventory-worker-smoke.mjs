/** Synthetic slow SQLite commit, not a physical-light latency benchmark. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
const root = resolve(process.argv[2] ?? ".");
const { DeviceStore } = await import(pathToFileURL(join(root, "dist/bridge/src/state/device-store.js")));
const { inventoryCachePath } = await import(pathToFileURL(join(root, "dist/bridge/src/state/inventory-writer.js")));
const directory = await mkdtemp(join(tmpdir(), "stw-compiled-worker-"));
async function run(backgroundPersistence) {
  const path = join(directory, backgroundPersistence ? "worker.sqlite" : "legacy.sqlite");
  const store = new DeviceStore({ sqlitePath: path, backgroundPersistence });
  store.observeAdvancedDeviceSnapshot({ items: [{ deviceId: "dev_001", locationId: "loc_001", label: "Fixture light",
    status: { components: { main: { switch: { switch: { value: "on" } } } } } }] });
  const db = new DatabaseSync(backgroundPersistence ? inventoryCachePath(path) : path);
  db.exec(`CREATE TABLE IF NOT EXISTS normalized_inventory(schema_version INTEGER PRIMARY KEY,inventory_json TEXT NOT NULL,persisted_at TEXT NOT NULL);
    CREATE TRIGGER slow_inventory_fixture AFTER INSERT ON normalized_inventory BEGIN
      SELECT sum(x) FROM (WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM cnt WHERE x<3000000) SELECT x FROM cnt);
    END;`);
  db.close();
  const server = createServer((_req, res) => { res.end(JSON.stringify(store.device("dev_001"))); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let timerDuringWrite = false, persisted = false, timerMs = 0;
  const start = performance.now();
  const timer = new Promise(resolve => setTimeout(() => {
    timerDuringWrite = !persisted; timerMs = performance.now() - start; resolve();
  }, 0));
  const draining = Promise.resolve(store.close()).then(() => { persisted = true; });
  let httpDuringWrite;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal((await response.json()).states[0].value, "on");
    httpDuringWrite = !persisted;
    await draining; await timer;
    const restored = new DeviceStore({ sqlitePath: path, backgroundPersistence });
    assert.equal(restored.device("dev_001").states[0].value, "on"); await restored.close();
  } finally { await new Promise(resolve => server.close(resolve)); await draining; }
  assert.equal(timerDuringWrite, backgroundPersistence);
  if (backgroundPersistence) assert.equal(httpDuringWrite, true);
  return { mode: backgroundPersistence ? "worker" : "sync", timerDuringWrite, httpDuringWrite,
    eventLoopTimerMs: Math.round(timerMs), totalMs: Math.round(performance.now() - start) };
}
try { console.log(JSON.stringify({ fixture: "slow_sqlite_not_physical_light", results: [await run(false), await run(true)] })); }
finally { await rm(directory, { recursive: true, force: true }); }
