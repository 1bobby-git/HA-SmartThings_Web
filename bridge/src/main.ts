import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { launchSmartThingsPersistentContext } from "./browser/persistent-context.js";
import { readBridgeConfig } from "./config.js";
import { SqliteAliasStore } from "./security/alias-store.js";
import { bootstrapDataPaths } from "./security/data-paths.js";
import { createRedactor } from "./security/redactor.js";
import { createBridgeHttpServer } from "./server/http-server.js";
import { CaptureStore } from "./state/capture-store.js";
import { RuntimeStatusStore } from "./state/runtime-state.js";

export async function main(): Promise<void> {
  const config = readBridgeConfig();
  const paths = bootstrapDataPaths(config.dataDir);
  const secret = readFileSync(paths.bridgeSecretPath, "utf8").trim();
  const status = new RuntimeStatusStore({
    initial: {
      bridgeVersion: "0.1.0",
      protocolVersion: "1",
      dbAvailable: true
    }
  });

  const aliases = new SqliteAliasStore(paths.sqlitePath, secret);
  const redactor = createRedactor(aliases);
  const captures = new CaptureStore(paths.sqlitePath);
  void redactor;
  void captures;

  await createBridgeHttpServer({ store: status, host: config.host, port: config.port });
  status.heartbeat();

  try {
    await launchSmartThingsPersistentContext(chromium, paths);
    status.update({ chromiumRunning: true, state: "LOGIN_REQUIRED" });
  } catch {
    status.update({ chromiumRunning: false, state: "BROWSER_FAILED" });
  }
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
