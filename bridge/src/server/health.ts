import type { RuntimeStatusSnapshot } from "../state/runtime-state.js";

export interface HealthReportOptions {
  nowMs?: number;
  heartbeatFreshMs?: number;
  snapshotFreshMs?: number;
}

export interface HealthDetails {
  state: RuntimeStatusSnapshot["state"];
  urlCategory: RuntimeStatusSnapshot["urlCategory"];
  activeConnections: number;
  observedDeviceCount: number;
  protocolChangeCount: number;
  restartCount: number;
  bridgeVersion: string;
  protocolVersion: string;
  heartbeatAgeMs: number;
  snapshotAgeMs: number;
  initialSnapshotAgeMs?: number;
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
const DEFAULT_SNAPSHOT_FRESH_MS = 60_000;

export function createHealthReport(
  snapshot: RuntimeStatusSnapshot,
  options: HealthReportOptions = {}
): HealthReport {
  const nowMs = options.nowMs ?? Date.now();
  const heartbeatFreshMs = options.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS;
  const snapshotFreshMs = options.snapshotFreshMs ?? DEFAULT_SNAPSHOT_FRESH_MS;
  const heartbeatAgeMs = ageMs(nowMs, snapshot.heartbeatAtMs);
  const snapshotAgeMs = ageMs(nowMs, snapshot.updatedAtMs);
  const initialSnapshotAgeMs = optionalAgeMs(nowMs, snapshot.initialSnapshotCompletedAtMs);
  const parserAgeMs = optionalAgeMs(nowMs, snapshot.lastParserSuccessAtMs);
  const pushAgeMs = optionalAgeMs(nowMs, snapshot.lastPushAtMs);
  const browserUptimeMs = optionalAgeMs(nowMs, snapshot.lastBrowserStartAtMs);

  const live = snapshot.dbAvailable && heartbeatAgeMs <= heartbeatFreshMs;
  const initialSnapshotFresh =
    snapshot.initialSnapshotComplete &&
    initialSnapshotAgeMs !== undefined &&
    initialSnapshotAgeMs <= snapshotFreshMs;

  const ready =
    live &&
    snapshot.chromiumRunning &&
    snapshot.keeperPresent &&
    snapshot.authenticated &&
    snapshot.pushConnected &&
    initialSnapshotFresh &&
    snapshot.parserHealthy;

  return {
    live,
    ready,
    details: stripUndefined({
      state: snapshot.state,
      urlCategory: snapshot.urlCategory,
      activeConnections: snapshot.activeConnections,
      observedDeviceCount: snapshot.observedDeviceCount,
      protocolChangeCount: snapshot.protocolChangeCount,
      restartCount: snapshot.restartCount,
      bridgeVersion: snapshot.bridgeVersion,
      protocolVersion: snapshot.protocolVersion,
      heartbeatAgeMs,
      snapshotAgeMs,
      initialSnapshotAgeMs,
      parserAgeMs,
      pushAgeMs,
      browserUptimeMs
    })
  };
}

function ageMs(nowMs: number, atMs: number): number {
  return Math.max(0, nowMs - atMs);
}

function optionalAgeMs(nowMs: number, atMs: number | undefined): number | undefined {
  return atMs === undefined ? undefined : ageMs(nowMs, atMs);
}

function stripUndefined(details: HealthDetailsDraft): HealthDetails {
  return Object.fromEntries(
    Object.entries(details).filter(([, value]) => value !== undefined)
  ) as unknown as HealthDetails;
}
