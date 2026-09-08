import type { DeviceStore, BridgeDevice, BridgeDeviceState } from "../state/device-store.js";
import type { CommandResyncEvidence } from "./command-service.js";
import { LIGHT_PROOF_MAX_AGE_MS } from "./light-dispatch-cache.js";
import type { VerifiedLightPlan } from "./light-plan.js";

export type LightDispatchPreview = (deviceId: string, locationId: string) => Promise<CommandResyncEvidence | undefined>;

/** Enumerated diagnostics only; no raw identifiers, values or auth data. */
export type LightPreflightReason =
  | "not_applicable" | "power_not_on" | "revision_unavailable" | "cancelled"
  | "read_unavailable" | "read_too_slow" | "proof_invalid" | "target_mismatch"
  | "revision_changed" | "power_missing" | "power_source_mismatch"
  | "power_value_mismatch" | "power_unit_mismatch" | "power_component_role_mismatch" | "power_capability_role_mismatch" | "power_timestamp_invalid"
  | "power_timestamp_older" | "corroboration_failed" | "pruned" | "pruned_corroborated";

type Agreement = "ok" | "missing" | "source_mismatch" | "value_mismatch" |
  "unit_mismatch" | "component_role_mismatch" | "capability_role_mismatch" | "timestamp_invalid" | "timestamp_older" | "corroborate";

/** Prune only redundant power/brightness proven by exact reads and unchanged
 * observed state. Never omit a color-mode setter or a power-only operation.
 * A preview is not published and cannot confirm the command.
 */
