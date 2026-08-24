import type { HaosAppInfo, HaosCandidatePreflightResult } from "./haos-candidate-preflight-core.js";
import { parseGuestExecText } from "./haos-runtime-api-audit-core.js";

export const HAOS_ROLLBACK_COMMIT_SHA = "5edd0e1eca1ea091a14fb43a0fbdd48ea1a17814";
export const HAOS_ROLLBACK_VERSION = "0.1.25";
export const HAOS_ROLLBACK_MANIFEST_SHA256 =
  "123ed81ee12c0615a1a1948dd333597f762897289bb0da2b4678e849439de699";
export const HAOS_ROLLBACK_RUNTIME_PATH =
  "/app/dist/bridge/src/inspector/protocol-analyzer.js";
export const HAOS_ROLLBACK_RUNTIME_SHA256 =
  "e64b9edcf9be251beabd97607a5dccd5af13a6e2bc00adebeb22be421af66067";
export const HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH = "/app/addon-package-manifest.json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;
const SAFE_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,120}$/u;

export type HaosCandidateDeploymentReason =
  | "preflight_blocked"
  | "candidate_commit_mismatch"
  | "candidate_manifest_mismatch"
  | "rollback_manifest_mismatch"
  | "rollback_runtime_mismatch";

export interface HaosCandidateDeploymentReadinessInput {
  preflight: HaosCandidatePreflightResult;
  expectedCandidateCommitSha: string;
  expectedCandidateManifestSha256: string;
  rollbackManifestSha256: string;
  installedRuntimeSha256: string;
}

export interface HaosCandidateDeploymentReadiness {
  schemaVersion: 1;
  deploymentEligible: boolean;
  reasons: HaosCandidateDeploymentReason[];
  preflight: HaosCandidatePreflightResult;
  identity: {
    candidateCommitSha: string;
    candidateManifestSha256: string;
    rollbackCommitSha: string;
    rollbackManifestSha256: string;
    rollbackRuntimeSha256: string;
  };
  checks: {
    preflightPassed: boolean;
    candidateCommitMatches: boolean;
    candidateManifestMatches: boolean;
    rollbackManifestMatches: boolean;
    installedRuntimeMatchesRollback: boolean;
  };
}

export interface HaosDeploymentRemoteLayout {
  deploymentId: string;
  temporaryRoot: string;
  candidateArchive: string;
  rollbackUploadArchive: string;
  candidateSource: string;
  rollbackSource: string;
  addonSource: string;
  backupRoot: string;
  durableRollbackArchive: string;
  previousSourceArchive: string;
  identityFile: string;
}

export interface HaosDeploymentArchiveIdentity {
  candidateCommitSha: string;
  candidateArchiveSha256: string;
  candidateManifestSha256: string;
  candidateVersion: string;
  rollbackArchiveSha256: string;
}

export function evaluateHaosCandidateDeploymentReadiness(
  input: HaosCandidateDeploymentReadinessInput
): HaosCandidateDeploymentReadiness {
  requireCommit(input.expectedCandidateCommitSha);
  requireSha256(input.expectedCandidateManifestSha256);
  requireSha256(input.rollbackManifestSha256);
  requireSha256(input.installedRuntimeSha256);

  const checks = {
    preflightPassed: input.preflight.deploymentEligible,
    candidateCommitMatches:
      input.preflight.source.commitSha === input.expectedCandidateCommitSha,
    candidateManifestMatches:
      input.preflight.candidate.manifestSha256 === input.expectedCandidateManifestSha256,
    rollbackManifestMatches:
      input.rollbackManifestSha256 === HAOS_ROLLBACK_MANIFEST_SHA256,
    installedRuntimeMatchesRollback:
      input.installedRuntimeSha256 === HAOS_ROLLBACK_RUNTIME_SHA256
  };
  const reasons: HaosCandidateDeploymentReason[] = [];
  addReason(reasons, checks.preflightPassed, "preflight_blocked");
  addReason(reasons, checks.candidateCommitMatches, "candidate_commit_mismatch");
  addReason(reasons, checks.candidateManifestMatches, "candidate_manifest_mismatch");
  addReason(reasons, checks.rollbackManifestMatches, "rollback_manifest_mismatch");
  addReason(reasons, checks.installedRuntimeMatchesRollback, "rollback_runtime_mismatch");

  return {
    schemaVersion: 1,
    deploymentEligible: reasons.length === 0,
    reasons,
    preflight: input.preflight,
    identity: {
      candidateCommitSha: input.preflight.source.commitSha,
      candidateManifestSha256: input.preflight.candidate.manifestSha256,
      rollbackCommitSha: HAOS_ROLLBACK_COMMIT_SHA,
      rollbackManifestSha256: input.rollbackManifestSha256,
      rollbackRuntimeSha256: input.installedRuntimeSha256
    },
    checks
  };
}

