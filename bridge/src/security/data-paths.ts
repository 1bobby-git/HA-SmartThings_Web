import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface BridgeDataPaths {
  dataDir: string;
  profileDir: string;
  downloadDir: string;
  sqlitePath: string;
  bridgeSecretPath: string;
}

export function bootstrapDataPaths(dataDir: string): BridgeDataPaths {
  const profileDir = join(dataDir, "chromium-profile");
  const downloadDir = join(dataDir, "downloads");
  const sqlitePath = join(dataDir, "bridge.sqlite");
  const bridgeSecretPath = join(dataDir, "bridge-secret");

  ensurePrivateDir(dataDir);
  ensurePrivateDir(profileDir);
  ensurePrivateDir(downloadDir);

  if (!existsSync(bridgeSecretPath)) {
    writeFileSync(bridgeSecretPath, randomBytes(32).toString("hex"), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } else {
    readFileSync(bridgeSecretPath, "utf8");
  }
  chmodSync(bridgeSecretPath, 0o600);

  if (!existsSync(sqlitePath)) {
    writeFileSync(sqlitePath, "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  chmodSync(sqlitePath, 0o600);

  return {
    dataDir,
    profileDir,
    downloadDir,
    sqlitePath,
    bridgeSecretPath
  };
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
