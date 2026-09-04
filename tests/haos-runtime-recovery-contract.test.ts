import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");

describe("HAOS runtime recovery contract", () => {
  test("quarantines recoverable persistent-data damage instead of blocking Bridge HTTP", () => {
    const prepareData = readText(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data"
    );

    expect(prepareData).toContain('RECOVERY_DIR="$DATA_DIR/recovery"');
    expect(prepareData).toContain("data_prep:quarantined:");
    expect(prepareData).toContain("bridge.sqlite-invalid-header");
    expect(prepareData).toContain("data_prep:sqlite_reset");
    expect(prepareData).toContain('chown root:root "$RECOVERY_DIR"');
    expect(prepareData).toContain('chmod 0700 "$RECOVERY_DIR"');
    expect(prepareData).not.toContain("find ");
  });

  test("keeps sandbox-first Chromium startup with one bounded compatibility fallback", () => {
    const persistentContext = readText("bridge/src/browser/persistent-context.ts");
    const runtime = readText("bridge/src/runtime.ts");

    expect(persistentContext).toContain("chromiumSandbox: true");
    expect(persistentContext).toContain("chromiumSandbox: false");
    expect(persistentContext).toContain("sandboxCompatibilityFailureTokens");
    expect(runtime).toContain('browser_launch:sandbox_fallback');
  });

  test("creates Openbox runtime directories and verifies the packaged image on every change", () => {
    const openbox = readText(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/openbox/run"
    );
    const runtime = readText("bridge/src/runtime.ts");
    const validate = readText(".github/workflows/validate.yml");
    const smoke = readText("tools/ci-haos-runtime-smoke.sh");

    expect(openbox).toContain('mkdir -p "$HOME" "$XDG_CACHE_HOME"');
    expect(openbox).toContain('chmod 0700 "$HOME" "$XDG_CACHE_HOME"');
    expect(runtime).toContain("bridge_init:http_server_ready:${server.port}");
    expect(validate).toContain("Packaged HAOS runtime smoke");
    expect(validate).toContain("tools/ci-haos-runtime-smoke.sh");
    expect(smoke).toContain("invalid-sqlite-directory");
    expect(smoke).toContain("invalid-sqlite-header");
    expect(smoke).toContain("empty-secret");
    expect(smoke).toContain("_NET_CLIENT_LIST");
  });
});
