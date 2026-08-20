import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type AliasKind = "location" | "device" | "account" | "user" | "identifier";

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
      )
    `);
  }

  alias(kind: AliasKind, rawIdentifier: string): string {
    const digest = this.#digest(kind, rawIdentifier);
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
