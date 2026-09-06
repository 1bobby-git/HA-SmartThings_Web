from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == 'aa7000eec7b0d095b6baf669c20784e045f2eba2'

def replace(path, old, new, n=1):
    p = root / path
    text = p.read_text(encoding='utf-8')
    assert text.count(old) == n, (path, old[:60], text.count(old))
    p.write_text(text.replace(old, new), encoding='utf-8')

p = 'bridge/src/browser/keeper-page.ts'
replace(p, '  #restoredPagesReconciled = false;', '  #restoredPagesReconciled = false;\n  #restoreInFlight: Promise<BrowserPageLike | undefined> | undefined;\n  #ensureInFlight: Promise<BrowserPageLike> | undefined;')
replace(p, '  async reconcileRestoredPages(): Promise<BrowserPageLike | undefined> {', '''  reconcileRestoredPages(): Promise<BrowserPageLike | undefined> {
    if (!this.#restoreInFlight) {
      const pending = this.reconcileRestoredPagesOnce().finally(() => {
        if (this.#restoreInFlight === pending) this.#restoreInFlight = undefined;
      });
      this.#restoreInFlight = pending;
    }
    return this.#restoreInFlight;
  }

  private async reconcileRestoredPagesOnce(): Promise<BrowserPageLike | undefined> {''')
replace(p, '  async ensureKeeper(): Promise<BrowserPageLike> {', '''  ensureKeeper(): Promise<BrowserPageLike> {
    if (!this.#ensureInFlight) {
      // Heartbeats and recovery may overlap while newPage/goto/close is pending.
      // Share only the current operation, never cache a completed page promise.
      const pending = this.ensureKeeperOnce().finally(() => {
        if (this.#ensureInFlight === pending) this.#ensureInFlight = undefined;
      });
      this.#ensureInFlight = pending;
    }
    return this.#ensureInFlight;
  }

  private async ensureKeeperOnce(): Promise<BrowserPageLike> {''')
replace(p, '''    const page = await this.context.newPage();
    await beforeGoto?.(page);
    await page.goto(ADVANCED_URL, { waitUntil: "domcontentloaded" });
    return page;''', '''    const page = await this.context.newPage();
    try {
      await beforeGoto?.(page);
      await page.goto(ADVANCED_URL, { waitUntil: "domcontentloaded" });
      return page;
    } catch (error) {
      // The caller cannot close a page that was never returned to it.
      await page.close().catch(() => undefined);
      throw error;
    }''')
replace(p, '''    const page = await this.context.newPage();
    await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
    return page;''', '''    const page = await this.context.newPage();
    try {
      await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded" });
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }''')
replace('bridge/src/advanced/capability-cache.ts', '''        this.#entries.delete(key);
        throw error;''', '''        if (this.#entries.get(key) === loaded) this.#entries.delete(key);
        throw error;''')
p = 'bridge/src/security/alias-store.ts'
replace(p, 'import { DatabaseSync } from "node:sqlite";', 'import { DatabaseSync, type StatementSync } from "node:sqlite";')
replace(p, 'const digestOnlyMigration = "digest-only-aliases-v1";', 'const digestOnlyMigration = "digest-only-aliases-v1";\nconst maxCachedAliases = 2048;')
replace(p, '  readonly #secret: string;', '''  readonly #secret: string;
  readonly #lookup: StatementSync;
  readonly #insert: StatementSync;
  readonly #count: StatementSync;
  // Cache HMAC digests, never raw device/account identifiers or credentials.
  readonly #cache = new Map<string, string>();''')
replace(p, '    this.#migrateDigestOnlyAliases();', '''    this.#migrateDigestOnlyAliases();
    this.#lookup = this.#db.prepare("SELECT alias FROM aliases WHERE kind = ? AND digest = ?");
    this.#insert = this.#db.prepare("INSERT INTO aliases (kind, digest, alias) VALUES (?, ?, ?)");
    this.#count = this.#db.prepare("SELECT COUNT(*) AS count FROM aliases WHERE kind = ?");''')
replace(p, '''    const found = this.#db
      .prepare("SELECT alias FROM aliases WHERE kind = ? AND digest = ?")
      .get(kind, digest) as { alias: string } | undefined;
    if (found) {
      return found.alias;
    }

    const alias = this.#createAlias(kind, digest);
    this.#db
      .prepare("INSERT INTO aliases (kind, digest, alias) VALUES (?, ?, ?)")
      .run(kind, digest, alias);
    return alias;''', '''    const key = `${kind}:${digest}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const found = this.#lookup.get(kind, digest) as { alias: string } | undefined;
    if (found) {
      this.#remember(key, found.alias);
      return found.alias;
    }

    const alias = this.#createAlias(kind, digest);
    this.#insert.run(kind, digest, alias);
    this.#remember(key, alias);
    return alias;''')
