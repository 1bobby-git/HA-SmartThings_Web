import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

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
  buildHaosSupervisorReloadRemoteScript,
  createHaosDeploymentRemoteLayout,
  deployedAppMatches,
  evaluateHaosCandidateDeploymentReadiness,
  HAOS_ROLLBACK_COMMIT_SHA,
  HAOS_ROLLBACK_MANIFEST_SHA256,
  HAOS_ROLLBACK_RUNTIME_SHA256,
  HAOS_ROLLBACK_VERSION,
  parseHaosCandidateManifestHashGuestResponse,
  parseHaosRuntimeHashGuestResponse,
  type HaosCandidateDeploymentReadiness,
  type HaosDeploymentArchiveIdentity,
  type HaosDeploymentRemoteLayout
} from "./haos-candidate-deploy-core.js";
import {
  buildHaosAppInfoRemoteCommand,
  evaluateHaosCandidatePreflight,
  parseHaosAppInfoGuestResponse,
  type CandidateSourceState,
  type HaosAppInfo
} from "./haos-candidate-preflight-core.js";
import { parseGuestExecText } from "./haos-runtime-api-audit-core.js";
import { inspectSoakDeploymentGate } from "./haos-soak-deployment-gate-core.js";
import { packageAddon, type PackageAddonResult } from "./package-addon.js";

const COMMAND_TIMEOUT_MS = 60_000;
const REBUILD_TIMEOUT_SECONDS = 3_600;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;
const MAX_QGA_STDIN_BYTES = 1_000_000;
const HEALTH_ATTEMPTS = 30;
const HEALTH_RETRY_MS = 10_000;

interface CliOptions {
  execute: boolean;
  runDirectory: string;
  repositoryRoot: string;
  expectedInstalledVersion: string;
  expectedCandidateVersion: string;
  expectedCandidateCommitSha: string;
  expectedCandidateManifestSha256: string;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

interface DeploymentArchive {
  path: string;
  sha256: string;
  byteLength: number;
}

interface DeploymentBundle {
  candidate: PackageAddonResult & {
    version: string;
    archive: DeploymentArchive;
  };
  rollback: PackageAddonResult & {
    version: string;
    archive: DeploymentArchive;
  };
}

interface DeploymentResult {
  version: string;
  packageManifestSha256?: string;
  app: {
    slug: string;
    state: string;
    localBuild: boolean;
    apparmorEnforced: boolean;
    ingressEnabled: boolean;
  };
}

class SafeDeploymentError extends Error {
  constructor(
    message: string,
    readonly rolledBack = false
  ) {
    super(message);
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "stw-haos-candidate-deploy-"));
  try {
    const bundle = await createDeploymentBundle(options.repositoryRoot, workspaceRoot);
    const readiness = await inspectDeploymentReadiness(options, bundle);
    const layout = createHaosDeploymentRemoteLayout(
      options.expectedCandidateCommitSha,
      options.expectedCandidateManifestSha256
    );

    if (!options.execute || !readiness.deploymentEligible) {
      emitResult({
        event: "haos_candidate_deployment_preview",
        mode: options.execute ? "execute_blocked" : "preview",
        remoteMutationPerformed: false,
        ...publicReadiness(readiness, bundle, layout)
      });
      if (!readiness.deploymentEligible) {
        process.exitCode = 1;
      }
      return;
    }

    const deployed = await executeDeployment(options, bundle, layout);
    emitResult({
      event: "haos_candidate_deployment_succeeded",
      mode: "execute",
      remoteMutationPerformed: true,
      rolledBack: false,
      ...publicReadiness(readiness, bundle, layout),
      deployed
    });
  } finally {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
    } catch {
      // An owned local temp directory must not override the reported HAOS deployment state.
    }
  }
}

