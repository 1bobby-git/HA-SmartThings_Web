import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface SessionStorageState {
  cookies: unknown[];
  origins: unknown[];
}

/** Only a genuinely empty profile may be replaced with an older backup.
 * Unknown/corrupt state fails closed; it is not proof that a profile is empty.
 */
export function isEmptySessionStorageState(value: unknown): boolean {
  const state = normalizeSessionStorageState(value);
  if (!state || state.cookies.length !== 0) return false;
  return state.origins.every((origin) => {
    const record = origin as Record<string, unknown>;
    return ["localStorage", "indexedDB"].every((key) =>
      record[key] === undefined || (Array.isArray(record[key]) && record[key].length === 0)
    );
  });
}

export type SessionStorageRestoreMode = "full" | "legacy";

export interface SessionStorageRestoreContext {
  setStorageState?: (state: SessionStorageState) => Promise<unknown>;
}

/** Restore the complete last verified Playwright storage state when supported.
 * This covers cookies, localStorage and IndexedDB. The caller keeps the existing
 * cookie + page-localStorage compatibility path for older contexts.
 */
export async function restoreSessionStorageState(
  context: SessionStorageRestoreContext,
  state: SessionStorageState
): Promise<SessionStorageRestoreMode> {
  if (!context.setStorageState) return "legacy";
  await context.setStorageState(state);
  return "full";
}

interface EncryptedSessionStateEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

const SESSION_STATE_VERSION = 1;
const SESSION_STATE_ALGORITHM = "aes-256-gcm";
const SESSION_STATE_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_STATE_KEY_CONTEXT = "smartthings-web:session-state:v1";
const SESSION_STATE_IV_BYTES = 12;

export class EncryptedSessionStateStore {
  readonly #key: Buffer;

  constructor(
    private readonly filePath: string,
    bridgeSecret: string
  ) {
    this.#key = createHash("sha256")
      .update(SESSION_STATE_KEY_CONTEXT)
      .update("\0")
      .update(bridgeSecret)
      .digest();
  }

  load(): SessionStorageState | undefined {
    try {
      const stats = lstatSync(this.filePath);
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        stats.size <= 0 ||
        stats.size > SESSION_STATE_MAX_BYTES
      ) {
        return undefined;
      }

      const envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<EncryptedSessionStateEnvelope>;
      if (
        envelope.version !== SESSION_STATE_VERSION ||
        envelope.algorithm !== SESSION_STATE_ALGORITHM ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        return undefined;
      }

      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      const ciphertext = Buffer.from(envelope.ciphertext, "base64");
      if (
        iv.length !== SESSION_STATE_IV_BYTES ||
        tag.length !== 16 ||
        ciphertext.length === 0
      ) {
        return undefined;
      }

      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      return normalizeSessionStorageState(JSON.parse(plaintext.toString("utf8")));
    } catch {
      return undefined;
    }
  }

  save(state: unknown): void {
    const normalized = normalizeSessionStorageState(state);
    if (!normalized) {
      throw new Error("invalid_session_storage_state");
    }

    const plaintext = Buffer.from(JSON.stringify(normalized), "utf8");
    if (plaintext.length > SESSION_STATE_MAX_BYTES) {
      throw new Error("session_storage_state_too_large");
    }

    const iv = randomBytes(SESSION_STATE_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const envelope: EncryptedSessionStateEnvelope = {
      version: SESSION_STATE_VERSION,
      algorithm: SESSION_STATE_ALGORITHM,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    const serialized = JSON.stringify(envelope) + "\n";
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    try {
      const fd = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600
      );
      try {
        const bytes = Buffer.from(serialized, "utf8");
        writeSync(fd, bytes, 0, bytes.length, 0);
        fsyncSync(fd);
        fchmodSync(fd, 0o600);
      } finally {
        closeSync(fd);
      }
      renameSync(temporaryPath, this.filePath);
      chmodSync(this.filePath, 0o600);
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file was renamed or was never created.
      }
    }
  }
}

function normalizeSessionStorageState(value: unknown): SessionStorageState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) {
    return undefined;
  }
  if (!record.cookies.every(isRecord) || !record.origins.every(isRecord)) {
    return undefined;
  }
  return {
    cookies: record.cookies,
    origins: record.origins
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
