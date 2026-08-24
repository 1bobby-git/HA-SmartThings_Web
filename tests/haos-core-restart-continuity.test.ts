import { describe, expect, it } from "vitest";

import {
  assertHaosCoreRestartGuestResponse,
  buildHaosBridgeHealthRemoteCommand,
  buildHaosCoreContainerStateRemoteCommand,
  buildHaosCoreInfoRemoteCommand,
  buildHaosCoreRestartRemoteCommand,
  evaluateHaosCoreRestartContinuity,
  evaluateHaosCoreRestartPreflight,
  healthIsUsable,
  parseHaosCoreContainerStateGuestResponse,
  parseHaosCoreInfoGuestResponse,
  type HaosCoreContainerState,
  type HaosCoreInfo
} from "../tools/haos-core-restart-continuity-core.js";
import type { SoakHealthObservation } from "../tools/haos-soak-core.js";
import type { SoakDeploymentGateResult } from "../tools/haos-soak-deployment-gate-core.js";

describe("HAOS Core restart command boundary", () => {
  it("builds only fixed inspection, health, and restart commands", () => {
    expect(buildHaosCoreInfoRemoteCommand(100)).toBe(
      "qm guest exec 100 -- ha core info --raw-json"
    );
    expect(buildHaosCoreContainerStateRemoteCommand(100)).toBe(
      "qm guest exec 100 -- docker inspect --format '{{.Id}}|{{.State.StartedAt}}|{{.State.Running}}' homeassistant"
    );
    expect(buildHaosCoreRestartRemoteCommand(100)).toBe(
      "qm guest exec 100 -- ha core restart"
    );
    expect(buildHaosBridgeHealthRemoteCommand(100, "local_smartthings_web_bridge")).toBe(
      "qm guest exec 100 -- docker exec app_local_smartthings_web_bridge curl -fsS http://127.0.0.1:8098/health/details"
    );
  });

  it("rejects command argument injection", () => {
    expect(() => buildHaosCoreInfoRemoteCommand(0)).toThrowError(
      "haos_core_restart_command_invalid"
    );
    expect(() => buildHaosBridgeHealthRemoteCommand(100, "safe; reboot")).toThrowError(
      "haos_core_restart_command_invalid"
    );
  });

  it("parses only allowlisted Core posture", () => {
    const parsed = parseHaosCoreInfoGuestResponse(
      guestExec(
        JSON.stringify({
          result: "ok",
          data: {
            version: "2026.8.3",
            version_latest: "2026.8.3",
            boot: true,
            watchdog: true,
            ip_address: "must-not-persist",
            port: 8123
          }
        })
      )
    );

    expect(parsed).toEqual({
      version: "2026.8.3",
      versionLatest: "2026.8.3",
      boot: true,
      watchdog: true
    });
    expect(JSON.stringify(parsed)).not.toContain("must-not-persist");
  });

  it("parses container identity only for in-memory comparison", () => {
    const parsed = parseHaosCoreContainerStateGuestResponse(
      guestExec(`${"a".repeat(64)}|2026-08-22T23:54:10.15175222Z|true\n`)
    );

    expect(parsed).toEqual({
      containerId: "a".repeat(64),
      startedAt: "2026-08-22T23:54:10.151Z",
      running: true
    });
    expect(() =>
      parseHaosCoreContainerStateGuestResponse(guestExec("raw-id|bad|true"))
    ).toThrowError("haos_core_container_response_invalid");
  });

  it("accepts only a successful guest restart response", () => {
    expect(() => assertHaosCoreRestartGuestResponse(guestExec("ok\n"))).not.toThrow();
    expect(() =>
      assertHaosCoreRestartGuestResponse(
        JSON.stringify({ exitcode: 1, exited: 1, "out-data": "failure" })
      )
    ).toThrowError("haos_core_restart_command_failed");
  });
});

describe("HAOS Core restart preflight", () => {
  it("permits execution only with a sealed soak and healthy exact runtime", () => {
    const preflight = evaluateHaosCoreRestartPreflight({
      soakGate: eligibleSoakGate(),
      coreInfo: coreInfo(),
      coreContainer: coreContainer(),
      health: health(),
      expectedCoreVersion: "2026.8.3",
      expectedBridgeVersion: "0.1.25"
    });

    expect(preflight.executionEligible).toBe(true);
    expect(preflight.reasons).toEqual([]);
    expect(JSON.stringify(preflight)).not.toContain("a".repeat(64));
  });

  it("fails closed on the active soak without weakening other checks", () => {
    const preflight = evaluateHaosCoreRestartPreflight({
      soakGate: { ...eligibleSoakGate(), deploymentEligible: false, evidenceState: "pending" },
      coreInfo: coreInfo(),
      coreContainer: coreContainer(),
      health: health(),
      expectedCoreVersion: "2026.8.3",
      expectedBridgeVersion: "0.1.25"
    });

    expect(preflight.executionEligible).toBe(false);
    expect(preflight.reasons).toEqual(["soak_gate_blocked"]);
  });

  it("reports every unsafe baseline prerequisite", () => {
    const unsafeHealth: SoakHealthObservation = {
      ...health(),
      live: false,
      ready: false,
      state: "STALE",
      urlCategory: "smartthings_advanced",
      observedDeviceCount: 0,
      bridgeVersion: "0.1.24",
      protocolChangeCount: 1,
      restartCount: 1
    };
    delete unsafeHealth.initialSnapshotAgeMs;
    delete unsafeHealth.browserUptimeMs;
    const preflight = evaluateHaosCoreRestartPreflight({
      soakGate: eligibleSoakGate(),
      coreInfo: { ...coreInfo(), version: "2026.8.2", boot: false, watchdog: false },
      coreContainer: { ...coreContainer(), running: false },
      health: unsafeHealth,
      expectedCoreVersion: "2026.8.3",
      expectedBridgeVersion: "0.1.25"
    });

    expect(preflight.reasons).toEqual(
      expect.arrayContaining([
        "core_version_mismatch",
        "core_boot_disabled",
        "core_watchdog_disabled",
        "core_container_not_running",
        "bridge_version_mismatch",
        "bridge_not_live",
        "bridge_not_ready",
        "bridge_not_connected",
        "keeper_not_location",
        "snapshot_missing",
        "browser_uptime_missing",
        "protocol_changed",
        "runtime_restarted"
      ])
    );
  });
});

