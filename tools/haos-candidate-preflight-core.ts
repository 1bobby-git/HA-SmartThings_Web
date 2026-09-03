import type { SoakDeploymentGateReason, SoakDeploymentGateResult } from "./haos-soak-deployment-gate-core.js";
import { parseGuestExecText } from "./haos-runtime-api-audit-core.js";

const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/u;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,120}$/u;

export type HaosCandidatePreflightReason =
  | "soak_gate_blocked"
  | "source_not_clean"
  | "source_not_main"
  | "source_not_published"
  | "candidate_version_mismatch"
  | "candidate_version_not_newer"
  | "installed_slug_mismatch"
  | "installed_version_mismatch"
  | "installed_not_started"
  | "installed_not_boot_auto"
  | "installed_not_local_build"
  | "installed_apparmor_missing"
  | "installed_ingress_disabled";

export interface HaosAppInfo {
  slug: string;
  version: string;
  versionLatest: string;
  state: string;
  boot: string;
  repository: string;
  build: boolean;
  apparmor: string;
  ingress: boolean;
  updateAvailable: boolean;
}

export interface CandidateSourceState {
  clean: boolean;
  onMain: boolean;
  published: boolean;
  commitSha: string;
}

export interface CandidatePackageState {
  version: string;
  fileCount: number;
  manifestSha256: string;
}

export interface HaosCandidatePreflightInput {
  soakGate: SoakDeploymentGateResult;
  source: CandidateSourceState;
  candidate: CandidatePackageState;
  installed: HaosAppInfo;
  expectedInstalledVersion: string;
  expectedCandidateVersion: string;
  expectedAddonSlug: string;
}

export interface HaosCandidatePreflightResult {
  schemaVersion: 1;
  deploymentEligible: boolean;
  reasons: HaosCandidatePreflightReason[];
  soak: {
    evidenceState: SoakDeploymentGateResult["evidenceState"];
    reasons: SoakDeploymentGateReason[];
    sampleCount?: number;
    successfulSampleCount?: number;
    errorSampleCount?: number;
    summarySha256?: string;
  };
  source: {
    clean: boolean;
    onMain: boolean;
    published: boolean;
    commitSha: string;
  };
  candidate: CandidatePackageState;
  installed: {
    slug: string;
    version: string;
    versionLatest: string;
    state: string;
    boot: string;
    localBuild: boolean;
    apparmorEnforced: boolean;
    ingressEnabled: boolean;
    updateAvailable: boolean;
  };
  checks: {
    soakGatePassed: boolean;
    sourceClean: boolean;
    sourceOnMain: boolean;
    sourcePublished: boolean;
    candidateVersionExpected: boolean;
    candidateVersionNewer: boolean;
    installedSlugExpected: boolean;
    installedVersionExpected: boolean;
    installedStarted: boolean;
    installedBootAuto: boolean;
    installedLocalBuild: boolean;
    installedApparmorEnforced: boolean;
    installedIngressEnabled: boolean;
  };
}

export function buildHaosAppInfoRemoteCommand(vmId: number, addonSlug: string): string {
  if (!Number.isSafeInteger(vmId) || vmId <= 0 || !SAFE_TOKEN_PATTERN.test(addonSlug)) {
    throw new Error("haos_candidate_preflight_command_invalid");
  }
  return `qm guest exec ${String(vmId)} -- ha apps info ${addonSlug} --raw-json`;
}

export function parseHaosAppInfoGuestResponse(raw: string): HaosAppInfo {
  const output = parseGuestExecText(
    raw,
    "haos_candidate_preflight_command_failed",
    "haos_candidate_preflight_response_invalid"
  );
  try {
    const envelope = requireRecord(JSON.parse(output) as unknown);
    if (envelope.result !== "ok") {
      throw new Error("invalid result");
    }
    const data = requireRecord(envelope.data);
    return {
      slug: safeToken(data.slug),
      version: safeVersion(data.version),
      versionLatest: safeVersion(data.version_latest),
      state: safeToken(data.state),
      boot: safeToken(data.boot),
      repository: safeToken(data.repository),
      build: safeBoolean(data.build),
      apparmor: safeToken(data.apparmor),
      ingress: safeBoolean(data.ingress),
      updateAvailable: safeBoolean(data.update_available)
    };
  } catch {
    throw new Error("haos_candidate_preflight_response_invalid");
  }
}

