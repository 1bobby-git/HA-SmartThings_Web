import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { CaptureStore, sanitizeCaptureRecord } from "../../src/state/capture-store.js";

describe("CaptureStore", () => {
  test("persists only records that went through the sanitizer boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    try {
      const store = new CaptureStore(join(root, "capture.sqlite"));
      const sanitized = sanitizeCaptureRecord(
        "unit",
        { url: "https://example.test/?token=secret", deviceId: "raw-device" },
        () => ({ url: "https://example.test/?token=[REDACTED]", deviceId: "dev_001" })
      );

      store.write(sanitized);
      const rows = store.listRecent(5);
      store.close();

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toMatch(/secret|raw-device/);
      expect(rows[0]?.payload).toContain("dev_001");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects forged records that only copy the sanitizer marker", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      const currentStore = store;

      expect(() =>
        currentStore.write({
          __sanitized: true,
          source: "unit",
          receivedAt: new Date().toISOString(),
          payload: { token: "secret" },
          payloadHash: "forged"
        })
      ).toThrow(/sanitizer/);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("validates recent capture limits before querying", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      const currentStore = store;

      expect(() => currentStore.listRecent(0)).toThrow(/limit/);
      expect(() => currentStore.listRecent(1.5)).toThrow(/limit/);
      expect(() => currentStore.listRecent(1001)).toThrow(/limit/);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("pings the capture database without writing capture data", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));

      expect(store.ping()).toBe(true);
      expect(store.listRecent(5)).toHaveLength(0);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("persists while an external read-only inspector holds a read transaction", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    const sqlitePath = join(root, "capture.sqlite");
    let store: CaptureStore | undefined;
    let inspector: DatabaseSync | undefined;
    try {
      store = new CaptureStore(sqlitePath);
      inspector = new DatabaseSync(sqlitePath, { readOnly: true });
      inspector.exec("BEGIN");
      inspector.prepare("SELECT COUNT(*) AS count FROM captures").get();

      expect(() =>
        store?.write(sanitizeCaptureRecord("unit", { value: "under-read-lock" }, (value) => value))
      ).not.toThrow();

      expect(store.listRecent(5).map((row) => row.payload)).toContain('{"value":"under-read-lock"}');
    } finally {
      inspector?.exec("ROLLBACK");
      inspector?.close();
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("drops a capture instead of throwing when another writer holds the database lock", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-"));
    const sqlitePath = join(root, "capture.sqlite");
    let store: CaptureStore | undefined;
    let locker: DatabaseSync | undefined;
    try {
      store = new CaptureStore(sqlitePath);
      locker = new DatabaseSync(sqlitePath);
      locker.exec("BEGIN EXCLUSIVE");

      expect(() =>
        store?.write(sanitizeCaptureRecord("unit", { value: "under-write-lock" }, (value) => value))
      ).not.toThrow();
    } finally {
      locker?.exec("ROLLBACK");
      locker?.close();
      const rows = store?.listRecent(5) ?? [];
      store?.close();
      rmSync(root, { force: true, recursive: true });
      expect(rows.map((row) => row.payload)).not.toContain('{"value":"under-write-lock"}');
    }
  });

  test("skips consecutive records with the same source and sanitized payload hash", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-dedupe-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      store.write(sanitizeCaptureRecord("unit", { value: "same" }, (value) => value));
      store.write(sanitizeCaptureRecord("unit", { value: "same" }, (value) => value));

      expect(store.listRecent(5)).toHaveLength(1);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("retains only the newest bounded diagnostic capture window on startup", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-retention-"));
    const sqlitePath = join(root, "capture.sqlite");
    let store: CaptureStore | undefined;
    let inspector: DatabaseSync | undefined;
    try {
      const seed = new DatabaseSync(sqlitePath);
      seed.exec(`
        CREATE TABLE captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          received_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL
        );
        WITH RECURSIVE rows(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM rows WHERE value < 2010
        )
        INSERT INTO captures (source, received_at, payload_json, payload_hash)
        SELECT 'unit', '2026-08-25T00:00:00Z', '{}', printf('%064d', value)
        FROM rows;
      `);
      seed.close();

      store = new CaptureStore(sqlitePath);
      store.close();
      store = undefined;
      inspector = new DatabaseSync(sqlitePath, { readOnly: true });
      const aggregate = inspector
        .prepare("SELECT COUNT(*) AS count, MIN(id) AS minId, MAX(id) AS maxId FROM captures")
        .get() as { count: number; minId: number; maxId: number };

      expect(aggregate).toEqual({ count: 2000, minId: 11, maxId: 2010 });
    } finally {
      inspector?.close();
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reapplies the bounded capture window while new observations continue", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-running-retention-"));
    const sqlitePath = join(root, "capture.sqlite");
    let store: CaptureStore | undefined;
    let inspector: DatabaseSync | undefined;
    try {
      const seed = new DatabaseSync(sqlitePath);
      seed.exec(`
        CREATE TABLE captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          received_at TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL
        );
        WITH RECURSIVE rows(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM rows WHERE value < 2000
        )
        INSERT INTO captures (source, received_at, payload_json, payload_hash)
        SELECT 'unit', '2026-08-25T00:00:00Z', '{}', printf('%064d', value)
        FROM rows;
      `);
      seed.close();

      store = new CaptureStore(sqlitePath);
      for (let index = 0; index < 1_000; index += 1) {
        store.write(sanitizeCaptureRecord("unit", { index }, (value) => value));
      }
      store.close();
      store = undefined;
      inspector = new DatabaseSync(sqlitePath, { readOnly: true });
      const aggregate = inspector
        .prepare("SELECT COUNT(*) AS count, MIN(id) AS minId, MAX(id) AS maxId FROM captures")
        .get() as { count: number; minId: number; maxId: number };

      expect(aggregate).toEqual({ count: 2000, minId: 1001, maxId: 3000 });
    } finally {
      inspector?.close();
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  }, 30_000);
});
