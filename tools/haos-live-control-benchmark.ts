import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertOutputDirectoryOutsideRepo } from "./haos-soak-core.js";
import {
  DEFAULT_LIVE_CONTROL_ENTITY_ID,
  createLiveControlBenchmarkPreview,
  runLiveControlBenchmark,
  type BridgeHealthClient,
  type HomeAssistantControlClient
} from "./haos-live-control-benchmark-core.js";

interface CliOptions {
  execute: boolean;
  entityId: string;
  allowedEntityIds: readonly string[];
  cycles: number;
  outputDirectory?: string;
  repositoryRoot: string;
  haUrl: string;
  bridgeUrl: string;
  waitTimeoutMs: number;
  pollIntervalMs: number;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const ha = createHomeAssistantClient(options.haUrl);
  const bridge = createBridgeHealthClient(options.bridgeUrl);
  if (!options.execute) {
    const preview = await createLiveControlBenchmarkPreview({
      entityId: options.entityId,
      allowedEntityIds: options.allowedEntityIds,
      cycles: options.cycles,
      ha,
      bridge
    });
    writeJson({ event: "haos_live_control_benchmark_preview", ...preview });
    return;
  }
  if (!options.outputDirectory) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  const outputDirectory = await assertOutputDirectoryOutsideRepo(
    options.outputDirectory,
    options.repositoryRoot
  );
  const result = await runLiveControlBenchmark({
    entityId: options.entityId,
    allowedEntityIds: options.allowedEntityIds,
    execute: true,
    cycles: options.cycles,
    ha,
    bridge,
    waitTimeoutMs: options.waitTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    writeArtifact: async (fileName, value) => {
      await writeFile(join(outputDirectory, fileName), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600
      });
    }
  });
  writeJson({
    event: "haos_live_control_benchmark_completed",
    mode: result.mode,
    entityId: result.entityId,
    cycles: result.cycles,
    transitionCount: result.transitions.length,
    finalState: result.finalState.state
  });
}

function createHomeAssistantClient(baseUrl: string): HomeAssistantControlClient {
  const token = process.env.SUPERVISOR_TOKEN;
  return {
    async getState(entityId) {
      const response = await fetch(`${baseUrl}/states/${encodeURIComponent(entityId)}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}
      });
      if (!response.ok) throw new Error("live_control_benchmark_ha_state_failed");
      const raw = (await response.json()) as Record<string, unknown>;
      if (
        raw.entity_id !== entityId ||
        typeof raw.state !== "string" ||
        typeof raw.last_updated !== "string"
      ) {
        throw new Error("live_control_benchmark_ha_state_invalid");
      }
      return { entityId, state: raw.state, lastUpdated: raw.last_updated };
    },
    async callService(domain, service, data) {
      const response = await fetch(`${baseUrl}/services/${domain}/${service}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(data)
      });
      if (!response.ok) throw new Error("live_control_benchmark_ha_service_failed");
    }
  };
}

function createBridgeHealthClient(baseUrl: string): BridgeHealthClient {
  return {
    async getHealth() {
      const response = await fetch(`${baseUrl}/health`, { headers: { accept: "application/json" } });
      if (!response.ok) return {};
      const raw = (await response.json()) as Record<string, unknown>;
      const details = raw.details;
      return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : raw;
    }
  };
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  const values = new Map<string, string[]>();
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--execute") {
      execute = true;
      continue;
    }
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("live_control_benchmark_arguments_invalid");
    }
    if (!allowedCliKeys.has(key)) {
      throw new Error("live_control_benchmark_arguments_invalid");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
    index += 1;
  }
  const entityId = single(values, "--entity-id") ?? DEFAULT_LIVE_CONTROL_ENTITY_ID;
  const allowedEntityIds = values.get("--allow-entity-id") ?? [DEFAULT_LIVE_CONTROL_ENTITY_ID];
  const cycles = positiveInteger(single(values, "--cycles") ?? "1", 20);
  const outputDirectory = single(values, "--output-dir");
  const parsed: CliOptions = {
    execute,
    entityId,
    allowedEntityIds,
    cycles,
    repositoryRoot: resolve(single(values, "--repository-root") ?? process.cwd()),
    haUrl: safeLocalApiUrl(single(values, "--ha-url") ?? "http://supervisor/core/api"),
    bridgeUrl: safeLocalBridgeUrl(single(values, "--bridge-url") ?? "http://127.0.0.1:8098"),
    waitTimeoutMs: positiveInteger(single(values, "--timeout-ms") ?? "15000", 120_000),
    pollIntervalMs: nonNegativeInteger(single(values, "--poll-ms") ?? "100", 120_000)
  };
  if (outputDirectory !== undefined) {
    parsed.outputDirectory = resolve(outputDirectory);
  }
  return parsed;
}

export function defaultOutputDirectory(now: Date): string {
  const base = process.env.LOCALAPPDATA ?? tmpdir();
  const runId = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
  return join(base, "HA-SmartThings-Web", "live-control-benchmark", runId);
}

const allowedCliKeys = new Set([
  "--entity-id",
  "--allow-entity-id",
  "--cycles",
  "--output-dir",
  "--repository-root",
  "--ha-url",
  "--bridge-url",
  "--timeout-ms",
  "--poll-ms"
]);

function single(values: Map<string, string[]>, key: string): string | undefined {
  const found = values.get(key);
  if (!found) return undefined;
  if (found.length !== 1) throw new Error("live_control_benchmark_arguments_invalid");
  return found[0];
}

function positiveInteger(value: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return parsed;
}

function nonNegativeInteger(value: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return parsed;
}

function safeLocalApiUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    !["supervisor", "127.0.0.1", "localhost", "::1"].includes(parsed.hostname)
  ) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function safeLocalBridgeUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("live_control_benchmark_arguments_invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function writeJson(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (executedPath && import.meta.url === executedPath) {
  void main().catch(() => {
    process.stderr.write("haos_live_control_benchmark_failed\n");
    process.exitCode = 1;
  });
}
