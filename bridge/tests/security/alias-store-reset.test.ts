import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { SqliteAliasStore, stableDeviceOrLocationAlias } from "../../src/security/alias-store.js";

// Routes that accept a device alias (command-service, camera images, event
// summaries) only allow digits after the prefix.
const DIGIT_DEVICE_ALIAS = /^dev_[0-9]{3,32}$/u;

describe("device and location aliases after a Bridge data reset", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function databasePath(): string {
    const root = mkdtempSync(join(tmpdir(), "stw-alias-reset-"));
    roots.push(root);
    return join(root, "bridge.sqlite");
  }

  test("new aliases are fixed-length digits accepted by every device route", () => {
    const store = new SqliteAliasStore(databasePath(), "unit-secret");
    try {
      const device = store.alias("device", "device-raw-a");
      const location = store.alias("location", "location-raw-a");
      expect(device).toMatch(/^dev_[0-9]{20}$/u);
      expect(device).toMatch(DIGIT_DEVICE_ALIAS);
      expect(location).toMatch(/^loc_[0-9]{20}$/u);
      expect(store.alias("device", "device-raw-b")).not.toBe(device);
      expect(store.alias("location", "device-raw-a")).not.toBe(location);
    } finally {
      store.close();
    }
  });

  test("an empty database with a new secret gives every device its old alias back", () => {
    const original = new SqliteAliasStore(databasePath(), "secret-before-reinstall");
    const before = ["device-raw-a", "device-raw-b", "device-raw-c"].map((raw) =>
      original.alias("device", raw)
    );
    const location = original.alias("location", "location-raw-a");
    original.close();

    // A reinstalled add-on starts with no rows and a new bridge secret, and it
    // discovers the devices in a different order.
    const reset = new SqliteAliasStore(databasePath(), "secret-after-reinstall");
    try {
      const after = ["device-raw-c", "device-raw-a", "device-raw-b"].map((raw) =>
        reset.alias("device", raw)
      );
      expect(after).toEqual([before[2], before[0], before[1]]);
      expect(reset.alias("location", "location-raw-a")).toBe(location);
    } finally {
      reset.close();
    }
  });

  test("keeps sequential aliases from earlier versions and never reuses their numbers", () => {
    const path = databasePath();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE aliases (
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, digest),
        UNIQUE (kind, alias)
      );
    `);
    const insert = legacy.prepare("INSERT INTO aliases (kind, digest, alias) VALUES (?, ?, ?)");
    const digest = (kind: string, raw: string) =>
      createHmac("sha256", "unit-secret").update(`${kind}:${raw}`).digest("hex");
    insert.run("device", digest("device", "old-device-1"), "dev_001");
    insert.run("device", digest("device", "old-device-2"), "dev_002");
    insert.run("location", digest("location", "old-location"), "loc_001");
    legacy.close();

    const store = new SqliteAliasStore(path, "unit-secret");
    try {
      expect(store.alias("device", "old-device-1")).toBe("dev_001");
      expect(store.alias("device", "old-device-2")).toBe("dev_002");
      expect(store.alias("location", "old-location")).toBe("loc_001");
      const added = store.alias("device", "new-device");
      expect(added).toBe(stableDeviceOrLocationAlias("device", "new-device"));
      expect(added).not.toBe("dev_003");
      expect(store.alias("location", "new-location")).not.toBe("loc_002");
    } finally {
      store.close();
    }
  });

  test("a new secret over a surviving database keeps the alias and one row per device", () => {
    const path = databasePath();
    const before = new SqliteAliasStore(path, "secret-a");
    const alias = before.alias("device", "device-raw-a");
    before.close();

    const after = new SqliteAliasStore(path, "secret-b");
    try {
      expect(after.alias("device", "device-raw-a")).toBe(alias);
      expect(after.alias("device", "device-raw-a")).toBe(alias);
    } finally {
      after.close();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare("SELECT COUNT(*) AS count FROM aliases WHERE kind = 'device'")
      .get() as { count: number };
    db.close();
    expect(rows.count).toBe(1);
  });
});
