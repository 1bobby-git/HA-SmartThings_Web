import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type AliasKind = "location" | "device" | "account" | "user" | "identifier";

const digestOnlyAliasKinds = new Set<AliasKind>(["account", "user", "identifier"]);
const digestOnlyMigration = "digest-only-aliases-v1";

export class SqliteAliasStore {
  readonly #db: DatabaseSync;
  readonly #secret: string;

  constructor(path: string, secret: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#secret = secret;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS aliases (
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        alias TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, digest),
        UNIQUE (kind, alias)
      );

      CREATE TABLE IF NOT EXISTS bridge_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.#migrateDigestOnlyAliases();
  }

  alias(kind: AliasKind, rawIdentifier: string): string {
    const digest = this.#digest(kind, rawIdentifier);
    if (digestOnlyAliasKinds.has(kind)) {
      return this.#createAlias(kind, digest);
    }
    const found = this.#db
      .prepare("SELECT alias FROM aliases WHERE kind = ? AND digest = ?")
      .get(kind, digest) as { alias: string } | undefined;
    if (found) {
      return found.alias;
    }

    const alias = this.#createAlias(kind, digest);
    this.#db
      .prepare("INSERT INTO aliases (kind, digest, alias) VALUES (?, ?, ?)")
      .run(kind, digest, alias);
    return alias;
  }

  close(): void {
    this.#db.close();
  }

  #migrateDigestOnlyAliases(): void {
    const applied = this.#db
      .prepare("SELECT 1 AS applied FROM bridge_migrations WHERE name = ?")
      .get(digestOnlyMigration) as { applied: number } | undefined;
    if (applied) return;

    // These aliases are deterministic HMAC digests. Persisting every transient
    // request/event ID only grows SQLite without adding identity stability.
    // This constructor runs before the capture and inventory connections open,
    // so one bounded compaction can safely reclaim the legacy rows and pages.
    this.#db.exec("DELETE FROM aliases WHERE kind IN ('account', 'user', 'identifier')");
    this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.#db.exec("VACUUM");
    this.#db
      .prepare("INSERT INTO bridge_migrations (name) VALUES (?)")
      .run(digestOnlyMigration);
  }

  #digest(kind: AliasKind, rawIdentifier: string): string {
    return createHmac("sha256", this.#secret)
      .update(`${kind}:${rawIdentifier}`)
      .digest("hex");
  }

  #createAlias(kind: AliasKind, digest: string): string {
    if (kind === "location" || kind === "device") {
      const prefix = kind === "location" ? "loc" : "dev";
      const row = this.#db
        .prepare("SELECT COUNT(*) AS count FROM aliases WHERE kind = ?")
        .get(kind) as { count: number };
      return `${prefix}_${String(row.count + 1).padStart(3, "0")}`;
    }

    return `${kind}_${digest.slice(0, 12)}`;
  }
}
