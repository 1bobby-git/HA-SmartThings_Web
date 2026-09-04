import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

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
  readonly #lastPayloadHashBySource = new Map<CaptureSource, string>();
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
      )
    `);
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
      this.#db
        .prepare(
          "INSERT INTO captures (source, received_at, payload_json, payload_hash) VALUES (?, ?, ?, ?)"
        )
        .run(record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash);
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
    return this.#db
      .prepare(
        "SELECT source, received_at AS receivedAt, payload_json AS payload, payload_hash AS payloadHash FROM captures ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as unknown as CaptureRow[];
  }

  ping(): boolean {
    this.#db.prepare("SELECT 1").get();
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
    this.#db
      .prepare(`
        DELETE FROM captures
        WHERE id < COALESCE(
          (SELECT id FROM captures ORDER BY id DESC LIMIT 1 OFFSET ?),
          0
        )
      `)
      .run(maxPersistedCaptureRows - 1);
    this.#writesSincePrune = 0;
  }
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