async function createDeploymentBundle(
  repositoryRoot: string,
  workspaceRoot: string
): Promise<DeploymentBundle> {
  const rollbackSource = resolve(workspaceRoot, "rollback-source");
  const gitArchive = resolve(workspaceRoot, "rollback-source.tar");
  await mkdir(rollbackSource, { recursive: true });
  const resolvedRollbackCommit = (
    await runLocal(
      "git",
      ["rev-parse", `${HAOS_ROLLBACK_COMMIT_SHA}^{commit}`],
      repositoryRoot,
      COMMAND_TIMEOUT_MS
    )
  ).trim();
  if (resolvedRollbackCommit !== HAOS_ROLLBACK_COMMIT_SHA) {
    throw new SafeDeploymentError("haos_candidate_deployment_rollback_commit_invalid");
  }
  await runLocal(
    "git",
    ["archive", "--format=tar", `--output=${gitArchive}`, HAOS_ROLLBACK_COMMIT_SHA],
    repositoryRoot,
    COMMAND_TIMEOUT_MS
  );
  await runLocal("tar", ["-xf", gitArchive, "-C", rollbackSource], repositoryRoot, COMMAND_TIMEOUT_MS);

  const [candidatePackage, rollbackPackage] = await Promise.all([
    packageAddon({
      repoRoot: repositoryRoot,
      outputRoot: resolve(workspaceRoot, "candidate-package")
    }),
    packageAddon({
      repoRoot: rollbackSource,
      outputRoot: resolve(workspaceRoot, "rollback-package")
    })
  ]);
  const [candidateVersion, rollbackVersion] = await Promise.all([
    readPackageVersion(candidatePackage.packageDir),
    readPackageVersion(rollbackPackage.packageDir)
  ]);
  if (
    rollbackVersion !== HAOS_ROLLBACK_VERSION ||
    rollbackPackage.manifestSha256 !== HAOS_ROLLBACK_MANIFEST_SHA256
  ) {
    throw new SafeDeploymentError("haos_candidate_deployment_rollback_package_invalid");
  }

  const [candidateArchive, rollbackArchive] = await Promise.all([
    createArchive(
      candidatePackage.packageDir,
      resolve(workspaceRoot, "candidate.tgz"),
      repositoryRoot
    ),
    createArchive(
      rollbackPackage.packageDir,
      resolve(workspaceRoot, "rollback.tgz"),
      repositoryRoot
    )
  ]);
  return {
    candidate: {
      ...candidatePackage,
      version: candidateVersion,
      archive: candidateArchive
    },
    rollback: {
      ...rollbackPackage,
      version: rollbackVersion,
      archive: rollbackArchive
    }
  };
}

async function createArchive(
  packageDirectory: string,
  archivePath: string,
  workingDirectory: string
): Promise<DeploymentArchive> {
  await runLocal(
    "tar",
    ["-czf", archivePath, "-C", packageDirectory, "."],
    workingDirectory,
    COMMAND_TIMEOUT_MS
  );
  const archiveStats = await stat(archivePath);
  if (!archiveStats.isFile() || archiveStats.size <= 0 || archiveStats.size > MAX_QGA_STDIN_BYTES) {
    throw new SafeDeploymentError("haos_candidate_deployment_archive_size_invalid");
  }
  return {
    path: archivePath,
    sha256: await sha256File(archivePath),
    byteLength: archiveStats.size
  };
}

async function inspectDeploymentReadiness(
  options: CliOptions,
  bundle: DeploymentBundle
): Promise<HaosCandidateDeploymentReadiness> {
  const [soakGate, source, installed, installedRuntimeSha256] = await Promise.all([
    inspectSoakDeploymentGate({
      runDirectory: options.runDirectory,
      repositoryRoot: options.repositoryRoot
    }),
    readSourceState(options.repositoryRoot),
    readInstalledAppInfo(options),
    readInstalledRuntimeSha256(options)
  ]);
  const preflight = evaluateHaosCandidatePreflight({
    soakGate,
    source,
    candidate: {
      version: bundle.candidate.version,
      fileCount: bundle.candidate.files.length,
      manifestSha256: bundle.candidate.manifestSha256
    },
    installed,
    expectedInstalledVersion: options.expectedInstalledVersion,
    expectedCandidateVersion: options.expectedCandidateVersion,
    expectedAddonSlug: options.addonSlug
  });
  return evaluateHaosCandidateDeploymentReadiness({
    preflight,
    expectedCandidateCommitSha: options.expectedCandidateCommitSha,
    expectedCandidateManifestSha256: options.expectedCandidateManifestSha256,
    rollbackManifestSha256: bundle.rollback.manifestSha256,
    installedRuntimeSha256
  });
}

