import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import protocolVersion from "../protocol/version.json" with { type: "json" };
import {
  createInitialProtocolIntegrityState,
  PROTOCOL_CONTRACT_VERSION
} from "../bridge/src/inspector/protocol-contract.js";
import { bootstrapDataPaths } from "../bridge/src/security/data-paths.js";

describe("protocol version contract", () => {
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