export function createHaosDeploymentRemoteLayout(
  candidateCommitSha: string,
  candidateManifestSha256: string
): HaosDeploymentRemoteLayout {
  requireCommit(candidateCommitSha);
  requireSha256(candidateManifestSha256);
  const deploymentId = `${candidateCommitSha.slice(0, 12)}-${candidateManifestSha256.slice(0, 12)}`;
  const temporaryRoot = `/tmp/ha-smartthings-web-bridge-${deploymentId}`;
  const backupRoot =
    `/mnt/data/supervisor/backup/ha-smartthings-web-bridge/${deploymentId}`;
  return {
    deploymentId,
    temporaryRoot,
    candidateArchive: `${temporaryRoot}/candidate.tgz`,
    rollbackUploadArchive: `${temporaryRoot}/rollback.tgz`,
    candidateSource: `${backupRoot}/candidate-source`,
    rollbackSource: `${backupRoot}/rollback-source`,
    addonSource: "/mnt/data/supervisor/addons/local/smartthings_web_bridge",
    backupRoot,
    durableRollbackArchive:
      `${backupRoot}/rollback-${HAOS_ROLLBACK_COMMIT_SHA}.tgz`,
    previousSourceArchive: `${backupRoot}/source-before-deploy.tar`,
    identityFile: `${backupRoot}/deployment-identity.txt`
  };
}

export function buildHaosRuntimeHashRemoteCommand(vmId: number, addonSlug: string): string {
  requireVmAndSlug(vmId, addonSlug);
  return `qm guest exec ${String(vmId)} -- docker exec app_${addonSlug} sha256sum ${HAOS_ROLLBACK_RUNTIME_PATH}`;
}

export function parseHaosRuntimeHashGuestResponse(raw: string): string {
  return parseHaosContainerFileHashGuestResponse(
    raw,
    HAOS_ROLLBACK_RUNTIME_PATH,
    "haos_candidate_deploy_runtime_hash_failed",
    "haos_candidate_deploy_runtime_hash_invalid"
  );
}

export function buildHaosCandidateManifestHashRemoteCommand(
  vmId: number,
  addonSlug: string
): string {
  requireVmAndSlug(vmId, addonSlug);
  return `qm guest exec ${String(vmId)} -- docker exec app_${addonSlug} sha256sum ${HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH}`;
}

export function parseHaosCandidateManifestHashGuestResponse(raw: string): string {
  return parseHaosContainerFileHashGuestResponse(
    raw,
    HAOS_CANDIDATE_MANIFEST_RUNTIME_PATH,
    "haos_candidate_deploy_manifest_hash_failed",
    "haos_candidate_deploy_manifest_hash_invalid"
  );
}

export function buildHaosGuestShellRemoteCommand(
  vmId: number,
  script: string,
  timeoutSeconds = 60
): string {
  if (
    !Number.isSafeInteger(vmId) ||
    vmId <= 0 ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > 7_200 ||
    script.length === 0 ||
    Buffer.byteLength(script, "utf8") > 32_768 ||
    script.includes("\0")
  ) {
    throw new Error("haos_candidate_deploy_command_invalid");
  }
  return `qm guest exec ${String(vmId)} --timeout ${String(timeoutSeconds)} -- sh -c ${shellQuote(script)}`;
}

