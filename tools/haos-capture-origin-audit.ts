import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  buildCaptureOriginAuditRemoteCommand,
  createCaptureOriginAuditSummary,
  parseCaptureOriginAuditAggregate
} from "./haos-capture-origin-audit-core.js";
import { parseGuestExecText } from "./haos-runtime-api-audit-core.js";
import { assertOutputDirectoryOutsideRepo } from "./haos-soak-core.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_COMMAND_OUTPUT_BYTES = 1_000_000;

interface CliOptions {
  outputDirectory: string;
  repositoryRoot: string;
  sshTarget: string;
  vmId: number;
  addonSlug: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  const remoteCommand = buildCaptureOriginAuditRemoteCommand({
    vmId: options.vmId,
    addonSlug: options.addonSlug
  });
  const aggregate = parseCaptureOriginAuditAggregate(
    parseGuestExecText(
      await runSsh(options.sshTarget, remoteCommand),
      "capture_origin_audit_command_failed",
      "capture_origin_audit_response_invalid"
    )
  );
  const summary = createCaptureOriginAuditSummary(aggregate);
  const serialized = `${JSON.stringify(summary, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  await writeFile(join(outputDirectory, "summary.json"), serialized, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await writeFile(join(outputDirectory, "summary.json.sha256"), `${digest}  summary.json\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  writeProgress({
    event: "capture_origin_audit_completed",
    result: summary.result,
    classification: summary.classification,
    analyzedCaptureRowCount: summary.analyzedCaptureRowCount,
    publicSmartThingsApiRecordCount: summary.originCounts.publicSmartThingsApi,
    consumerSmartThingsWebRecordCount: summary.originCounts.consumerSmartThingsWeb,
    summarySha256: digest,
    outputDirectory
  });
  if (summary.result !== "no_public_api_observed") {
    process.exitCode = 1;
  }
}

async function runSsh(target: string, remoteCommand: string): Promise<string> {
  const result = await execFileAsync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      target,
      remoteCommand
    ],
    {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true
    }
  );
  return result.stdout;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const allowed = new Set([
    "--output-dir",
    "--repository-root",
    "--ssh-target",
    "--vm-id",
    "--addon-slug"
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith("--") ||
      !allowed.has(key) ||
      values.has(key) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("capture_origin_audit_arguments_invalid");
    }
    values.set(key, value);
  }
  const sshTarget = safeIdentifier(values.get("--ssh-target") ?? "pve-new-ts", true);
  const addonSlug = safeIdentifier(
    values.get("--addon-slug") ?? "local_smartthings_web_bridge",
    false
  );
  const vmId = positiveInteger(values.get("--vm-id") ?? "100");
  const repositoryRoot = resolve(values.get("--repository-root") ?? process.cwd());
  const outputDirectory = resolve(
    values.get("--output-dir") ?? defaultOutputDirectory(new Date())
  );
  return { outputDirectory, repositoryRoot, sshTarget, vmId, addonSlug };
}

function safeIdentifier(value: string, allowDots: boolean): string {
  const pattern = allowDots ? /^[A-Za-z0-9_.-]{1,120}$/u : /^[A-Za-z0-9_-]{1,120}$/u;
  if (!pattern.test(value)) {
    throw new Error("capture_origin_audit_arguments_invalid");
  }
  return value;
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("capture_origin_audit_arguments_invalid");
  }
  return parsed;
}

function defaultOutputDirectory(now: Date): string {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const runId = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return join(base, "HA-SmartThings-Web", "capture-origin-audit", runId);
}

function writeProgress(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main().catch(() => {
  process.stderr.write("capture_origin_audit_failed\n");
  process.exitCode = 1;
});
