import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

import protocolVersion from "../protocol/version.json" with { type: "json" };
import {
  createInitialProtocolIntegrityState,
  PROTOCOL_CONTRACT_VERSION
} from "../bridge/src/inspector/protocol-contract.js";
import { bootstrapDataPaths } from "../bridge/src/security/data-paths.js";

describe("protocol version contract", () => {
  test("keeps every Bridge release surface on the packaged 0.1.26 candidate", () => {
    const expectedBridgeVersion = "0.1.26";
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    const addonConfig = YAML.parse(
      readFileSync("addon/smartthings_web_bridge/config.yaml", "utf8")
    ) as { version?: string };
    const runtimeSource = readFileSync("bridge/src/runtime.ts", "utf8");

    expect(packageJson.version).toBe(expectedBridgeVersion);
    expect(packageLock.version).toBe(expectedBridgeVersion);
    expect(packageLock.packages?.[""]?.version).toBe(expectedBridgeVersion);
    expect(protocolVersion.bridge_version).toBe(expectedBridgeVersion);
    expect(addonConfig.version).toBe(expectedBridgeVersion);
    expect(runtimeSource).toContain(`const bridgeVersion = "${expectedBridgeVersion}";`);
    expect(protocolVersion.protocol_version).toBe(1);
  });

  test("keeps the protocol contract version synchronized from source to bootstrap JSON", () => {
    expect(PROTOCOL_CONTRACT_VERSION).toBe(protocolVersion.protocol_version);

    const expectedInitialState = {
      schema_version: 1,
      protocol_contract_version: protocolVersion.protocol_version,
      baseline: null,
      current: null,
      change_count: 0,
      mismatch_keys: [],
      last_mismatch: null
    };

    expect(createInitialProtocolIntegrityState()).toEqual(expectedInitialState);

    const root = mkdtempSync(join(tmpdir(), "stw-protocol-version-"));
    try {
      const paths = bootstrapDataPaths(root);
      const bootstrappedState = JSON.parse(
        readFileSync(paths.protocolFingerprintPath, "utf8")
      ) as unknown;

      expect(bootstrappedState).toEqual(createInitialProtocolIntegrityState());
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