async function executeDeployment(
  options: CliOptions,
  bundle: DeploymentBundle,
  layout: HaosDeploymentRemoteLayout
): Promise<DeploymentResult> {
  const archiveIdentity: HaosDeploymentArchiveIdentity = {
    candidateCommitSha: options.expectedCandidateCommitSha,
    candidateArchiveSha256: bundle.candidate.archive.sha256,
    candidateManifestSha256: bundle.candidate.manifestSha256,
    candidateVersion: bundle.candidate.version,
    rollbackArchiveSha256: bundle.rollback.archive.sha256
  };

  await runGuestMarker(
    options,
    buildHaosInitializeRemoteScript(layout),
    "upload_ready",
    60
  );
  await uploadArchive(options, bundle.candidate.archive.path, layout.candidateArchive);
  await uploadArchive(options, bundle.rollback.archive.path, layout.rollbackUploadArchive);
  await runGuestMarker(
    options,
    buildHaosPrepareRemoteScript(layout, archiveIdentity),
    "stage_ready",
    300
  );

  const finalReadiness = await inspectDeploymentReadiness(options, bundle);
  if (!finalReadiness.deploymentEligible) {
    await bestEffortCleanup(options, layout);
    throw new SafeDeploymentError("haos_candidate_deployment_preflight_changed");
  }

  try {
    await runGuestMarker(
      options,
      buildHaosActivateRemoteScript(layout),
      "source_activated",
      120
    );
    await reloadAndRebuild(options);
    const deployed = await verifyInstalledVersion(
      options,
      options.expectedCandidateVersion,
      bundle.candidate.manifestSha256
    );
    await bestEffortCleanup(options, layout);
    return deployed;
  } catch {
    try {
      await restoreRollback(options, bundle, layout);
      await bestEffortCleanup(options, layout);
    } catch {
      throw new SafeDeploymentError("haos_candidate_deployment_rollback_failed");
    }
    throw new SafeDeploymentError("haos_candidate_deployment_failed_rolled_back", true);
  }
}

async function restoreRollback(
  options: CliOptions,
  bundle: DeploymentBundle,
  layout: HaosDeploymentRemoteLayout
): Promise<void> {
  await runGuestMarker(
    options,
    buildHaosRollbackSourceRemoteScript(layout, bundle.rollback.archive.sha256),
    "rollback_source_restored",
    300
  );
  await reloadAndRebuild(options);
  await verifyInstalledVersion(options, HAOS_ROLLBACK_VERSION);
  const runtimeSha256 = await readInstalledRuntimeSha256(options);
  if (runtimeSha256 !== HAOS_ROLLBACK_RUNTIME_SHA256) {
    throw new SafeDeploymentError("haos_candidate_deployment_rollback_runtime_invalid");
  }
}

async function reloadAndRebuild(options: CliOptions): Promise<void> {
  await runGuestMarker(
    options,
    buildHaosSupervisorReloadRemoteScript(),
    "supervisor_reloaded",
    300
  );
  await runGuestMarker(
    options,
    buildHaosAddonRebuildRemoteScript(options.addonSlug),
    "addon_rebuilt",
    REBUILD_TIMEOUT_SECONDS
  );
}

async function verifyInstalledVersion(
  options: CliOptions,
  expectedVersion: string,
  expectedManifestSha256?: string
): Promise<DeploymentResult> {
  await waitForHealth(options);
  const installed = await readInstalledAppInfo(options);
  if (!deployedAppMatches(installed, expectedVersion, options.addonSlug)) {
    throw new SafeDeploymentError("haos_candidate_deployment_postflight_invalid");
  }
  if (expectedManifestSha256 !== undefined) {
    const installedManifestSha256 = await readInstalledCandidateManifestSha256(options);
    if (installedManifestSha256 !== expectedManifestSha256) {
      throw new SafeDeploymentError("haos_candidate_deployment_runtime_identity_invalid");
    }
    return safeDeploymentResult(installed, installedManifestSha256);
  }
  return safeDeploymentResult(installed);
}

async function waitForHealth(options: CliOptions): Promise<void> {
  for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
    try {
      await runGuestMarker(
        options,
        buildHaosHealthRemoteScript(options.addonSlug),
        "health_ready",
        30
      );
      return;
    } catch {
      if (attempt === HEALTH_ATTEMPTS) {
        break;
      }
      await sleep(HEALTH_RETRY_MS);
    }
  }
  throw new SafeDeploymentError("haos_candidate_deployment_health_timeout");
}

async function bestEffortCleanup(
  options: CliOptions,
  layout: HaosDeploymentRemoteLayout
): Promise<void> {
  try {
    await runGuestMarker(
      options,
      buildHaosCleanupRemoteScript(layout),
      "temporary_files_removed",
      60
    );
  } catch {
    // Cleanup is bounded to the generated temporary directory and must not mask deployment state.
  }
}

