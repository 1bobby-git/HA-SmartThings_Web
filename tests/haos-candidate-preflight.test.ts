import { describe, expect, test } from "vitest";

import type { SoakDeploymentGateResult } from "../tools/haos-soak-deployment-gate-core.js";
import {
  buildHaosAppInfoRemoteCommand,
  evaluateHaosCandidatePreflight,
  parseHaosAppInfoGuestResponse,
  type HaosAppInfo,
  type HaosCandidatePreflightInput
} from "../tools/haos-candidate-preflight-core.js";

describe("HAOS candidate deployment preflight", () => {
  test("builds only the fixed read-only app-info command", () => {
    expect(buildHaosAppInfoRemoteCommand(100, "local_smartthings_web_bridge")).toBe(
      "qm guest exec 100 -- ha apps info local_smartthings_web_bridge --raw-json"
    );
    expect(() =>
      buildHaosAppInfoRemoteCommand(100, "local_smartthings_web_bridge;reboot")
    ).toThrowError("haos_candidate_preflight_command_invalid");
    expect(() => buildHaosAppInfoRemoteCommand(0, "local_smartthings_web_bridge")).toThrowError(
      "haos_candidate_preflight_command_invalid"
    );
  });

  test("reconstructs only safe installed-app posture fields", () => {
    const parsed = parseHaosAppInfoGuestResponse(
      guestResponse({
        result: "ok",
        data: {
          slug: "local_smartthings_web_bridge",
          version: "0.1.25",
          version_latest: "0.1.25",
          state: "started",
          boot: "auto",
          repository: "local",
          build: true,
          apparmor: "profile",
          ingress: true,
          update_available: false,
          ingress_entry: "/api/hassio_ingress/raw-secret-token",
          ip_address: "192.0.2.10",
          options: { password: "raw-secret-token" }
        }
      })
    );

    expect(parsed).toEqual(validInstalled());
    expect(JSON.stringify(parsed)).not.toMatch(/raw-secret|ingress_entry|ip_address|password/i);
  });

  test("rejects malformed or unsafe app-info responses without echoing content", () => {
    expect(() =>
      parseHaosAppInfoGuestResponse(
        guestResponse({ result: "ok", data: { ...validRawInstalled(), version: "raw-secret" } })
      )
    ).toThrowError("haos_candidate_preflight_response_invalid");
    expect(() =>
      parseHaosAppInfoGuestResponse(
        JSON.stringify({ exitcode: 1, exited: 1, "out-data": "raw-secret-token" })
      )
    ).toThrowError("haos_candidate_preflight_command_failed");
  });

  test("allows a published clean candidate only after the sealed soak passes", () => {
    const result = evaluateHaosCandidatePreflight(validInput());

    expect(result).toMatchObject({
      deploymentEligible: true,
      reasons: [],
      source: { clean: true, onMain: true, published: true },
      candidate: { version: "0.1.26", fileCount: 69 },
      installed: {
        version: "0.1.25",
        state: "started",
        localBuild: true,
        apparmorEnforced: true,
        ingressEnabled: true
      }
    });
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });

  test("keeps an otherwise-ready candidate blocked while the soak is pending", () => {
    const input = validInput();
    input.soakGate = pendingSoakGate();

    const result = evaluateHaosCandidatePreflight(input);

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toEqual(["soak_gate_blocked"]);
    expect(result.soak).toMatchObject({
      evidenceState: "pending",
      sampleCount: 37,
      successfulSampleCount: 37,
      errorSampleCount: 0
    });
  });

  test("reports every source, version, and installed-posture defect with fixed reasons", () => {
    const input = validInput();
    input.source = {
      clean: false,
      onMain: false,
      published: false,
      commitSha: "a".repeat(40)
    };
    input.candidate.version = "0.1.24";
    input.installed = {
      ...validInstalled(),
      slug: "local_wrong",
      version: "0.1.24",
      state: "stopped",
      boot: "manual",
      repository: "official",
      build: false,
      apparmor: "disabled",
      ingress: false
    };

    const result = evaluateHaosCandidatePreflight(input);

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "source_not_clean",
        "source_not_main",
        "source_not_published",
        "candidate_version_mismatch",
        "candidate_version_not_newer",
        "installed_slug_mismatch",
        "installed_version_mismatch",
        "installed_not_started",
        "installed_not_boot_auto",
        "installed_not_local_build",
        "installed_apparmor_missing",
        "installed_ingress_disabled"
      ])
    );
  });

  test("compares numeric version components instead of lexical order", () => {
    const input = validInput();
    input.candidate.version = "0.1.10";
    input.expectedCandidateVersion = "0.1.10";
    input.installed.version = "0.1.9";
    input.installed.versionLatest = "0.1.9";
    input.expectedInstalledVersion = "0.1.9";

    expect(evaluateHaosCandidatePreflight(input).deploymentEligible).toBe(true);
  });

  test("rejects unsafe hashes and commit identifiers before emitting output", () => {
    const input = validInput();
    input.source.commitSha = "raw-secret-token";
    input.candidate.manifestSha256 = "also-unsafe";

    expect(() => evaluateHaosCandidatePreflight(input)).toThrowError(
      "haos_candidate_preflight_input_invalid"
    );
  });
});

