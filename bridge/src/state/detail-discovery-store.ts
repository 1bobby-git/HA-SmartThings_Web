import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DetailDiscoveryExhaustion {
  /** sha256 of the device name the exhausted visits used. */
  nameHash: string;
  exhaustedAtMs: number;
}

export interface DetailDiscoveryExhaustionStore {
  load(): Map<string, DetailDiscoveryExhaustion>;
  save(records: ReadonlyMap<string, DetailDiscoveryExhaustion>): void;
}

const FILE_NAME = "detail-discovery.json";

/**
 * Remembers devices whose detail visits ran out without completing their
 * controls, so a Bridge restart does not reopen a page for each of them.
 */
export class FileDetailDiscoveryStore implements DetailDiscoveryExhaustionStore {
  readonly #path: string;

  constructor(dataDir: string) {
    this.#path = join(dataDir, FILE_NAME);
  }

  load(): Map<string, DetailDiscoveryExhaustion> {
    const records = new Map<string, DetailDiscoveryExhaustion>();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return records;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.exhausted)) {
      return records;
    }
    for (const [deviceId, value] of Object.entries(parsed.exhausted)) {
      if (
        isRecord(value) &&
        typeof value.nameHash === "string" &&
        typeof value.exhaustedAtMs === "number" &&
        Number.isFinite(value.exhaustedAtMs)
      ) {
        records.set(deviceId, { nameHash: value.nameHash, exhaustedAtMs: value.exhaustedAtMs });
      }
    }
    return records;
  }

  save(records: ReadonlyMap<string, DetailDiscoveryExhaustion>): void {
    const temp = `${this.#path}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ schemaVersion: 1, exhausted: Object.fromEntries(records) }),
      { encoding: "utf8", mode: 0o600 }
    );
    renameSync(temp, this.#path);
    chmodSync(this.#path, 0o600);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
