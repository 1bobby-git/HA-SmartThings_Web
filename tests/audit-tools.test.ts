import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { auditSmartThingsApiFree } from "../tools/api-free-audit.js";
import { scanProductionSecrets } from "../tools/secret-scan.js";

function seededTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ha-st-api-audit-"));
}

function write(root: string, path: string, text: string): void {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, text);
}

describe("api-free production audit", () => {
  test("fails direct SmartThings API, SDK, polling, and interception code", () => {
    const root = seededTempDir();
    write(root, "bridge/src/bad.ts", `
      import got from "got";
      import { SmartThingsClient } from "@smartthings/core-sdk";
      export async function bad(page) {
        setInterval(() => fetch("https://api.smartthings.com/v1/devices"), 15000);
        await page.route("**/*", route => route.fulfill({ status: 200 }));
        await page.context().setExtraHTTPHeaders({ Authorization: "Bearer x" });
      }
    `);

    const findings = auditSmartThingsApiFree({ cwd: root });

    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "direct-smartthings-api-host",
        "smartthings-v1-endpoint",
        "official-smartthings-sdk",
        "direct-http-client",
        "polling-smartthings-call",
        "playwright-network-mutation"
      ])
    );
  });

  test("ignores legitimate local heartbeat timers", () => {
    const root = seededTempDir();
    write(root, "bridge/src/health.ts", `
      export function startHeartbeat(send) {
        return setInterval(() => send({ type: "heartbeat" }), 10000);
      }
    `);

    expect(auditSmartThingsApiFree({ cwd: root })).toEqual([]);
  });
});

describe("secret production scan", () => {
  test("fails production token-like assignments and bearer material", () => {
    const root = seededTempDir();
    write(root, "bridge/src/secrets.ts", `
      const sessionToken = "session_12345678901234567890";
      const authorization = "Bearer abcdefghijklmnopqrstuvwxyz123456";
      const captchaCode = "123456";
    `);

    const findings = scanProductionSecrets({ cwd: root });

    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "secret-assignment",
        "bearer-material"
      ])
    );
  });

  test("excludes docs, tests, synthetic fixtures, and scanner definitions", () => {
    const root = seededTempDir();
    write(root, "docs/example.md", "access_token = example");
    write(root, "tests/example.test.ts", "const authorization = 'Bearer abcdefghijklmnopqrstuvwxyz123456'");
    write(root, "protocol/fixtures/synthetic/example.json", "{ \"refresh_token\": \"fake\" }");
    write(root, "tools/secret-scan.ts", "const pattern = /access_token\\\\s*[:=]/");

    expect(scanProductionSecrets({ cwd: root })).toEqual([]);
  });
});
