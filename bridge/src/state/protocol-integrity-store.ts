import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { REQUIRED_SNAPSHOT_CATEGORIES } from "../inspector/snapshot-detector.js";
import type { ProtocolMismatchSurface } from "../inspector/protocol-contract.js";

export const PROTOCOL_INTEGRITY_ERROR_CODES = [
  "invalid_contract_version",
  "invalid_path",
  "symlink_target",
  "file_not_regular",
  "read_failed",
  "malformed_json",
  "unknown_key",
  "invalid_schema",
  "invalid_fingerprint",
  "invalid_mismatch_surface",
  "atomic_write_failed"
] as const;

export type ProtocolIntegrityErrorCode = (typeof PROTOCOL_INTEGRITY_ERROR_CODES)[number];

export class ProtocolIntegrityError extends Error {
  readonly code: ProtocolIntegrityErrorCode;

  constructor(code: ProtocolIntegrityErrorCode) {
    super(`Protocol integrity store failed: ${code}`);
    this.name = "ProtocolIntegrityError";
    this.code = code;
  }
}

export const PROTOCOL_MISMATCH_SURFACES = [
  ...REQUIRED_SNAPSHOT_CATEGORIES.map(
    (category) => `snapshot:${category}:response_shape` as const
  ),
  "event:device_event:identity"
] satisfies readonly ProtocolMismatchSurface[];

export interface ProtocolIntegrityStoreOptions {
  contractVersion: number;
  now?: () => number;
  atomicWriteHooks?: {
    beforeReplace?: () => void;
    replaceTarget?: (tempPath: string, targetPath: string) => void;
  };
}

export type ProtocolIntegrityLastMismatch =
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "surface"; readonly surface: ProtocolMismatchSurface };

export interface ProtocolIntegritySnapshot {
  readonly protocolContractVersion: number;
  readonly baseline: string | null;
  readonly current: string | null;
  readonly changeCount: number;
  readonly lastMismatch: ProtocolIntegrityLastMismatch | null;
  readonly compatible: boolean | "unknown";
}

interface PersistedProtocolIntegrityState {
  schema_version: 1;
  protocol_contract_version: number;
  baseline: string | null;
  current: string | null;
  change_count: number;
  mismatch_keys: string[];
  last_mismatch: ProtocolIntegrityLastMismatch | null;
}

const schemaVersion = 1;
const persistedKeys = new Set([
  "schema_version",
  "protocol_contract_version",
  "baseline",
  "current",
  "change_count",
  "mismatch_keys",
  "last_mismatch"
]);
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const mismatchSurfaceSet = new Set<ProtocolMismatchSurface>(PROTOCOL_MISMATCH_SURFACES);

export class ProtocolIntegrityStore {
  readonly #path: string;
  readonly #contractVersion: number;
  readonly #hooks: ProtocolIntegrityStoreOptions["atomicWriteHooks"] | undefined;
  #state: PersistedProtocolIntegrityState;

