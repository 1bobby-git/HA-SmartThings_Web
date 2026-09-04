import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");

const prepareDataPath =
  "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data";
const nginxPath =
  "addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf";
const fallbackPath =
  "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html";

describe("SmartThings Web add-on startup resilience", () => {
  test("repairs Supervisor-owned top-level runtime files on every start", () => {
    const prepareData = readText(prepareDataPath);
    const shallowRepair = prepareData.indexOf("for file in \\");
    const oneTimeMigration = prepareData.indexOf(
      'if [ ! -f "$OWNERSHIP_MARKER" ]; then'
    );

    expect(prepareData).toContain('OWNERSHIP_MARKER="/data/.ownership-migrated-v2"');
    expect(shallowRepair).toBeGreaterThan(-1);
    expect(oneTimeMigration).toBeGreaterThan(shallowRepair);
    for (const file of [
      "/data/options.json",
      "/data/bridge-secret",
      "/data/bridge.sqlite",
      "/data/bridge.sqlite-wal",
      "/data/bridge.sqlite-shm",
      "/data/settings.json",
      "/data/protocol-fingerprint.json"
    ]) {
      expect(prepareData).toContain(file);
    }
    expect(prepareData).toContain('if [ -f "$file" ] && [ ! -L "$file" ]; then');
    expect(prepareData).toContain("data_prep_recursive_ownership_retry_required");
    expect(prepareData).not.toContain("chown -R");
  });

  test("keeps ingress usable while the internal Bridge HTTP process is restarting", () => {
    const nginx = readText(nginxPath);

    expect(nginx).toContain("location = / {");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:8098;");
    expect(nginx).toContain("proxy_connect_timeout 2s;");
    expect(nginx).toContain("proxy_intercept_errors on;");
    expect(nginx).toContain(
      "error_page 502 503 504 =200 /bridge-unavailable.html;"
    );
    expect(nginx).toContain("location = /bridge-unavailable.html {");
    expect(nginx).toContain("internal;");
    expect(nginx).toContain("root /usr/share/smartthings-web;");
    expect(nginx.match(/location \/ \{/gu)?.length).toBe(2);
    expect(nginx).not.toMatch(/location\s+=\s+\/health\/live[\s\S]*?error_page/u);
  });

  test("packages a visible recovery page with direct noVNC access", () => {
    expect(existsSync(fallbackPath)).toBe(true);
    const fallback = readText(fallbackPath);

    expect(fallback).toContain('http-equiv="refresh" content="5"');
    expect(fallback).toContain("127.0.0.1:8098");
    expect(fallback).toContain("bridge_start_failed:");
    expect(fallback).toContain("bridge_init:");
    expect(fallback).toContain("data_prep_");
    expect(fallback).toContain("novnc-ui/vnc.html");
  });
});
