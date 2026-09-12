import { readLightCommandStatus } from "./command/light-status-recheck.js";
import { verifiedAdvancedControl } from "./command/verified-control-route.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContextLike, BrowserPageLike } from "./browser/keeper-page.js";
import { readLocationSecurityStatus } from "./browser/location-status.js";
import { LocationSecurityCommandExecutor } from "./browser/location-security-command.js";
import { verifyLocationRead } from "./state/location-read-proof.js";
import { installCakeClientCapture } from "./browser/cake-client-capture.js";
import {
  ADVANCED_DEVICE_SNAPSHOT_URLS,
  KEEPER_URL,
  KeeperPageManager,
  fetchAdvancedDeviceSnapshotEntries,
  fetchAdvancedDeviceSnapshots,
  waitForSettledKeeperPage
} from "./browser/keeper-page.js";
import { verifyLocationApplicationSession, inspectAuthenticationPage } from "./browser/session-application-proof.js";
import { SessionMaintenanceGate } from "./browser/session-maintenance.js";
import { BrowserSupervisor } from "./browser/browser-supervisor.js";
import { SmartThingsWebUiCommandExecutor } from "./browser/command-page.js";
import { DeviceDetailDiscovery } from "./browser/device-detail-discovery.js";
import { AuthenticatedSmartThingsSession } from "./advanced/authenticated-session.js";
import { AdvancedInventoryAdapter } from "./advanced/inventory-adapter.js";
import { AdvancedCommandAdapter } from "./advanced/command-adapter.js";
import {
  AdvancedCommandCatalog,
  type AdvancedCommandCatalogResult,
  type CapabilityBinding as AdvancedCommandCatalogBinding
} from "./advanced/command-catalog.js";
import {
  CapabilityDefinitionCache,
  parseCapabilityDefinition
} from "./advanced/capability-cache.js";
import { AdvancedFirstCommandExecutor } from "./command/advanced-first-executor.js";
import {
  type CommandResyncEvidence,
  type CommandResyncRequest
} from "./command/command-service.js";
import { CommandConfirmationCoordinator } from "./command/command-confirmation.js";
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
import { VolatileIdentifierMap } from "./security/volatile-identifier-map.js";
import { bootstrapDataPaths } from "./security/data-paths.js";
import { EncryptedSessionStateStore, restoreSessionStorageState, isEmptySessionStorageState } from "./security/session-state.js";
import { createRedactor } from "./security/redactor.js";
import { installBrowserObserver, type CaptureSink } from "./inspector/browser-observer.js";
import { installCdpNetworkObserver, type CdpSessionLike } from "./inspector/cdp-network.js";
import { PROTOCOL_CONTRACT_VERSION, type ProtocolMismatchSurface } from "./inspector/protocol-contract.js";
import { ProtocolAnalyzer } from "./inspector/protocol-analyzer.js";
import { createBridgeHttpServer, type BridgeHttpServer } from "./server/http-server.js";
import {
  createHealthReport,
  DEFAULT_PUSH_FRESH_MS,
  type HealthReport
} from "./server/health.js";
import { BridgeAuth } from "./server/bridge-auth.js";
import { CaptureStore, type SanitizedCaptureRecord } from "./state/capture-store.js";
import { CameraImageStore } from "./state/camera-image-store.js";
import {
  DeviceStore,
  type BridgeAdvancedCommandCatalogUpdate
} from "./state/device-store.js";
import { StateReconciliationCoordinator } from "./state/reconciliation-coordinator.js";
import { LocationRealtimeAdapter } from "./realtime/location-realtime-adapter.js";
import {
  ProtocolIntegrityStore,
  type ProtocolIntegritySnapshot
} from "./state/protocol-integrity-store.js";
import {
  RuntimeStatusStore,
  type RuntimeStatusPatch,
  type RuntimeStatusSnapshot,
  type UrlCategory
} from "./state/runtime-state.js";

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
  addInitScript?: (script: () => void) => Promise<unknown>;
  addCookies?: (cookies: unknown[]) => Promise<unknown>;
  setStorageState?: (state: { cookies: unknown[]; origins: unknown[] }) => Promise<unknown>;
  storageState?: (options?: { indexedDB?: boolean }) => Promise<unknown>;
  on: (event: string, handler: (payload?: unknown) => void | Promise<void>) => void;
  close?: () => Promise<unknown>;
  browser?: () => { version?: () => string } | null;
  newCDPSession?: (page: BrowserPageLike) => Promise<CdpSessionLike>;
};

const bridgeVersion = "1.8.43";
const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;
const DETAIL_DISCOVERY_INTERVAL_MS = 15_000;
const PROFILE_MAINTENANCE_REQUIRED_FILE = ".profile-maintenance-required";
const PROFILE_MAINTENANCE_FAILED_FILE = ".profile-maintenance-failed";
const PROFILE_MAINTENANCE_WAIT_TIMEOUT_MS = 210_000;
const PROFILE_MAINTENANCE_POLL_MS = 250;

