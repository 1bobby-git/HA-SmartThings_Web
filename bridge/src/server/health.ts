import { MAX_CLOCK_SKEW_MS, type RuntimeStatusSnapshot } from "../state/runtime-state.js";

export interface HealthReportOptions {
  nowMs?: number;
  heartbeatFreshMs?: number;
  pushFreshMs?: number;
}

export interface HealthDetails {
  state: RuntimeStatusSnapshot["state"];
  urlCategory: RuntimeStatusSnapshot["urlCategory"];
  activeConnections: number;
  observedDeviceCount: number;
  decodedDeviceEventCount: number;
  uniqueLogicalEventCount: number;
  duplicateEventCount: number;
  dedupeJournalSize: number;
  protocolInvalidFrameCount: number;
  detailDiscoveryFailureCount: number;
  protocolChangeCount: number;
  protocolMismatchSurface?: RuntimeStatusSnapshot["protocolMismatchSurface"];
  restartCount: number;
  architectureVersion: string;
  advancedInventoryDeviceCount: number;
  advancedInventoryLocationCount: number;
  advancedInventoryPageCount: number;
  adapterFailureCount: number;
  pendingCommandCount: number;
  domFallbackCount: number;
  reconnectCount: number;
  lastReconnectAtMs?: number;
  lastCommandTransport?: string;
  lastCommandConfirmation?: string;
  bridgeVersion: string;
  browserVersion: string;
  protocolVersion: string;
  heartbeatAgeMs: number;
  snapshotAgeMs: number;
  initialSnapshotAgeMs?: number;
  lastSnapshotAgeMs?: number;
  frameAgeMs?: number;
  eventAgeMs?: number;
  parserAgeMs?: number;
  pushAgeMs?: number;
  browserUptimeMs?: number;
}

type HealthDetailsDraft = {
  [Key in keyof HealthDetails]: HealthDetails[Key] | undefined;
};

export interface HealthReport {
  live: boolean;
  ready: boolean;
  details: HealthDetails;
}

const DEFAULT_HEARTBEAT_FRESH_MS = 31_000;
export const DEFAULT_PUSH_FRESH_MS = 120_000;

export function createHealthReport(
  snapshot: RuntimeStatusSnapshot,
  options: HealthReportOptions = {}
): HealthReport {
  const nowMs = options.nowMs ?? Date.now();
  const heartbeatFreshMs = options.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS;
  const pushFreshMs = options.pushFreshMs ?? DEFAULT_PUSH_FRESH_MS;
  const heartbeatAgeMs = ageMs(nowMs, snapshot.heartbeatAtMs);
  const snapshotAgeMs = ageMs(nowMs, snapshot.updatedAtMs);
  const initialSnapshotAgeMs = optionalAgeMs(nowMs, snapshot.initialSnapshotCompletedAtMs);
  const lastSnapshotAgeMs = optionalAgeMs(nowMs, snapshot.lastSnapshotAtMs);
  const frameAgeMs = optionalAgeMs(nowMs, snapshot.lastFrameAtMs);
  const eventAgeMs = optionalAgeMs(nowMs, snapshot.lastEventAtMs);
  const parserAgeMs = optionalAgeMs(nowMs, snapshot.lastParserSuccessAtMs);
  const pushAgeMs = optionalAgeMs(nowMs, snapshot.lastPushAtMs);
  const browserUptimeMs = optionalAgeMs(nowMs, snapshot.lastBrowserStartAtMs);

  const live =
    snapshot.dbAvailable &&
    !isFutureBeyondSkew(nowMs, snapshot.heartbeatAtMs) &&
    heartbeatAgeMs <= heartbeatFreshMs;
  const initialSnapshotCurrent =
    snapshot.initialSnapshotComplete &&
    snapshot.initialSnapshotCompletedAtMs !== undefined &&
    snapshot.lastSnapshotAtMs !== undefined &&
    !isFutureBeyondSkew(nowMs, snapshot.initialSnapshotCompletedAtMs) &&
    !isFutureBeyondSkew(nowMs, snapshot.lastSnapshotAtMs) &&
    snapshot.lastSnapshotAtMs <= snapshot.updatedAtMs + MAX_CLOCK_SKEW_MS;
  const pushCurrent =
    snapshot.pushConnected &&
    pushAgeMs !== undefined &&
    snapshot.lastPushAtMs !== undefined &&
    !isFutureBeyondSkew(nowMs, snapshot.lastPushAtMs) &&
    pushAgeMs <= pushFreshMs;
  const parserCurrent =
    snapshot.parserHealthy &&
    snapshot.lastParserSuccessAtMs !== undefined &&
    !isFutureBeyondSkew(nowMs, snapshot.lastParserSuccessAtMs);

  const ready =
    live &&
    snapshot.chromiumRunning &&
    snapshot.keeperPresent &&
    snapshot.authenticated &&
    pushCurrent &&
    initialSnapshotCurrent &&
    parserCurrent;

  return {
    live,
    ready,
    details: stripUndefined({
      state: snapshot.state,
      urlCategory: snapshot.urlCategory,
      activeConnections: snapshot.activeConnections,
      observedDeviceCount: snapshot.observedDeviceCount,
      decodedDeviceEventCount: snapshot.decodedDeviceEventCount,
      uniqueLogicalEventCount: snapshot.uniqueLogicalEventCount,
      duplicateEventCount: snapshot.duplicateEventCount,
      dedupeJournalSize: snapshot.dedupeJournalSize,
      protocolInvalidFrameCount: snapshot.protocolInvalidFrameCount,
      detailDiscoveryFailureCount: snapshot.detailDiscoveryFailureCount,
      protocolChangeCount: snapshot.protocolChangeCount,
      protocolMismatchSurface: snapshot.protocolMismatchSurface,
      restartCount: snapshot.restartCount,
      architectureVersion: snapshot.architectureVersion,
      advancedInventoryDeviceCount: snapshot.advancedInventoryDeviceCount,
      advancedInventoryLocationCount: snapshot.advancedInventoryLocationCount,
      advancedInventoryPageCount: snapshot.advancedInventoryPageCount,
      adapterFailureCount: snapshot.adapterFailureCount,
      pendingCommandCount: snapshot.pendingCommandCount,
      domFallbackCount: snapshot.domFallbackCount,
      reconnectCount: snapshot.reconnectCount,
      lastReconnectAtMs: snapshot.lastReconnectAtMs,
      lastCommandTransport: snapshot.lastCommandTransport,
      lastCommandConfirmation: snapshot.lastCommandConfirmation,
      bridgeVersion: snapshot.bridgeVersion,
      browserVersion: snapshot.browserVersion,
      protocolVersion: snapshot.protocolVersion,
      heartbeatAgeMs,
      snapshotAgeMs,
      initialSnapshotAgeMs,
      lastSnapshotAgeMs,
      frameAgeMs,
      eventAgeMs,
      parserAgeMs,
      pushAgeMs,
      browserUptimeMs
    })
  };
}

function ageMs(nowMs: number, atMs: number): number {
  return Math.max(0, nowMs - atMs);
}

function isFutureBeyondSkew(nowMs: number, atMs: number): boolean {
  return atMs > nowMs + MAX_CLOCK_SKEW_MS;
}

function optionalAgeMs(nowMs: number, atMs: number | undefined): number | undefined {
  return atMs === undefined ? undefined : ageMs(nowMs, atMs);
}

function stripUndefined(details: HealthDetailsDraft): HealthDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined)
  ) as unknown as HealthDetails;
}
