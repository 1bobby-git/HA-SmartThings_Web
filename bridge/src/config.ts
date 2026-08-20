export interface BridgeConfig {
  dataDir: string;
  host: string;
  port: number;
}

export function readBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  return {
    dataDir: env.STW_DATA_DIR ?? "/data",
    host: env.STW_HOST ?? "0.0.0.0",
    port: Number(env.STW_PORT ?? "8098")
  };
}