export function buildHaosArchiveUploadRemoteCommand(vmId: number, remotePath: string): string {
  requireSafeAbsolutePath(remotePath, "/tmp/ha-smartthings-web-bridge-");
  return buildHaosGuestShellRemoteCommand(
    vmId,
    `umask 077; cat > ${shellQuote(remotePath)}`,
    120
  ).replace(" -- sh -c ", " --pass-stdin 1 -- sh -c ");
}

export function buildHaosInitializeRemoteScript(layout: HaosDeploymentRemoteLayout): string {
  validateLayout(layout);
  return [
    "set -eu",
    "umask 077",
    `rm -rf ${shellQuote(layout.temporaryRoot)}`,
    `mkdir -p ${shellQuote(layout.temporaryRoot)}`,
    "printf 'upload_ready\\n'"
  ].join("; ");
}

export function buildHaosPrepareRemoteScript(
  layout: HaosDeploymentRemoteLayout,
  identity: HaosDeploymentArchiveIdentity
): string {
  validateLayout(layout);
  validateArchiveIdentity(identity);
  if (
    layout.deploymentId !==
    `${identity.candidateCommitSha.slice(0, 12)}-${identity.candidateManifestSha256.slice(0, 12)}`
  ) {
    throw new Error("haos_candidate_deploy_layout_invalid");
  }
  const candidateVersionPattern = identity.candidateVersion.replaceAll(".", "\\.");
  return [
    "set -eu",
    "umask 077",
    hashCheck(layout.candidateArchive, identity.candidateArchiveSha256),
    hashCheck(layout.rollbackUploadArchive, identity.rollbackArchiveSha256),
    `mkdir -p ${shellQuote(layout.backupRoot)}`,
    `rm -rf ${shellQuote(layout.candidateSource)}`,
    `mkdir -p ${shellQuote(layout.candidateSource)}`,
    `tar -xzf ${shellQuote(layout.candidateArchive)} -C ${shellQuote(layout.candidateSource)}`,
    hashCheck(
      `${layout.candidateSource}/addon-package-manifest.json`,
      identity.candidateManifestSha256
    ),
    `grep -Eq ${shellQuote(`^version:[[:space:]]*\"?${candidateVersionPattern}\"?[[:space:]]*$`)} ${shellQuote(`${layout.candidateSource}/config.yaml`)}`,
    `if [ -d ${shellQuote(layout.addonSource)} ]; then tar -cf ${shellQuote(`${layout.previousSourceArchive}.tmp`)} -C ${shellQuote(layout.addonSource)} .; mv ${shellQuote(`${layout.previousSourceArchive}.tmp`)} ${shellQuote(layout.previousSourceArchive)}; fi`,
    `cp ${shellQuote(layout.rollbackUploadArchive)} ${shellQuote(`${layout.durableRollbackArchive}.tmp`)}`,
    hashCheck(`${layout.durableRollbackArchive}.tmp`, identity.rollbackArchiveSha256),
    `mv ${shellQuote(`${layout.durableRollbackArchive}.tmp`)} ${shellQuote(layout.durableRollbackArchive)}`,
    `printf '%s\\n' ${shellQuote("schema_version=1")} ${shellQuote(`candidate_commit=${identity.candidateCommitSha}`)} ${shellQuote(`candidate_manifest=${identity.candidateManifestSha256}`)} ${shellQuote(`rollback_commit=${HAOS_ROLLBACK_COMMIT_SHA}`)} ${shellQuote(`rollback_manifest=${HAOS_ROLLBACK_MANIFEST_SHA256}`)} ${shellQuote(`rollback_archive=${identity.rollbackArchiveSha256}`)} > ${shellQuote(`${layout.identityFile}.tmp`)}`,
    `mv ${shellQuote(`${layout.identityFile}.tmp`)} ${shellQuote(layout.identityFile)}`,
    "printf 'stage_ready\\n'"
  ].join("; ");
}

