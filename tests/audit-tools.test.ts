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
        await page.context().setExtraHTTPHeaders({ Authorization: "Bearer x", "access_token": "json-token-value", "client_secret": "json-secret-value", "x-csrf-token": "csrf-secret-value", "client-secret": "client-dash-secret", "x-api-secret": "api-secret-value", Cookie: "sid=secretcookievalue" });
        const directSocket = new WebSocket("wss://my.smartthings.com/socket.io/");
        const multilineSocket = new WebSocket(
          "wss://my.smartthings.com/socket.io/"
        );
        const multilineEvents = new EventSource(
          "https://my.smartthings.com/events"
        );
        const multilineIo = io(
          "https://my.smartthings.com"
        );
        await createSubscription();
      }
    `);

    const findings = auditSmartThingsApiFree({ cwd: root });

    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "direct-smartthings-api-host",
        "smartthings-v1-endpoint",
        "official-smartthings-auth",
        "official-smartthings-sdk",
        "direct-http-client",
        "direct-smartthings-socket",
        "polling-smartthings-call",
        "playwright-network-mutation"
      ])
    );
    expect(JSON.stringify(findings)).not.toContain("Bearer x");
    expect(JSON.stringify(findings)).not.toContain("json-token-value");
    expect(JSON.stringify(findings)).not.toContain("json-secret-value");
    expect(JSON.stringify(findings)).not.toContain("secretcookievalue");
    expect(JSON.stringify(findings)).not.toContain("csrf-secret-value");
    expect(JSON.stringify(findings)).not.toContain("client-dash-secret");
    expect(JSON.stringify(findings)).not.toContain("api-secret-value");
    expect(findings.filter((finding) => finding.rule === "direct-smartthings-socket").length).toBeGreaterThanOrEqual(4);
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

  test("allows observed subscription event names without allowing subscription creation", () => {
    const root = seededTempDir();
    write(
      root,
      "bridge/src/protocol-analyzer.ts",
      'export const observedEvent = "api/subscription DEVICE_EVENT";\n'
    );

    expect(auditSmartThingsApiFree({ cwd: root })).toEqual([]);
  });

  test("allows same-origin Bridge UI requests without allowing direct external clients", () => {
    const root = seededTempDir();
    write(
      root,
      "bridge/src/status-page.ts",
      'export const pair = () => fetch("api/v1/pairing-code", { method: "POST", credentials: "same-origin" });\n'
    );

    expect(auditSmartThingsApiFree({ cwd: root })).toEqual([]);
  });

  test("allows SmartThings Web UI observer class names without treating them as SDK clients", () => {
    const root = seededTempDir();
    write(
      root,
      "bridge/src/runtime.ts",
      "const executor = new SmartThingsWebUiCommandExecutor(() => keeper);\n"
    );

    expect(auditSmartThingsApiFree({ cwd: root })).toEqual([]);
  });
});

describe("secret production scan", () => {
  test("fails production token-like assignments and bearer material", () => {
    const root = seededTempDir();
    write(root, "bridge/src/secrets.ts", `
      const sessionToken = "session_12345678901234567890";
      const authorization = "bEaReR abcdefghijklmnopqrstuvwxyz123456";
      const captchaCode = "123456";
      const serialized = { "access_token": "json-token-value", "client_secret": "json-secret-value" };
      const notoken = "ordinary-production-label";
    `);

    const findings = scanProductionSecrets({ cwd: root });

    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "secret-assignment",
        "bearer-material"
      ])
    );
    expect(
      findings
        .filter((finding) => finding.rule === "secret-assignment")
        .map((finding) => finding.key)
        .sort()
    ).toEqual(["access_token", "authorization", "captchaCode", "client_secret", "sessionToken"].sort());
    expect(findings.some((finding) => finding.key === "token" && finding.line > 0)).toBe(false);
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