async function uploadArchive(
  options: CliOptions,
  localPath: string,
  remotePath: string
): Promise<void> {
  const bytes = await readFile(localPath);
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_QGA_STDIN_BYTES) {
    throw new SafeDeploymentError("haos_candidate_deployment_archive_size_invalid");
  }
  const raw = await runSsh(
    options,
    buildHaosArchiveUploadRemoteCommand(options.vmId, remotePath),
    bytes,
    180_000
  );
  const output = parseGuestExecText(
    raw,
    "haos_candidate_deployment_upload_failed",
    "haos_candidate_deployment_upload_response_invalid"
  );
  if (output.trim() !== "") {
    throw new SafeDeploymentError("haos_candidate_deployment_upload_response_invalid");
  }
}

async function runGuestMarker(
  options: CliOptions,
  script: string,
  expectedMarker: string,
  timeoutSeconds: number
): Promise<void> {
  const raw = await runSsh(
    options,
    buildHaosGuestShellRemoteCommand(options.vmId, script, timeoutSeconds),
    undefined,
    (timeoutSeconds + 30) * 1_000
  );
  const output = parseGuestExecText(
    raw,
    "haos_candidate_deployment_remote_command_failed",
    "haos_candidate_deployment_remote_response_invalid"
  );
  if (output.trim() !== expectedMarker) {
    throw new SafeDeploymentError("haos_candidate_deployment_remote_response_invalid");
  }
}

async function readInstalledAppInfo(options: CliOptions): Promise<HaosAppInfo> {
  const raw = await runSsh(
    options,
    buildHaosAppInfoRemoteCommand(options.vmId, options.addonSlug),
    undefined,
    COMMAND_TIMEOUT_MS
  );
  return parseHaosAppInfoGuestResponse(raw);
}

async function readInstalledRuntimeSha256(options: CliOptions): Promise<string> {
  const raw = await runSsh(
    options,
    buildHaosRuntimeHashRemoteCommand(options.vmId, options.addonSlug),
    undefined,
    COMMAND_TIMEOUT_MS
  );
  return parseHaosRuntimeHashGuestResponse(raw);
}

async function readInstalledCandidateManifestSha256(options: CliOptions): Promise<string> {
  const raw = await runSsh(
    options,
    buildHaosCandidateManifestHashRemoteCommand(options.vmId, options.addonSlug),
    undefined,
    COMMAND_TIMEOUT_MS
  );
  return parseHaosCandidateManifestHashGuestResponse(raw);
}

