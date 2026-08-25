import { readFileSync } from "node:fs";

import type { BrowserContextLike, BrowserPageLike } from "./browser/keeper-page.js";
import { KeeperPageManager } from "./browser/keeper-page.js";
import { BrowserSupervisor } from "./browser/browser-supervisor.js";
import { SmartThingsWebUiCommandExecutor } from "./browser/command-page.js";
import { DeviceDetailDiscovery } from "./browser/device-detail-discovery.js";
import { SafeCommandService } from "./command/command-service.js";
import {
  launchSmartThingsPersistentContext,
  type ChromiumLauncher
} from "./browser/persistent-context.js";
import { isProbeBrowserIsolated } from "./browser/probe-browser-isolation.js";
import type { BridgeConfig } from "./config.js";
import {
  PhysicalActionCorrelationProbe,
  type ProbeRuntimeEvidence
} from "./inspector/physical-action-correlation-probe.js";
import { SqliteAliasStore } from "./security/alias-store.js";
import { bootstrapDataPaths } from "./security/data-paths.js";
import { createRedactor } from "./security/redactor.js";
import { installBrowserObserver, type CaptureSink } from "./inspector/browser-observer.js";
import { installCdpNetworkObserver, type CdpSessionLike } from "./inspector/cdp-network.js";
import { PROTOCOL_CONTRACT_VERSION, type ProtocolMismatchSurface } from "./inspector/protocol-contract.js";
import { ProtocolAnalyzer } from "./inspector/protocol-analyzer.js";
import { createBridgeHttpServer, type BridgeHttpServer } from "./server/http-server.js";
import { createHealthReport, type HealthReport } from "./server/health.js";
import { BridgeAuth } from "./server/bridge-auth.js";
import { CaptureStore } from "./state/capture-store.js";
import { CameraImageStore } from "./state/camera-image-store.js";
import { DeviceStore } from "./state/device-store.js";
import {
  ProtocolIntegrityStore,
  type ProtocolIntegritySnapshot
} from "./state/protocol-integrity-store.js";
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

const bridgeVersion = "0.1.34";

