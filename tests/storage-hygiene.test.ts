import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("HAOS storage hygiene", () => {
  test("keeps normal protocol capture persistence opt-in", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("deps.config.debugProtocolLogging === true");
    expect(runtime).toContain(
      'persistCapture(record, analysis?.kind === "protocol_changed")'
    );
  });

  test("avoids recursive ownership rewrites and preserves Samsung login stores", () => {
    const script = readFileSync(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
      "utf8"
    );
    expect(script).not.toContain("chown -R");
    expect(script).toContain("chown pwuser:pwuser /data");
    expect(script).toContain("/data/chromium-profile/Default/Cache");
    expect(script).toContain("/data/chromium-profile/Default/Service Worker/CacheStorage");
    expect(script).not.toContain("/data/chromium-profile/Default/Cookies");
    expect(script).not.toContain("/data/chromium-profile/Default/Local Storage");
    expect(script).not.toContain("/data/chromium-profile/Default/IndexedDB");
  });

  test("repairs durable data ownership once without scanning all of /data every boot", () => {
    const script = readFileSync(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
      "utf8"
    );
    expect(script).toContain('OWNERSHIP_MARKER="/data/.ownership-migrated-v2"');
    expect(script).toContain('if [ ! -f "$OWNERSHIP_MARKER" ]; then');
    expect(script).toContain("find /data -maxdepth 1 -type f");
    expect(script).toContain('find "$directory" -xdev');
    expect(script).toContain('touch "$OWNERSHIP_MARKER"');
    expect(script).not.toContain("find /data -xdev");
  });
});
