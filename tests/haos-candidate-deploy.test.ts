import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import type {
  HaosAppInfo,
  HaosCandidatePreflightResult
} from "../tools/haos-candidate-preflight-core.js";
import {
  buildHaosAddonRebuildRemoteScript,
  buildHaosActivateRemoteScript,
  buildHaosArchiveUploadRemoteCommand,
  buildHaosCandidateManifestHashRemoteCommand,
  buildHaosCleanupRemoteScript,
  buildHaosGuestShellRemoteCommand,
  buildHaosHealthRemoteScript,
  buildHaosInitializeRemoteScript,
  buildHaosPrepareRemoteScript,
  buildHaosRollbackSourceRemoteScript,
  buildHaosRuntimeHashRemoteCommand,
  createHaosDeploymentRemoteLayout,
  deployedAppMatches,
  evaluateHaosCandidateDeploymentReadiness,
  HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH,
  HAOS_ROLLBACK_COMMIT_SHA,
  HAOS_ROLLBACK_MANIFEST_SHA256,
  HAOS_ROLLBACK_RUNTIME_PATH,
  HAOS_ROLLBACK_RUNTIME_SHA256,
  HAOS_ROLLBACK_VERSION,
  parseHaosCandidateManifestHashGuestResponse,
  parseHaosRuntimeHashGuestResponse
} from "../tools/haos-candidate-deploy-core.js";

const CANDIDATE_COMMIT = "a".repeat(40);
const CANDIDATE_MANIFEST = "b".repeat(64);
const CANDIDATE_ARCHIVE = "c".repeat(64);
const ROLLBACK_ARCHIVE = "d".repeat(64);

describe("HAOS candidate deployment gate", () => {
  test("pins the deployed 0.1.49 build as the next rollback", () => {
    expect(HAOS_ROLLBACK_COMMIT_SHA).toBe(
      "a4dada757f84409c6734149d26ee97d8dd5a114e"
    );
    expect(HAOS_ROLLBACK_VERSION).toBe("0.1.49");
    expect(HAOS_ROLLBACK_MANIFEST_SHA256).toBe(
      "d60503ed2f78e830e47e7a63bd1ba756ce805475c12408c0cb5692fc30ae0df4"
    );
  });

  test("authorizes only the exact published candidate and pinned running rollback", () => {
    const result = evaluateHaosCandidateDeploymentReadiness({
      preflight: passingPreflight(),
      expectedCandidateCommitSha: CANDIDATE_COMMIT,
      expectedCandidateManifestSha256: CANDIDATE_MANIFEST,
      rollbackManifestSha256: HAOS_ROLLBACK_MANIFEST_SHA256,
      installedRuntimeSha256: HAOS_ROLLBACK_RUNTIME_SHA256
    });

    expect(result.deploymentEligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.identity).toEqual({
      candidateCommitSha: CANDIDATE_COMMIT,
      candidateManifestSha256: CANDIDATE_MANIFEST,
      rollbackCommitSha: HAOS_ROLLBACK_COMMIT_SHA,
      rollbackManifestSha256: HAOS_ROLLBACK_MANIFEST_SHA256,
      rollbackRuntimeSha256: HAOS_ROLLBACK_RUNTIME_SHA256
    });
  });

  test("reports all independent identity and preflight blockers", () => {
    const preflight = passingPreflight();
    preflight.deploymentEligible = false;
    preflight.reasons = ["soak_gate_blocked"];
    preflight.source.commitSha = "e".repeat(40);
    preflight.candidate.manifestSha256 = "f".repeat(64);

    const result = evaluateHaosCandidateDeploymentReadiness({
      preflight,
      expectedCandidateCommitSha: CANDIDATE_COMMIT,
      expectedCandidateManifestSha256: CANDIDATE_MANIFEST,
      rollbackManifestSha256: "1".repeat(64),
      installedRuntimeSha256: "2".repeat(64)
    });

    expect(result.deploymentEligible).toBe(false);
    expect(result.reasons).toEqual([
      "preflight_blocked",
      "candidate_commit_mismatch",
      "candidate_manifest_mismatch",
      "rollback_manifest_mismatch",
      "rollback_runtime_mismatch"
    ]);
  });

  test("rejects malformed expected identities", () => {
    expect(() =>
      evaluateHaosCandidateDeploymentReadiness({
        preflight: passingPreflight(),
        expectedCandidateCommitSha: "not-a-commit",
        expectedCandidateManifestSha256: CANDIDATE_MANIFEST,
        rollbackManifestSha256: HAOS_ROLLBACK_MANIFEST_SHA256,
        installedRuntimeSha256: HAOS_ROLLBACK_RUNTIME_SHA256
      })
    ).toThrowError("haos_candidate_deploy_input_invalid");
  });
});

