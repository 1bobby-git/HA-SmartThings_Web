import { createHash } from "node:crypto";

import type { SnapshotCategory } from "./snapshot-detector.js";

export const PROTOCOL_CONTRACT_VERSION = 5;

export interface ProtocolIntegrityState {
  schema_version: 1;
  protocol_contract_version: number;
  baseline: null;
  current: null;
  change_count: 0;
  mismatch_keys: ProtocolMismatchSurface[];
  last_mismatch: null;
}

export const REQUIRED_PROTOCOL_SURFACES = [
  "snapshot:locations:v1",
  "snapshot:rooms:v1",
  "snapshot:device_cards:v1",
  "snapshot:device_states:v1",
  "snapshot:device_health:v1",
  "snapshot:scenes:v1",
  "event:device_event:v1"
] as const;

export type SafeProtocolSurface = (typeof REQUIRED_PROTOCOL_SURFACES)[number];

export type ProtocolMismatchSurface =
  | `snapshot:${SnapshotCategory}:response_shape`
  | "event:device_event:identity";

export const PROTOCOL_CONTRACT_FINGERPRINT = protocolContractFingerprint(
  REQUIRED_PROTOCOL_SURFACES
);

export function snapshotProtocolSurface(category: SnapshotCategory): SafeProtocolSurface {
  return `snapshot:${category}:v1` as SafeProtocolSurface;
}

export function protocolContractFingerprint(surfaces: readonly string[]): string {
  const canonical = JSON.stringify([...new Set(surfaces)].sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export function createInitialProtocolIntegrityState(): ProtocolIntegrityState {
  return {
    schema_version: 1,
    protocol_contract_version: PROTOCOL_CONTRACT_VERSION,
    baseline: null,
    current: null,
    change_count: 0,
    mismatch_keys: [],
    last_mismatch: null
  };
}
