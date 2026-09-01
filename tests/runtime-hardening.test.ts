import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const readText = (path: string) => readFileSync(path, "utf8");

describe("runtime hardening", () => {
  test("keeps pairing-code creation on the authenticated ingress boundary", () => {
    const nginx = readText("addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf");
    const coreServer = nginx.split("listen 8100;", 2)[1] ?? "";
    expect(coreServer).toContain("location = /api/v1/pairing-code");
    expect(coreServer).toContain("return 403;");
  });

  test("starts reauthentication and stops the stale event loop on token rejection", () => {
    const integration = readText("custom_components/smartthings_web/__init__.py");
    expect(integration).toContain("_EVENT_RECONNECT_MIN_DELAY = 1.0");
    expect(integration).toContain("_EVENT_RECONNECT_MAX_DELAY = 60.0");
    expect(integration).toContain("entry.async_start_reauth(hass)");
    expect(integration).toContain("if hass is None:");
    expect(integration).toContain("entry.async_start_reauth(hass)");
  });
});