describe("HAOS deployment command construction", () => {
  test("reads only the pinned runtime file from the installed container", () => {
    expect(buildHaosRuntimeHashRemoteCommand(100, "local_smartthings_web_bridge")).toBe(
      `qm guest exec 100 -- docker exec app_local_smartthings_web_bridge sha256sum ${HAOS_ROLLBACK_RUNTIME_PATH}`
    );
    expect(() =>
      buildHaosRuntimeHashRemoteCommand(100, "local_smartthings_web_bridge;reboot")
    ).toThrowError("haos_candidate_deploy_command_invalid");
  });

  test("parses the exact allowlisted runtime hash response", () => {
    expect(
      parseHaosRuntimeHashGuestResponse(
        guestResponse(`${HAOS_ROLLBACK_RUNTIME_SHA256}  ${HAOS_ROLLBACK_RUNTIME_PATH}\n`)
      )
    ).toBe(HAOS_ROLLBACK_RUNTIME_SHA256);
    expect(() =>
      parseHaosRuntimeHashGuestResponse(
        guestResponse(`${HAOS_ROLLBACK_RUNTIME_SHA256}  /data/secret\n`)
      )
    ).toThrowError("haos_candidate_deploy_runtime_hash_invalid");
  });

  test("verifies the exact candidate package manifest inside the running container", () => {
    expect(
      buildHaosCandidateManifestHashRemoteCommand(100, "local_smartthings_web_bridge")
    ).toBe(
      `qm guest exec 100 -- docker exec app_local_smartthings_web_bridge sha256sum ${HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH}`
    );
    expect(
      parseHaosCandidateManifestHashGuestResponse(
        guestResponse(`${CANDIDATE_MANIFEST}  ${HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH}\n`)
      )
    ).toBe(CANDIDATE_MANIFEST);
    expect(() =>
      parseHaosCandidateManifestHashGuestResponse(
        guestResponse(`${CANDIDATE_MANIFEST}  /app/package.json\n`)
      )
    ).toThrowError("haos_candidate_deploy_manifest_hash_invalid");
  });

  test("copies the generated package manifest into the candidate image", () => {
    const dockerfile = readFileSync(
      resolve("addon/smartthings_web_bridge/Dockerfile"),
      "utf8"
    );

    expect(dockerfile).toContain("COPY addon-package-manifest.json ./");
  });

  test("creates bounded candidate, backup, and exact add-on source paths", () => {
    const layout = createHaosDeploymentRemoteLayout(CANDIDATE_COMMIT, CANDIDATE_MANIFEST);

    expect(layout.deploymentId).toBe("aaaaaaaaaaaa-bbbbbbbbbbbb");
    expect(layout.temporaryRoot).toBe(
      "/tmp/ha-smartthings-web-bridge-aaaaaaaaaaaa-bbbbbbbbbbbb"
    );
    expect(layout.addonSource).toBe(
      "/mnt/data/supervisor/apps/local/smartthings_web_bridge"
    );
    expect(layout.backupRoot).toBe(
      "/mnt/data/supervisor/backup/ha-smartthings-web-bridge/aaaaaaaaaaaa-bbbbbbbbbbbb"
    );
  });

  test("stages both verified archives before the exact source activation", () => {
    const layout = createHaosDeploymentRemoteLayout(CANDIDATE_COMMIT, CANDIDATE_MANIFEST);
    const initialize = buildHaosInitializeRemoteScript(layout);
    const upload = buildHaosArchiveUploadRemoteCommand(100, layout.candidateArchive);
    const prepare = buildHaosPrepareRemoteScript(layout, {
      candidateCommitSha: CANDIDATE_COMMIT,
      candidateArchiveSha256: CANDIDATE_ARCHIVE,
      candidateManifestSha256: CANDIDATE_MANIFEST,
      candidateVersion: "0.1.26",
      rollbackArchiveSha256: ROLLBACK_ARCHIVE
    });
    const activate = buildHaosActivateRemoteScript(layout);

    expect(initialize).toContain(`rm -rf '${layout.temporaryRoot}'`);
    expect(upload).toContain("--pass-stdin 1");
    expect(upload).toContain("cat >");
    expect(upload).toContain(layout.candidateArchive);
    expect(prepare).toContain(CANDIDATE_ARCHIVE);
    expect(prepare).toContain(CANDIDATE_MANIFEST);
    expect(prepare).toContain(ROLLBACK_ARCHIVE);
    expect(prepare).toContain(HAOS_ROLLBACK_COMMIT_SHA);
    expect(prepare).toContain(layout.durableRollbackArchive);
    expect(prepare).not.toContain(`rm -rf '${layout.addonSource}'`);
    expect(activate).toContain(`rm -rf '${layout.addonSource}'`);
    expect(activate).toContain(`mv '${layout.candidateSource}' '${layout.addonSource}'`);
    expect(activate).not.toContain("/mnt/data/supervisor/apps/local';");
  });

  test("rejects a package identity that does not belong to the remote layout", () => {
    const layout = createHaosDeploymentRemoteLayout(CANDIDATE_COMMIT, CANDIDATE_MANIFEST);

    expect(() =>
      buildHaosPrepareRemoteScript(layout, {
        candidateCommitSha: "9".repeat(40),
        candidateArchiveSha256: CANDIDATE_ARCHIVE,
        candidateManifestSha256: CANDIDATE_MANIFEST,
        candidateVersion: "0.1.26",
        rollbackArchiveSha256: ROLLBACK_ARCHIVE
      })
    ).toThrowError("haos_candidate_deploy_layout_invalid");
  });

  test("restores the pinned rollback package to only the exact add-on source", () => {
    const layout = createHaosDeploymentRemoteLayout(CANDIDATE_COMMIT, CANDIDATE_MANIFEST);
    const rollback = buildHaosRollbackSourceRemoteScript(layout, ROLLBACK_ARCHIVE);
    const cleanup = buildHaosCleanupRemoteScript(layout);

    expect(rollback).toContain(ROLLBACK_ARCHIVE);
    expect(rollback).toContain(HAOS_ROLLBACK_MANIFEST_SHA256);
    expect(rollback).toContain(HAOS_ROLLBACK_VERSION.replace(/\./gu, "\\."));
    expect(rollback).not.toContain("0\\.1\\.25");
    expect(rollback).toContain(`rm -rf '${layout.addonSource}'`);
    expect(rollback).toContain(`mv '${layout.rollbackSource}' '${layout.addonSource}'`);
    expect(cleanup).toContain(`rm -rf '${layout.temporaryRoot}'`);
    expect(cleanup).toContain(`rm -rf '${layout.candidateSource}'`);
    expect(cleanup).toContain(`rm -rf '${layout.rollbackSource}'`);
  });

  test("builds fixed rebuild and privacy-safe health commands", () => {
    const rebuild = buildHaosAddonRebuildRemoteScript("local_smartthings_web_bridge");
    const health = buildHaosHealthRemoteScript("local_smartthings_web_bridge");

    expect(rebuild).toContain(
      "ha apps rebuild local_smartthings_web_bridge --force >/dev/null 2>&1"
    );
    expect(health).toContain("/health/live");
    expect(health).toContain("/health/ready");
    expect(health).toContain("-o /dev/null");
    expect(() => buildHaosAddonRebuildRemoteScript("bad;reboot")).toThrowError(
      "haos_candidate_deploy_command_invalid"
    );
    expect(() => buildHaosHealthRemoteScript("bad;reboot")).toThrowError(
      "haos_candidate_deploy_command_invalid"
    );
  });

  test("bounds guest shell execution time and script size", () => {
    expect(buildHaosGuestShellRemoteCommand(100, "printf ok", 60)).toBe(
      "qm guest exec 100 --timeout 60 -- sh -c 'printf ok'"
    );
    expect(() => buildHaosGuestShellRemoteCommand(100, "printf ok", 7_201)).toThrowError(
      "haos_candidate_deploy_command_invalid"
    );
    expect(() => buildHaosArchiveUploadRemoteCommand(100, "/tmp/other/file.tgz")).toThrowError(
      "haos_candidate_deploy_layout_invalid"
    );
  });
});

