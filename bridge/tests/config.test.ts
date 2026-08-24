import { describe, expect, test } from "vitest";

import { readBridgeConfig } from "../src/config.js";

describe("readBridgeConfig", () => {
  test("uses bounded defaults for server, heartbeat, and browser restarts", () => {
    expect(readBridgeConfig({})).toEqual({
      dataDir: "/data",
      host: "0.0.0.0",
      port: 8098,
      heartbeatIntervalMs: 10_000,
      browserMaxRestarts: 3,
      browserRetryDelayMs: 1_000
    });
  });

  test("validates port, heartbeat interval, and restart count from env", () => {
    expect(
      readBridgeConfig({
        STW_DATA_DIR: "D:/bridge-data",
        STW_HOST: "127.0.0.1",
        STW_PORT: "18098",
        STW_HEARTBEAT_INTERVAL_MS: "5000",
        STW_BROWSER_MAX_RESTARTS: "2",
        STW_BROWSER_RETRY_DELAY_MS: "750"
      })
    ).toMatchObject({
      dataDir: "D:/bridge-data",
      host: "127.0.0.1",
      port: 18_098,
      heartbeatIntervalMs: 5_000,
      browserMaxRestarts: 2,
      browserRetryDelayMs: 750
    });

    for (const env of [
      { STW_PORT: "0" },
      { STW_PORT: "65536" },
      { STW_PORT: "not-a-port" },
      { STW_HEARTBEAT_INTERVAL_MS: "31000" },
      { STW_HEARTBEAT_INTERVAL_MS: "0" },
      { STW_BROWSER_MAX_RESTARTS: "-1" },
      { STW_BROWSER_MAX_RESTARTS: "1.5" },
      { STW_BROWSER_RETRY_DELAY_MS: "99" },
      { STW_BROWSER_RETRY_DELAY_MS: "10001" }
    ]) {
      expect(() => readBridgeConfig(env)).toThrow(/invalid bridge config/i);
    }
  });
});
