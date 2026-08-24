import { describe, expect, test } from "vitest";

import { createHealthReport } from "../../src/server/health.js";
import { renderStatusPage } from "../../src/server/status-page.js";
import { RuntimeStatusStore, type RuntimeStatusPatch } from "../../src/state/runtime-state.js";

describe("renderStatusPage", () => {
  test("renders green verified protocol evidence from safe health fields only", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      protocolChangeCount: 0,
      dbAvailable: true,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      lastSnapshotAtMs: 9_900,
      lastParserSuccessAtMs: 9_950,
      lastPushAtMs: 9_975
    }));

    expect(html).toContain('data-protocol-state="verified"');
    expect(html).toContain("Protocol verified");
    expect(html).toContain("1:abcdef1234567890");
    expect(html).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
  });

  test("renders amber discovery incomplete protocol evidence", () => {
    const html = renderStatusPage(reportFor({
      state: "DISCOVERING_PROTOCOL",
      protocolVersion: "1:discovering",
      protocolChangeCount: 0,
      dbAvailable: true
    }));

    expect(html).toContain('data-protocol-state="discovering"');
    expect(html).toContain("Protocol discovery incomplete");
    expect(html).toContain("1:discovering");
    expect(html).toContain(
      'href="novnc-ui/vnc.html?autoconnect=1&amp;resize=scale&amp;path=websockify"'
    );
    expect(html).not.toContain('href="/novnc');
  });

  test("renders red protocol-changed evidence and escapes safe field values", () => {
    const html = renderStatusPage(reportFor({
      state: "PROTOCOL_CHANGED",
      protocolVersion: '1:<probe"',
      protocolChangeCount: 2,
      protocolMismatchSurface: "snapshot:scenes:response_shape",
      dbAvailable: true,
      parserHealthy: false
    }));

    expect(html).toContain('data-protocol-state="changed"');
    expect(html).toContain("Protocol changed");
    expect(html).toContain("Readiness blocked");
    expect(html).toContain("Phase 2 remains closed");
    expect(html).toContain("snapshot:scenes:response_shape");
    expect(html).toContain("1:&lt;probe&quot;");
    expect(html).not.toContain('1:<probe"');
    expect(html).not.toMatch(/https?:|deviceId|locationId|token|secret|raw-/i);
  });

  test("renders green protocol evidence for compatible status with historical changes", () => {
    const html = renderStatusPage(reportFor({
      state: "CONNECTED",
      protocolVersion: "1:abcdef1234567890",
      protocolChangeCount: 3,
      dbAvailable: true,
      chromiumRunning: true,
      keeperPresent: true,
      authenticated: true,
      pushConnected: true,
      initialSnapshotComplete: true,
      parserHealthy: true,
      lastSnapshotAtMs: 9_900,
      lastParserSuccessAtMs: 9_950,
      lastPushAtMs: 9_975
    }));

    expect(html).toContain('data-protocol-state="verified"');
    expect(html).toContain("Protocol verified");
    expect(html).not.toContain("Phase 2 remains closed");
  });
});

function reportFor(patch: RuntimeStatusPatch) {
  const now = 10_000;
  const store = new RuntimeStatusStore({
    now: () => now,
    initial: {
      heartbeatAtMs: 9_990,
      bridgeVersion: "0.1.0",
      browserVersion: "Chromium 141.0.7390.122",
      ...patch
    }
  });
  return createHealthReport(store.getSnapshot(), { nowMs: now });
}
