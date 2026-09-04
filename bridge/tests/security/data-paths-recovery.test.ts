import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { bootstrapDataPaths } from "../../src/security/data-paths.js";

describe("Bridge secret recovery", () => {
  test("repairs an empty persistent secret once and then preserves the replacement", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-empty-secret-"));
    try {
      const secretPath = join(root, "bridge-secret");
      writeFileSync(secretPath, "", { encoding: "utf8", mode: 0o600 });

      const first = bootstrapDataPaths(root);
      const repaired = readFileSync(first.bridgeSecretPath, "utf8").trim();
      const second = bootstrapDataPaths(root);

      expect(repaired).toMatch(/^[a-f0-9]{64}$/u);
      expect(readFileSync(second.bridgeSecretPath, "utf8").trim()).toBe(repaired);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("preserves an existing valid legacy secret exactly", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-valid-secret-"));
    try {
      const secretPath = join(root, "bridge-secret");
      const legacySecret = "legacy-bridge-secret-that-is-valid-and-stable";
      writeFileSync(secretPath, `${legacySecret}\n`, {
        encoding: "utf8",
        mode: 0o600
      });

      bootstrapDataPaths(root);

      expect(readFileSync(secretPath, "utf8")).toBe(`${legacySecret}\n`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