export function evaluateHaosCandidatePreflight(
  input: HaosCandidatePreflightInput
): HaosCandidatePreflightResult {
  validateInput(input);
  const checks = {
    soakGatePassed: input.soakGate.deploymentEligible,
    sourceClean: input.source.clean,
    sourceOnMain: input.source.onMain,
    sourcePublished: input.source.published,
    candidateVersionExpected: input.candidate.version === input.expectedCandidateVersion,
    candidateVersionNewer:
      compareVersions(input.candidate.version, input.installed.version) > 0,
    installedSlugExpected: input.installed.slug === input.expectedAddonSlug,
    installedVersionExpected: input.installed.version === input.expectedInstalledVersion,
    installedStarted: input.installed.state === "started",
    installedBootAuto: input.installed.boot === "auto",
    installedLocalBuild: input.installed.repository === "local" && input.installed.build,
    installedApparmorEnforced: input.installed.apparmor === "profile",
    installedIngressEnabled: input.installed.ingress
  };
  const reasons: HaosCandidatePreflightReason[] = [];
  addReason(reasons, checks.soakGatePassed, "soak_gate_blocked");
  addReason(reasons, checks.sourceClean, "source_not_clean");
  addReason(reasons, checks.sourceOnMain, "source_not_main");
  addReason(reasons, checks.sourcePublished, "source_not_published");
  addReason(reasons, checks.candidateVersionExpected, "candidate_version_mismatch");
  addReason(reasons, checks.candidateVersionNewer, "candidate_version_not_newer");
  addReason(reasons, checks.installedSlugExpected, "installed_slug_mismatch");
  addReason(reasons, checks.installedVersionExpected, "installed_version_mismatch");
  addReason(reasons, checks.installedStarted, "installed_not_started");
  addReason(reasons, checks.installedBootAuto, "installed_not_boot_auto");
  addReason(reasons, checks.installedLocalBuild, "installed_not_local_build");
  addReason(reasons, checks.installedApparmorEnforced, "installed_apparmor_missing");
  addReason(reasons, checks.installedIngressEnabled, "installed_ingress_disabled");

  return {
    schemaVersion: 1,
    deploymentEligible: reasons.length === 0,
    reasons,
    soak: {
      evidenceState: input.soakGate.evidenceState,
      reasons: [...input.soakGate.reasons],
      ...(input.soakGate.sampleCount === undefined
        ? {}
        : { sampleCount: input.soakGate.sampleCount }),
      ...(input.soakGate.successfulSampleCount === undefined
        ? {}
        : { successfulSampleCount: input.soakGate.successfulSampleCount }),
      ...(input.soakGate.errorSampleCount === undefined
        ? {}
        : { errorSampleCount: input.soakGate.errorSampleCount }),
      ...(input.soakGate.summarySha256 === undefined
        ? {}
        : { summarySha256: input.soakGate.summarySha256 })
    },
    source: { ...input.source },
    candidate: { ...input.candidate },
    installed: {
      slug: input.installed.slug,
      version: input.installed.version,
      versionLatest: input.installed.versionLatest,
      state: input.installed.state,
      boot: input.installed.boot,
      localBuild: checks.installedLocalBuild,
      apparmorEnforced: checks.installedApparmorEnforced,
      ingressEnabled: input.installed.ingress,
      updateAvailable: input.installed.updateAvailable
    },
    checks
  };
}

function validateInput(input: HaosCandidatePreflightInput): void {
  for (const version of [
    input.candidate.version,
    input.installed.version,
    input.installed.versionLatest,
    input.expectedInstalledVersion,
    input.expectedCandidateVersion
  ]) {
    safeVersion(version);
  }
  if (
    !SAFE_TOKEN_PATTERN.test(input.expectedAddonSlug) ||
    !/^[a-f0-9]{40}$/u.test(input.source.commitSha) ||
    !Number.isSafeInteger(input.candidate.fileCount) ||
    input.candidate.fileCount <= 0 ||
    !/^[a-f0-9]{64}$/u.test(input.candidate.manifestSha256)
  ) {
    throw new Error("haos_candidate_preflight_input_invalid");
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(leftParts[index]) - Number(rightParts[index]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function addReason(
  reasons: HaosCandidatePreflightReason[],
  passed: boolean,
  reason: HaosCandidatePreflightReason
): void {
  if (!passed) {
    reasons.push(reason);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid record");
  }
  return value as Record<string, unknown>;
}

function safeToken(value: unknown): string {
  if (typeof value !== "string" || !SAFE_TOKEN_PATTERN.test(value)) {
    throw new Error("invalid token");
  }
  return value;
}

function safeVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error("invalid version");
  }
  return value;
}

function safeBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("invalid boolean");
  }
  return value;
}
