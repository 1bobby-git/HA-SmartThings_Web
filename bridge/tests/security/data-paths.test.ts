import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { bootstrapDataPaths } from "../../src/security/data-paths.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const posixModesAvailable = process.platform !== "win32";

describe("bootstrapDataPaths", () => {
  test("creates private data paths and a persistent bridge secret", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-"));
    try {
      const paths = bootstrapDataPaths(root);
      const firstSecret = readFileSync(paths.bridgeSecretPath, "utf8");
      const second = bootstrapDataPaths(root);
      const secondSecret = readFileSync(second.bridgeSecretPath, "utf8");

      expect(existsSync(paths.profileDir)).toBe(true);
      expect(existsSync(paths.downloadDir)).toBe(true);
      expect(existsSync(paths.sqlitePath)).toBe(true);
      expect(statSync(paths.sqlitePath).size).toBe(0);
      expect(paths.sqlitePath).toBe(join(root, "bridge.sqlite"));
      expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(secondSecret).toBe(firstSecret);
      if (posixModesAvailable) {
        expect(mode(root)).toBe(0o700);
        expect(mode(paths.profileDir)).toBe(0o700);
        expect(mode(paths.downloadDir)).toBe(0o700);
        expect(mode(paths.bridgeSecretPath)).toBe(0o600);
        expect(mode(paths.sqlitePath)).toBe(0o600);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("does not truncate an existing bridge database", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-existing-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      writeFileSync(sqlitePath, "existing-db-content", { encoding: "utf8" });

      const paths = bootstrapDataPaths(root);

      expect(paths.sqlitePath).toBe(sqlitePath);
      expect(readFileSync(sqlitePath, "utf8")).toBe("existing-db-content");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
