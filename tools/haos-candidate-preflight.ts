import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import YAML from "yaml";

import { packageAddon } from "./package-addon.js";
import {
  buildHaosAppInfoRemoteCommand,
  evaluateHaosCandidatePreflight,
  parseHaosAppInfoGuestResponse,
  type CandidateSourceState
} from "./haos-candidate-preflight-core.js";
import { inspectSoakDeploymentGate } from "./haos-soak-deployment-gate-core.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 45_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

interface CliOptions {
  runDirectory: string;
  repositoryRoot: string;
  expectedInstalledVersion: string;
  expectedCandidateVersion: string;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const [soakGate, packageResult, installed] = await Promise.all([
    inspectSoakDeploymentGate({
      runDirectory: options.runDirectory,
      repositoryRoot: options.repositoryRoot
    }),
    packageAddon({
      repoRoot: options.repositoryRoot,
      outputRoot: resolve(options.repositoryRoot, "dist-addon")
    }),
    readInstalledAppInfo(options)
  ]);
  const [source, candidateVersion] = await Promise.all([
    readSourceState(options.repositoryRoot),
    readCandidateVersion(packageResult.packageDir)
  ]);
  const result = evaluateHaosCandidatePreflight({
    soakGate,
    source,
    candidate: {
      version: candidateVersion,
      fileCount: packageResult.files.length,
      manifestSha256: packageResult.manifestSha256
    },
    installed,
    expectedInstalledVersion: options.expectedInstalledVersion,
    expectedCandidateVersion: options.expectedCandidateVersion,
    expectedAddonSlug: options.addonSlug
  });
  process.stdout.write(
    `${JSON.stringify({ event: "haos_candidate_preflight_result", ...result })}\n`
  );
  if (!result.deploymentEligible) {
    process.exitCode = 1;
  }
}

async function readSourceState(repositoryRoot: string): Promise<CandidateSourceState> {
  const [status, branch, head, remote] = await Promise.all([
    runGit(repositoryRoot, ["status", "--porcelain", "--untracked-files=all"]),
    runGit(repositoryRoot, ["branch", "--show-current"]),
    runGit(repositoryRoot, ["rev-parse", "HEAD"]),
    runGit(repositoryRoot, ["ls-remote", "origin", "refs/heads/main"])
  ]);
  const commitSha = head.trim();
  const remoteSha = remote.trim().split(/\s+/u)[0] ?? "";
  if (!/^[a-f0-9]{40}$/u.test(commitSha) || !/^[a-f0-9]{40}$/u.test(remoteSha)) {
    throw new Error("haos_candidate_preflight_git_invalid");
  }
  return {
    clean: status.trim() === "",
    onMain: branch.trim() === "main",
    published: commitSha === remoteSha,
    commitSha
  };
}

async function runGit(repositoryRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true
  });
  return result.stdout;
}

async function readInstalledAppInfo(options: CliOptions) {
  const result = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      options.sshTarget,
      buildHaosAppInfoRemoteCommand(options.vmId, options.addonSlug)
    ],
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true
    }
  );
  return parseHaosAppInfoGuestResponse(result.stdout);
}

async function readCandidateVersion(packageDirectory: string): Promise<string> {
  const text = await readFile(resolve(packageDirectory, "config.yaml"), "utf8");
  const parsed = YAML.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("haos_candidate_preflight_candidate_invalid");
  }
  const version = (parsed as Record<string, unknown>).version;
  if (typeof version !== "string" || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(version)) {
    throw new Error("haos_candidate_preflight_candidate_invalid");
  }
  return version;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      throw new Error("haos_candidate_preflight_arguments_invalid");
    }
    values.set(key, value);
  }
  const allowed = new Set([
    "--run-dir",
    "--repository-root",
    "--expected-installed-version",
    "--expected-candidate-version",
    "--ssh-target",
    "--vm-id",
    "--addon-slug"
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("haos_candidate_preflight_arguments_invalid");
  }
  const runDirectory = values.get("--run-dir");
  const expectedInstalledVersion = values.get("--expected-installed-version");
  const expectedCandidateVersion = values.get("--expected-candidate-version");
  if (!runDirectory || !expectedInstalledVersion || !expectedCandidateVersion) {
    throw new Error("haos_candidate_preflight_arguments_invalid");
  }
  return {
    runDirectory: resolve(runDirectory),
    repositoryRoot: resolve(values.get("--repository-root") ?? process.cwd()),
    expectedInstalledVersion: safeVersion(expectedInstalledVersion),
    expectedCandidateVersion: safeVersion(expectedCandidateVersion),
    sshTarget: safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true),
    vmId: positiveInteger(values.get("--vm-id") ?? "100"),
    addonSlug: safeIdentifier(
      values.get("--addon-slug") ?? "local_smartthings_web_bridge",
      false
    )
  };
}

function safeVersion(value: string): string {
  if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/u.test(value)) {
    throw new Error("haos_candidate_preflight_arguments_invalid");
  }
  return value;
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]{1,120}$/u : /^[A-Za-z0-9_-]{1,120}$/u;
  if (!pattern.test(value)) {
    throw new Error("haos_candidate_preflight_arguments_invalid");
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("haos_candidate_preflight_arguments_invalid");
  }
  return parsed;
}

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      event: "haos_candidate_preflight_error",
      deploymentEligible: false,
      error: "haos_candidate_preflight_failed"
    })}\n`
  );
  process.exitCode = 1;
});
