import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBridgeConfig } from "../src/config.js";

describe("readBridgeConfig", () => {
  test("uses bounded defaults for server, heartbeat, and browser restarts", () => {
    expect(readBridgeConfig({})).toEqual({
      dataDir: "/data",
      host: "0.0.0.0",
      port: 8098,
      heartbeatIntervalMs: 10_000,
      browserMaxRestarts: 3,
      browserRetryDelayMs: 1_000,
      domFallbackEnabled: true,
      commandConfirmationTimeoutMs: 30_000,
      statusRecheckEnabled: true,
      inventoryReconciliationIntervalMs: 21_600_000,
      debugProtocolLogging: false
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
        STW_BROWSER_RETRY_DELAY_MS: "750",
        STW_DOM_FALLBACK_ENABLED: "false",
        STW_COMMAND_CONFIRMATION_TIMEOUT_SECONDS: "45",
        STW_STATUS_RECHECK_ENABLED: "false",
        STW_INVENTORY_RECONCILIATION_SECONDS: "7200",
        STW_DEBUG_PROTOCOL_LOGGING: "true"
      })
    ).toMatchObject({
      dataDir: "D:/bridge-data",
      host: "127.0.0.1",
      port: 18_098,
      heartbeatIntervalMs: 5_000,
      browserMaxRestarts: 2,
      browserRetryDelayMs: 750,
      domFallbackEnabled: false,
      commandConfirmationTimeoutMs: 45_000,
      statusRecheckEnabled: false,
      inventoryReconciliationIntervalMs: 7_200_000,
      debugProtocolLogging: true
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
      { STW_BROWSER_RETRY_DELAY_MS: "10001" },
      { STW_DOM_FALLBACK_ENABLED: "yes" },
      { STW_COMMAND_CONFIRMATION_TIMEOUT_SECONDS: "0" },
      { STW_STATUS_RECHECK_ENABLED: "yes" },
      { STW_INVENTORY_RECONCILIATION_SECONDS: "60" },
      { STW_DEBUG_PROTOCOL_LOGGING: "yes" }
    ]) {
      expect(() => readBridgeConfig(env)).toThrow(/invalid bridge config/i);
    }
  });

  test("does not expose a SmartThings state polling interval", () => {
    expect(readBridgeConfig({ ADVANCED_POLL_SECONDS: "60" })).not.toHaveProperty(
      "advancedPollSeconds"
    );
    expect(readBridgeConfig({ STW_ADVANCED_POLL_SECONDS: "15" })).not.toHaveProperty(
      "advancedPollSeconds"
    );
  });

  test("reads advanced options from the Home Assistant add-on options file", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-options-"));
    const path = join(root, "options.json");
    writeFileSync(
      path,
      JSON.stringify({
        dom_fallback_enabled: false,
        command_confirmation_timeout: 45,
        status_recheck_enabled: false,
        inventory_reconciliation_interval: 7200,
        debug_protocol_logging: true
      })
    );
    try {
      expect(readBridgeConfig({}, path)).toMatchObject({
        domFallbackEnabled: false,
        commandConfirmationTimeoutMs: 45_000,
        statusRecheckEnabled: false,
        inventoryReconciliationIntervalMs: 7_200_000,
        debugProtocolLogging: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
