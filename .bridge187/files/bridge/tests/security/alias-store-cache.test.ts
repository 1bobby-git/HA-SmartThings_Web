import { createHmac } from "node:crypto";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SqliteAliasStore } from "../../src/security/alias-store.js";

function withStore(run: (store: SqliteAliasStore, path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "stw-alias-cache-"));
  const path = join(root, "bridge.sqlite");
  const store = new SqliteAliasStore(path, "unit-secret");
  try { run(store, path); }
  finally { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }); }
}

describe("bounded digest-only alias cache", () => {
  test("a warm alias needs no further SQL lookups or statement preparation", () => withStore((store) => {
    const first = store.alias("device", "device-value");
    const get = vi.spyOn(StatementSync.prototype, "get");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    for (let index = 0; index < 1000; index += 1) {
      expect(store.alias("device", "device-value")).toBe(first);
    }
    expect(get).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  }));

  test("preserves persistent aliases across instances and kinds", () => withStore((store, path) => {
    const device = store.alias("device", "same-value");
    const location = store.alias("location", "same-value");
    const reopened = new SqliteAliasStore(path, "unit-secret");
    try {
      expect(reopened.alias("device", "same-value")).toBe(device);
      expect(reopened.alias("location", "same-value")).toBe(location);
      expect(device).not.toBe(location);
      expect(reopened.alias("device", "second-value")).toBe("dev_002");
    } finally { reopened.close(); }
  }));

  test("bounds cached device aliases and reloads an evicted alias without changing it", () => withStore((store, path) => {
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO aliases (kind, digest, alias) VALUES (?, ?, ?)");
      for (let index = 0; index < 2049; index += 1) {
        const digest = createHmac("sha256", "unit-secret").update(`device:value-${index}`).digest("hex");
        insert.run("device", digest, `dev_${String(index + 1).padStart(3, "0")}`);
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    for (let index = 0; index < 2049; index += 1) store.alias("device", `value-${index}`);
    const get = vi.spyOn(StatementSync.prototype, "get");
    expect(store.alias("device", "value-2048")).toBe("dev_2049");
    expect(get).not.toHaveBeenCalled();
    expect(store.alias("device", "value-0")).toBe("dev_001");
    expect(get).toHaveBeenCalledTimes(1);
  }));

  test("transient identifiers do not enter the persistent cache or create rows", () => withStore((store, path) => {
    const alias = store.alias("device", "stable-value");
    const get = vi.spyOn(StatementSync.prototype, "get");
    for (let index = 0; index < 3000; index += 1) store.alias("identifier", `request-${index}`);
    expect(store.alias("device", "stable-value")).toBe(alias);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM aliases").get()?.count).toBe(1); }
    finally { db.close(); }
  }));

  test("failed insert is never cached", () => withStore((store) => {
    const run = vi.spyOn(StatementSync.prototype, "run").mockImplementationOnce(() => { throw new Error("synthetic_write_failure"); });
    expect(() => store.alias("device", "new-value")).toThrow("synthetic_write_failure");
    run.mockRestore();
    expect(store.alias("device", "new-value")).toBe("dev_001");
  }));
});
