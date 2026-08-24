import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { readBridgeConfig } from "./config.js";
import { createBridgeRuntime, type BridgeRuntime } from "./runtime.js";

export interface ShutdownProcessLike {
  once(signal: string, handler: () => void): unknown;
}

export interface ShutdownLogLike {
  error(message: string): void;
}

export async function main(): Promise<BridgeRuntime> {
  const config = readBridgeConfig();
  const runtime = await createBridgeRuntime({ config, chromium });
  installShutdownHandlers(runtime);
  return runtime;
}

export function installShutdownHandlers(
  runtime: Pick<BridgeRuntime, "stop">,
  processLike: ShutdownProcessLike = process,
  log: ShutdownLogLike = console
): void {
  const shutdown = () => {
    runtime.stop().catch(() => {
      log.error("bridge_stop_failed");
    });
  };
  processLike.once("SIGTERM", shutdown);
  processLike.once("SIGINT", shutdown);
}

export function startupFailureToken(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "UNKNOWN";
  }
  const code = error.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
    ? code
    : "UNKNOWN";
}

const entry = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (entry) {
  main()
    .then((runtime) => {
      runtime.browserStartup.catch(() => {
        console.error("browser_startup_failed");
      });
    })
    .catch((error: unknown) => {
      console.error(`bridge_start_failed:${startupFailureToken(error)}`);
      process.exitCode = 1;
    });
}