  constructor(path: string, options: ProtocolIntegrityStoreOptions) {
    if (!isPositiveSafeInteger(options.contractVersion)) {
      throw new ProtocolIntegrityError("invalid_contract_version");
    }
    if (typeof path !== "string" || path.length === 0) {
      throw new ProtocolIntegrityError("invalid_path");
    }

    this.#path = path;
    this.#contractVersion = options.contractVersion;
    this.#hooks = options.atomicWriteHooks;
    this.#state = this.#loadOrInitialize();

    if (this.#state.protocol_contract_version !== this.#contractVersion) {
      this.#state = {
        schema_version: schemaVersion,
        protocol_contract_version: this.#contractVersion,
        baseline: null,
        current: null,
        change_count: this.#state.change_count,
        mismatch_keys: [],
        last_mismatch: null
      };
      this.#persist();
    }
  }

  observeCompleteFingerprint(fingerprint: string): ProtocolIntegritySnapshot {
    if (!isFingerprint(fingerprint)) {
      throw new ProtocolIntegrityError("invalid_fingerprint");
    }

    if (this.#state.baseline === null) {
      this.#state = {
        ...this.#state,
        baseline: fingerprint,
        current: fingerprint
      };
      this.#persist();
      return this.snapshot();
    }

    if (fingerprint === this.#state.baseline) {
      this.#state = {
        ...this.#state,
        current: fingerprint
      };
      this.#persist();
      return this.snapshot();
    }

    const mismatchKey = fingerprintMismatchKey(fingerprint);
    const isNewMismatchKey = !this.#state.mismatch_keys.includes(mismatchKey);
    this.#state = {
      ...this.#state,
      current: fingerprint,
      change_count: isNewMismatchKey ? this.#state.change_count + 1 : this.#state.change_count,
      mismatch_keys: addMismatchKey(this.#state.mismatch_keys, mismatchKey),
      last_mismatch: freezeLastMismatch({ kind: "fingerprint", fingerprint })
    };
    this.#persist();
    return this.snapshot();
  }

  recordMismatch(surface: ProtocolMismatchSurface): ProtocolIntegritySnapshot {
    if (!isMismatchSurface(surface)) {
      throw new ProtocolIntegrityError("invalid_mismatch_surface");
    }

    const mismatchKey = surfaceMismatchKey(surface);
    const isNewMismatchKey = !this.#state.mismatch_keys.includes(mismatchKey);
    this.#state = {
      ...this.#state,
      change_count: isNewMismatchKey ? this.#state.change_count + 1 : this.#state.change_count,
      mismatch_keys: addMismatchKey(this.#state.mismatch_keys, mismatchKey),
      last_mismatch: freezeLastMismatch({ kind: "surface", surface })
    };
    this.#persist();
    return this.snapshot();
  }

  snapshot(): ProtocolIntegritySnapshot {
    const compatible =
      this.#state.mismatch_keys.length > 0
        ? false
        : this.#state.baseline === null
        ? "unknown"
        : this.#state.current === this.#state.baseline;
    return Object.freeze({
      protocolContractVersion: this.#state.protocol_contract_version,
      baseline: this.#state.baseline,
      current: this.#state.current,
      changeCount: this.#state.change_count,
      lastMismatch: this.#state.last_mismatch
        ? freezeLastMismatch({ ...this.#state.last_mismatch })
        : null,
      compatible
    });
  }

  #loadOrInitialize(): PersistedProtocolIntegrityState {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    this.#assertSafeExistingTarget();

    if (!existsSync(this.#path)) {
      const initial = defaultState(this.#contractVersion);
      writeAtomically(this.#path, initial, this.#hooks);
      return initial;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ProtocolIntegrityError("malformed_json");
      }
      throw new ProtocolIntegrityError("read_failed");
    }

    const state = parsePersistedState(parsed);
    chmodTarget(this.#path);
    return state;
  }

  #assertSafeExistingTarget(): void {
    try {
      const stats = lstatSync(this.#path);
      if (stats.isSymbolicLink()) {
        throw new ProtocolIntegrityError("symlink_target");
      }
      if (!stats.isFile()) {
        throw new ProtocolIntegrityError("file_not_regular");
      }
    } catch (error) {
      if (error instanceof ProtocolIntegrityError) {
        throw error;
      }
      if (isNodeErrorCode(error, "ENOENT")) {
        return;
      }
      throw new ProtocolIntegrityError("read_failed");
    }
  }

  #persist(): void {
    writeAtomically(this.#path, this.#state, this.#hooks);
  }
}

function defaultState(contractVersion: number): PersistedProtocolIntegrityState {
  return {
    schema_version: schemaVersion,
    protocol_contract_version: contractVersion,
    baseline: null,
    current: null,
    change_count: 0,
    mismatch_keys: [],
    last_mismatch: null
  };
}

function parsePersistedState(value: unknown): PersistedProtocolIntegrityState {
  if (!isPlainObject(value)) {
    throw new ProtocolIntegrityError("invalid_schema");
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!persistedKeys.has(key)) {
      throw new ProtocolIntegrityError("unknown_key");
    }
  }
  if (keys.length !== persistedKeys.size) {
    throw new ProtocolIntegrityError("invalid_schema");
  }

  const state = value as Record<string, unknown>;
  if (
    state["schema_version"] !== schemaVersion ||
    !isPositiveSafeInteger(state["protocol_contract_version"]) ||
    !isNullableFingerprint(state["baseline"]) ||
    !isNullableFingerprint(state["current"]) ||
    !isNonnegativeSafeInteger(state["change_count"]) ||
    !isMismatchKeyArray(state["mismatch_keys"]) ||
    !isNullableLastMismatch(state["last_mismatch"])
  ) {
    throw new ProtocolIntegrityError("invalid_schema");
  }

  validatePersistedInvariants(
    state["baseline"],
    state["current"],
    state["change_count"],
    state["mismatch_keys"],
    state["last_mismatch"]
  );

  return {
    schema_version: schemaVersion,
    protocol_contract_version: state["protocol_contract_version"],
    baseline: state["baseline"],
    current: state["current"],
    change_count: state["change_count"],
    mismatch_keys: [...(state["mismatch_keys"] as string[])],
    last_mismatch: state["last_mismatch"]
      ? freezeLastMismatch({ ...state["last_mismatch"] })
      : null
  };
}

function validatePersistedInvariants(
  baseline: string | null,
  current: string | null,
  changeCount: number,
  mismatchKeys: string[],
  lastMismatch: ProtocolIntegrityLastMismatch | null
): void {
  if (mismatchKeys.length > changeCount) {
    throw new ProtocolIntegrityError("invalid_schema");
  }
  if ((baseline === null) !== (current === null)) {
    throw new ProtocolIntegrityError("invalid_schema");
  }
  if (lastMismatch !== null) {
    const lastKey =
      lastMismatch.kind === "fingerprint"
        ? fingerprintMismatchKey(lastMismatch.fingerprint)
        : surfaceMismatchKey(lastMismatch.surface);
    if (!mismatchKeys.includes(lastKey)) {
      throw new ProtocolIntegrityError("invalid_schema");
    }
  }
  if (lastMismatch?.kind === "fingerprint") {
    if (baseline === lastMismatch.fingerprint) {
      throw new ProtocolIntegrityError("invalid_schema");
    }
  }
  if (baseline !== null && current !== null && baseline !== current) {
    if (!mismatchKeys.includes(fingerprintMismatchKey(current))) {
      throw new ProtocolIntegrityError("invalid_schema");
    }
  }
}

function writeAtomically(
  path: string,
  state: PersistedProtocolIntegrityState,
  hooks: ProtocolIntegrityStoreOptions["atomicWriteHooks"] | undefined
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = join(dir, `.protocol-integrity-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;

  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodTarget(tempPath);

    hooks?.beforeReplace?.();
    hooks?.replaceTarget ? hooks.replaceTarget(tempPath, path) : renameSync(tempPath, path);

    chmodTarget(path);
    fsyncDirectoryBestEffort(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors while preserving the primary atomic-write error.
      }
    }
    cleanupIfExists(tempPath);
    throw new ProtocolIntegrityError("atomic_write_failed");
  }
}

function fsyncDirectoryBestEffort(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Directory fsync is best-effort only.
      }
    }
  }
}

function cleanupIfExists(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Cleanup is best-effort; callers still receive the fixed atomic_write_failed code.
  }
}

function chmodTarget(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  }
}

function isNullableFingerprint(value: unknown): value is string | null {
  return value === null || isFingerprint(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && fingerprintPattern.test(value);
}

function isMismatchSurface(value: unknown): value is ProtocolMismatchSurface {
  return typeof value === "string" && mismatchSurfaceSet.has(value as ProtocolMismatchSurface);
}

function isNullableLastMismatch(value: unknown): value is ProtocolIntegrityLastMismatch | null {
  if (value === null) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (value["kind"] === "fingerprint") {
    return keys.length === 2 && keys.includes("kind") && keys.includes("fingerprint") && isFingerprint(value["fingerprint"]);
  }
  if (value["kind"] === "surface") {
    return keys.length === 2 && keys.includes("kind") && keys.includes("surface") && isMismatchSurface(value["surface"]);
  }
  return false;
}

function isMismatchKeyArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  const seen = new Set<string>();
  let previous: string | undefined;
  for (const key of value) {
    if (!isMismatchKey(key)) {
      return false;
    }
    if (seen.has(key)) {
      return false;
    }
    if (previous !== undefined && previous > key) {
      return false;
    }
    seen.add(key);
    previous = key;
  }
  return true;
}

function isMismatchKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  if (value.startsWith("fingerprint:")) {
    return isFingerprint(value.slice("fingerprint:".length));
  }
  if (value.startsWith("surface:")) {
    return isMismatchSurface(value.slice("surface:".length));
  }
  return false;
}

function addMismatchKey(keys: readonly string[], key: string): string[] {
  return [...new Set([...keys, key])].sort();
}

function fingerprintMismatchKey(fingerprint: string): string {
  return `fingerprint:${fingerprint}`;
}

function surfaceMismatchKey(surface: ProtocolMismatchSurface): string {
  return `surface:${surface}`;
}

function freezeLastMismatch<T extends ProtocolIntegrityLastMismatch>(value: T): T {
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
