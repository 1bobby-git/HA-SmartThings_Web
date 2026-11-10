import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileDetailDiscoveryStore } from "../../src/state/detail-discovery-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stw-detail-discovery-"));
  roots.push(root);
  return root;
}

describe("FileDetailDiscoveryStore", () => {
  test("keeps exhausted devices across store instances", () => {
    const root = tempRoot();
    new FileDetailDiscoveryStore(root).save(
      new Map([["dev_1", { nameHash: "abc", exhaustedAtMs: 1_000 }]])
    );

    expect([...new FileDetailDiscoveryStore(root).load()]).toEqual([
      ["dev_1", { nameHash: "abc", exhaustedAtMs: 1_000 }]
    ]);
  });

  test("starts empty when the file is missing or corrupt", () => {
    const root = tempRoot();
    expect(new FileDetailDiscoveryStore(root).load().size).toBe(0);
    writeFileSync(join(root, "detail-discovery.json"), "{not json");
    expect(new FileDetailDiscoveryStore(root).load().size).toBe(0);
  });

  test("drops malformed records", () => {
    const root = tempRoot();
    writeFileSync(
      join(root, "detail-discovery.json"),
      JSON.stringify({
        schemaVersion: 1,
        exhausted: { dev_ok: { nameHash: "x", exhaustedAtMs: 5 }, dev_bad: { nameHash: 1 } }
      })
    );

    expect([...new FileDetailDiscoveryStore(root).load().keys()]).toEqual(["dev_ok"]);
  });

  test("stores only a hash of the device name", () => {
    const root = tempRoot();
    new FileDetailDiscoveryStore(root).save(
      new Map([["dev_1", { nameHash: "hash-only", exhaustedAtMs: 1 }]])
    );
    expect(readFileSync(join(root, "detail-discovery.json"), "utf8")).not.toContain("거실");
  });
});
