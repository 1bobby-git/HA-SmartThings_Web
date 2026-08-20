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

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL
      )
    `);
  }

  write(record: SanitizedCaptureRecord): void {
    if (record.__sanitized !== true || !sanitizedRecords.has(record)) {
      throw new Error("capture records must pass through sanitizer before persistence");
    }
    this.#db
      .prepare(
        "INSERT INTO captures (source, received_at, payload_json, payload_hash) VALUES (?, ?, ?, ?)"
      )
      .run(record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash);
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
    this.#db.close();
  }
}