function validInput(): HaosCandidatePreflightInput {
  return {
    soakGate: passingSoakGate(),
    source: {
      clean: true,
      onMain: true,
      published: true,
      commitSha: "a".repeat(40)
    },
    candidate: {
      version: "0.1.26",
      fileCount: 69,
      manifestSha256: "b".repeat(64)
    },
    installed: validInstalled(),
    expectedInstalledVersion: "0.1.25",
    expectedCandidateVersion: "0.1.26",
    expectedAddonSlug: "local_smartthings_web_bridge"
  };
}

function validInstalled(): HaosAppInfo {
  return {
    slug: "local_smartthings_web_bridge",
    version: "0.1.25",
    versionLatest: "0.1.25",
    state: "started",
    boot: "auto",
    repository: "local",
    build: true,
    apparmor: "profile",
    ingress: true,
    updateAvailable: false
  };
}

function validRawInstalled(): Record<string, unknown> {
  return {
    slug: "local_smartthings_web_bridge",
    version: "0.1.25",
    version_latest: "0.1.25",
    state: "started",
    boot: "auto",
    repository: "local",
    build: true,
    apparmor: "profile",
    ingress: true,
    update_available: false
  };
}

function passingSoakGate(): SoakDeploymentGateResult {
  return {
    schemaVersion: 1,
    deploymentEligible: true,
    evidenceState: "eligible",
    reasons: [],
    runStatus: "completed",
    soakStatus: "pass",
    startedAt: "2026-08-24T00:00:00.000Z",
    expectedEndAt: "2026-08-27T00:00:00.000Z",
    durationMs: 259_200_000,
    intervalMs: 300_000,
    sampleCount: 865,
    successfulSampleCount: 865,
    errorSampleCount: 0,
    failures: [],
    warnings: [],
    summarySha256: "c".repeat(64)
  };
}

function pendingSoakGate(): SoakDeploymentGateResult {
  return {
    schemaVersion: 1,
    deploymentEligible: false,
    evidenceState: "pending",
    reasons: [
      "run_not_completed",
      "soak_not_passed",
      "summary_not_completed",
      "completion_time_invalid",
      "insufficient_samples"
    ],
    runStatus: "running",
    soakStatus: "pending",
    startedAt: "2026-08-24T00:00:00.000Z",
    expectedEndAt: "2026-08-27T00:00:00.000Z",
    durationMs: 259_200_000,
    intervalMs: 300_000,
    sampleCount: 37,
    successfulSampleCount: 37,
    errorSampleCount: 0,
    failures: [],
    warnings: []
  };
}

function guestResponse(body: unknown): string {
  return JSON.stringify({
    exitcode: 0,
    exited: 1,
    "out-data": JSON.stringify(body),
    "out-truncated": 0
  });
}
