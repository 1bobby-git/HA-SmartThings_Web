import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { PROTOCOL_CONTRACT_VERSION } from "../../src/inspector/protocol-contract.js";
import { bootstrapDataPaths } from "../../src/security/data-paths.js";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const posixModesAvailable = process.platform !== "win32";
const SAFE_PRIVATE_FILE_ERROR = "Invalid private data file";
type FsStats = ReturnType<typeof statSync>;

describe("bootstrapDataPaths", () => {
  test("reports path-free bootstrap stages in operation order", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-stages-"));
    const stages: string[] = [];
    try {
      bootstrapDataPaths(root, (stage: string) => stages.push(stage));

      expect(stages).toEqual([
        "data_dir",
        "profile_dir",
        "download_dir",
        "bridge_secret",
        "sqlite_file",
        "settings_file",
        "protocol_fingerprint_file"
      ]);
      expect(JSON.stringify(stages)).not.toMatch(/\\|\/data|secret path|token/i);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
      expect(existsSync(paths.settingsPath)).toBe(true);
      expect(existsSync(paths.protocolFingerprintPath)).toBe(true);
      expect(statSync(paths.sqlitePath).size).toBe(0);
      expect(paths.sqlitePath).toBe(join(root, "bridge.sqlite"));
      expect(paths.settingsPath).toBe(join(root, "settings.json"));
      expect(paths.protocolFingerprintPath).toBe(join(root, "protocol-fingerprint.json"));
      expect(readFileSync(paths.settingsPath, "utf8")).toBe(
        '{"schema_version":1}\n'
      );
      expect(readFileSync(paths.protocolFingerprintPath, "utf8")).toBe(
        `{"schema_version":1,"protocol_contract_version":${PROTOCOL_CONTRACT_VERSION},"baseline":null,"current":null,"change_count":0,"mismatch_keys":[],"last_mismatch":null}\n`
      );
      expect(firstSecret).toMatch(/^[a-f0-9]{64}$/);
      expect(secondSecret).toBe(firstSecret);
      if (posixModesAvailable) {
        expect(mode(root)).toBe(0o700);
        expect(mode(paths.profileDir)).toBe(0o700);
        expect(mode(paths.downloadDir)).toBe(0o700);
        expect(mode(paths.bridgeSecretPath)).toBe(0o600);
        expect(mode(paths.sqlitePath)).toBe(0o600);
        expect(mode(paths.settingsPath)).toBe(0o600);
        expect(mode(paths.protocolFingerprintPath)).toBe(0o600);
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

  test("validates a large existing database without reading the whole file", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-large-db-"));
    try {
      const sqlitePath = join(root, "bridge.sqlite");
      writeFileSync(sqlitePath, "sqlite-header", { encoding: "utf8" });
      truncateSync(sqlitePath, 2_147_483_648);

      expect(() => bootstrapDataPaths(root)).not.toThrow();
      expect(statSync(sqlitePath).size).toBe(2_147_483_648);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("preserves existing settings and protocol fingerprint content across restarts", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-existing-json-"));
    try {
      const settingsPath = join(root, "settings.json");
      const protocolFingerprintPath = join(root, "protocol-fingerprint.json");
      const existingSettings = '{\n  "schema_version": 2,\n  "custom": true\n}\n';
      const existingFingerprint =
        '{\n  "schema_version": 1,\n  "change_count": 7\n}\n';
      writeFileSync(settingsPath, existingSettings, { encoding: "utf8" });
      writeFileSync(protocolFingerprintPath, existingFingerprint, {
        encoding: "utf8"
      });

      const paths = bootstrapDataPaths(root);
      const second = bootstrapDataPaths(root);

      expect(paths.settingsPath).toBe(settingsPath);
      expect(paths.protocolFingerprintPath).toBe(protocolFingerprintPath);
      expect(second.settingsPath).toBe(settingsPath);
      expect(second.protocolFingerprintPath).toBe(protocolFingerprintPath);
      expect(readFileSync(settingsPath, "utf8")).toBe(existingSettings);
      expect(readFileSync(protocolFingerprintPath, "utf8")).toBe(
        existingFingerprint
      );
      if (posixModesAvailable) {
        expect(mode(settingsPath)).toBe(0o600);
        expect(mode(protocolFingerprintPath)).toBe(0o600);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("preserves bytes when first-boot settings creation loses an EEXIST race", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-race-"));
    const settingsPath = join(root, "settings.json");
    const racedSettings = '{"schema_version":9,"raced":true}\n';
    try {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>(
          "node:fs"
        );
        let raced = false;
        return {
          ...actual,
          writeFileSync: vi.fn(
            (
              path: Parameters<typeof actual.writeFileSync>[0],
              data: Parameters<typeof actual.writeFileSync>[1],
              options?: Parameters<typeof actual.writeFileSync>[2]
            ) => {
              if (
                !raced &&
                path === settingsPath &&
                typeof options === "object" &&
                options?.flag === "wx"
              ) {
                raced = true;
                actual.writeFileSync(settingsPath, racedSettings, {
                  encoding: "utf8",
                  mode: 0o600
                });
                throw Object.assign(new Error("simulated EEXIST race"), {
                  code: "EEXIST"
                });
              }
              return actual.writeFileSync(path, data, options);
            }
          )
        };
      });

      const { bootstrapDataPaths: bootstrapWithMockedFs } = await import(
        "../../src/security/data-paths.js"
      );

      const paths = bootstrapWithMockedFs(root);

      expect(paths.settingsPath).toBe(settingsPath);
      expect(readFileSync(settingsPath, "utf8")).toBe(racedSettings);
      if (posixModesAvailable) {
        expect(mode(settingsPath)).toBe(0o600);
      }
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects a symlink private file after an EEXIST race with a safe error", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-symlink-mock-"));
    const settingsPath = join(root, "settings.json");
    try {
      const { bootstrapWithMockedFs } = await importDataPathsWithMockedFs(
        (actual) => ({
          chmodSync: vi.fn(actual.chmodSync),
          lstatSync: vi.fn((path): FsStats => {
            if (path === settingsPath) {
              return {
                isSymbolicLink: (): boolean => true,
                isFile: (): boolean => false
              } as FsStats;
            }
            return actual.lstatSync(path);
          }) as ActualFs["lstatSync"],
          readFileSync: vi.fn((path, options) => {
            if (path === settingsPath) {
              return Buffer.from("hidden-target-content");
            }
            return actual.readFileSync(path, options);
          }) as unknown as ActualFs["readFileSync"],
          writeFileSync: vi.fn((path, data, options) => {
            if (
              path === settingsPath &&
              typeof options === "object" &&
              options?.flag === "wx"
            ) {
              throw Object.assign(new Error("simulated EEXIST symlink"), {
                code: "EEXIST"
              });
            }
            return actual.writeFileSync(path, data, options);
          })
        })
      );

      const error = captureError(() => bootstrapWithMockedFs(root));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SAFE_PRIVATE_FILE_ERROR);
      expect((error as Error).message).not.toContain(settingsPath);
      expect((error as Error).message).not.toContain("hidden-target-content");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects a non-regular private file after an EEXIST race with a safe error", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-nonregular-mock-"));
    const sqlitePath = join(root, "bridge.sqlite");
    try {
      const { bootstrapWithMockedFs } = await importDataPathsWithMockedFs(
        (actual) => ({
          chmodSync: vi.fn(actual.chmodSync),
          lstatSync: vi.fn((path): FsStats => {
            if (path === sqlitePath) {
              return {
                isSymbolicLink: (): boolean => false,
                isFile: (): boolean => false
              } as FsStats;
            }
            return actual.lstatSync(path);
          }) as ActualFs["lstatSync"],
          readFileSync: vi.fn((path, options) => {
            if (path === sqlitePath) {
              return Buffer.from("not-a-regular-file");
            }
            return actual.readFileSync(path, options);
          }) as unknown as ActualFs["readFileSync"],
          writeFileSync: vi.fn((path, data, options) => {
            if (
              path === sqlitePath &&
              typeof options === "object" &&
              options?.flag === "wx"
            ) {
              throw Object.assign(new Error("simulated EEXIST directory"), {
                code: "EEXIST"
              });
            }
            return actual.writeFileSync(path, data, options);
          })
        })
      );

      const error = captureError(() => bootstrapWithMockedFs(root));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SAFE_PRIVATE_FILE_ERROR);
      expect((error as Error).message).not.toContain(sqlitePath);
      expect((error as Error).message).not.toContain("not-a-regular-file");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rethrows non-EEXIST private file creation errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-non-eexist-"));
    const settingsPath = join(root, "settings.json");
    const writeError = Object.assign(new Error("simulated write failure"), {
      code: "ENOSPC"
    });
    try {
      const { bootstrapWithMockedFs } = await importDataPathsWithMockedFs(
        (actual) => ({
          writeFileSync: vi.fn((path, data, options) => {
            if (
              path === settingsPath &&
              typeof options === "object" &&
              options?.flag === "wx"
            ) {
              throw writeError;
            }
            return actual.writeFileSync(path, data, options);
          })
        })
      );

      const error = captureError(() => bootstrapWithMockedFs(root));

      expect(error).toBe(writeError);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects a real symlink private file when symlinks are supported", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-data-symlink-real-"));
    try {
      const targetPath = join(root, "target-settings.json");
      const settingsPath = join(root, "settings.json");
      writeFileSync(targetPath, '{"schema_version":77}\n', {
        encoding: "utf8"
      });
      try {
        symlinkSync(targetPath, settingsPath);
      } catch {
        return;
      }

      const error = captureError(() => bootstrapDataPaths(root));

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(SAFE_PRIVATE_FILE_ERROR);
      expect((error as Error).message).not.toContain(settingsPath);
      expect(readFileSync(targetPath, "utf8")).toBe('{"schema_version":77}\n');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

type ActualFs = typeof import("node:fs");
type FsOverrides = Partial<ActualFs>;

async function importDataPathsWithMockedFs(
  buildOverrides: (actual: ActualFs) => FsOverrides
): Promise<{
  bootstrapWithMockedFs: typeof bootstrapDataPaths;
}> {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<ActualFs>("node:fs");
    return {
      ...actual,
      ...buildOverrides(actual)
    };
  });
  const { bootstrapDataPaths: bootstrapWithMockedFs } = await import(
    "../../src/security/data-paths.js"
  );
  return { bootstrapWithMockedFs };
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}
