import { readFileSync } from "node:fs";

import type { BrowserContextLike, BrowserPageLike } from "./browser/keeper-page.js";
import { KeeperPageManager } from "./browser/keeper-page.js";
import { BrowserSupervisor } from "./browser/browser-supervisor.js";
import {
  launchSmartThingsPersistentContext,
  type ChromiumLauncher
} from "./browser/persistent-context.js";
import type { BridgeConfig } from "./config.js";
import { SqliteAliasStore } from "./security/alias-store.js";
import { bootstrapDataPaths } from "./security/data-paths.js";
import { createRedactor } from "./security/redactor.js";
import { installBrowserObserver, type CaptureSink } from "./inspector/browser-observer.js";
import { installCdpNetworkObserver, type CdpSessionLike } from "./inspector/cdp-network.js";
import { createBridgeHttpServer, type BridgeHttpServer } from "./server/http-server.js";
import { CaptureStore } from "./state/capture-store.js";
import { RuntimeStatusStore, type RuntimeStatusPatch, type UrlCategory } from "./state/runtime-state.js";

export interface BridgeRuntimeLog {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

export interface BridgeRuntimeDependencies {
  config: BridgeConfig;
  chromium: ChromiumLauncher;
  log?: BridgeRuntimeLog;
}

export interface BridgeRuntime {
  port: number;
  status: RuntimeStatusStore;
  browserStartup: Promise<void>;
  stop: () => Promise<void>;
}

type ObservableContext = BrowserContextLike & {
  on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => void;
  close?: () => Promise<unknown>;
  browser?: () => { version?: () => string } | null;
  newCDPSession?: (page: BrowserPageLike) => Promise<CdpSessionLike>;
};

const bridgeVersion = "0.1.0";

export async function createBridgeRuntime(deps: BridgeRuntimeDependencies): Promise<BridgeRuntime> {
  const log = deps.log ?? console;
  const paths = bootstrapDataPaths(deps.config.dataDir);
  const secret = readFileSync(paths.bridgeSecretPath, "utf8").trim();
  const status = new RuntimeStatusStore({
    initial: {
      bridgeVersion,
      dbAvailable: true
    },
    onListenerError: () => log.warn("runtime_status_listener_failed")
  });
  const aliases = new SqliteAliasStore(paths.sqlitePath, secret);
  const redactor = createRedactor(aliases);
  const captures = new CaptureStore(paths.sqlitePath);
  const server = await createBridgeHttpServer({
    store: status,
    host: deps.config.host,
    port: deps.config.port
  });

  let currentContext: ObservableContext | undefined;
  let currentKeeperManager: KeeperPageManager | undefined;
  let activeContextGeneration = 0;
  let stopped = false;
  let restarting = false;
  const sink = createStatusCaptureSink(captures, status);
  const heartbeat = () => {
    let dbAvailable = false;
    try {
      dbAvailable = captures.ping();
    } catch {
      dbAvailable = false;
    }
    status.update({ dbAvailable });
    status.heartbeat();
  };
  const heartbeatInterval = setInterval(heartbeat, deps.config.heartbeatIntervalMs);
  const keeperInterval = setInterval(() => {
    void reconcileActiveKeeper();
  }, deps.config.heartbeatIntervalMs);
  heartbeat();

  const supervisor = new BrowserSupervisor({
    maxRestarts: deps.config.browserMaxRestarts,
    launch: async () => {
      let context: ObservableContext | undefined;
      let assigned = false;
      context = (await launchSmartThingsPersistentContext(deps.chromium, paths)) as ObservableContext;
      if (stopped) {
        await closeContextQuietly(context);
        return context;
      }
      try {
        const keeperManager = new KeeperPageManager(context);
        await attachContext(context, keeperManager, sink, redactor, status, log);
        currentContext = context;
        currentKeeperManager = keeperManager;
        assigned = true;
        return context;
      } finally {
        if (!assigned) {
          await closeContextQuietly(context);
        }
      }
    },
    status,
    onLaunchError: () => log.error("browser_launch_failed")
  });

  const restartBrowser = async () => {
    if (stopped || restarting) {
      return;
    }
    restarting = true;
    try {
      const context = (await supervisor.start()) as ObservableContext | undefined;
      if (context && !stopped) {
        activeContextGeneration += 1;
        const generation = activeContextGeneration;
        context.on?.("close", async () => {
          if (stopped || generation !== activeContextGeneration || context !== currentContext) {
            return;
          }
          status.update({
            chromiumRunning: false,
            keeperPresent: false,
            state: "RECONNECTING"
          });
          await restartBrowser();
        });
        await reconcileActiveKeeper();
      }
    } finally {
      restarting = false;
    }
  };

  const reconcileActiveKeeper = async () => {
    const keeperManager = currentKeeperManager;
    const context = currentContext;
    const generation = activeContextGeneration;
    if (stopped || !keeperManager || !context) {
      return;
    }
    try {
      const keeper = await keeperManager.ensureKeeper();
      if (generation === activeContextGeneration && context === currentContext && !stopped) {
        status.update(statusForKeeperUrl(keeper.url()));
      }
    } catch {
      log.warn("keeper_reconcile_failed");
    }
  };

  const browserStartup = restartBrowser().catch(() => {
    log.error("browser_startup_failed");
  });

  let stopPromise: Promise<void> | undefined;
  return {
    port: server.port,
    status,
    browserStartup,
    stop: () => {
      stopPromise ??= stopRuntime({
        getContext: () => currentContext,
        heartbeatInterval,
        keeperInterval,
        server,
        aliases,
        captures,
        setStopped: () => {
          stopped = true;
        }
      });
      return stopPromise;
    }
  };
}

export function classifySmartThingsUrl(value: string): UrlCategory {
  if (value.length === 0) {
    return "none";
  }
  try {
    const url = new URL(value);
    if (url.origin === "https://my.smartthings.com" && url.pathname === "/location") {
      return "smartthings_location";
    }
    if (url.origin === "https://my.smartthings.com" && url.pathname === "/advanced") {
      return "smartthings_advanced";
    }
    if (url.hostname === "account.samsung.com") {
      return "samsung_login";
    }
    return "other";
  } catch {
    return "error";
  }
}

async function attachContext(
  context: ObservableContext,
  keeperManager: KeeperPageManager,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  status: RuntimeStatusStore,
  log: BridgeRuntimeLog
): Promise<void> {
  const observedCdpPages = new WeakSet<object>();
  const keeper = await keeperManager.ensureKeeper();
  status.update({
    browserVersion: safeBrowserVersion(context.browser?.()?.version?.()),
    keeperPresent: true,
    ...statusForKeeperUrl(keeper.url())
  });

  installBrowserObserver(context, sink, redact);
  await installCdpForPages(context, sink, redact, observedCdpPages, log);
  context.on?.("page", (page) => {
    void installCdpForPage(context, page as BrowserPageLike, sink, redact, observedCdpPages, log);
  });
}

async function installCdpForPages(
  context: ObservableContext,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog
): Promise<void> {
  await Promise.all(
    context.pages().map((page) => installCdpForPage(context, page, sink, redact, observedCdpPages, log))
  );
}

async function installCdpForPage(
  context: ObservableContext,
  page: BrowserPageLike,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog
): Promise<void> {
  if (observedCdpPages.has(page) || !context.newCDPSession) {
    return;
  }
  try {
    const session = await context.newCDPSession(page);
    await installCdpNetworkObserver(session, sink, redact);
    observedCdpPages.add(page);
  } catch {
    log.warn("cdp_observer_install_failed");
  }
}

function createStatusCaptureSink(captures: CaptureStore, status: RuntimeStatusStore): CaptureSink {
  return {
    write(record) {
      captures.write(record);
      const now = Date.now();
      if (record.source === "playwright-websocket-frame" || record.source === "cdp-websocket-frame") {
        status.update({ lastFrameAtMs: now, lastPushAtMs: now });
        return;
      }
      if (record.source === "cdp-eventsource") {
        status.update({ lastEventAtMs: now });
      }
    }
  };
}

function statusForKeeperUrl(value: string): RuntimeStatusPatch {
  const urlCategory = classifySmartThingsUrl(value);
  if (urlCategory === "samsung_login") {
    return { authenticated: false, state: "LOGIN_REQUIRED", urlCategory };
  }
  if (urlCategory === "smartthings_location" || urlCategory === "smartthings_advanced") {
    return { authenticated: true, state: "DISCOVERING_PROTOCOL", urlCategory };
  }
  return { authenticated: false, state: "PAGE_LOADING", urlCategory };
}

function safeBrowserVersion(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  try {
    new RuntimeStatusStore({ initial: { browserVersion: value } });
    return value;
  } catch {
    return "unknown";
  }
}

async function stopRuntime(options: {
  getContext: () => ObservableContext | undefined;
  heartbeatInterval: NodeJS.Timeout;
  keeperInterval: NodeJS.Timeout;
  server: BridgeHttpServer;
  aliases: SqliteAliasStore;
  captures: CaptureStore;
  setStopped: () => void;
}): Promise<void> {
  options.setStopped();
  clearInterval(options.heartbeatInterval);
  clearInterval(options.keeperInterval);
  const context = options.getContext();
  await Promise.allSettled([
    context?.close?.(),
    options.server.close(),
    Promise.resolve().then(() => options.aliases.close()),
    Promise.resolve().then(() => options.captures.close())
  ]);
}

async function closeContextQuietly(context: ObservableContext): Promise<void> {
  try {
    await context.close?.();
  } catch {
    // Best-effort cleanup only. Raw close errors are intentionally not logged.
  }
}