describe("HAOS deployment postflight", () => {
  test("accepts only a started, local, confined ingress app at the expected version", () => {
    expect(deployedAppMatches(installedApp(), "0.1.26", "local_smartthings_web_bridge")).toBe(
      true
    );

    for (const changed of [
      { version: "0.1.29" },
      { state: "stopped" },
      { boot: "manual" },
      { repository: "official" },
      { build: false },
      { apparmor: "disabled" },
      { ingress: false }
    ]) {
      expect(
        deployedAppMatches(
          { ...installedApp(), ...changed },
          "0.1.26",
          "local_smartthings_web_bridge"
        )
      ).toBe(false);
    }
  });
});

function passingPreflight(): HaosCandidatePreflightResult {
  return {
    schemaVersion: 1,
    deploymentEligible: true,
    reasons: [],
    soak: {
      evidenceState: "eligible",
      reasons: [],
      sampleCount: 865,
      successfulSampleCount: 865,
      errorSampleCount: 0,
      summarySha256: "3".repeat(64)
    },
    source: {
      clean: true,
      onMain: true,
      published: true,
      commitSha: CANDIDATE_COMMIT
    },
    candidate: {
      version: "0.1.30",
      fileCount: 71,
      manifestSha256: CANDIDATE_MANIFEST
    },
    installed: {
      slug: "local_smartthings_web_bridge",
      version: "0.1.29",
      versionLatest: "0.1.29",
      state: "started",
      boot: "auto",
      localBuild: true,
      apparmorEnforced: true,
      ingressEnabled: true,
      updateAvailable: false
    },
    checks: {
      soakGatePassed: true,
      sourceClean: true,
      sourceOnMain: true,
      sourcePublished: true,
      candidateVersionExpected: true,
      candidateVersionNewer: true,
      installedSlugExpected: true,
      installedVersionExpected: true,
      installedStarted: true,
      installedBootAuto: true,
      installedLocalBuild: true,
      installedApparmorEnforced: true,
      installedIngressEnabled: true
    }
  };
}

function installedApp(): HaosAppInfo {
  return {
    slug: "local_smartthings_web_bridge",
    version: "0.1.26",
    versionLatest: "0.1.26",
    state: "started",
    boot: "auto",
    repository: "local",
    build: true,
    apparmor: "profile",
    ingress: true,
    updateAvailable: false
  };
}

function guestResponse(output: string): string {
  return JSON.stringify({
    exitcode: 0,
    exited: 1,
    "out-data": output,
    "out-truncated": 0
  });
}