export async function prepareLightDispatch(
  devices: DeviceStore, device: BridgeDevice, plan: VerifiedLightPlan,
  preview?: LightDispatchPreview, signal?: AbortSignal, recentProof?: CommandResyncEvidence
): Promise<{ actions: VerifiedLightPlan["actions"]; skippedCommands: string[]; preflightMs: number;
  preflightSource?: "recent_read" | "live_read"; previewFailed?: boolean;
  preflightReason: LightPreflightReason; preflightReads: number }> {
  const unchanged = { actions: plan.actions, skippedCommands: [] as string[], preflightMs: 0,
    preflightReason: "not_applicable" as LightPreflightReason, preflightReads: 0 };
  const power = plan.actions[0];
  if ((!preview && !recentProof) || signal?.aborted || !power || power.command !== "on" || plan.actions.length < 2) return unchanged;
  const before = devices.commandStates(device.id, device.locationId);
  const powerState = exact(before, power.component, power.capability, "switch");
  if (powerState?.value !== "on") return { ...unchanged, preflightReason: "power_not_on" };
  const revision = devices.commandStateRevision(device.id, device.locationId);
  if (revision === undefined) return { ...unchanged, preflightReason: "revision_unavailable" };
  const start = Date.now(), monotonicStart = performance.now();
  const elapsed = () => Math.max(0, Date.now() - start, performance.now() - monotonicStart);
  let preflightReads = recentProof ? 0 : 1;
  const proof = recentProof ?? await boundedPreview(() => preview!(device.id, device.locationId), signal);
  const preflightSource = recentProof ? "recent_read" as const : "live_read" as const;
  const fallback = (preflightReason: LightPreflightReason, previewFailed = false) => ({
    ...unchanged, preflightMs: Math.max(0, Date.now() - start), preflightSource, preflightReason, preflightReads, previewFailed
  });
  const invalidProof = (p: CommandResyncEvidence | undefined, earliest: number): LightPreflightReason | undefined => {
    if (signal?.aborted) return "cancelled";
    if (elapsed() > 400) return "read_too_slow";
    if (!p) return "read_unavailable";
    if (p.deviceId !== device.id || p.locationId !== device.locationId) return "target_mismatch";
    if (p.source !== "advanced_device_status" || p.authoritativeSnapshot ||
        !Number.isFinite(p.startedAtMs) || p.startedAtMs < earliest || p.startedAtMs > Date.now() ||
        !Array.isArray(p.observedStates)) return "proof_invalid";
    if (devices.commandStateRevision(device.id, device.locationId) !== revision) return "revision_changed";
    return undefined;
  };
  const invalid = invalidProof(proof, start - (recentProof ? LIGHT_PROOF_MAX_AGE_MS : 0));
  if (invalid) return fallback(invalid, invalid === "read_unavailable" || invalid === "read_too_slow");
  const agrees = (component: string, capability: string, attribute: string, value: unknown): Agreement => {
    const old = exact(before, component, capability, attribute);
    const read = exact(proof!.observedStates!, component, capability, attribute);
    if (!old || !read) return "missing";
    if (read.source !== "COMMAND_STATUS_RECHECK") return "source_mismatch";
    if (old.value !== value || read.value !== value) return "value_mismatch";
    const metadataError = metadataMismatch(old, read);
    if (metadataError) return metadataError;
    if (read.updatedAt === null) return "ok";
    const at = Date.parse(read.updatedAt);
    if (!Number.isFinite(at) || (old.updatedAt !== null && !Number.isFinite(Date.parse(old.updatedAt)))) return "timestamp_invalid";
    if (old.updatedAt === null || at >= Date.parse(old.updatedAt)) return "ok";
    // A location event's event time and an Advanced attribute timestamp are
    // different observations. Do not lower the store watermark or trust one old
    // response: a second exact GET must independently corroborate the SAME value.
    return old.source === "LOCATION_EVENT" ? "corroborate" : "timestamp_older";
  };
  const powerAgreement = agrees(power.component, power.capability, "switch", "on");
  if (powerAgreement !== "ok" && powerAgreement !== "corroborate") return fallback(`power_${powerAgreement}`);
  const hasModeSetter = plan.actions.some((action) =>
    ["setColor", "setColorTemperature", "setHue", "setSaturation"].includes(action.command));
  const level = hasModeSetter ? plan.actions.find((a) => a.command === "setLevel" && a.arguments.length === 1) : undefined;
  const levelAgreement = level ? agrees(level.component, level.capability, "level", level.arguments[0]) : undefined;
  let corroborated: CommandResyncEvidence | undefined;
  if ((powerAgreement === "corroborate" || levelAgreement === "corroborate") && preview) {
    const remainingMs = 400 - elapsed();
    if (remainingMs <= 0) return fallback("read_too_slow", true);
    const secondStart = Date.now();
    preflightReads++;
    corroborated = await boundedPreview(() => preview(device.id, device.locationId), signal, remainingMs);
    const secondInvalid = invalidProof(corroborated, secondStart);
    if (secondInvalid) return fallback(secondInvalid, secondInvalid === "read_unavailable" || secondInvalid === "read_too_slow");
  }
  const corroborates = (component: string, capability: string, attribute: string) => {
    const first = exact(proof!.observedStates!, component, capability, attribute);
    const second = exact(corroborated?.observedStates ?? [], component, capability, attribute);
    return !!first && !!second && second.source === "COMMAND_STATUS_RECHECK" &&
      first.value === second.value && first.updatedAt === second.updatedAt && sameMetadata(first, second);
  };
  if (powerAgreement === "corroborate" && !corroborates(power.component, power.capability, "switch")) return fallback("corroboration_failed");
  // If a second read contradicts any skipped target, retain that target. Power
  // disagreement invalidates the entire optimization, including brightness.
  if (corroborated && !corroborates(power.component, power.capability, "switch")) return fallback("corroboration_failed");
  const skippedCommands = ["on"];
  const actions = plan.actions.slice(1).filter((action) => {
    if (action === level && (levelAgreement === "ok" || (levelAgreement === "corroborate" && corroborated)) &&
        (!corroborated || corroborates(action.component, action.capability, "level"))) {
      skippedCommands.push("setLevel"); return false;
    }
    return true;
  });
  return { actions, skippedCommands, preflightMs: Math.max(0, Date.now() - start), preflightSource,
    preflightReason: corroborated ? "pruned_corroborated" : "pruned", preflightReads };
}

/** Roles are descriptive and may differ only in case between inventory and
 * status. IDs, units, explicit role conflicts and values still compare exactly.
 */
function sameMetadata(a: BridgeDeviceState, b: BridgeDeviceState): boolean {
  return metadataMismatch(a, b) === undefined;
}

function metadataMismatch(a: BridgeDeviceState, b: BridgeDeviceState):
  "unit_mismatch" | "component_role_mismatch" | "capability_role_mismatch" | undefined {
  const role = (value: string | undefined) => value?.trim().toLowerCase();
  if (a.unit !== b.unit) return "unit_mismatch";
  if (role(a.componentRole) !== role(b.componentRole)) return "component_role_mismatch";
  if (role(a.capabilityRole) !== role(b.capabilityRole)) return "capability_role_mismatch";
  return undefined;
}

function exact(states: readonly BridgeDeviceState[], component: string, capability: string, attribute: string) {
  const matches = states.filter((state) => state.component === component &&
    state.capability === capability && state.attribute === attribute);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Bound even a faulty custom reader. Late read results have no store side effects. */
async function boundedPreview(read: () => Promise<CommandResyncEvidence | undefined>, signal?: AbortSignal, budgetMs = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => signal?.aborted ? undefined : read()).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        timer = setTimeout(abort, budgetMs);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
