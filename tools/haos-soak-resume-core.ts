import { parseSoakObservation, type SoakObservation } from "./haos-soak-core.js";
import {
  parseSoakRunMetadata,
  type SoakRunMetadata
} from "./haos-soak-deployment-gate-core.js";

export const SOAK_COLLECTOR_LOCK_NAME = ".collector.lock";
export const SOAK_COLLECTOR_CONFIG_NAME = "collector-config.json";
export const MAX_SOAK_OBSERVATION_LOG_BYTES = 16 * 1_024 * 1_024;

const MAX_OBSERVATION_LINE_BYTES = 32 * 1_024;
const LOCK_KEYS = new Set(["schemaVersion", "pid", "createdAt"]);
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "mode",
  "sshTarget",
  "vmId",
  "addonSlug",
  "bridgeUrl",
  "bridgeTokenFile",
  "maxMemoryGrowthBytes"
]);

export interface SoakCollectorLock {
  schemaVersion: 1;
  pid: number;
  createdAt: string;
}

export type SoakCollectorConfig = QgaSoakCollectorConfig | LocalBridgeSoakCollectorConfig;

export interface QgaSoakCollectorConfig {
  schemaVersion: 1;
  mode: "qga";
  sshTarget: string;
  vmId: number;
  addonSlug: string;
  maxMemoryGrowthBytes: number;
}

export interface LocalBridgeSoakCollectorConfig {
  schemaVersion: 1;
  mode: "local_bridge";
  bridgeUrl: string;
  bridgeTokenFile: string;
  maxMemoryGrowthBytes: number;
}

export interface SoakResumeState {
  metadata: SoakRunMetadata;
  observations: SoakObservation[];
  startedAtMs: number;
  expectedEndAtMs: number;
  nextSampleAtMs: number;
}

export function createSoakCollectorLock(pid: number, createdAtMs: number): SoakCollectorLock {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(createdAtMs)) {
    throw new Error("soak_collector_lock_invalid");
  }
  return {
    schemaVersion: 1,
    pid,
    createdAt: new Date(createdAtMs).toISOString()
  };
}

export function parseSoakCollectorLock(text: string): SoakCollectorLock {
  if (Buffer.byteLength(text, "utf8") > 1_024) {
    throw new Error("soak_collector_lock_invalid");
  }
  try {
    const record = requireRecord(JSON.parse(text) as unknown);
    assertExactKeys(record, LOCK_KEYS);
    if (
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.pid) ||
      Number(record.pid) <= 0 ||
      typeof record.createdAt !== "string" ||
      new Date(record.createdAt).toISOString() !== record.createdAt
    ) {
      throw new Error("invalid lock");
    }
    return {
      schemaVersion: 1,
      pid: Number(record.pid),
      createdAt: record.createdAt
    };
  } catch {
    throw new Error("soak_collector_lock_invalid");
  }
}

export function createSoakCollectorConfig(input: {
  mode?: "qga";
  sshTarget: string;
  vmId: number;
  addonSlug: string;
  maxMemoryGrowthBytes: number;
} | {
  mode: "local_bridge";
  bridgeUrl: string;
  bridgeTokenFile: string;
  maxMemoryGrowthBytes: number;
}): SoakCollectorConfig {
  return parseSoakCollectorConfig(JSON.stringify({ schemaVersion: 1, mode: "qga", ...input }));
}