describe("HAOS Core restart continuity verdict", () => {
  it("passes a Core container restart while the Bridge browser and counters continue", () => {
    const summary = evaluateHaosCoreRestartContinuity(continuityInput());

    expect(summary.status).toBe("pass");
    expect(summary.failures).toEqual([]);
    expect(summary.checks).toMatchObject({
      coreRestartObserved: true,
      coreStartedAtAdvanced: true,
      bridgeAvailableEverySample: true,
      browserUptimeAdvanced: true,
      countersMonotonic: true
    });
    expect(summary.core.containerIdentityChanged).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("a".repeat(64));
  });

  it("fails when Core restart is not observed or Bridge monitoring has a gap", () => {
    const input = continuityInput();
    const summary = evaluateHaosCoreRestartContinuity({
      ...input,
      postCoreContainer: input.baselineCoreContainer,
      healthSampleErrorCount: 1,
      unhealthyHealthSampleCount: 1
    });

    expect(summary.status).toBe("fail");
    expect(summary.failures).toEqual(
      expect.arrayContaining([
        "core_restart_not_observed",
        "bridge_health_sample_error",
        "bridge_unavailable_during_restart"
      ])
    );
  });

  it("fails browser, protocol, inventory, invalid-frame, and counter regressions", () => {
    const input = continuityInput();
    const summary = evaluateHaosCoreRestartContinuity({
      ...input,
      postHealth: {
        ...input.postHealth,
        browserVersion: "changed",
        protocolVersion: "changed",
        browserUptimeMs: 1,
        restartCount: 1,
        protocolChangeCount: 1,
        protocolInvalidFrameCount: 3,
        observedDeviceCount: 212,
        decodedDeviceEventCount: 99,
        uniqueLogicalEventCount: 49,
        duplicateEventCount: 49
      }
    });

    expect(summary.status).toBe("fail");
    expect(summary.failures).toEqual(
      expect.arrayContaining([
        "browser_version_changed",
        "protocol_version_changed",
        "browser_restarted",
        "runtime_restart_count_changed",
        "protocol_change_count_changed",
        "invalid_frame_count_changed",
        "device_inventory_changed",
        "counter_regression",
        "post_health_unusable"
      ])
    );
  });

  it("requires the complete current keeper health contract", () => {
    const missingSnapshot: SoakHealthObservation = health();
    delete missingSnapshot.initialSnapshotAgeMs;
    expect(healthIsUsable(health())).toBe(true);
    expect(healthIsUsable({ ...health(), urlCategory: "smartthings_advanced" })).toBe(false);
    expect(healthIsUsable(missingSnapshot)).toBe(false);
  });
});

function continuityInput() {
  const baselineHealth = health();
  const postHealth = health({
    decodedDeviceEventCount: 110,
    uniqueLogicalEventCount: 55,
    duplicateEventCount: 55,
    browserUptimeMs: 3_660_000
  });
  return {
    startedAt: "2026-08-24T12:00:00.000Z",
    endedAt: "2026-08-24T12:01:00.000Z",
    baselineCoreInfo: coreInfo(),
    postCoreInfo: coreInfo(),
    baselineCoreContainer: coreContainer(),
    postCoreContainer: coreContainer({ startedAt: "2026-08-24T12:00:10.000Z" }),
    baselineHealth,
    postHealth,
    healthSampleCount: 10,
    healthSampleErrorCount: 0,
    unhealthyHealthSampleCount: 0
  };
}

function eligibleSoakGate(): SoakDeploymentGateResult {
  return {
    schemaVersion: 1,
    deploymentEligible: true,
    evidenceState: "eligible",
    reasons: [],
    sampleCount: 865
  };
}

function coreInfo(): HaosCoreInfo {
  return { version: "2026.8.3", versionLatest: "2026.8.3", boot: true, watchdog: true };
}

function coreContainer(override: Partial<HaosCoreContainerState> = {}): HaosCoreContainerState {
  return {
    containerId: "a".repeat(64),
    startedAt: "2026-08-22T23:54:10.151Z",
    running: true,
    ...override
  };
}

function health(override: Partial<SoakHealthObservation> = {}): SoakHealthObservation {
  return {
    live: true,
    ready: true,
    state: "CONNECTED",
    urlCategory: "smartthings_location",
    activeConnections: 0,
    observedDeviceCount: 213,
    decodedDeviceEventCount: 100,
    uniqueLogicalEventCount: 50,
    duplicateEventCount: 50,
    dedupeJournalSize: 50,
    protocolInvalidFrameCount: 2,
    protocolChangeCount: 0,
    restartCount: 0,
    bridgeVersion: "0.1.25",
    browserVersion: "151.0.7922.34",
    protocolVersion: "1:93ad956a7d0c0139",
    heartbeatAgeMs: 1000,
    snapshotAgeMs: 1000,
    initialSnapshotAgeMs: 1000,
    pushAgeMs: 500,
    browserUptimeMs: 3_600_000,
    ...override
  };
}

function guestExec(output: string): string {
  return JSON.stringify({
    exitcode: 0,
    exited: 1,
    "out-data": output,
    "out-truncated": 0
  });
}
