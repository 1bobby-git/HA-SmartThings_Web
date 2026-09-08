import type { BridgeDevice, DeviceStore } from "../state/device-store.js";
import type { CommandResyncEvidence } from "./command-service.js";

export const LIGHT_PROOF_MAX_AGE_MS = 1_000;
const PREVIEW_BACKOFF_MS = 5_000;
const LIMIT = 128;
type Entry = { token: symbol; scope: unknown; proof?: CommandResyncEvidence;
  revision?: number; proofCapturedAt?: number; proofAgeAtCapture?: number; retryAt: number; updatedAt: number };

/** Ephemeral, consume-once evidence from a successful command's actual status GET.
 * Never persists desired values or turns a pre-command observation into success.
 */
export class LightDispatchCache {
  readonly #entries = new Map<string, Entry>();
  constructor(private readonly devices: DeviceStore) {}

  clear(): void { this.#entries.clear(); }
  invalidate(deviceId: string): void { this.#entries.delete(deviceId); }

  begin(device: BridgeDevice, scope: unknown) {
    const now = Date.now(), old = this.#entries.get(device.id);
    const sameScope = old && old.scope === scope && now >= old.updatedAt;
    const age = old?.proof ? Math.max(now - old.proof.startedAtMs,
      performance.now() - (old.proofCapturedAt ?? -Infinity) + (old.proofAgeAtCapture ?? Infinity)) : Infinity;
    const proof = sameScope && age >= 0 && age <= LIGHT_PROOF_MAX_AGE_MS &&
      old.proof?.locationId === device.locationId &&
      old.revision !== undefined && old.revision === this.devices.commandStateRevision(device.id, device.locationId)
      ? old.proof : undefined;
    const entry: Entry = { token: Symbol(), scope, retryAt: sameScope ? old.retryAt : 0, updatedAt: now };
    this.#entries.delete(device.id); this.#entries.set(device.id, entry);
    while (this.#entries.size > LIMIT) this.#entries.delete(this.#entries.keys().next().value!);
    return { token: entry.token, proof, skipPreview: now < entry.retryAt };
  }

  remember(device: BridgeDevice, token: symbol, proof: CommandResyncEvidence, revision: number | undefined): void {
    const entry = this.#entries.get(device.id), now = Date.now();
    if (!entry || entry.token !== token || revision === undefined ||
        revision !== this.devices.commandStateRevision(device.id, device.locationId) ||
        proof.source !== "advanced_device_status" || proof.authoritativeSnapshot ||
        proof.deviceId !== device.id || proof.locationId !== device.locationId ||
        !Number.isFinite(proof.startedAtMs) || now < proof.startedAtMs ||
        now - proof.startedAtMs > LIGHT_PROOF_MAX_AGE_MS || !proof.observedStates?.length) return;
    entry.proof = structuredClone(proof); entry.revision = revision; entry.updatedAt = now;
    entry.proofCapturedAt = performance.now(); entry.proofAgeAtCapture = now - proof.startedAtMs;
  }

  previewFailed(deviceId: string, token: symbol): void {
    const entry = this.#entries.get(deviceId);
    if (entry?.token === token) { entry.retryAt = Date.now() + PREVIEW_BACKOFF_MS; entry.updatedAt = Date.now(); }
  }
}
