export interface BridgeConfig {
  dataDir: string;
  host: string;
  port: number;
  heartbeatIntervalMs: number;
  browserMaxRestarts: number;
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    dataDir: env.STW_DATA_DIR ?? "/data",
    host: env.STW_HOST ?? "0.0.0.0",
    port: parsePort(env.STW_PORT ?? "8098"),
    heartbeatIntervalMs: parseHeartbeatInterval(env.STW_HEARTBEAT_INTERVAL_MS ?? "10000"),
    browserMaxRestarts: parseRestartCount(env.STW_BROWSER_MAX_RESTARTS ?? "3")
  };
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
