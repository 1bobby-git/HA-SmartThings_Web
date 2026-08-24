import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  ProtocolIntegrityError,
  ProtocolIntegrityStore
} from "../../src/state/protocol-integrity-store.js";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const fingerprintC = "c".repeat(64);

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ProtocolIntegrityStore", () => {
  test("establishes the first complete fingerprint as the compatible baseline", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1, now: () => 1_000 });

    expect(store.snapshot()).toEqual({
      protocolContractVersion: 1,
      baseline: null,
      current: null,
      changeCount: 0,
      lastMismatch: null,
      compatible: "unknown"
    });
    expect(store.observeCompleteFingerprint(fingerprintA)).toEqual({
      protocolContractVersion: 1,
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 0,
      lastMismatch: null,
      compatible: true
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schema_version: 1,
      protocol_contract_version: 1,
      baseline: fingerprintA,
      current: fingerprintA,
      change_count: 0,
      mismatch_keys: [],
      last_mismatch: null
    });
  });

  test("keeps matching fingerprints compatible and counts distinct fingerprint mismatch keys once per contract", () => {
    const store = new ProtocolIntegrityStore(tempPath(), { contractVersion: 1 });

    expect(store.observeCompleteFingerprint(fingerprintA).compatible).toBe(true);
    expect(store.observeCompleteFingerprint(fingerprintA)).toMatchObject({
      compatible: true,
      changeCount: 0,
      lastMismatch: null
    });
    expect(store.observeCompleteFingerprint(fingerprintB)).toMatchObject({
      compatible: false,
      changeCount: 1,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB }
    });
    expect(store.observeCompleteFingerprint(fingerprintB)).toMatchObject({
      compatible: false,
      changeCount: 1
    });
    expect(store.observeCompleteFingerprint(fingerprintA)).toMatchObject({
      compatible: false,
      changeCount: 1,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB }
    });
    expect(store.observeCompleteFingerprint(fingerprintB)).toMatchObject({
      compatible: false,
      changeCount: 1,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB }
    });
    expect(store.observeCompleteFingerprint(fingerprintC)).toMatchObject({
      compatible: false,
      changeCount: 2,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintC }
    });
    expect(store.observeCompleteFingerprint(fingerprintB)).toMatchObject({
      compatible: false,
      changeCount: 2,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB }
    });
  });

  test("latches incompatible after same-version mismatches until a contract version bump", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1 });

    store.observeCompleteFingerprint(fingerprintA);
    store.observeCompleteFingerprint(fingerprintB);
    expect(store.observeCompleteFingerprint(fingerprintA)).toMatchObject({
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 1,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB },
      compatible: false
    });
    expect(new ProtocolIntegrityStore(path, { contractVersion: 1 }).snapshot()).toMatchObject({
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 1,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB },
      compatible: false
    });

    const bumped = new ProtocolIntegrityStore(path, { contractVersion: 2 });
    expect(bumped.snapshot()).toMatchObject({
      protocolContractVersion: 2,
      baseline: null,
      current: null,
      changeCount: 1,
      lastMismatch: null,
      compatible: "unknown"
    });
    expect(bumped.observeCompleteFingerprint(fingerprintA)).toMatchObject({
      protocolContractVersion: 2,
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 1,
      lastMismatch: null,
      compatible: true
    });
  });

  test("surface mismatch before baseline remains incompatible after first baseline and restart", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1 });

    store.recordMismatch("snapshot:rooms:response_shape");
    expect(store.observeCompleteFingerprint(fingerprintA)).toMatchObject({
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 1,
      lastMismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" },
      compatible: false
    });
    expect(new ProtocolIntegrityStore(path, { contractVersion: 1 }).snapshot()).toMatchObject({
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 1,
      lastMismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" },
      compatible: false
    });
  });

  test("records only known safe mismatch surfaces and counts each distinct key once per contract", () => {
    const store = new ProtocolIntegrityStore(tempPath(), { contractVersion: 1 });

    expect(store.recordMismatch("snapshot:rooms:response_shape")).toMatchObject({
      compatible: false,
      changeCount: 1,
      lastMismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" }
    });
    expect(store.recordMismatch("snapshot:rooms:response_shape")).toMatchObject({
      compatible: false,
      changeCount: 1
    });
    expect(store.recordMismatch("event:device_event:identity")).toMatchObject({
      compatible: false,
      changeCount: 2,
      lastMismatch: { kind: "surface", surface: "event:device_event:identity" }
    });
    expect(store.recordMismatch("snapshot:rooms:response_shape")).toMatchObject({
      compatible: false,
      changeCount: 2,
      lastMismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" }
    });
    expectProtocolIntegrityCode(
      () => store.recordMismatch("snapshot:raw-device-id:response_shape" as never),
      "invalid_mismatch_surface"
    );
  });

  test("persists across restarts and rebaselines after a contract version bump", () => {
    const path = tempPath();
    const first = new ProtocolIntegrityStore(path, { contractVersion: 1 });

    first.observeCompleteFingerprint(fingerprintA);
    first.observeCompleteFingerprint(fingerprintB);

    expect(new ProtocolIntegrityStore(path, { contractVersion: 1 }).snapshot()).toMatchObject({
      protocolContractVersion: 1,
      baseline: fingerprintA,
      current: fingerprintB,
      changeCount: 1,
      compatible: false
    });

    const bumped = new ProtocolIntegrityStore(path, { contractVersion: 2 });
    expect(bumped.snapshot()).toEqual({
      protocolContractVersion: 2,
      baseline: null,
      current: null,
      changeCount: 1,
      lastMismatch: null,
      compatible: "unknown"
    });
    expect(bumped.observeCompleteFingerprint(fingerprintC)).toMatchObject({
      protocolContractVersion: 2,
      baseline: fingerprintC,
      current: fingerprintC,
      changeCount: 1,
      compatible: true
    });
    expect(bumped.observeCompleteFingerprint(fingerprintB)).toMatchObject({
      protocolContractVersion: 2,
      changeCount: 2,
      lastMismatch: { kind: "fingerprint", fingerprint: fingerprintB },
      compatible: false
    });
    expect(JSON.parse(readFileSync(path, "utf8")).mismatch_keys).toEqual([
      `fingerprint:${fingerprintB}`
    ]);
  });

  test("rejects corrupt, unknown, and unsafe persisted data with safe fixed errors", () => {
    const cases: Array<readonly [unknown, ProtocolIntegrityError["code"]]> = [
      ["not json", "malformed_json"],
      [{ schema_version: 1 }, "invalid_schema"],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 0,
          mismatch_keys: [],
          last_mismatch: null,
          raw_url: "https://example.invalid/?token=secret"
        },
        "unknown_key"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: "sha256:aaa",
          current: null,
          change_count: 0,
          mismatch_keys: [],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: -1,
          mismatch_keys: [],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 0,
          mismatch_keys: [],
          last_mismatch: { kind: "surface", surface: "snapshot:raw:response_shape" }
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 0,
          mismatch_keys: [`fingerprint:${fingerprintB}`, `fingerprint:${fingerprintA}`],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 0,
          mismatch_keys: ["surface:snapshot:raw:response_shape"],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 0,
          mismatch_keys: ["surface:snapshot:rooms:response_shape"],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: null,
          change_count: 1,
          mismatch_keys: ["surface:snapshot:rooms:response_shape"],
          last_mismatch: { kind: "surface", surface: "snapshot:scenes:response_shape" }
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: fingerprintA,
          current: null,
          change_count: 0,
          mismatch_keys: [],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: null,
          current: fingerprintA,
          change_count: 0,
          mismatch_keys: [],
          last_mismatch: null
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: fingerprintA,
          current: fingerprintB,
          change_count: 1,
          mismatch_keys: ["surface:snapshot:rooms:response_shape"],
          last_mismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" }
        },
        "invalid_schema"
      ],
      [
        {
          schema_version: 1,
          protocol_contract_version: 1,
          baseline: fingerprintA,
          current: fingerprintB,
          change_count: 1,
          mismatch_keys: [`fingerprint:${fingerprintB}`],
          last_mismatch: { kind: "fingerprint", fingerprint: fingerprintC }
        },
        "invalid_schema"
      ]
    ];

    for (const [content, code] of cases) {
      const path = tempPath();
      writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });

      expectProtocolIntegrityCode(() => new ProtocolIntegrityStore(path, { contractVersion: 1 }), code);
      try {
        new ProtocolIntegrityStore(path, { contractVersion: 1 });
      } catch (error) {
        expect(String(error)).not.toContain("token=secret");
        expect(String(error)).not.toContain(path);
      }
    }
  });

  test("accepts a valid persisted surface mismatch before any complete fingerprint baseline", () => {
    const path = tempPath();
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 1,
        protocol_contract_version: 1,
        baseline: null,
        current: null,
        change_count: 1,
        mismatch_keys: ["surface:snapshot:rooms:response_shape"],
        last_mismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" }
      }),
      { mode: 0o600 }
    );

    expect(new ProtocolIntegrityStore(path, { contractVersion: 1 }).snapshot()).toEqual({
      protocolContractVersion: 1,
      baseline: null,
      current: null,
      changeCount: 1,
      lastMismatch: { kind: "surface", surface: "snapshot:rooms:response_shape" },
      compatible: false
    });
  });

  test("rejects symlink targets where the filesystem supports them", () => {
    const root = tempRoot();
    const target = join(root, "target.json");
    const link = join(root, "link.json");

    writeFileSync(target, defaultJson(), { mode: 0o600 });
    try {
      symlinkSync(target, link);
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) {
        return;
      }
      throw error;
    }

    expectProtocolIntegrityCode(
      () => new ProtocolIntegrityStore(link, { contractVersion: 1 }),
      "symlink_target"
    );
  });

  test("writes private POSIX permissions when supported", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1 });

    store.observeCompleteFingerprint(fingerprintA);

    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  test("preserves the previous file and removes leftovers when atomic replacement fails before replace", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1 });
    store.observeCompleteFingerprint(fingerprintA);
    const before = readFileSync(path, "utf8");

    const failing = new ProtocolIntegrityStore(path, {
      contractVersion: 1,
      atomicWriteHooks: {
        beforeReplace: () => {
          throw new Error("injected failure");
        }
      }
    });

    expectProtocolIntegrityCode(
      () => failing.observeCompleteFingerprint(fingerprintB),
      "atomic_write_failed"
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(
      readdirNames(path).filter((name) => name.includes(".protocol-integrity-"))
    ).toEqual([]);
  });

  test("preserves the previous baseline when the final target replacement throws", () => {
    const path = tempPath();
    const store = new ProtocolIntegrityStore(path, { contractVersion: 1 });
    store.observeCompleteFingerprint(fingerprintA);
    const before = readFileSync(path, "utf8");

    const failing = new ProtocolIntegrityStore(path, {
      contractVersion: 1,
      atomicWriteHooks: {
        replaceTarget: () => {
          throw new Error("injected replace failure");
        }
      }
    });

    expectProtocolIntegrityCode(
      () => failing.observeCompleteFingerprint(fingerprintB),
      "atomic_write_failed"
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(new ProtocolIntegrityStore(path, { contractVersion: 1 }).snapshot()).toMatchObject({
      baseline: fingerprintA,
      current: fingerprintA,
      changeCount: 0,
      compatible: true
    });
    expect(
      readdirNames(path).filter((name) => name.includes(".protocol-integrity-"))
    ).toEqual([]);
  });
});

function expectProtocolIntegrityCode(received: () => unknown, code: ProtocolIntegrityError["code"]): void {
  try {
    received();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolIntegrityError);
    expect((error as ProtocolIntegrityError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ProtocolIntegrityError code ${code}`);
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "protocol-integrity-store-"));
  tempRoots.push(root);
  return root;
}

function tempPath(): string {
  return join(tempRoot(), "protocol-fingerprint.json");
}

function defaultJson(): string {
  return JSON.stringify({
    schema_version: 1,
    protocol_contract_version: 1,
    baseline: null,
    current: null,
    change_count: 0,
    mismatch_keys: [],
    last_mismatch: null
  });
}

function readdirNames(path: string): string[] {
  return readdirSync(dirname(path));
}

function isUnsupportedSymlinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "ENOSYS")
  );
}
