import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");
const root = "addon/smartthings_web_bridge/rootfs/etc/s6-overlay";
const prepareDataPath = `${root}/scripts/prepare-data`;
const maintainProfilePath = `${root}/scripts/maintain-profile`;
const serviceRoot = `${root}/s6-rc.d`;
const bundleRoot = `${root}/user-bundles.d/user/contents.d`;
const nginxPath = "addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf";
const fallbackPath =
  "addon/smartthings_web_bridge/rootfs/usr/share/smartthings-web/bridge-unavailable.html";

describe("SmartThings Web add-on startup resilience", () => {
  test("keeps the Bridge gate limited to fast critical data preparation", () => {
    const prepareData = readText(prepareDataPath);
    const bridgeDependencies = `${serviceRoot}/bridge/dependencies.d`;

    expect(prepareData).toContain("data_prep:start");
    expect(prepareData).toContain("data_prep:ready");
    expect(prepareData).toContain(".profile-maintenance-required");
    expect(prepareData).toContain("/data/options.json");
    expect(prepareData).toContain("/data/bridge.sqlite-wal");
    expect(prepareData).not.toContain('find "$directory" -xdev');
    expect(prepareData).not.toContain("Service Worker/CacheStorage");
    expect(prepareData).not.toContain("chown -R");
    expect(existsSync(`${bridgeDependencies}/data-prep`)).toBe(true);
    expect(existsSync(`${bridgeDependencies}/xvfb-ready`)).toBe(true);
    expect(existsSync(`${bridgeDependencies}/profile-maintenance`)).toBe(false);
  });

  test("runs bounded profile maintenance independently from HTTP startup", () => {
    const maintenance = readText(maintainProfilePath);
    const profileRun = readText(`${serviceRoot}/profile-maintenance/run`);
    const runtime = readText("bridge/src/runtime.ts");

    expect(maintenance).toContain("profile_maintenance:start");
    expect(maintenance).toContain("Service Worker/CacheStorage");
    expect(maintenance).toContain("timeout --signal=TERM --kill-after=5s 180s");
    expect(maintenance).toContain('find "$directory" -xdev');
    expect(maintenance).toContain(".ownership-migrated-v2");
    expect(maintenance).toContain(".profile-maintenance-failed");
    expect(maintenance.indexOf("Service Worker/CacheStorage")).toBeLessThan(
      maintenance.indexOf('if [ ! -f "$MIGRATED_MARKER" ]; then')
    );
    expect(profileRun).toContain("/etc/s6-overlay/scripts/maintain-profile");
    expect(profileRun).toContain("exec s6-pause");
    expect(readText(`${serviceRoot}/profile-maintenance/type`).trim()).toBe("longrun");
    expect(
      readText(`${serviceRoot}/profile-maintenance/dependencies.d/data-prep`).trim()
    ).toBe("");
    expect(existsSync(`${bundleRoot}/profile-maintenance`)).toBe(true);
    expect(runtime.indexOf("createBridgeHttpServer")).toBeLessThan(
      runtime.indexOf("waitForProfileMaintenance(")
    );
    expect(runtime).toContain("browser_startup:profile_maintenance_wait");
  });

  test("logs the Bridge service boundary before Node starts and whenever it exits", () => {
    const run = readText(`${serviceRoot}/bridge/run`);
    const finish = readText(`${serviceRoot}/bridge/finish`);

    expect(run).toContain("bridge_service:missing_compiled_main");
    expect(run).toContain("bridge_service:start");
    expect(run.indexOf("bridge_service:start")).toBeLessThan(
      run.indexOf("exec s6-setuidgid pwuser node")
    );
    expect(finish).toContain("bridge_service:exit:code=");
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
