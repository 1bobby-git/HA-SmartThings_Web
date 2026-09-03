import { resolve } from "node:path";

import { inspectSoakDeploymentGate } from "./haos-soak-deployment-gate-core.js";

interface CliOptions {
  runDirectory: string;
  repositoryRoot: string;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await inspectSoakDeploymentGate(options);
  process.stdout.write(
    `${JSON.stringify({ event: "soak_deployment_gate_result", ...result })}\n`
  );
  if (!result.deploymentEligible) {
    process.exitCode = 1;
  }
}

function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("soak_deployment_gate_arguments_invalid");
    }
    if (values.has(key)) {
      throw new Error("soak_deployment_gate_arguments_invalid");
    }
    values.set(key, value);
  }
  const allowed = new Set(["--run-dir", "--repository-root"]);
  if ([...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("soak_deployment_gate_arguments_invalid");
  }
  const runDirectory = values.get("--run-dir");
  if (!runDirectory) {
    throw new Error("soak_deployment_gate_arguments_invalid");
  }
  return {
    runDirectory: resolve(runDirectory),
    repositoryRoot: resolve(values.get("--repository-root") ?? process.cwd())
  };
}

void main().catch(() => {
  process.stderr.write(
    `${JSON.stringify({
      event: "soak_deployment_gate_error",
      deploymentEligible: false,
      error: "soak_deployment_gate_failed"
    })}\n`
  );
  process.exitCode = 1;
});