export function buildHaosActivateRemoteScript(layout: HaosDeploymentRemoteLayout): string {
  validateLayout(layout);
  return [
    "set -eu",
    `test -f ${shellQuote(`${layout.candidateSource}/addon-package-manifest.json`)}`,
    `rm -rf ${shellQuote(layout.addonSource)}`,
    `mv ${shellQuote(layout.candidateSource)} ${shellQuote(layout.addonSource)}`,
    "printf 'source_activated\\n'"
  ].join("; ");
}

export function buildHaosRollbackSourceRemoteScript(
  layout: HaosDeploymentRemoteLayout,
  rollbackArchiveSha256: string
): string {
  validateLayout(layout);
  requireSha256(rollbackArchiveSha256);
  return [
    "set -eu",
    "umask 077",
    hashCheck(layout.durableRollbackArchive, rollbackArchiveSha256),
    `rm -rf ${shellQuote(layout.rollbackSource)}`,
    `mkdir -p ${shellQuote(layout.rollbackSource)}`,
    `tar -xzf ${shellQuote(layout.durableRollbackArchive)} -C ${shellQuote(layout.rollbackSource)}`,
    hashCheck(
      `${layout.rollbackSource}/addon-package-manifest.json`,
      HAOS_ROLLBACK_MANIFEST_SHA256
    ),
    `grep -Eq ${shellQuote("^version:[[:space:]]*\"?0\\.1\\.25\"?[[:space:]]*$")} ${shellQuote(`${layout.rollbackSource}/config.yaml`)}`,
    `rm -rf ${shellQuote(layout.addonSource)}`,
    `mv ${shellQuote(layout.rollbackSource)} ${shellQuote(layout.addonSource)}`,
    "printf 'rollback_source_restored\\n'"
  ].join("; ");
}

export function buildHaosSupervisorReloadRemoteScript(): string {
  return "set -eu; ha store reload >/dev/null; printf 'supervisor_reloaded\\n'";
}

export function buildHaosAddonRebuildRemoteScript(addonSlug: string): string {
  if (!SAFE_SLUG_PATTERN.test(addonSlug)) {
    throw new Error("haos_candidate_deploy_command_invalid");
  }
  return `set -eu; ha apps rebuild ${addonSlug} --force >/dev/null 2>&1; printf 'addon_rebuilt\\n'`;
}

export function buildHaosHealthRemoteScript(
  addonSlug: string,
  requireReady = true
): string {
  if (!SAFE_SLUG_PATTERN.test(addonSlug)) {
    throw new Error("haos_candidate_deploy_command_invalid");
  }
  const container = `app_${addonSlug}`;
  return [
    "set -eu",
    `docker exec ${container} curl -fsS -o /dev/null http://127.0.0.1:8098/health/live`,
    ...(requireReady
      ? [`docker exec ${container} curl -fsS -o /dev/null http://127.0.0.1:8098/health/ready`]
      : []),
    "printf 'health_ready\\n'"
  ].join("; ");
}

export function buildHaosCleanupRemoteScript(layout: HaosDeploymentRemoteLayout): string {
  validateLayout(layout);
  return [
    "set -eu",
    `rm -rf ${shellQuote(layout.temporaryRoot)}`,
    `rm -rf ${shellQuote(layout.candidateSource)}`,
    `rm -rf ${shellQuote(layout.rollbackSource)}`,
    "printf 'temporary_files_removed\\n'"
  ].join("; ");
}