export async function createBridgeRuntime(deps: BridgeRuntimeDependencies): Promise<BridgeRuntime> {
  const log = deps.log ?? console;
  log.info(`bridge_init:version:${bridgeVersion}:home_monitor_direct`);
  log.info("bridge_init:data_paths");
  const paths = bootstrapDataPaths(deps.config.dataDir, (stage) => {
    log.info(`bridge_init:data_paths:${stage}`);
  });
  log.info("bridge_init:secret");
  const secret = readFileSync(paths.bridgeSecretPath, "utf8").trim();
  const auth = new BridgeAuth(secret);
  const sessionStateStore = new EncryptedSessionStateStore(
    join(paths.dataDir, "session-state.json"),
    secret
  );
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
      architectureVersion: "advanced-primary-v1",
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
  const volatileIdentifiers = new VolatileIdentifierMap((kind, rawIdentifier) =>
    aliases.alias(kind, rawIdentifier)
  , (rawIdentifier) => aliases.alias("location", rawIdentifier));
  log.info("bridge_init:capture_store");
  const captures = new CaptureStore(paths.sqlitePath);
  // Quiet time also covers brief gaps between consecutive slider intents.
  let commandQuietUntilMs = 0;
  const commandWorkBusy = () => status.getSnapshot().pendingCommandCount > 0 ||
    performance.now() < commandQuietUntilMs;
  const devices = new DeviceStore({
    backgroundPersistence: true,
    deferPersistenceWhile: commandWorkBusy,
    onPersistenceTiming: (event) => {
      if (event.totalMs >= 50 || event.deferredMs > 0 || event.outcome === "failed") {
        log.info(`inventory_persist_timing:${JSON.stringify(event)}`);
      }
    },
    sqlitePath: paths.sqlitePath,
    onPersistenceError: () => log.warn("device_store_persist_failed"),
    normalizeStateToken: (value) =>
      aliases.alias("identifier", aliases.alias("identifier", value)),
    normalizeAdvancedAlias: (kind, value) => aliases.alias(kind, value),
    identifierRole: (value) => volatileIdentifiers.semanticIdentifierRole(value)
  });
  status.update({ observedDeviceCount: devices.snapshot().devices.length });
  const cameraImages = new CameraImageStore({
    dataDir: paths.dataDir,
    // Raw camera traffic is observed before the redacted snapshot reaches
    // DeviceStore. Match the redactor plus DeviceStore normalization so cached
    // bytes use the exact public device ID exposed by inventory and Home Assistant.
    aliasDeviceId: (rawDeviceId) =>
      aliases.alias("device", aliases.alias("device", rawDeviceId))
  });
  cameraImages.observeInventory(devices.snapshot());
  const physicalActionProbe = new PhysicalActionCorrelationProbe();
  let currentContext: ObservableContext | undefined;
  let currentKeeperManager: KeeperPageManager | undefined;
  let recoverCurrentPushSocket: (() => void) | undefined;
  let sessionTouchInFlight = false;
  let nextSessionTouchAtMs: number | undefined;
  let sessionTouchFailures = 0;
  let sessionTouchOperation: symbol | undefined;
  const persistCurrentSessionState = () =>
    persistSessionStateIfHealthy(currentContext, sessionStateStore, status, log);
  let nextBrowserRetryAtMs = Number.POSITIVE_INFINITY;
  let browserRetryDelayMs = 60_000;
  const authenticatedSession = new AuthenticatedSmartThingsSession({
    onRequestTiming: (event) => log.info(`advanced_request_timing:${JSON.stringify(event)}`),
    onAuthenticationFailure: (page, url) => {
      if (currentKeeperManager?.reportAuthenticationFailure(page, url)) {
        status.update({ authenticated: false, state: "LOGIN_REQUIRED" });
        nextSessionTouchAtMs = 0;
        log.warn("session_authentication_rejected");
      }
    },
    currentKeeper: () => currentKeeperManager?.currentKeeper(),
    openAdvancedPage: async () => {
      const manager = currentKeeperManager;
      if (!manager) throw new Error("advanced_session_unavailable");
      return await manager.openAdvancedPage();
    }
  });
  const advancedInventory = new AdvancedInventoryAdapter(authenticatedSession);
  const loadCapabilityDefinition = async (capabilityId: string, version: number) =>
    parseCapabilityDefinition(
      await advancedInventory.getCapabilityDefinition(capabilityId, version)
    );
  const capabilityCache = new CapabilityDefinitionCache(loadCapabilityDefinition);
  // Discovery and dispatch must validate the same cached definition, without a second GET.
  const advancedCommandCatalog = new AdvancedCommandCatalog((id, version) => capabilityCache.get(id, version));
  let advancedCommandCatalogGeneration = 0;
  const buildAdvancedCommandCatalog = async (
    authoritativeDeviceIds: ReadonlySet<string>
  ): Promise<void> => {
    const generation = ++advancedCommandCatalogGeneration;
    const { bindings, unresolvedDeviceIds } = advancedCommandCatalogBindings(
      devices,
      volatileIdentifiers,
      authoritativeDeviceIds
    );
    try {
      const catalog: AdvancedCommandCatalogResult = bindings.length > 0
        ? await advancedCommandCatalog.build(bindings)
        : {
            commandsByDevice: new Map(),
            omissionsByDevice: new Map(),
            omissions: []
          };
      if (generation !== advancedCommandCatalogGeneration) return;
      const currentDevices = new Map(devices.snapshot().devices.map((device) => [device.id, device]));
      let preservedFailure = false;
      const catalogUpdates: BridgeAdvancedCommandCatalogUpdate[] = [];
      for (const deviceId of [...authoritativeDeviceIds].sort()) {
        if (unresolvedDeviceIds.has(deviceId)) {
          preservedFailure = true;
          continue;
        }
        const nextCommands = catalog.commandsByDevice.get(deviceId) ?? [];
        const nextOmissions = catalog.omissionsByDevice.get(deviceId) ?? [];
        const currentDevice = currentDevices.get(deviceId);
        if (
          nextCommands.length === 0 &&
          nextOmissions.some((omission) =>
            omission.reason === "definition_unavailable" || omission.reason === "schema_invalid"
          ) &&
          (currentDevice?.advancedCommands?.length ?? 0) > 0
        ) {
          preservedFailure = true;
          continue;
        }
        catalogUpdates.push({
          deviceId,
          commands: nextCommands,
          omissions: nextOmissions
        });
      }
      devices.observeAdvancedCommandCatalogs(catalogUpdates);
      if (preservedFailure) {
        const current = status.getSnapshot();
        status.update({
          advancedCommandCatalogFailureCount: current.advancedCommandCatalogFailureCount + 1
        });
        log.warn("advanced_command_catalog_sync_failed");
      }
      cameraImages.observeInventory(devices.snapshot());
    } catch {
      const current = status.getSnapshot();
      status.update({
        advancedCommandCatalogFailureCount: current.advancedCommandCatalogFailureCount + 1
      });
      log.warn("advanced_command_catalog_sync_failed");
    }
  };
  const reconciliation = new StateReconciliationCoordinator({
    load: () => advancedInventory.getInventory(),
    apply: (snapshot) => {
      const rawSnapshot = {
        locations: snapshot.locations,
        rooms: snapshot.rooms,
        devices: snapshot.devices
      };
      volatileIdentifiers.observeRawAdvancedDeviceSnapshot({ items: snapshot.devices });
      cameraImages.observeRawAdvancedDeviceSnapshot({ items: snapshot.devices });
      const sanitized = redactor(rawSnapshot) as {
        locations?: unknown;
        rooms?: unknown;
        devices?: unknown;
      };
      devices.observeAdvancedInventorySnapshot(sanitized, {
        authoritativeWholeSnapshot: true
      });
      cameraImages.observeInventory(devices.snapshot());
      void buildAdvancedCommandCatalog(
        authoritativeDeviceIdsFromSanitizedSnapshot(
          sanitized.devices,
          (deviceId) => aliases.alias("device", deviceId)
        )
      );
      status.update({
        advancedInventoryLastSyncAtMs: Date.now(),
        advancedInventoryDeviceCount: snapshot.devices.length,
        advancedInventoryLocationCount: snapshot.locations.length,
        advancedInventoryPageCount: snapshot.pageCount
      });
    }
  });
  const refreshCommandSnapshot = (
    request?: CommandResyncRequest
  ): Promise<CommandResyncEvidence> => {
    return (async () => {
      const startedAtMs = Date.now();
      const keeper = currentKeeperManager?.currentKeeper();
      if (!keeper || classifySmartThingsUrl(keeper.url()) !== "smartthings_location") {
        throw new Error("command_browser_unavailable");
      }
      if (request?.locationId) {
        const rawLocationId = volatileIdentifiers.rawLocationId(request.locationId);
        if (!rawLocationId) throw new Error("location_status_identifier_unavailable");
        const before = devices.location(request.locationId);
        const checked = await verifyLocationRead(
          () => readLocationSecurityStatus(keeper, rawLocationId), rawLocationId, before
        );
        if (!checked || !before) {
          log.info("home_monitor_command:status_read_unavailable");
          throw new Error("location_status_unavailable");
        }
        const { observed, undatedConfirmed } = checked;
        // Exact raw IDs remain browser-local. Compare against the pre-read observation.
        const accepted = devices.observeLocationStatusSnapshot({
          locationId: request.locationId, armState: observed.armState, updatedAt: observed.updatedAt
        }, request.locationId, { before, undatedConfirmed });
        if (!accepted) throw new Error("location_status_stale");
        log.info("home_monitor_command:status_read_completed");
        return { source: "location_status", authoritativeSnapshot: false,
          locationId: request.locationId, armState: observed.armState, startedAtMs };
      }
      if (request?.deviceId) {
        const device = devices.device(request.deviceId);
        const rawDeviceId = volatileIdentifiers.rawDeviceId(request.deviceId);
        const rawLocationId = device
          ? volatileIdentifiers.rawLocationId(device.locationId)
          : undefined;
        if (!device || !rawDeviceId || !rawLocationId) {
          throw new Error("advanced_status_identifier_unavailable");
        }
        const observedStates = await readLightCommandStatus(devices, request.deviceId, device.locationId,
          async () => {
            const statusPayload = await advancedInventory.getDeviceStatus(rawDeviceId);
            devices.observeOnlineEvidence(request.deviceId!, Date.now());
            const rawSnapshot = { items: [{ deviceId: rawDeviceId, locationId: rawLocationId, status: statusPayload }] };
            volatileIdentifiers.observeRawAdvancedDeviceSnapshot(rawSnapshot);
            return redactor(rawSnapshot);
          }, request.lightComponent);
        if (!request.lightComponent) cameraImages.observeInventory(devices.snapshot());
        log.info("command_diag:advanced_status_refreshed");
        return {
          source: "advanced_device_status",
          authoritativeSnapshot: false,
          deviceId: request.deviceId,
          locationId: device.locationId,
          observedStates,
          startedAtMs
        };
      }
      await reconciliation.request("command_status");
      const reconciliationStatus = reconciliation.snapshot();
      if (reconciliationStatus.deviceCount === 0) throw new Error("advanced_snapshot_unavailable");
      log.info(`command_diag:advanced_snapshot_refreshed:${reconciliationStatus.pageCount}`);
      return {
        source: "advanced_inventory",
        authoritativeSnapshot: true,
        startedAtMs
      };
    })();
  };
  const legacyCommandExecutor = new SmartThingsWebUiCommandExecutor(
    () => currentKeeperManager,
    (rawLocationId) =>
      aliases.alias("location", aliases.alias("location", rawLocationId)),
    {
      warmPageTtlMs: 24 * 60 * 60_000,
      onDiagnostic: (stage) => log.info(`command_diag:${stage}`),
      onHomeMonitorDiagnostic: (diagnostics) =>
        log.info(
          `home_monitor_diag:${diagnostics.phase}` +
          `:monitor_${diagnostics.monitorExactCount}` +
          `:action_${diagnostics.actionExactCount}` +
          `:clickable_${diagnostics.actionClickableCount}` +
          `:mode_groups_${diagnostics.modeGroupCount}` +
          `:dialogs_${diagnostics.visibleDialogCount}` +
          `:iframes_${diagnostics.visibleIframeCount}` +
          `:shadow_roots_${diagnostics.openShadowRootCount}`
        ),
      onHomeMonitorCardDiagnostic: (diagnostics) =>
        log.info(
`home_monitor_card:${diagnostics.outcome}` +
`:titles_${diagnostics.titles}:mode_groups_${diagnostics.modeGroups}` +
`:html_${diagnostics.htmlModes}:svg_${diagnostics.svgModes}` +
`:pseudo_${diagnostics.pseudoModes}:canvas_${diagnostics.canvases}` +
`:dialogs_${diagnostics.dialogs}:targets_${diagnostics.targets}`
        ),
      onHomeMonitorDialogDiagnostic: (diagnostics) =>
        log.info(
          `home_monitor_diag:dialog_${diagnostics.outcome}` +
          `:dialogs_${diagnostics.dialogs}:selects_${diagnostics.selects}` +
          `:options_${diagnostics.options}:mode_groups_${diagnostics.modeGroups}` +
          `:targets_${diagnostics.targets}`
        ),
      resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),
      resolveRawLocationId: (alias) => volatileIdentifiers.rawLocationId(alias),
      resolveRawIdentifier: (alias) => volatileIdentifiers.rawIdentifier(alias)
    }
  );
  const advancedCommandExecutor = new AdvancedCommandAdapter({
    session: authenticatedSession,
    capabilityCache,
    resolveRawDeviceId: (alias) => volatileIdentifiers.rawDeviceId(alias),
    resolveRawIdentifier: (alias) => volatileIdentifiers.rawIdentifier(alias)
  });
  const locationSecurityExecutor = new LocationSecurityCommandExecutor({
    getManager: () => currentKeeperManager,
    resolveRawLocationId: (alias) => volatileIdentifiers.rawLocationId(alias),
    onDiagnostic: (stage) => log.info(`home_monitor_direct:${stage}`)
  });
  const commandExecutor = new AdvancedFirstCommandExecutor(
    advancedCommandExecutor,
    legacyCommandExecutor,
    {
      locationExecutor: locationSecurityExecutor,
      lightCommandBatchEnabled: deps.config.lightCommandBatchEnabled ?? false,
      domFallbackEnabled: deps.config.domFallbackEnabled ?? true,
      canUseAdvanced: (input) => verifiedAdvancedControl(
        input.deviceId ? devices.device(input.deviceId) : undefined, input),
      onDiagnostic: ({ transport, stage, outcome, code, mode, commandCount }) =>
        log.info(
          `command_route:${transport}:${stage}:${outcome}${code ? `:${code}` : ""}${mode ? `:mode_${mode}:commands_${commandCount}` : ""}`
        ),
      onComponentDiagnostic: ({ phase, ordinal, outcome, code }) =>
        log.info(
          `command_component:${phase}:${ordinal}:${outcome}${code ? `:${code}` : ""}`
        )
    }
  );
  const commands = new CommandConfirmationCoordinator({
    devices,
    status,
    executor: commandExecutor,
    timeoutMs: deps.config.commandConfirmationTimeoutMs ?? 30_000,
    ...(deps.config.statusRecheckEnabled === false ? {} : { resyncAfterMs: 250 }),
    resync: refreshCommandSnapshot,
    lightDispatchScope: () => currentKeeperManager?.currentKeeper(),
    ...(deps.config.lightCommandBatchEnabled === true ? {} : { lightDispatchPreview: async (deviceId: string, locationId: string): Promise<CommandResyncEvidence | undefined> => {
      if (deps.config.statusRecheckEnabled === false) return undefined;
      const startedAtMs = Date.now();
      const rawDeviceId = volatileIdentifiers.rawDeviceId(deviceId);
      const rawLocationId = volatileIdentifiers.rawLocationId(locationId);
      const keeper = currentKeeperManager?.currentKeeper();
      if (!rawDeviceId || !rawLocationId || !keeper ||
          classifySmartThingsUrl(keeper.url()) !== "smartthings_location") return undefined;
      // Pure, bounded GET: no store/online/inventory mutation, no fallback page.
      const statusPayload = await advancedInventory.previewLightStatus(rawDeviceId);
      const sanitized = redactor({ items: [{ deviceId: rawDeviceId, locationId: rawLocationId, status: statusPayload }] });
      return { source: "advanced_device_status", authoritativeSnapshot: false,
        deviceId, locationId, startedAtMs,
        observedStates: devices.commandStatusStates(sanitized, deviceId, locationId) };
    } }),
    onLocationDiagnostic: (diagnostic) => log.info(
      `home_monitor_command:${diagnostic.phase}:action_${diagnostic.action}` +
      `:matches_${Number(diagnostic.observedStateMatches)}:elapsed_ms_${diagnostic.elapsedMs}` +
      (diagnostic.reason ? `:reason_${diagnostic.reason}` : "")
    ),
    onDeviceDiagnostic: (event) => log.info(`command_device:${JSON.stringify(event)}`),
    onRequestTiming: (event) => log.info(`command_request_timing:${JSON.stringify(event)}`),
    onPendingCountChange: (count) => {
      status.update({ pendingCommandCount: count });
      if (count === 0) commandQuietUntilMs = performance.now() + 750;
      legacyCommandExecutor.setExternalCommandsPending(count > 0);
    },
    onResult: (result) => {
      const current = status.getSnapshot();
      status.update({
        lastCommandTransport: result.transport,
        lastCommandConfirmation: result.lifecycle,
        ...(result.transport === "dom"
          ? { domFallbackCount: current.domFallbackCount + 1 }
          : {})
      });
    }
  });
  const getProbeEvidence = () =>
    probeEvidenceFrom(
      createHealthReport(status.getSnapshot()),
      isProbeBrowserIsolated(currentContext, currentKeeperManager)
    );
  const detailDiscovery = new DeviceDetailDiscovery({
    inventory: () => devices.snapshot(),
    inspector: legacyCommandExecutor,
    resolveCameraImageUrl: (deviceId) => cameraImages.thumbnailRequestUrl(deviceId),
    canInspect: () => {
      const report = createHealthReport(status.getSnapshot());
      return (
        report.ready &&
        report.details.state === "CONNECTED" &&
        !commandWorkBusy() &&
        !legacyCommandExecutor.hasWarmCommandPage() &&
        !legacyCommandExecutor.hasForegroundOperation() &&
        !sessionTouchInFlight &&
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
    maintenance: {
      reloadInventory: async () => await reconciliation.request("reload"),
      reconnectRealtime: async () => {
        if (!recoverCurrentPushSocket) throw new Error("realtime_reconnect_unavailable");
        recoverCurrentPushSocket();
      }
    },
    images: cameraImages,
    physicalActionProbe,
    getProbeEvidence
  });
  log.info(`bridge_init:http_server_ready:${server.port}`);
  log.info(`bridge_init:light_command_mode:${deps.config.lightCommandBatchEnabled === true ? "batch" : "sequence"}`);

  let activeContextGeneration = 0;
  let stopped = false;
  let restarting = false;
  const capturePipeline = createStatusCapturePipeline(
    captures,
    deps.config.debugProtocolLogging === true,
    status,
    protocolIntegrity,
    log,
    protocolIntegritySnapshot?.compatible === false,
    physicalActionProbe,
    devices,
    cameraImages,
    volatileIdentifiers
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
  const sessionMaintenance = new SessionMaintenanceGate();
  const keeperInterval = setInterval(() => {
    if (stopped || sessionMaintenance.isRunning()) return;
    const snapshot = status.getSnapshot();
    if (
      recoverCurrentPushSocket &&
      shouldRecoverStaleSmartThingsWebSocket(snapshot)
    ) {
      log.warn("smartthings_websocket_stale_recovery");
      recoverCurrentPushSocket();
    }
    if (snapshot.state === "BROWSER_FAILED" && Date.now() >= nextBrowserRetryAtMs) {
      void restartBrowser();
      return;
    }
    void sessionMaintenance.run(async () => {
      if (stopped) return;
      await reconcileActiveKeeper();
      if (stopped) return;
      await touchAuthenticatedSessionIfDue();
      const manager = currentKeeperManager;
      const context = currentContext;
      const generation = activeContextGeneration;
      if (stopped || !manager || !context) return;
      const beforeRefresh = manager.currentKeeper();
      if (await manager.refreshAuthenticatedSessionIfDue() === "verified" &&
          !stopped && generation === activeContextGeneration &&
          manager === currentKeeperManager && context === currentContext) {
        await reconcileActiveKeeper();
        await persistSessionStateIfHealthy(context, sessionStateStore, status, log, "proactive_refresh");
        if (beforeRefresh !== manager.currentKeeper()) {
          void reconciliation.request("reconnect").catch(() => log.warn("session_handoff_inventory_sync_failed"));
        }
      }
    }).catch(() => { log.warn("session_maintenance_failed"); });
  }, deps.config.heartbeatIntervalMs);
  const detailDiscoveryInterval = setInterval(() => {
    void detailDiscovery.runOne().then((result) => {
      if (result !== "failed") return;
      const current = status.getSnapshot();
      status.update({
        detailDiscoveryFailureCount: current.detailDiscoveryFailureCount + 1
      });
      const failure = detailDiscovery.lastFailure();
      log.warn(
        failure
          ? `detail_discovery_failed:${failure.reason}:${failure.deviceId}`
          : "detail_discovery_failed"
      );
    });
  }, DETAIL_DISCOVERY_INTERVAL_MS);
  detailDiscoveryInterval.unref();
  const reconciliationInterval = setInterval(() => {
    if (stopped || !createHealthReport(status.getSnapshot()).ready) return;
    void reconciliation.request("interval").catch(() => {
      const current = status.getSnapshot();
      status.update({ adapterFailureCount: current.adapterFailureCount + 1 });
      if (deps.config.debugProtocolLogging === true) {
        log.warn("advanced_interval_reconciliation_failed");
      }
    });
  }, deps.config.inventoryReconciliationIntervalMs ?? 21_600_000);
  reconciliationInterval.unref();
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
          persistSessionState: async () => undefined,
          heartbeatInterval,
          keeperInterval,
          detailDiscoveryInterval,
          reconciliationInterval,
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

  const canNavigateKeeper = () => !stopped && status.getSnapshot().pendingCommandCount === 0 &&
    !legacyCommandExecutor.hasForegroundOperation() && !legacyCommandExecutor.hasWarmCommandPage();

  const supervisor = new BrowserSupervisor({
    maxRestarts: deps.config.browserMaxRestarts,
    retryDelayMs: deps.config.browserRetryDelayMs ?? 1_000,
    shouldStop: () => stopped,
    launch: async () => {
      let context: ObservableContext | undefined;
      let assigned = false;
      context = (await launchSmartThingsPersistentContext(deps.chromium, paths, {
        onSandboxFallback: () => log.warn("browser_launch:sandbox_fallback")
      })) as ObservableContext;
      if (stopped) {
        await closeContextQuietly(context);
        return context;
      }
      try {
        await restorePersistedSessionIfAvailable(context, sessionStateStore, log);
        if (!(await installCakeClientCapture(context))) {
          log.warn("cake_client_capture_unavailable");
        }
        const keeperManager = new KeeperPageManager(context, {
          verifyRefreshCandidate: async (candidate, target) => {
            const proof = await verifyLocationApplicationSession(candidate, target);
            log.info(`session_application_probe:${JSON.stringify(proof)}`);
            return proof.outcome === "ok";
          },
          onLoginPage: async (page, stage) => {
            const diagnostic = await inspectAuthenticationPage(page);
            log.info(`session_login_page:${JSON.stringify({ stage, ...diagnostic })}`);
          },
          onRecovery: (phase) => log.info(`session_recovery:${JSON.stringify({ phase })}`),
          onSessionProbe: (diagnostic) => log.info(`session_probe:${JSON.stringify(diagnostic)}`),
          canNavigate: canNavigateKeeper
        });
        volatileIdentifiers.reset();
        const recoverSmartThingsWebSocket = await attachContext(
          context,
          keeperManager,
          sink,
          redactor,
          cameraImages,
          volatileIdentifiers,
          status,
          log,
          capturePipeline.resetSnapshotSession,
          () => !stopped && (currentContext === undefined || context === currentContext),
          () => {
            if (context === currentContext && keeperManager === currentKeeperManager) {
              physicalActionProbe.recordBrowserIsolation(
                isProbeBrowserIsolated(context, keeperManager)
              );
            }
          },
          () => {
            const report = createHealthReport(status.getSnapshot());
            return (
              context === currentContext &&
              keeperManager === currentKeeperManager &&
              report.ready &&
              !legacyCommandExecutor.hasWarmCommandPage() &&
              !legacyCommandExecutor.hasForegroundOperation() &&
              !sessionTouchInFlight &&
              isProbeBrowserIsolated(context, keeperManager) &&
              physicalActionProbe.snapshot(getProbeEvidence()).state !== "armed"
            );
          },
          () => {
            void reconciliation.request("reconnect").catch(() => {
              const current = status.getSnapshot();
              status.update({ adapterFailureCount: current.adapterFailureCount + 1 });
              log.warn("advanced_reconnect_reconciliation_failed");
            });
          },
          (snapshot, url) => {
            devices.observeAdvancedDeviceSnapshot(snapshot, {
              // A single observed page is never authoritative after the Advanced
              // endpoint became paginated. Only the merged reconciliation result prunes.
              authoritativeWholeSnapshot: false
            });
            cameraImages.observeInventory(devices.snapshot());
          }
        );
        currentContext = context;
        currentKeeperManager = keeperManager;
        nextSessionTouchAtMs = undefined;
        sessionTouchFailures = 0;
        sessionTouchOperation = undefined;
        sessionTouchInFlight = false;
        status.update({ sessionTouchConsecutiveFailures: 0, sessionTouchLastOutcome: undefined,
          lastSessionTouchAtMs: undefined, lastSessionTouchSuccessAtMs: undefined });
        recoverCurrentPushSocket = recoverSmartThingsWebSocket;
        detailDiscovery.reset();
        await reconciliation.request("startup").catch(() => {
          const current = status.getSnapshot();
          status.update({ adapterFailureCount: current.adapterFailureCount + 1 });
          log.warn("advanced_primary_inventory_sync_failed");
        });
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
      if (!context && !stopped) {
        nextBrowserRetryAtMs = Date.now() + browserRetryDelayMs;
        log.warn(`browser_recovery_scheduled:${browserRetryDelayMs}`);
        browserRetryDelayMs = Math.min(300_000, browserRetryDelayMs * 2);
      }
      if (context && !stopped) {
        nextBrowserRetryAtMs = Number.POSITIVE_INFINITY;
        browserRetryDelayMs = 60_000;
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
          recoverCurrentPushSocket = undefined;
          currentContext = undefined;
          currentKeeperManager = undefined;
          sessionTouchOperation = undefined;
          sessionTouchInFlight = false;
          capturePipeline.reset();
          status.update({
            chromiumRunning: false,
            keeperPresent: false,
            authenticated: false,
            pushConnected: false,
            parserHealthy: false,
            initialSnapshotComplete: false,
            observedDeviceCount: devices.snapshot().devices.length,
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
        const keeperStatus: RuntimeStatusPatch =
          keeperManager.authenticationRecoveryPending()
            ? {
                authenticated: false,
                state: "LOGIN_REQUIRED",
                urlCategory: classifySmartThingsUrl(keeper.url())
              }
            : statusForKeeperUrl(keeper.url());
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

  const touchAuthenticatedSessionIfDue = async () => {
    const keeperManager = currentKeeperManager;
    const context = currentContext;
    const generation = activeContextGeneration;
    const snapshot = status.getSnapshot();
    const now = Date.now();
    const keeper = keeperManager?.currentKeeper();
    if (stopped || !keeperManager || !context || !snapshot.chromiumRunning ||
        !snapshot.keeperPresent || classifySmartThingsUrl(keeper?.url() ?? "") !== "smartthings_location" ||
        !(snapshot.authenticated || keeperManager.authenticationRecoveryPending())) return;
    nextSessionTouchAtMs ??= now + SESSION_TOUCH_INTERVAL_MS;
    // A backwards wall-clock correction must not suspend maintenance indefinitely.
    if (nextSessionTouchAtMs - now > SESSION_TOUCH_INTERVAL_MS) nextSessionTouchAtMs = now + SESSION_TOUCH_INTERVAL_MS;
    if (now < nextSessionTouchAtMs || sessionTouchInFlight) return;
    const operation = Symbol();
    sessionTouchOperation = operation;
    sessionTouchInFlight = true;
    status.update({ lastSessionTouchAtMs: now, sessionTouchCount: (snapshot.sessionTouchCount ?? 0) + 1 });
    try {
      const outcome = await keeperManager.touchAuthenticatedSession();
      if (stopped || generation !== activeContextGeneration || context !== currentContext ||
          keeperManager !== currentKeeperManager || sessionTouchOperation !== operation) return;
      if (outcome === "stale") {
        nextSessionTouchAtMs = Date.now() + 30_000;
        status.update({ sessionTouchLastOutcome: "stale" });
        return;
      }
      const effectiveOutcome = outcome;
      // A live 401 must use the current profile's SSO flow. Replacing shared
      // storage here could roll back freshly rotated cookies in other tabs.
      const sessionStateRecovered = false;
      const finished = Date.now();
      sessionTouchFailures = effectiveOutcome === "failed" ? sessionTouchFailures + 1 : 0;
      const retryMs = effectiveOutcome === "ok" ? SESSION_TOUCH_INTERVAL_MS : effectiveOutcome === "reauth" ? 30_000 :
        Math.min(SESSION_TOUCH_INTERVAL_MS, 30_000 * 2 ** Math.min(4, sessionTouchFailures - 1));
      nextSessionTouchAtMs = finished + retryMs;
      status.update({ sessionTouchLastOutcome: effectiveOutcome, sessionTouchConsecutiveFailures: sessionTouchFailures,
        ...(effectiveOutcome === "ok" ? { lastSessionTouchSuccessAtMs: finished } : {}) });
      log.info(`session_keepalive:${JSON.stringify({ outcome: effectiveOutcome, durationMs: Math.max(0, finished - now),
        consecutiveFailures: sessionTouchFailures, nextCheckInMs: retryMs, sessionStateRecovered })}`);
      if (effectiveOutcome === "ok") {
        if (sessionStateRecovered || !snapshot.authenticated) {
          await reconcileActiveKeeper();
        }
        await persistSessionStateIfHealthy(
          context,
          sessionStateStore,
          status,
          log,
          sessionStateRecovered ? "recovery" : "keepalive"
        );
      } else if (effectiveOutcome === "reauth") {
        status.update({ authenticated: false, state: "LOGIN_REQUIRED" });
      } else if (effectiveOutcome === "failed") {
        // Network/permission/invalid payload failures are NOT a logout signal.
        log.warn("session_touch_failed");
      }
    } finally {
      if (sessionTouchOperation === operation) {
        sessionTouchOperation = undefined;
        sessionTouchInFlight = false;
      }
    }
  };

  const browserStartup = waitForProfileMaintenance(
    paths.dataDir,
    log,
    () => stopped
  )
    .then(restartBrowser)
    .catch(() => {
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
        persistSessionState: persistCurrentSessionState,
        heartbeatInterval,
        keeperInterval,
        detailDiscoveryInterval,
        reconciliationInterval,
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

export type ProfileMaintenanceWaitResult =
  | "not_required"
  | "complete"
  | "failed"
  | "timeout"
  | "stopped";

export interface ProfileMaintenanceWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForProfileMaintenance(
  dataDir: string,
  log: Pick<BridgeRuntimeLog, "info" | "warn">,
  shouldStop: () => boolean = () => false,
  options: ProfileMaintenanceWaitOptions = {}
): Promise<ProfileMaintenanceWaitResult> {
  const requiredPath = join(dataDir, PROFILE_MAINTENANCE_REQUIRED_FILE);
  if (!existsSync(requiredPath)) return "not_required";

  log.info("browser_startup:profile_maintenance_wait");
  const timeoutMs = Math.max(
    0,
    options.timeoutMs ?? PROFILE_MAINTENANCE_WAIT_TIMEOUT_MS
  );
  const pollMs = Math.max(
    1,
    options.pollMs ?? PROFILE_MAINTENANCE_POLL_MS
  );
  const deadline = Date.now() + timeoutMs;

  while (
    existsSync(requiredPath) &&
    !shouldStop() &&
    Date.now() < deadline
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }

  if (shouldStop()) {
    log.info("browser_startup:profile_maintenance_stopped");
    return "stopped";
  }
  if (existsSync(requiredPath)) {
    log.warn("browser_startup:profile_maintenance_timeout");
    return "timeout";
  }
  if (existsSync(join(dataDir, PROFILE_MAINTENANCE_FAILED_FILE))) {
    log.warn("browser_startup:profile_maintenance_failed");
    return "failed";
  }

  log.info("browser_startup:profile_maintenance_complete");
  return "complete";
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
  volatileIdentifiers: VolatileIdentifierMap,
  status: RuntimeStatusStore,
  log: BridgeRuntimeLog,
  resetSnapshotSession: () => void,
  canRecoverSocket: () => boolean,
  onNewPage: () => void,
  canOpenAdvancedSnapshot: () => boolean,
  onRealtimeRecovered: () => void,
  onAdvancedDeviceSnapshot: (snapshot: unknown, url: string) => void
): Promise<() => void> {
  const observedCdpPages = new WeakSet<object>();
  const restoredSettledKeeperPresent = context
    .pages()
    .some((page) => !page.isClosed() && isSettledSmartThingsLocation(page.url()));

  await keeperManager.reconcileRestoredPages();

  let realtime: LocationRealtimeAdapter;
  realtime = new LocationRealtimeAdapter({
    canRecover: canRecoverSocket,
    onRecoveryAttempt: () => {
      resetSnapshotSession();
      status.update({
        pushConnected: false,
        parserHealthy: false,
        initialSnapshotComplete: false,
        lastSnapshotAtMs: undefined,
        lastParserSuccessAtMs: undefined,
        state: "RECONNECTING"
      });
    },
    recover: async () => {
      const keeper = await keeperManager.recoverKeeper();
      if (canRecoverSocket()) {
        status.update({ keeperPresent: true, ...statusForManagedKeeper(keeperManager, keeper) });
      }
    },
    onRecoveryFailed: () => log.warn("smartthings_websocket_recovery_failed"),
    onRecovered: () => {
      const realtimeStatus = realtime.snapshot();
      status.update({
        reconnectCount: realtimeStatus.reconnectCount,
        ...(realtimeStatus.lastReconnectAtMs === undefined
          ? {}
          : { lastReconnectAtMs: realtimeStatus.lastReconnectAtMs })
      });
      onRealtimeRecovered();
    }
  });
  const recoverSmartThingsWebSocket = () => realtime.requestRecovery();
  const observeSmartThingsWebSocketFrame = (direction: "sent" | "received") => {
    if (direction === "received" && canRecoverSocket()) {
      status.update({ lastPushAtMs: Date.now() });
      realtime.observeFrame(direction);
    }
  };

  installBrowserObserver(context, sink, redact, {
    onRawWebSocketFrame: (direction, payload, connectionId) => {
      volatileIdentifiers.observeRawWebSocketFrame(direction, payload);
      cameraImages.observeRawWebSocketFrame(direction, payload, connectionId);
    },
    onRawWebSocketBinaryFrame: (direction, payload, connectionId) => {
      cameraImages.observeRawWebSocketBinaryFrame(direction, payload, connectionId);
    },
    // Context-level Playwright websocket events do not identify their page.
    // Keep received-frame freshness, but handle close recovery only through
    // page-scoped CDP where the persistent keeper can be distinguished.
    onSmartThingsWebSocketFrame: observeSmartThingsWebSocketFrame
  });
  context.on?.("page", (page) => {
    void installCdpForPage(
      context,
      page as BrowserPageLike,
      sink,
      redact,
      observedCdpPages,
      log,
      cameraImages,
      volatileIdentifiers,
      observeSmartThingsWebSocketFrame,
      recoverSmartThingsWebSocket,
      onAdvancedDeviceSnapshot,
      () => keeperManager.currentKeeper() === page
    );
    onNewPage();
  });
  await installCdpForPages(
    context,
    sink,
    redact,
    observedCdpPages,
    log,
    cameraImages,
    volatileIdentifiers,
    observeSmartThingsWebSocketFrame,
    recoverSmartThingsWebSocket,
    onAdvancedDeviceSnapshot,
    (page) => keeperManager.currentKeeper() === page
  );

  let keeper = await keeperManager.ensureKeeper();
  if (restoredSettledKeeperPresent && classifySmartThingsUrl(keeper.url()) === "smartthings_location") {
    keeper = await keeperManager.recoverKeeper();
  }
  status.update({
    browserVersion: safeBrowserVersion(context.browser?.()?.version?.()),
    keeperPresent: true,
    ...statusForManagedKeeper(keeperManager, keeper)
  });
  return recoverSmartThingsWebSocket;
}

async function restorePersistedSessionIfAvailable(
  context: ObservableContext,
  store: EncryptedSessionStateStore,
  log: BridgeRuntimeLog
): Promise<BrowserPageLike | undefined> {
  const state = store.load();
  if (!state || (state.cookies.length === 0 && state.origins.length === 0)) return undefined;
  // Startup-only disaster recovery. Existing tabs/profile state always win over
  // a backup; especially preserve the current Samsung sign-in/challenge state.
  const pages = context.pages().filter((page) => !page.isClosed());
  if (pages.some((page) => page.url() !== "about:blank")) return undefined;
  let page: BrowserPageLike | undefined;
  let created = false;
  try {
    if (!context.storageState) return undefined;
    const currentState = await context.storageState({ indexedDB: true });
    if (!isEmptySessionStorageState(currentState)) {
      log.info("session_state_restore_skipped:profile_present");
      return undefined;
    }
    if (context.pages().some((candidate) => !candidate.isClosed() && candidate.url() !== "about:blank")) return undefined;
    page = pages.find((candidate) => !candidate.isClosed() && candidate.url() === "about:blank");
    if (!page) { page = await context.newPage(); created = true; }
    const restoreMode = await restoreSessionStorageState(context, state);
    if (restoreMode === "legacy" && state.cookies.length > 0) {
      if (!context.addCookies) throw new Error("session_state_restore_unavailable");
      // api-free-audit: encrypted-session-restore
      await context.addCookies(state.cookies);
    }
    await page.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 12_000 });
    if (!(await waitForSettledKeeperPage(page))) throw new Error("session_state_restore_not_settled");
    if (restoreMode === "legacy" && page.evaluate && state.origins.length > 0) {
      await page.evaluate((origins: unknown[]) => {
        for (const origin of origins) {
          if (typeof origin !== "object" || origin === null || Array.isArray(origin)) continue;
          const record = origin as Record<string, unknown>;
          if (record.origin !== location.origin || !Array.isArray(record.localStorage)) continue;
          for (const entry of record.localStorage) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
            const item = entry as Record<string, unknown>;
            if (typeof item.name === "string" && typeof item.value === "string") {
              window.localStorage.setItem(item.name, item.value);
            }
          }
        }
      }, state.origins);
      await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 12_000 });
      if (!(await waitForSettledKeeperPage(page))) throw new Error("session_state_restore_not_settled");
    }
    const candidate = page;
    const verifier = new KeeperPageManager({ pages: () => [candidate], newPage: async () => candidate }, {
      canNavigate: () => false,
      onSessionProbe: (diagnostic) => log.info(`session_probe:${JSON.stringify(diagnostic)}`)
    });
    await verifier.reconcileRestoredPages();
    if (await verifier.touchAuthenticatedSession() !== "ok") throw new Error("session_state_restore_not_verified");
    log.info("session_state_restored");
    return page;
  } catch {
    if (created) await page?.close().catch(() => undefined);
    log.warn("session_state_restore_failed");
    return undefined;
  }
}

async function persistSessionStateIfHealthy(
  context: ObservableContext | undefined,
  store: EncryptedSessionStateStore,
  status: RuntimeStatusStore,
  log: BridgeRuntimeLog,
  reason = "shutdown"
): Promise<void> {
  if (!context?.storageState) return;
  const statusSnapshot = status.getSnapshot();
  if (!statusSnapshot.authenticated || statusSnapshot.sessionTouchLastOutcome !== "ok") return;
  const hasSettledKeeper = context.pages().some((page) => !page.isClosed() &&
    isSettledSmartThingsLocation(page.url()));
  if (!hasSettledKeeper) return;
  try {
    const state = await context.storageState({ indexedDB: true });
    const latest = status.getSnapshot();
    if (!latest.authenticated || latest.sessionTouchLastOutcome !== "ok") return;
    store.save(state);
    log.info("session_state_persisted:" + reason);
  } catch {
    log.warn("session_state_persist_failed");
  }
}

function shouldRecoverStaleSmartThingsWebSocket(
  snapshot: RuntimeStatusSnapshot,
  nowMs = Date.now()
): boolean {
  return (
    snapshot.state === "CONNECTED" &&
    snapshot.authenticated &&
    snapshot.keeperPresent &&
    snapshot.pushConnected &&
    snapshot.parserHealthy &&
    snapshot.initialSnapshotComplete &&
    snapshot.lastPushAtMs !== undefined &&
    nowMs - snapshot.lastPushAtMs > DEFAULT_PUSH_FRESH_MS
  );
}

function isSettledSmartThingsLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return classifySmartThingsUrl(value) === "smartthings_location" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function scheduleAdvancedSnapshotPage(
  state: () => "open" | "wait" | "stop",
  open: () => Promise<void>,
  firstAttempt = true
): void {
  const delayMs = firstAttempt ? 2_000 : 1_000;
  const timer = setTimeout(() => {
    const current = state();
    if (current === "stop") return;
    if (current === "open") {
      void open();
      return;
    }
    scheduleAdvancedSnapshotPage(state, open, false);
  }, delayMs);
  timer.unref();
}

async function installCdpForPages(
  context: ObservableContext,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog,
  cameraImages: CameraImageStore,
  volatileIdentifiers: VolatileIdentifierMap,
  onSmartThingsWebSocketFrame: (direction: "sent" | "received") => void,
  onSmartThingsWebSocketClose: () => void,
  onAdvancedDeviceSnapshot: (snapshot: unknown, url: string) => void,
  isRealtimeKeeper: (page: BrowserPageLike) => boolean
): Promise<void> {
  await Promise.all(
    context.pages().map((page) =>
      installCdpForPage(
        context,
        page,
        sink,
        redact,
        observedCdpPages,
        log,
        cameraImages,
        volatileIdentifiers,
        onSmartThingsWebSocketFrame,
        onSmartThingsWebSocketClose,
        onAdvancedDeviceSnapshot,
        () => isRealtimeKeeper(page)
      )
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
  cameraImages: CameraImageStore,
  volatileIdentifiers: VolatileIdentifierMap,
  onSmartThingsWebSocketFrame: (direction: "sent" | "received") => void,
  onSmartThingsWebSocketClose: () => void,
  onAdvancedDeviceSnapshot: (snapshot: unknown, url: string) => void,
  isRealtimeKeeper: () => boolean
): Promise<void> {
  if (observedCdpPages.has(page) || !context.newCDPSession) {
    return;
  }
  try {
    const session = await context.newCDPSession(page);
    await installCdpNetworkObserver(session, sink, redact, {
      onRawSmartThingsAdvancedDeviceSnapshot: (snapshot) => {
        volatileIdentifiers.observeRawAdvancedDeviceSnapshot(snapshot);
        cameraImages.observeRawAdvancedDeviceSnapshot(snapshot);
      },
      onRawWebSocketFrame: (direction, payload, connectionId) => {
        volatileIdentifiers.observeRawWebSocketFrame(direction, payload);
        cameraImages.observeRawWebSocketFrame(direction, payload, connectionId);
      },
      onRawWebSocketBinaryFrame: (direction, payload, connectionId) => {
        cameraImages.observeRawWebSocketBinaryFrame(direction, payload, connectionId);
      },
      onSmartThingsWebSocketFrame,
      onSmartThingsWebSocketClose: () => {
        if (isRealtimeKeeper()) onSmartThingsWebSocketClose();
      },
      onSmartThingsAdvancedDeviceSnapshot: (snapshot, url) => {
        onAdvancedDeviceSnapshot(snapshot, url);
      }
    });
    observedCdpPages.add(page);
  } catch {
    log.warn("cdp_observer_install_failed");
  }
}

async function observeAdvancedSnapshotPage(
  context: ObservableContext,
  keeperManager: KeeperPageManager,
  sink: CaptureSink,
  redact: (value: unknown) => unknown,
  observedCdpPages: WeakSet<object>,
  log: BridgeRuntimeLog,
  cameraImages: CameraImageStore,
  volatileIdentifiers: VolatileIdentifierMap,
  onSmartThingsWebSocketFrame: (direction: "sent" | "received") => void,
  onSmartThingsWebSocketClose: () => void,
  onAdvancedDeviceSnapshot: (snapshot: unknown, url: string) => void
): Promise<void> {
  let page: BrowserPageLike | undefined;
  let wholeSnapshotSeen = false;
  let resolveWholeSnapshot: (() => void) | undefined;
  const wholeSnapshotObserved = new Promise<void>((resolve) => {
    resolveWholeSnapshot = resolve;
  });
  try {
    page = await keeperManager.openAdvancedPage((created) =>
      installCdpForPage(
        context,
        created,
        sink,
        redact,
        observedCdpPages,
        log,
        cameraImages,
        volatileIdentifiers,
        onSmartThingsWebSocketFrame,
        onSmartThingsWebSocketClose,
        (snapshot, url) => {
          onAdvancedDeviceSnapshot(snapshot, url);
          if (isWholeAdvancedDevicesSnapshotUrl(url)) {
            wholeSnapshotSeen = true;
            resolveWholeSnapshot?.();
          }
        },
        () => false
      )
    );
    await Promise.race([
      wholeSnapshotObserved,
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
    if (wholeSnapshotSeen) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } else if (page) {
      const snapshots = await fetchAdvancedDeviceSnapshotEntries(page);
      for (const { snapshot, url } of snapshots) {
        volatileIdentifiers.observeRawAdvancedDeviceSnapshot(snapshot);
        cameraImages.observeRawAdvancedDeviceSnapshot(snapshot);
        onAdvancedDeviceSnapshot(
          redact(snapshot),
          url
        );
      }
      if (snapshots.length === 0) {
        log.warn("advanced_snapshot_fallback_empty");
      } else {
        log.info(`advanced_snapshot_fallback_loaded:${snapshots.length}`);
      }
    }
  } catch {
    log.warn("advanced_snapshot_observation_failed");
  } finally {
    await page?.close().catch(() => undefined);
  }
}

export function isWholeAdvancedDevicesSnapshotUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(
      ADVANCED_DEVICE_SNAPSHOT_URLS[1],
      "https://my.smartthings.com"
    );
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return false;
    }
    const actualEntries = [...url.searchParams.entries()].sort(compareSearchParam);
    const expectedEntries = [...expected.searchParams.entries()].sort(compareSearchParam);
    return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
  } catch {
    return false;
  }
}

function compareSearchParam(
  left: readonly [string, string],
  right: readonly [string, string]
): number {
  return left[0] === right[0]
    ? left[1].localeCompare(right[1])
    : left[0].localeCompare(right[0]);
}

function advancedCommandCatalogBindings(
  devices: DeviceStore,
  volatileIdentifiers: VolatileIdentifierMap,
  authoritativeDeviceIds: ReadonlySet<string>
): {
  bindings: AdvancedCommandCatalogBinding[];
  unresolvedDeviceIds: Set<string>;
} {
  const bindings: AdvancedCommandCatalogBinding[] = [];
  const unresolvedDeviceIds = new Set<string>();
  for (const device of devices.snapshot().devices) {
    if (!authoritativeDeviceIds.has(device.id)) continue;
    const capabilityBindings = devices.capabilityBindings(device.id);
    if (capabilityBindings.length === 0) continue;
    const rawDeviceId = volatileIdentifiers.rawDeviceId(device.id);
    if (!rawDeviceId) {
      unresolvedDeviceIds.add(device.id);
      continue;
    }
    const deviceBindings: AdvancedCommandCatalogBinding[] = [];
    for (const binding of capabilityBindings) {
      const rawComponent = volatileIdentifiers.rawIdentifier(binding.component);
      const rawCapability = volatileIdentifiers.rawIdentifier(binding.capability);
      const capabilityRole = volatileIdentifiers.semanticIdentifierRole(binding.capability);
      if (!rawComponent || !rawCapability) {
        unresolvedDeviceIds.add(device.id);
        deviceBindings.length = 0;
        break;
      }
      deviceBindings.push({
        deviceId: device.id,
        component: binding.component,
        ...(binding.componentRole ? { componentRole: binding.componentRole } : {}),
        capability: binding.capability,
        ...(capabilityRole === "speechsynthesis" ? { capabilityRole } : {}),
        rawCapability,
        version: binding.version
      });
    }
    bindings.push(...deviceBindings);
  }
  return {
    bindings: bindings.sort((left, right) =>
      [
        left.deviceId.localeCompare(right.deviceId),
        left.component.localeCompare(right.component),
        left.capability.localeCompare(right.capability),
        left.version - right.version
      ].find((result) => result !== 0) ?? 0
    ),
    unresolvedDeviceIds
  };
}

function authoritativeDeviceIdsFromSanitizedSnapshot(
  value: unknown,
  normalizeDeviceId: (deviceId: string) => string
): Set<string> {
  const root = runtimeRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(root?.items)
      ? root.items
      : Array.isArray(root?.devices)
        ? root.devices
        : Array.isArray(root?.data)
          ? root.data
          : [];
  const result = new Set<string>();
  for (const rowValue of rows) {
    const row = runtimeRecord(rowValue);
    const id = typeof row?.deviceId === "string"
      ? row.deviceId
      : typeof row?.device_id === "string"
        ? row.device_id
        : typeof row?.id === "string"
          ? row.id
          : undefined;
    if (id && /^dev_[A-Za-z0-9]{3,64}$/u.test(id)) {
      const normalized = normalizeDeviceId(id);
      if (/^dev_[A-Za-z0-9]{3,64}$/u.test(normalized)) result.add(normalized);
    }
  }
  return result;
}

function runtimeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function createStatusCapturePipeline(
  captures: CaptureStore,
  persistDebugCaptures: boolean,
  status: RuntimeStatusStore,
  protocolIntegrity: ProtocolIntegrityStore | undefined,
  log: BridgeRuntimeLog,
  initiallyProtocolBlocked: boolean,
  physicalActionProbe: PhysicalActionCorrelationProbe,
  devices: DeviceStore,
  cameraImages: CameraImageStore,
  volatileIdentifiers: VolatileIdentifierMap
): { sink: CaptureSink; reset: () => void; resetSnapshotSession: () => void } {
  let analyzer = new ProtocolAnalyzer({ ttlMs: 300_000, maxEntries: 100_000 });
  let protocolFingerprintObserved = false;
  let protocolBlocked = initiallyProtocolBlocked;
  const persistCapture = (record: SanitizedCaptureRecord, force = false): void => {
    if (persistDebugCaptures || force) captures.write(record);
  };
  return {
    resetSnapshotSession: () => {
      physicalActionProbe.fail("runtime_restarted");
      devices.resetSnapshotSession();
      analyzer.resetSnapshotSession();
      protocolFingerprintObserved = false;
    },
    reset: () => {
      physicalActionProbe.fail("runtime_restarted");
      devices.reset();
      cameraImages.reset();
      volatileIdentifiers.reset();
      analyzer.reset();
      analyzer = new ProtocolAnalyzer({ ttlMs: 300_000, maxEntries: 100_000 });
      protocolFingerprintObserved = false;
    },
    sink: {
      write(record) {
        // Live state delivery is authoritative; diagnostics must never sit ahead of SSE publication.
        devices.observe(record);
        const now = Date.now();
        if (record.source === "playwright-websocket-frame" || record.source === "cdp-websocket-frame") {
          const analysis = analyzer.observe(record);
          // Count every delivery in memory, but persist only the first copy of one logical event.
          if (analysis?.kind !== "duplicate") {
            persistCapture(record, analysis?.kind === "protocol_changed");
          }
          const protocol = analyzer.snapshot();
          const current = status.getSnapshot();
          const basePatch: RuntimeStatusPatch = {
            lastFrameAtMs: now,
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
        persistCapture(record);
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

function statusForManagedKeeper(manager: KeeperPageManager, keeper: BrowserPageLike): RuntimeStatusPatch {
  return manager.authenticationRecoveryPending()
    ? { authenticated: false, state: "LOGIN_REQUIRED", urlCategory: classifySmartThingsUrl(keeper.url()) }
    : statusForKeeperUrl(keeper.url());
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
  persistSessionState: () => Promise<void>;
  heartbeatInterval: NodeJS.Timeout;
  keeperInterval: NodeJS.Timeout;
  detailDiscoveryInterval: NodeJS.Timeout;
  reconciliationInterval: NodeJS.Timeout;
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
  clearInterval(options.reconciliationInterval);
  await Promise.allSettled([options.persistSessionState()]);
  const context = options.getContext();
  if (context) {
    await closeContextQuietly(context);
  }
  // Let accepted HTTP commands finish before draining the latest state cache.
  // Identity/capture stores remain available until those commands have left.
  await Promise.allSettled([options.server.close()]);
  await Promise.allSettled([Promise.resolve().then(() => options.devices.close())]);
  await Promise.allSettled([
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