replace(p, '''  close(): void {
    this.#db.close();
  }''', '''  close(): void {
    this.#cache.clear();
    this.#db.close();
  }

  #remember(key: string, alias: string): void {
    this.#cache.set(key, alias);
    if (this.#cache.size > maxCachedAliases) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
  }''')
replace(p, '''      const row = this.#db
        .prepare("SELECT COUNT(*) AS count FROM aliases WHERE kind = ?")
        .get(kind) as { count: number };''', '''      const row = this.#count.get(kind) as { count: number };''')
p = 'bridge/src/state/capture-store.ts'
replace(p, 'import { DatabaseSync } from "node:sqlite";', 'import { DatabaseSync, type StatementSync } from "node:sqlite";')
replace(p, '  readonly #db: DatabaseSync;', '''  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #recent: StatementSync;
  readonly #ping: StatementSync;
  readonly #prune: StatementSync;''')
replace(p, '''    this.#pruneOldCaptures();
  }

  write(''', '''    this.#insert = this.#db.prepare(
      "INSERT INTO captures (source, received_at, payload_json, payload_hash) VALUES (?, ?, ?, ?)"
    );
    this.#recent = this.#db.prepare(
      "SELECT source, received_at AS receivedAt, payload_json AS payload, payload_hash AS payloadHash FROM captures ORDER BY id DESC LIMIT ?"
    );
    this.#ping = this.#db.prepare("SELECT 1");
    this.#prune = this.#db.prepare(`
      DELETE FROM captures
      WHERE id < COALESCE(
        (SELECT id FROM captures ORDER BY id DESC LIMIT 1 OFFSET ?),
        0
      )
    `);
    this.#pruneOldCaptures();
  }

  write(''')
replace(p, '''      this.#db
        .prepare(
          "INSERT INTO captures (source, received_at, payload_json, payload_hash) VALUES (?, ?, ?, ?)"
        )
        .run(record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash);''', '''      this.#insert.run(
        record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash
      );''')
replace(p, '''    return this.#db
      .prepare(
        "SELECT source, received_at AS receivedAt, payload_json AS payload, payload_hash AS payloadHash FROM captures ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as unknown as CaptureRow[];''', '''    return this.#recent.all(limit) as unknown as CaptureRow[];''')
replace(p, '    this.#db.prepare("SELECT 1").get();', '    this.#ping.get();')
replace(p, '''    this.#db
      .prepare(`
        DELETE FROM captures
        WHERE id < COALESCE(
          (SELECT id FROM captures ORDER BY id DESC LIMIT 1 OFFSET ?),
          0
        )
      `)
      .run(maxPersistedCaptureRows - 1);''', '''    this.#prune.run(maxPersistedCaptureRows - 1);''')
for p, n in [('package.json', 1), ('package-lock.json', 2)]:
    replace(p, '"version": "1.8.6"', '"version": "1.8.7"', n)
replace('protocol/version.json', '"bridge_version": "1.8.6"', '"bridge_version": "1.8.7"')
replace('addon/smartthings_web_bridge/config.yaml', 'version: 1.8.6', 'version: 1.8.7')
replace('bridge/src/runtime.ts', 'const bridgeVersion = "1.8.6";', 'const bridgeVersion = "1.8.7";')
replace('tests/protocol-version-contract.test.ts', 'unchanged Bridge 1.8.6', 'Bridge 1.8.7')
replace('tests/protocol-version-contract.test.ts', 'const expectedBridgeVersion = "1.8.6";', 'const expectedBridgeVersion = "1.8.7";')
p = 'tests/addon-config.test.ts'
replace(p, 'as version 1.8.6', 'as version 1.8.7')
replace(p, 'toBe("1.8.6")', 'toBe("1.8.7")', 3)
replace(p, '''toContain('const bridgeVersion = "1.8.6";')''', '''toContain('const bridgeVersion = "1.8.7";')''')
replace(p, '    expect(changelog).toContain("## 1.8.6");', '    expect(changelog).toContain("## 1.8.7");\n    expect(changelog).toContain("## 1.8.6");')
print('Applied guarded bridge-only source changes.')
