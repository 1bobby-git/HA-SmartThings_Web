import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const prepareData = () =>
  readFileSync(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
    "utf8"
  );
const maintainProfile = () =>
  readFileSync(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/maintain-profile",
    "utf8"
  );

describe("HAOS storage hygiene", () => {
  test("keeps normal protocol capture persistence opt-in", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("deps.config.debugProtocolLogging === true");
    expect(runtime).toContain(
      'persistCapture(record, analysis?.kind === "protocol_changed")'
    );
  });

  test("keeps normal startup shallow while preserving Samsung login stores", () => {
    const quick = prepareData();
    const maintenance = maintainProfile();

    expect(quick).not.toContain("chown -R");
    expect(quick).not.toContain("find ");
    expect(quick).toContain("chown pwuser:pwuser \"$DATA_DIR\"");
    expect(quick).toContain("/data/options.json");
    expect(quick).toContain("/data/bridge-secret");
    expect(quick).toContain("/data/bridge.sqlite-wal");
    expect(maintenance).toContain("/data/chromium-profile/Default/Cache");
    expect(maintenance).toContain(
      "/data/chromium-profile/Default/Service Worker/CacheStorage"
    );
    expect(maintenance).not.toContain("/data/chromium-profile/Default/Cookies");
    expect(maintenance).not.toContain("/data/chromium-profile/Default/Local Storage");
    expect(maintenance).not.toContain("/data/chromium-profile/Default/IndexedDB");
  });

  test("bounds the legacy ownership migration without gating Bridge HTTP", () => {
    const quick = prepareData();
    const maintenance = maintainProfile();

    expect(quick).toContain(".profile-maintenance-required");
    expect(maintenance).toContain('if [ "${1:-}" = "migrate" ]; then');
    expect(maintenance).toContain('find "$directory" -xdev');
    expect(maintenance).toContain("! -user pwuser");
    expect(maintenance).toContain("! -group pwuser");
    expect(maintenance).toContain(
      'timeout --signal=TERM --kill-after=5s 180s "$0" migrate'
    );
    expect(maintenance).toContain("profile_maintenance:ownership_migration_complete");
    expect(maintenance).toContain("profile_maintenance:ownership_migration_timeout_or_failed");
    expect(maintenance).toContain('rm -f -- "$MAINTENANCE_REQUIRED"');
    expect(maintenance).not.toContain("find /data -xdev");
  });
});