export function deployedAppMatches(
  installed: HaosAppInfo,
  expectedVersion: string,
  expectedSlug: string
): boolean {
  requireVersion(expectedVersion);
  if (!SAFE_SLUG_PATTERN.test(expectedSlug)) {
    throw new Error("haos_candidate_deploy_input_invalid");
  }
  return (
    installed.slug === expectedSlug &&
    installed.version === expectedVersion &&
    installed.state === "started" &&
    installed.boot === "auto" &&
    installed.repository === "local" &&
    installed.build &&
    installed.apparmor === "profile" &&
    installed.ingress
  );
}

function validateArchiveIdentity(identity: HaosDeploymentArchiveIdentity): void {
  requireCommit(identity.candidateCommitSha);
  requireSha256(identity.candidateArchiveSha256);
  requireSha256(identity.candidateManifestSha256);
  requireVersion(identity.candidateVersion);
  requireSha256(identity.rollbackArchiveSha256);
}

function validateLayout(layout: HaosDeploymentRemoteLayout): void {
  if (!/^[a-f0-9]{12}-[a-f0-9]{12}$/u.test(layout.deploymentId)) {
    throw new Error("haos_candidate_deploy_layout_invalid");
  }
  requireSafeAbsolutePath(layout.temporaryRoot, "/tmp/ha-smartthings-web-bridge-");
  for (const path of [layout.candidateArchive, layout.rollbackUploadArchive]) {
    requireChildPath(layout.temporaryRoot, path);
  }
  requireSafeAbsolutePath(
    layout.backupRoot,
    "/mnt/data/supervisor/backup/ha-smartthings-web-bridge/"
  );
  for (const path of [
    layout.candidateSource,
    layout.rollbackSource,
    layout.durableRollbackArchive,
    layout.previousSourceArchive,
    layout.identityFile
  ]) {
    requireChildPath(layout.backupRoot, path);
  }
  if (layout.addonSource !== "/mnt/data/supervisor/addons/local/smartthings_web_bridge") {
    throw new Error("haos_candidate_deploy_layout_invalid");
  }
}

function requireChildPath(parent: string, path: string): void {
  if (!path.startsWith(`${parent}/`) || path.includes("..")) {
    throw new Error("haos_candidate_deploy_layout_invalid");
  }
}

function requireSafeAbsolutePath(path: string, prefix: string): void {
  if (!path.startsWith(prefix) || !/^\/[A-Za-z0-9._/-]{1,512}$/u.test(path) || path.includes("..")) {
    throw new Error("haos_candidate_deploy_layout_invalid");
  }
}

function hashCheck(path: string, expectedSha256: string): string {
  requireSha256(expectedSha256);
  return `test \"$(sha256sum ${shellQuote(path)} | cut -c1-64)\" = ${shellQuote(expectedSha256)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function requireVmAndSlug(vmId: number, addonSlug: string): void {
  if (!Number.isSafeInteger(vmId) || vmId <= 0 || !SAFE_SLUG_PATTERN.test(addonSlug)) {
    throw new Error("haos_candidate_deploy_command_invalid");
  }
}

function parseHaosContainerFileHashGuestResponse(
  raw: string,
  expectedPath: string,
  commandFailure: string,
  responseFailure: string
): string {
  const output = parseGuestExecText(raw, commandFailure, responseFailure).trim();
  const match = /^([a-f0-9]{64})\s+(\/[^\s]+)$/u.exec(output);
  if (!match?.[1] || match[2] !== expectedPath) {
    throw new Error(responseFailure);
  }
  return match[1];
}

function requireSha256(value: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error("haos_candidate_deploy_input_invalid");
  }
}

function requireCommit(value: string): void {
  if (!COMMIT_PATTERN.test(value)) {
    throw new Error("haos_candidate_deploy_input_invalid");
  }
}

function requireVersion(value: string): void {
  if (!VERSION_PATTERN.test(value)) {
    throw new Error("haos_candidate_deploy_input_invalid");
  }
}

function addReason(
  reasons: HaosCandidateDeploymentReason[],
  passed: boolean,
  reason: HaosCandidateDeploymentReason
): void {
  if (!passed) {
    reasons.push(reason);
  }
}
