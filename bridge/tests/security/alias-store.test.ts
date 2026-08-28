import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { SqliteAliasStore } from "../../src/security/alias-store.js";

describe("SqliteAliasStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps digest-derived aliases stable without persisting unbounded identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-alias-store-"));
    roots.push(root);
    const path = join(root, "bridge.sqlite");
    const aliases = new SqliteAliasStore(path, "unit-secret");

    const identifier = aliases.alias("identifier", "request-id-that-never-repeats");
    expect(aliases.alias("identifier", "request-id-that-never-repeats")).toBe(identifier);
    aliases.alias("account", "account-value");
    aliases.alias("user", "user-value");
    aliases.alias("device", "device-value");
    aliases.alias("location", "location-value");
    aliases.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare("SELECT kind, COUNT(*) AS count FROM aliases GROUP BY kind ORDER BY kind")
      .all() as unknown as Array<{ kind: string; count: number }>;
    db.close();

    expect(rows).toEqual([
      { kind: "device", count: 1 },
      { kind: "location", count: 1 }
    ]);
  });

  test("removes legacy digest-derived alias rows during the bounded startup migration", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-alias-migration-"));
    roots.push(root);
    const path = join(root, "bridge.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE aliases (
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, digest),
        UNIQUE (kind, alias)
      );
      INSERT INTO aliases (kind, digest, alias) VALUES
        ('identifier', 'legacy-digest', 'identifier_0123456789ab'),
        ('device', 'device-digest', 'dev_001');
    `);
    db.close();

    const aliases = new SqliteAliasStore(path, "unit-secret");
    aliases.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    const rows = migrated
      .prepare("SELECT kind, COUNT(*) AS count FROM aliases GROUP BY kind ORDER BY kind")
      .all() as unknown as Array<{ kind: string; count: number }>;
    migrated.close();

    expect(rows).toEqual([{ kind: "device", count: 1 }]);
  });

  test("records logical cleanup without requiring startup database compaction", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-alias-logical-migration-"));
    roots.push(root);
    const path = join(root, "bridge.sqlite");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE aliases (
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, digest),
        UNIQUE (kind, alias)
      );
      WITH RECURSIVE values_to_remove(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM values_to_remove WHERE value < 5000
      )
      INSERT INTO aliases (kind, digest, alias)
      SELECT
        'identifier',
        printf('digest-%06d', value),
        printf('identifier_%06d_%s', value, hex(randomblob(256)))
      FROM values_to_remove;
      INSERT INTO aliases (kind, digest, alias)
      VALUES ('device', 'device-digest', 'dev_001');
    `);
    db.close();

    const aliases = new SqliteAliasStore(path, "unit-secret");
    aliases.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    const marker = migrated
      .prepare("SELECT name FROM bridge_migrations WHERE name = ?")
      .get("digest-only-aliases-v1") as { name: string } | undefined;
    const freePages = migrated.prepare("PRAGMA freelist_count").get() as {
      freelist_count: number;
    };
    migrated.close();

    expect(marker?.name).toBe("digest-only-aliases-v1");
    expect(freePages.freelist_count).toBeGreaterThan(0);
  });
});