export async function createBridgeRuntime(deps: BridgeRuntimeDependencies): Promise<BridgeRuntime> {
  const log = deps.log ?? console;
  log.info("bridge_init:data_paths");
  const paths = bootstrapDataPaths(deps.config.dataDir, (stage) => {
    log.info(`bridge_init:data_paths:${stage}`);
  });
  log.info("bridge_init:secret");
  const secret = readFileSync(paths.bridgeSecretPath, "utf8").trim();
  const auth = new BridgeAuth(secret);
  let protocolIntegrity: ProtocolIntegrityStore | undefined;
  let protocolIntegritySnapshot: ProtocolIntegritySnapshot | undefined;
  let protocolIntegrityLoadFailed = false;
  log.info("bridge_init:protocol_integrity");
  try {
    protocolIntegrity = new ProtocolIntegrityStore(paths.protocolFingerprintPath, {
      contractVersion: PROTOCOL_CONTRACT_VERSION
    });
    protocolIntegritySnapshot = protocolIntegrity.snapshot();
  } catch {
    protocolIntegrityLoadFailed = true;
    log.error("protocol_integrity_store_failed");
  }
  const status = new RuntimeStatusStore({
    initial: {
      bridgeVersion,
      dbAvailable: true,
      protocolVersion: protocolVersionFor(protocolIntegritySnapshot),
      protocolChangeCount: protocolIntegritySnapshot?.changeCount ?? 0,
      protocolMismatchSurface: protocolMismatchSurfaceFor(protocolIntegritySnapshot),
      ...(protocolIntegritySnapshot?.compatible === false
        ? {
            state: "PROTOCOL_CHANGED" as const,
            parserHealthy: false,
            initialSnapshotComplete: false,
            pushConnected: false
          }
        : {})
    },
    onListenerError: () => log.warn("runtime_status_listener_failed")
  });
  log.info("bridge_init:alias_store");
  const aliases = new SqliteAliasStore(paths.sqlitePath, secret);
  const redactor = createRedactor(aliases);
  log.info("bridge_init:capture_store");
  const captures = new CaptureStore(paths.sqlitePath);
  const devices = new DeviceStore({
    sqlitePath: paths.sqlitePath,
    normalizeStateToken: (value) =>
      aliases.alias("identifier", aliases.alias("identifier", value))
  });
  const cameraImages = new CameraImageStore({
    dataDir: paths.dataDir,
    aliasDeviceId: (rawDeviceId) => aliases.alias("device", rawDeviceId)
  });
  const physicalActionProbe = new PhysicalActionCorrelationProbe();
  let currentContext: ObservableContext | undefined;
  let currentKeeperManager: KeeperPageManager | undefined;
  const commandExecutor = new SmartThingsWebUiCommandExecutor(
    () => currentKeeperManager,
    (rawLocationId) =>
      aliases.alias("location", aliases.alias("location", rawLocationId))
  );
  const commands = new SafeCommandService({
    devices,
    status,
    executor: commandExecutor,
    timeoutMs: 15_000,
    resync: async () => {
      const keeperManager = currentKeeperManager;
      if (!keeperManager) throw new Error("command_browser_unavailable");
      await keeperManager.recoverKeeper();
    }
  });
  const getProbeEvidence = () =>
    probeEvidenceFrom(
      createHealthReport(status.getSnapshot()),
      isProbeBrowserIsolated(currentContext, currentKeeperManager)
    );
  const detailDiscovery = new DeviceDetailDiscovery({
    inventory: () => devices.snapshot(),
    inspector: commandExecutor,
    canInspect: () => {
      const report = createHealthReport(status.getSnapshot());
      return (
        report.ready &&
        report.details.state === "CONNECTED" &&
        isProbeBrowserIsolated(currentContext, currentKeeperManager) &&
        physicalActionProbe.snapshot(getProbeEvidence()).state !== "armed"
      );
    }
  });
  log.info("bridge_init:http_server");
  const server = await createBridgeHttpServer({
    store: status,
    host: deps.config.host,
    port: deps.config.port,
    auth,
    devices,
    commands,
    images: cameraImages,
    physicalActionProbe,
    getProbeEvidence
  });

  let activeContextGeneration = 0;
  let stopped = false;
  let restarting = false;
  const capturePipeline = createStatusCapturePipeline(
    captures,
    status,
    protocolIntegrity,
    log,
    protocolIntegritySnapshot?.compatible === false,
    physicalActionProbe,
    devices,
    cameraImages
  );
  const sink = capturePipeline.sink;
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
  const detailDiscoveryInterval = setInterval(() => {
    void detailDiscovery.runOne().then((result) => {
      if (result !== "failed") return;
      const current = status.getSnapshot();
      status.update({
        detailDiscoveryFailureCount: current.detailDiscoveryFailureCount + 1
      });
      log.warn("detail_discovery_failed");
    });
  }, 1_000);
  heartbeat();

  if (protocolIntegrityLoadFailed) {
    status.update({
      state: "PROTOCOL_CHANGED",
      parserHealthy: false,
      initialSnapshotComplete: false,
      pushConnected: false,
      protocolVersion: `${PROTOCOL_CONTRACT_VERSION}:discovering`
    });
    const browserStartup = Promise.resolve();
    let stopPromise: Promise<void> | undefined;
    return {
      port: server.port,
      status,
      browserStartup,
      stop: () => {
        stopPromise ??= stopRuntime({
          getContext: () => undefined,
          heartbeatInterval,
          keeperInterval,
          detailDiscoveryInterval,
          server,
          aliases,
          captures,
          devices,
          setStopped: () => {
            stopped = true;
          }
        });
        return stopPromise;
      }
    };
  }

  const supervisor = new BrowserSupervisor({
    maxRestarts: deps.config.browserMaxRestarts,
    retryDelayMs: deps.config.browserRetryDelayMs ?? 1_000,
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
        await attachContext(context, keeperManager, sink, redactor, cameraImages, status, log, () => {
          if (context === currentContext && keeperManager === currentKeeperManager) {
            physicalActionProbe.recordBrowserIsolation(isProbeBrowserIsolated(context, keeperManager));
          }
        });
        currentContext = context;
        currentKeeperManager = keeperManager;
        detailDiscovery.reset();
        assigned = true;
        return context;
      } finally {
        if (!assigned) {
          await closeContextQuietly(context);
        }
      }
    },
    status,
    onLaunchError: (token) => log.error(`browser_launch_failed:${token}`)
  });

  const restartBrowser = async () => {
    if (stopped || restarting) {
      return;
    }
    restarting = true;
    try {
      const context = (await supervisor.start()) as ObservableContext | undefined;
      if (context && !stopped) {
        const protocolSnapshot = safeProtocolSnapshot(protocolIntegrity);
        if (protocolSnapshot?.compatible === false) {
          status.update(protocolBlockedPatch(protocolSnapshot));
        }
        activeContextGeneration += 1;
        const generation = activeContextGeneration;
        context.on?.("close", async () => {
          if (stopped || generation !== activeContextGeneration || context !== currentContext) {
            return;
          }
          capturePipeline.reset();
          status.update({
            chromiumRunning: false,
            keeperPresent: false,
            authenticated: false,
            pushConnected: false,
            parserHealthy: false,
            initialSnapshotComplete: false,
            observedDeviceCount: 0,
            decodedDeviceEventCount: 0,
            uniqueLogicalEventCount: 0,
            duplicateEventCount: 0,
            dedupeJournalSize: 0,
            protocolInvalidFrameCount: 0,
            lastSnapshotAtMs: undefined,
            lastEventAtMs: undefined,
            lastParserSuccessAtMs: undefined,
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
        const keeperStatus = statusForKeeperUrl(keeper.url());
        const currentState = status.getSnapshot().state;
        if (
          keeperStatus.authenticated === true &&
          ["SYNCING", "CONNECTED", "STALE", "PROTOCOL_CHANGED"].includes(currentState)
        ) {
          const { state: _state, ...withoutState } = keeperStatus;
          status.update(withoutState);
        } else {
          status.update(keeperStatus);
        }
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
        detailDiscoveryInterval,
        server,
        aliases,
        captures,
        devices,
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
    if (
      url.origin === "https://my.smartthings.com" &&
      /^\/location(?:\/[^/]+)?\/?$/.test(url.pathname)
    ) {
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
  cameraImages: CameraImageStore,
  status: RuntimeStatusStore,
  log: BridgeRuntimeLog,
  onNewPage: () => void
): Promise<void> {
  const observedCdpPages = new WeakSet<object>();
  const restoredSettledKeeperPresent = context
    .pages()
    .some((page) => !page.isClosed() && isSettledSmartThingsLocation(page.url()));

  installBrowserObserver(context, sink, redact, {
    onRawWebSocketFrame: (direction, payload, connectionId) =>
      cameraImages.observeRawWebSocketFrame(direction, payload, connectionId)
  });
  context.on?.("page", (page) => {
    void installCdpForPage(
      context,
      page as BrowserPageLike,
      sink,
      redact,
      observedCdpPages,
      log,
      cameraImages
    );
    onNewPage();
  });
  await installCdpForPages(context, sink, redact, observedCdpPages, log, cameraImages);

  let keeper = await keeperManager.ensureKeeper();
  if (restoredSettledKeeperPresent && classifySmartThingsUrl(keeper.url()) === "smartthings_location") {
    keeper = await keeperManager.recoverKeeper();
  }
  status.update({
    browserVersion: safeBrowserVersion(context.browser?.()?.version?.()),
    keeperPresent: true,
    ...statusForKeeperUrl(keeper.url())
  });
}

function isSettledSmartThingsLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return classifySmartThingsUrl(value) === "smartthings_location" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

async function installCdpForPages(
  context: ObservableContext,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog,
  cameraImages: CameraImageStore
): Promise<void> {
  await Promise.all(
    context.pages().map((page) =>
      installCdpForPage(context, page, sink, redact, observedCdpPages, log, cameraImages)
    )
  );
}

async function installCdpForPage(
  context: ObservableContext,
  page: BrowserPageLike,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog,
  cameraImages: CameraImageStore
): Promise<void> {
  if (observedCdpPages.has(page) || !context.newCDPSession) {
    return;
  }
  try {
    const session = await context.newCDPSession(page);
    await installCdpNetworkObserver(session, sink, redact, {
      onRawWebSocketFrame: (direction, payload, connectionId) =>
        cameraImages.observeRawWebSocketFrame(direction, payload, connectionId)
    });
    observedCdpPages.add(page);
  } catch {
    log.warn("cdp_observer_install_failed");
  }
}

function createStatusCapturePipeline(
  captures: CaptureStore,
  status: RuntimeStatusStore,
  protocolIntegrity: ProtocolIntegrityStore | undefined,
  log: BridgeRuntimeLog,
  initiallyProtocolBlocked: boolean,
  physicalActionProbe: PhysicalActionCorrelationProbe,
  devices: DeviceStore,
  cameraImages: CameraImageStore
): { sink: CaptureSink; reset: () => void } {
  let analyzer = new ProtocolAnalyzer({ ttlMs: 300_000, maxEntries: 100_000 });
  let protocolFingerprintObserved = false;
  let protocolBlocked = initiallyProtocolBlocked;
  return {
    reset: () => {
      physicalActionProbe.fail("runtime_restarted");
      devices.reset();
      cameraImages.reset();
      analyzer.reset();
      analyzer = new ProtocolAnalyzer({ ttlMs: 300_000, maxEntries: 100_000 });
      protocolFingerprintObserved = false;
    },
    sink: {
      write(record) {
        captures.write(record);
        devices.observe(record);
        const now = Date.now();
        if (record.source === "playwright-websocket-frame" || record.source === "cdp-websocket-frame") {
          const analysis = analyzer.observe(record);
          const protocol = analyzer.snapshot();
          const current = status.getSnapshot();
          const basePatch: RuntimeStatusPatch = {
            lastFrameAtMs: now,
            lastPushAtMs: now,
            decodedDeviceEventCount: protocol.decodedDeviceEvents,
            uniqueLogicalEventCount: protocol.uniqueLogicalEvents,
            duplicateEventCount: protocol.duplicateDeliveries,
            dedupeJournalSize: protocol.journalSize,
            protocolInvalidFrameCount: protocol.invalidFrames
          };

          if (analysis?.kind === "protocol_changed") {
            physicalActionProbe.fail("protocol_changed");
            status.update({
              ...basePatch,
              ...recordProtocolMismatch(protocolIntegrity, analysis.surface, log)
            });
            protocolBlocked = true;
            return;
          }
          if (analysis?.kind === "new" || analysis?.kind === "duplicate") {
            if (analysis.event) {
              physicalActionProbe.observe(analysis);
            } else {
              physicalActionProbe.observeUnsafeEvent();
            }
          }

          if (!protocolBlocked && !protocolFingerprintObserved && protocol.protocolFingerprint) {
            protocolFingerprintObserved = true;
            const protocolPatch = observeProtocolFingerprint(
              protocolIntegrity,
              protocol.protocolFingerprint,
              log
            );
            if (protocolPatch.state === "PROTOCOL_CHANGED") {
              status.update({ ...basePatch, ...protocolPatch });
              protocolBlocked = true;
              return;
            }
            status.update(protocolPatch);
          }

          if (protocolBlocked) {
            status.update({
              ...basePatch,
              ...protocolBlockedPatch(protocolIntegrity?.snapshot())
            });
            return;
          }

          if (analysis?.kind === "snapshot") {
            status.update({
              ...basePatch,
              initialSnapshotComplete: protocol.snapshotComplete || current.initialSnapshotComplete,
              lastSnapshotAtMs: now,
              observedDeviceCount: Math.max(
                current.observedDeviceCount,
                protocol.snapshotCategories.device_cards ?? 0,
                protocol.snapshotCategories.device_health ?? 0
              ),
              state:
                protocol.snapshotComplete && current.pushConnected && current.parserHealthy
                  ? "CONNECTED"
                  : "SYNCING"
            });
            return;
          }
          if (analysis) {
            status.update({
              ...basePatch,
              lastEventAtMs: now,
              lastParserSuccessAtMs: now,
              parserHealthy: true,
              pushConnected: true,
              state: current.initialSnapshotComplete ? "CONNECTED" : "SYNCING"
            });
            return;
          }
          status.update(basePatch);
          return;
        }
        if (record.source === "cdp-eventsource") {
          status.update({ lastEventAtMs: now });
        }
      }
    }
  };
}

function probeEvidenceFrom(report: HealthReport, browserIsolated: boolean): ProbeRuntimeEvidence {
  return {
    live: report.live,
    ready: report.ready,
    state: report.details.state,
    browserIsolated,
    observedDeviceCount: report.details.observedDeviceCount,
    decodedDeviceEventCount: report.details.decodedDeviceEventCount,
    uniqueLogicalEventCount: report.details.uniqueLogicalEventCount,
    duplicateEventCount: report.details.duplicateEventCount,
    protocolInvalidFrameCount: report.details.protocolInvalidFrameCount,
    protocolChangeCount: report.details.protocolChangeCount,
    restartCount: report.details.restartCount
  };
}

function observeProtocolFingerprint(
  protocolIntegrity: ProtocolIntegrityStore | undefined,
  fingerprint: string,
  log: BridgeRuntimeLog
): RuntimeStatusPatch {
  if (!protocolIntegrity) {
    return protocolBlockedPatch();
  }
  try {
    const snapshot = protocolIntegrity.observeCompleteFingerprint(fingerprint);
    if (snapshot.compatible === false) {
      return protocolBlockedPatch(snapshot);
    }
    return {
      protocolVersion: protocolVersionFor(snapshot),
      protocolChangeCount: snapshot.changeCount,
      protocolMismatchSurface: undefined
    };
  } catch {
    log.error("protocol_integrity_write_failed");
    return protocolBlockedPatch(safeProtocolSnapshot(protocolIntegrity));
  }
}

function recordProtocolMismatch(
  protocolIntegrity: ProtocolIntegrityStore | undefined,
  surface: ProtocolMismatchSurface,
  log: BridgeRuntimeLog
): RuntimeStatusPatch {
  if (!protocolIntegrity) {
    return protocolBlockedPatch();
  }
  try {
    return protocolBlockedPatch(protocolIntegrity.recordMismatch(surface));
  } catch {
    log.error("protocol_integrity_write_failed");
    return protocolBlockedPatch(safeProtocolSnapshot(protocolIntegrity));
  }
}

function protocolBlockedPatch(snapshot?: ProtocolIntegritySnapshot): RuntimeStatusPatch {
  return {
    state: "PROTOCOL_CHANGED",
    parserHealthy: false,
    pushConnected: false,
    initialSnapshotComplete: false,
    protocolVersion: protocolVersionFor(snapshot),
    protocolChangeCount: snapshot?.changeCount ?? 0,
    protocolMismatchSurface: protocolMismatchSurfaceFor(snapshot)
  };
}

function protocolVersionFor(snapshot?: ProtocolIntegritySnapshot): string {
  const fingerprint = snapshot?.baseline ?? snapshot?.current;
  return `${PROTOCOL_CONTRACT_VERSION}:${fingerprint ? fingerprint.slice(0, 16) : "discovering"}`;
}

function safeProtocolSnapshot(
  protocolIntegrity: ProtocolIntegrityStore | undefined
): ProtocolIntegritySnapshot | undefined {
  try {
    return protocolIntegrity?.snapshot();
  } catch {
    return undefined;
  }
}

function protocolMismatchSurfaceFor(
  snapshot: ProtocolIntegritySnapshot | undefined
): ProtocolMismatchSurface | undefined {
  return snapshot?.lastMismatch?.kind === "surface" ? snapshot.lastMismatch.surface : undefined;
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
  detailDiscoveryInterval: NodeJS.Timeout;
  server: BridgeHttpServer;
  aliases: SqliteAliasStore;
  captures: CaptureStore;
  devices: DeviceStore;
  setStopped: () => void;
}): Promise<void> {
  options.setStopped();
  clearInterval(options.heartbeatInterval);
  clearInterval(options.keeperInterval);
  clearInterval(options.detailDiscoveryInterval);
  const context = options.getContext();
  await Promise.allSettled([
    context?.close?.(),
    options.server.close(),
    Promise.resolve().then(() => options.aliases.close()),
    Promise.resolve().then(() => options.captures.close()),
    Promise.resolve().then(() => options.devices.close())
  ]);
}

async function closeContextQuietly(context: ObservableContext): Promise<void> {
  try {
    await context.close?.();
  } catch {
    // Best-effort cleanup only. Raw close errors are intentionally not logged.
  }
}
