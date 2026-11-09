import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { validateSnapshotResponseShape, type SnapshotResponseShape } from "../inspector/snapshot-response-diagnostics.js";
import { REQUIRED_SNAPSHOT_CATEGORIES } from "../inspector/snapshot-detector.js";

export type CaptureSource =
  | "unit"
  | "playwright-request"
  | "playwright-response"
  | "playwright-websocket"
  | "playwright-websocket-frame"
  | "playwright-service-worker"
  | "cdp-websocket-frame"
  | "cdp-eventsource"
  | "cdp-response-body"
  | "page-console"
  | "page-lifecycle";

export interface SanitizedCaptureRecord {
  readonly __sanitized: true;
  readonly source: CaptureSource;
  readonly receivedAt: string;
  readonly payload: unknown;
  readonly payloadHash: string;
}

export interface CaptureRow {
  source: CaptureSource;
  receivedAt: string;
  payload: string;
  payloadHash: string;
}

const sanitizedRecords = new WeakSet<object>();
const maxRecentCaptureLimit = 1000;
const captureBusyTimeoutMs = 250;
const maxPersistedCaptureRows = 2_000;
const capturePruneInterval = 100;

export function sanitizeCaptureRecord(
  source: CaptureSource,
  payload: unknown,
  redact: (value: unknown) => unknown
): SanitizedCaptureRecord {
  const sanitized = redact(payload);
  const serialized = JSON.stringify(sanitized);
  const record: SanitizedCaptureRecord = {
    __sanitized: true,
    source,
    receivedAt: new Date().toISOString(),
    payload: sanitized,
    payloadHash: createHash("sha256").update(serialized).digest("hex")
  };
  sanitizedRecords.add(record);
  return record;
}

export class CaptureStore {
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #recent: StatementSync;
  readonly #ping: StatementSync;
  readonly #prune: StatementSync;
  readonly #upsertDiagnostic: StatementSync;
  readonly #listDiagnostics: StatementSync;
  readonly #scanCandidates: StatementSync;
  readonly #lastPayloadHashBySource = new Map<CaptureSource, string>();
  readonly #lastDiagnosticJsonBySurface = new Map<string, string>();
  #writesSincePrune = 0;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path, { timeout: captureBusyTimeoutMs });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = ${captureBusyTimeoutMs};
      PRAGMA wal_autocheckpoint = 64;
      PRAGMA journal_size_limit = 1048576;

      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_response_diagnostics (
        surface TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL,
        shape_json TEXT NOT NULL
      )
    `);
    this.#insert = this.#db.prepare(
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
    this.#upsertDiagnostic = this.#db.prepare(`INSERT INTO snapshot_response_diagnostics(surface, contract_version, shape_json)
      VALUES (?, ?, ?) ON CONFLICT(surface) DO UPDATE SET contract_version=excluded.contract_version, shape_json=excluded.shape_json`);
    this.#listDiagnostics = this.#db.prepare("SELECT surface, shape_json AS shapeJson FROM snapshot_response_diagnostics WHERE contract_version = ? LIMIT 6");
    this.#scanCandidates = this.#db.prepare("SELECT payload_json AS payload FROM captures WHERE source IN ('playwright-websocket-frame','cdp-websocket-frame') ORDER BY id DESC LIMIT 1000");
    this.#pruneOldCaptures();
  }

  write(record: SanitizedCaptureRecord): void {
    if (record.__sanitized !== true || !sanitizedRecords.has(record)) {
      throw new Error("capture records must pass through sanitizer before persistence");
    }
    if (this.#lastPayloadHashBySource.get(record.source) === record.payloadHash) {
      return;
    }
    try {
      this.#insert.run(
        record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash
      );
      this.#lastPayloadHashBySource.set(record.source, record.payloadHash);
      this.#writesSincePrune += 1;
      if (this.#writesSincePrune >= capturePruneInterval) {
        this.#pruneOldCaptures();
      }
    } catch (error) {
      if (isSqliteBusyError(error)) {
        return;
      }
      throw error;
    }
  }

  listRecent(limit: number): CaptureRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > maxRecentCaptureLimit) {
      throw new Error(`capture list limit must be an integer between 1 and ${maxRecentCaptureLimit}`);
    }
    return this.#recent.all(limit) as unknown as CaptureRow[];
  }

  writeSnapshotDiagnostic(surface: string, contractVersion: number, shape: SnapshotResponseShape): void {
    if (!isSnapshotSurface(surface) || !Number.isSafeInteger(contractVersion) || contractVersion < 0) throw new Error("invalid_diagnostic");
    const safe = validateSnapshotResponseShape(shape);
    if (!safe) throw new Error("invalid_diagnostic");
    const serialized = JSON.stringify(safe);
    const fingerprint = `${contractVersion}:${serialized}`;
    if (this.#lastDiagnosticJsonBySurface.get(surface) === fingerprint) return;
    this.#upsertDiagnostic.run(surface, contractVersion, serialized);
    this.#lastDiagnosticJsonBySurface.set(surface, fingerprint);
  }

  listSnapshotDiagnostics(contractVersion: number): Array<{ surface: string; shape: SnapshotResponseShape }> {
    const result: Array<{ surface: string; shape: SnapshotResponseShape }> = [];
    for (const row of this.#listDiagnostics.iterate(contractVersion) as Iterable<{ surface: string; shapeJson: string }>) {
      if (!isSnapshotSurface(row.surface) || typeof row.shapeJson !== "string" || row.shapeJson.length > 8192) continue;
      try {
        const shape = validateSnapshotResponseShape(JSON.parse(row.shapeJson));
        if (shape) result.push({ surface: row.surface, shape });
      } catch { /* A damaged diagnostic is excluded. */ }
    }
    return result;
  }

  *recentWebsocketCapturePayloads(): Generator<string> {
    let bytes = 0;
    for (const row of this.#scanCandidates.iterate() as Iterable<{ payload: string }>) {
      if (typeof row.payload !== "string") continue;
      bytes += Buffer.byteLength(row.payload);
      if (bytes > 10 * 1024 * 1024) break;
      yield row.payload;
    }
  }

  ping(): boolean {
    this.#ping.get();
    return true;
  }

  close(): void {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A concurrent reader may keep the WAL busy during shutdown.
    }
    this.#db.close();
  }

  #pruneOldCaptures(): void {
    this.#prune.run(maxPersistedCaptureRows - 1);
    this.#writesSincePrune = 0;
  }
}

function isSnapshotSurface(surface: string): boolean {
  return REQUIRED_SNAPSHOT_CATEGORIES.some((category) => surface === `snapshot:${category}:response_shape`);
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return /\bdatabase is (?:locked|busy)\b/i.test(error.message);
}
