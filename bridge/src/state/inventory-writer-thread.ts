/** Private inventory-cache worker. No authentication data or device commands. */
import { parentPort, workerData } from "node:worker_threads";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const port = parentPort;
if (!port) throw new Error("inventory_worker_port_missing");
let db: DatabaseSync | undefined;
let previousJson: string | undefined;
try {
  // A separate cache DB avoids holding the live aliases/captures database's
  // writer lock while a slow inventory commit/checkpoint runs in this thread.
  const path = workerData.path as string;
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("inventory_cache_not_regular");
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  db = new DatabaseSync(path, { timeout: 250 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;
    CREATE TABLE IF NOT EXISTS normalized_inventory (
      schema_version INTEGER PRIMARY KEY, inventory_json TEXT NOT NULL, persisted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cache_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL)`);
  const insert = db.prepare(`INSERT INTO normalized_inventory(schema_version,inventory_json,persisted_at)
    VALUES(1,?,?) ON CONFLICT(schema_version) DO UPDATE SET
    inventory_json=excluded.inventory_json,persisted_at=excluded.persisted_at`);
  port.on("message", (message: { id: number; inventory: unknown; close?: boolean }) => {
    if (message.close) {
      try { db?.close(); db = undefined; } catch { /* committed data remains in WAL */ }
      port.close();
      return;
    }
    const start = performance.now();
    let serializeMs = 0, writeMs = 0;
    let outcome: "persisted" | "unchanged" | "failed" = "failed";
    try {
      const json = JSON.stringify(message.inventory);
      serializeMs = Math.max(0, Math.round(performance.now() - start));
      if (json === previousJson) outcome = "unchanged";
      else {
        const writeStart = performance.now();
        try {
          db!.exec("BEGIN IMMEDIATE");
          try {
            insert.run(json, new Date().toISOString());
            db!.prepare("INSERT INTO cache_identity(singleton,identity) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET identity=excluded.identity")
              .run(workerData.identity);
            db!.exec("COMMIT");
          } catch (error) {
            try { db!.exec("ROLLBACK"); } catch { /* retain failure */ }
            throw error;
          }
        }
        finally { writeMs = Math.max(0, Math.round(performance.now() - writeStart)); }
        previousJson = json;
        outcome = "persisted";
      }
    } catch { /* Return fixed categories, never paths, SQL or payloads. */ }
    port.postMessage({ id: message.id, outcome, serializeMs, writeMs });
  });
  port.on("close", () => { try { db?.close(); } catch { /* best effort */ } });
} catch {
  try { db?.close(); } catch { /* keep the fixed failure response */ }
  port.postMessage({ failure: "inventory_worker_init_failed" });
  port.close();
}
