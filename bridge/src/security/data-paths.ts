import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createInitialProtocolIntegrityState } from "../inspector/protocol-contract.js";

export interface BridgeDataPaths {
  dataDir: string;
  profileDir: string;
  downloadDir: string;
  sqlitePath: string;
  bridgeSecretPath: string;
  protocolFingerprintPath: string;
  settingsPath: string;
}

const DEFAULT_SETTINGS = '{"schema_version":1}\n';
const DEFAULT_PROTOCOL_FINGERPRINT = (): string =>
  `${JSON.stringify(createInitialProtocolIntegrityState())}\n`;
const INVALID_PRIVATE_FILE_ERROR = "Invalid private data file";
const MIN_BRIDGE_SECRET_LENGTH = 32;
const MAX_BRIDGE_SECRET_LENGTH = 512;
const MAX_BRIDGE_SECRET_FILE_BYTES = 4_096;

type DefaultContent = string | (() => string);

export type DataPathBootstrapStage =
  | "data_dir"
  | "profile_dir"
  | "download_dir"
  | "bridge_secret"
  | "sqlite_file"
  | "settings_file"
  | "protocol_fingerprint_file";

export function bootstrapDataPaths(
  dataDir: string,
  reportStage: (stage: DataPathBootstrapStage) => void = () => undefined
): BridgeDataPaths {
  const profileDir = join(dataDir, "chromium-profile");
  const downloadDir = join(dataDir, "downloads");
  const sqlitePath = join(dataDir, "bridge.sqlite");
  const bridgeSecretPath = join(dataDir, "bridge-secret");
  const protocolFingerprintPath = join(dataDir, "protocol-fingerprint.json");
  const settingsPath = join(dataDir, "settings.json");

  reportStage("data_dir");
  ensurePrivateDir(dataDir);
  reportStage("profile_dir");
  ensurePrivateDir(profileDir);
  reportStage("download_dir");
  ensurePrivateDir(downloadDir);

  reportStage("bridge_secret");
  ensureBridgeSecret(bridgeSecretPath);
  reportStage("sqlite_file");
  ensurePrivateFile(sqlitePath, "");
  reportStage("settings_file");
  ensurePrivateFile(settingsPath, DEFAULT_SETTINGS);
  reportStage("protocol_fingerprint_file");
  ensurePrivateFile(protocolFingerprintPath, DEFAULT_PROTOCOL_FINGERPRINT);

  return {
    dataDir,
    profileDir,
    downloadDir,
    sqlitePath,
    bridgeSecretPath,
    protocolFingerprintPath,
    settingsPath
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function ensureBridgeSecret(path: string): void {
  const replacement = createBridgeSecret();
  try {
    writeFileSync(path, replacement, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    chmodSync(path, 0o600);
    return;
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      throw error;
    }
  }

  const pathStats = lstatSync(path);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(INVALID_PRIVATE_FILE_ERROR);
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDWR | noFollow);
  try {
    const descriptorStats = fstatSync(fd);
    if (!descriptorStats.isFile()) {
      throw new Error(INVALID_PRIVATE_FILE_ERROR);
    }
    fchmodSync(fd, 0o600);
    const current =
      descriptorStats.size > 0 && descriptorStats.size <= MAX_BRIDGE_SECRET_FILE_BYTES
        ? readFileSync(fd, "utf8").trim()
        : "";
    if (
      current.length >= MIN_BRIDGE_SECRET_LENGTH &&
      current.length <= MAX_BRIDGE_SECRET_LENGTH
    ) {
      return;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, replacement, 0, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function createBridgeSecret(): string {
  return randomBytes(32).toString("hex");
}

function ensurePrivateFile(path: string, defaultContent: DefaultContent): void {
  try {
    const content =
      typeof defaultContent === "function" ? defaultContent() : defaultContent;
    writeFileSync(path, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    chmodSync(path, 0o600);
  } catch (error) {
    if (!isNodeErrorCode(error, "EEXIST")) {
      throw error;
    }
    validateExistingPrivateFile(path);
  }
}

function validateExistingPrivateFile(path: string): void {
  const pathStats = lstatSync(path);
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new Error(INVALID_PRIVATE_FILE_ERROR);
  }

  const noFollow =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const descriptorStats = fstatSync(fd);
    if (!descriptorStats.isFile()) {
      throw new Error(INVALID_PRIVATE_FILE_ERROR);
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