export function parseSoakCollectorConfig(text: string): SoakCollectorConfig {
  if (Buffer.byteLength(text, "utf8") > 4_096) {
    throw new Error("soak_collector_config_invalid");
  }
  try {
    const record = requireRecord(JSON.parse(text) as unknown);
    assertAllowedKeys(record, CONFIG_KEYS);
    const mode = record.mode ?? "qga";
    if (
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.maxMemoryGrowthBytes) ||
      Number(record.maxMemoryGrowthBytes) < 0
    ) {
      throw new Error("invalid config");
    }
    if (mode === "qga") {
      assertExactKeys(record, new Set(["schemaVersion", "mode", "sshTarget", "vmId", "addonSlug", "maxMemoryGrowthBytes"]), true);
      if (
        typeof record.sshTarget !== "string" ||
        !/^[A-Za-z0-9_.-]{1,120}$/u.test(record.sshTarget) ||
        !Number.isSafeInteger(record.vmId) ||
        Number(record.vmId) <= 0 ||
        typeof record.addonSlug !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/u.test(record.addonSlug)
      ) {
        throw new Error("invalid config");
      }
      return {
        schemaVersion: 1,
        mode: "qga",
        sshTarget: record.sshTarget,
        vmId: Number(record.vmId),
        addonSlug: record.addonSlug,
        maxMemoryGrowthBytes: Number(record.maxMemoryGrowthBytes)
      };
    }
    if (mode === "local_bridge") {
      assertExactKeys(record, new Set(["schemaVersion", "mode", "bridgeUrl", "bridgeTokenFile", "maxMemoryGrowthBytes"]));
      if (
        typeof record.bridgeUrl !== "string" ||
        !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(record.bridgeUrl) ||
        typeof record.bridgeTokenFile !== "string" ||
        !/^[/A-Za-z]:?[/\\A-Za-z0-9_. -]{1,260}$/u.test(record.bridgeTokenFile)
      ) {
        throw new Error("invalid config");
      }
      return {
        schemaVersion: 1,
        mode: "local_bridge",
        bridgeUrl: record.bridgeUrl,
        bridgeTokenFile: record.bridgeTokenFile,
        maxMemoryGrowthBytes: Number(record.maxMemoryGrowthBytes)
      };
    }
    throw new Error("invalid config");
  } catch {
    throw new Error("soak_collector_config_invalid");
  }
}

export function parseSoakObservationLog(text: string): SoakObservation[] {
  if (Buffer.byteLength(text, "utf8") > MAX_SOAK_OBSERVATION_LOG_BYTES) {
    throw new Error("soak_resume_samples_invalid");
  }
  if (text === "") {
    return [];
  }
  if (!text.endsWith("\n")) {
    throw new Error("soak_resume_samples_invalid");
  }
  const lines = text.slice(0, -1).split("\n");
  const observations: SoakObservation[] = [];
  try {
    for (const line of lines) {
      if (line.length === 0 || Buffer.byteLength(line, "utf8") > MAX_OBSERVATION_LINE_BYTES) {
        throw new Error("invalid line");
      }
      observations.push(parseSoakObservation(JSON.parse(line) as unknown));
    }
  } catch {
    throw new Error("soak_resume_samples_invalid");
  }
  return observations;
}

export function createSoakResumeState(input: {
  metadataText: string;
  observationsText: string;
  requestedDurationMs: number;
  requestedIntervalMs: number;
}): SoakResumeState {
  const metadata = parseSoakRunMetadata(input.metadataText);
  if (
    metadata.status === "completed" ||
    metadata.durationMs !== input.requestedDurationMs ||
    metadata.intervalMs !== input.requestedIntervalMs
  ) {
    throw new Error("soak_resume_metadata_mismatch");
  }
  const startedAtMs = Date.parse(metadata.startedAt);
  const expectedEndAtMs = Date.parse(metadata.expectedEndAt);
  if (
    !Number.isSafeInteger(startedAtMs) ||
    !Number.isSafeInteger(expectedEndAtMs) ||
    expectedEndAtMs !== startedAtMs + metadata.durationMs
  ) {
    throw new Error("soak_resume_metadata_mismatch");
  }
  const observations = parseSoakObservationLog(input.observationsText);
  const lastObservation = observations.at(-1);
  const lastSampleAtMs = lastObservation ? Date.parse(lastObservation.sampledAt) : undefined;
  if (
    lastSampleAtMs !== undefined &&
    (!Number.isSafeInteger(lastSampleAtMs) || lastSampleAtMs < startedAtMs)
  ) {
    throw new Error("soak_resume_samples_invalid");
  }
  return {
    metadata,
    observations,
    startedAtMs,
    expectedEndAtMs,
    nextSampleAtMs:
      lastSampleAtMs === undefined ? startedAtMs : lastSampleAtMs + metadata.intervalMs
  };
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  allowMissingMode = false
): void {
  const keys = Object.keys(record);
  const expectedSize = allowMissingMode && record.mode === undefined ? allowed.size - 1 : allowed.size;
  if (keys.some((key) => !allowed.has(key)) || keys.length !== expectedSize) {
    throw new Error("unexpected keys");
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("unexpected keys");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}