async function runSsh(
  options: CliOptions,
  remoteCommand: string,
  input: Buffer | undefined,
  timeoutMs: number
): Promise<string> {
  return await new Promise<string>((resolveResult, rejectResult) => {
    const child = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        options.sshTarget,
        remoteCommand
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const reject = () => {
      if (!settled) {
        settled = true;
        rejectResult(new SafeDeploymentError("haos_candidate_deployment_ssh_failed"));
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      reject();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      if (code !== 0) {
        reject();
        return;
      }
      settled = true;
      resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", reject);
    child.stdin.end(input);
  });
}

async function readSourceState(repositoryRoot: string): Promise<CandidateSourceState> {
  const [statusText, branchText, headText, remoteText] = await Promise.all([
    runLocal(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      repositoryRoot,
      COMMAND_TIMEOUT_MS
    ),
    runLocal("git", ["branch", "--show-current"], repositoryRoot, COMMAND_TIMEOUT_MS),
    runLocal("git", ["rev-parse", "HEAD"], repositoryRoot, COMMAND_TIMEOUT_MS),
    runLocal(
      "git",
      ["ls-remote", "origin", "refs/heads/main"],
      repositoryRoot,
      COMMAND_TIMEOUT_MS
    )
  ]);
  const commitSha = headText.trim();
  const remoteSha = remoteText.trim().split(/\s+/u)[0] ?? "";
  if (!/^[a-f0-9]{40}$/u.test(commitSha) || !/^[a-f0-9]{40}$/u.test(remoteSha)) {
    throw new SafeDeploymentError("haos_candidate_deployment_git_invalid");
  }
  return {
    clean: statusText.trim() === "",
    onMain: branchText.trim() === "main",
    published: commitSha === remoteSha,
    commitSha
  };
}

async function readPackageVersion(packageDirectory: string): Promise<string> {
  const text = await readFile(resolve(packageDirectory, "config.yaml"), "utf8");
  let parsed: unknown;
  try {
    parsed = YAML.parse(text) as unknown;
  } catch {
    throw new SafeDeploymentError("haos_candidate_deployment_package_invalid");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SafeDeploymentError("haos_candidate_deployment_package_invalid");
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(version)) {
    throw new SafeDeploymentError("haos_candidate_deployment_package_invalid");
  }
  return version;
}

async function runLocal(
  executable: string,
  args: readonly string[],
  workingDirectory: string,
  timeoutMs: number
): Promise<string> {
  return await new Promise<string>((resolveResult, rejectResult) => {
    const child = spawn(executable, [...args], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const reject = () => {
      if (!settled) {
        settled = true;
        rejectResult(new SafeDeploymentError("haos_candidate_deployment_local_command_failed"));
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      reject();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject();
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) {
        return;
      }
      if (code !== 0) {
        reject();
        return;
      }
      settled = true;
      resolveResult(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

function publicReadiness(
  readiness: HaosCandidateDeploymentReadiness,
  bundle: DeploymentBundle,
  layout: HaosDeploymentRemoteLayout
) {
  return {
    deploymentEligible: readiness.deploymentEligible,
    reasons: readiness.reasons,
    preflight: readiness.preflight,
    checks: readiness.checks,
    identity: readiness.identity,
    bundle: {
      candidateVersion: bundle.candidate.version,
      candidateFileCount: bundle.candidate.files.length,
      candidateArchiveSha256: bundle.candidate.archive.sha256,
      candidateArchiveBytes: bundle.candidate.archive.byteLength,
      rollbackVersion: bundle.rollback.version,
      rollbackFileCount: bundle.rollback.files.length,
      rollbackArchiveSha256: bundle.rollback.archive.sha256,
      rollbackArchiveBytes: bundle.rollback.archive.byteLength
    },
    remote: {
      deploymentId: layout.deploymentId,
      addonSource: layout.addonSource,
      backupRoot: layout.backupRoot
    }
  };
}

function safeDeploymentResult(
  installed: HaosAppInfo,
  packageManifestSha256?: string
): DeploymentResult {
  return {
    version: installed.version,
    ...(packageManifestSha256 === undefined ? {} : { packageManifestSha256 }),
    app: {
      slug: installed.slug,
      state: installed.state,
      localBuild: installed.repository === "local" && installed.build,
      apparmorEnforced: installed.apparmor === "profile",
      ingressEnabled: installed.ingress
    }
  };
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--execute") {
      if (execute) {
        throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
      }
      execute = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
    }
    values.set(key, value);
    index += 1;
  }
  const allowed = new Set([
    "--run-dir",
    "--repository-root",
    "--expected-installed-version",
    "--expected-candidate-version",
    "--expected-commit-sha",
    "--expected-candidate-manifest-sha",
    "--ssh-target",
    "--vm-id",
    "--addon-slug"
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  const runDirectory = values.get("--run-dir");
  const expectedInstalledVersion = values.get("--expected-installed-version");
  const expectedCandidateVersion = values.get("--expected-candidate-version");
  const expectedCandidateCommitSha = values.get("--expected-commit-sha");
  const expectedCandidateManifestSha256 = values.get(
    "--expected-candidate-manifest-sha"
  );
  if (
    !runDirectory ||
    !expectedInstalledVersion ||
    !expectedCandidateVersion ||
    !expectedCandidateCommitSha ||
    !expectedCandidateManifestSha256
  ) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    false
  );
  if (addonSlug !== "local_smartthings_web_bridge") {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  const installedVersion = safeVersion(expectedInstalledVersion);
  if (installedVersion !== HAOS_ROLLBACK_VERSION) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return {
    execute,
    runDirectory: resolve(runDirectory),
    repositoryRoot: resolve(values.get("--repository-root") ?? process.cwd()),
    expectedInstalledVersion: installedVersion,
    expectedCandidateVersion: safeVersion(expectedCandidateVersion),
    expectedCandidateCommitSha: safeCommit(expectedCandidateCommitSha),
    expectedCandidateManifestSha256: safeSha256(expectedCandidateManifestSha256),
    sshTarget: safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true),
    vmId: positiveInteger(values.get("--vm-id") ?? "100"),
    addonSlug
  };
}

function safeVersion(value: string): string {
  if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(value)) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return value;
}

function safeCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return value;
}

function safeSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return value;
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]{1,120}$/u : /^[A-Za-z0-9_-]{1,120}$/u;
  if (!pattern.test(value)) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new SafeDeploymentError("haos_candidate_deployment_arguments_invalid");
  }
  return parsed;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function emitResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function runCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    const safeError =
      error instanceof SafeDeploymentError
        ? error
        : new SafeDeploymentError("haos_candidate_deployment_failed");
    process.stderr.write(
      `${JSON.stringify({
        event: "haos_candidate_deployment_error",
        success: false,
        rolledBack: safeError.rolledBack,
        error: safeError.message
      })}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCli();
}
