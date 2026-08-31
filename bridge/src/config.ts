import { existsSync, readFileSync } from "node:fs";

export interface BridgeConfig {
  dataDir: string;
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  browserMaxRestarts: number;
  browserRetryDelayMs?: number;
  domFallbackEnabled?: boolean;
}

export function readBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  optionsPath = env.STW_OPTIONS_PATH ?? "/data/options.json"
): BridgeConfig {
  const options = readAddonOptions(optionsPath);
  return {
    dataDir: env.STW_DATA_DIR ?? "/data",
    host: env.STW_HOST ?? "0.0.0.0",
    port: parsePort(env.STW_PORT ?? "8098"),
    heartbeatIntervalMs: parseHeartbeatInterval(env.STW_HEARTBEAT_INTERVAL_MS ?? "10000"),
    browserMaxRestarts: parseRestartCount(env.STW_BROWSER_MAX_RESTARTS ?? "3"),
    browserRetryDelayMs: parseRetryDelay(env.STW_BROWSER_RETRY_DELAY_MS ?? "1000"),
    domFallbackEnabled: parseBoolean(
      env.STW_DOM_FALLBACK_ENABLED ?? String(options.dom_fallback_enabled ?? true),
      "STW_DOM_FALLBACK_ENABLED"
    )
  };
}

function readAddonOptions(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    throw new Error("invalid bridge config: options.json must contain valid JSON");
  }
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`invalid bridge config: ${name} must be true or false`);
}

function parseRetryDelay(value: string): number {
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 100 || delay > 10_000) {
    throw new Error("invalid bridge config: STW_BROWSER_RETRY_DELAY_MS must be an integer from 100 to 10000");
  }
  return delay;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("invalid bridge config: STW_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseHeartbeatInterval(value: string): number {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 1_000 || interval >= 31_000) {
    throw new Error("invalid bridge config: STW_HEARTBEAT_INTERVAL_MS must be an integer from 1000 to 30999");
  }
  return interval;
}

function parseRestartCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 20) {
    throw new Error("invalid bridge config: STW_BROWSER_MAX_RESTARTS must be an integer from 0 to 20");
  }
  return count;
}
