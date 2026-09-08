import type { DeviceStore, BridgeDevice, BridgeDeviceState } from "../state/device-store.js";
import type { CommandResyncEvidence } from "./command-service.js";
import { LIGHT_PROOF_MAX_AGE_MS } from "./light-dispatch-cache.js";
import type { VerifiedLightPlan } from "./light-plan.js";

export type LightDispatchPreview = (deviceId: string, locationId: string) => Promise<CommandResyncEvidence | undefined>;

/** Prune only redundant power/brightness proven by an exact GET and the
 * unchanged observed cache. Never omit a color-mode setter or a power-only
 * operation. This preview is not published and cannot confirm the command.
 */
export async function prepareLightDispatch(
  devices: DeviceStore, device: BridgeDevice, plan: VerifiedLightPlan,
  preview?: LightDispatchPreview, signal?: AbortSignal, recentProof?: CommandResyncEvidence
): Promise<{ actions: VerifiedLightPlan["actions"]; skippedCommands: string[]; preflightMs: number; preflightSource?: "recent_read" | "live_read"; previewFailed?: boolean }> {
  const unchanged = { actions: plan.actions, skippedCommands: [] as string[], preflightMs: 0 };
  const power = plan.actions[0];
  if ((!preview && !recentProof) || signal?.aborted || !power || power.command !== "on" || plan.actions.length < 2) return unchanged;
  const before = devices.commandStates(device.id, device.locationId);
  const powerState = exact(before, power.component, power.capability, "switch");
  // No extra round trip when power is off, unknown, or not currently observable.
  if (powerState?.value !== "on") return unchanged;
  const revision = devices.commandStateRevision(device.id, device.locationId);
  if (revision === undefined) return unchanged;
  const start = Date.now();
  // Reuse only caller-validated, consume-once post-command evidence. All normal
  // target/value/timestamp/revision checks below still apply to the cached proof.
  const proof = recentProof ?? await boundedPreview(() => preview!(device.id, device.locationId), signal);
  const preflightSource = recentProof ? "recent_read" as const : "live_read" as const;
  const preflightMs = Math.max(0, Date.now() - start);
  const fallback = { ...unchanged, preflightMs, preflightSource, previewFailed: !proof || preflightMs > 400 };
  if (signal?.aborted || !proof || proof.source !== "advanced_device_status" || proof.authoritativeSnapshot ||
      proof.deviceId !== device.id || proof.locationId !== device.locationId ||
      !Number.isFinite(proof.startedAtMs) || proof.startedAtMs < start - (recentProof ? LIGHT_PROOF_MAX_AGE_MS : 0) || proof.startedAtMs > Date.now() ||
      preflightMs > 400 || !Array.isArray(proof.observedStates) ||
      devices.commandStateRevision(device.id, device.locationId) !== revision) return fallback;
  const agrees = (component: string, capability: string, attribute: string, value: unknown) => {
    const old = exact(before, component, capability, attribute);
    const read = exact(proof.observedStates!, component, capability, attribute);
    if (!old || !read || read.source !== "COMMAND_STATUS_RECHECK" || old.value !== value || read.value !== value ||
        old.unit !== read.unit || old.componentRole !== read.componentRole || old.capabilityRole !== read.capabilityRole) return false;
    // An undated live GET may corroborate the SAME value, never override one.
    if (read.updatedAt === null) return true;
    const at = Date.parse(read.updatedAt);
    return Number.isFinite(at) && (old.updatedAt === null ||
      (Number.isFinite(Date.parse(old.updatedAt)) && at >= Date.parse(old.updatedAt)));
  };
  if (!agrees(power.component, power.capability, "switch", "on")) return fallback;
  const skippedCommands = ["on"];
  const hasModeSetter = plan.actions.some((action) =>
    ["setColor", "setColorTemperature", "setHue", "setSaturation"].includes(action.command));
  const actions = plan.actions.slice(1).filter((action) => {
    if (hasModeSetter && action.command === "setLevel" && action.arguments.length === 1 &&
        agrees(action.component, action.capability, "level", action.arguments[0])) {
      skippedCommands.push("setLevel"); return false;
    }
    return true;
  });
  return actions.length ? { actions, skippedCommands, preflightMs, preflightSource } : fallback;
}

function exact(states: readonly BridgeDeviceState[], component: string, capability: string, attribute: string) {
  const matches = states.filter((state) => state.component === component &&
    state.capability === capability && state.attribute === attribute);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Bound even a faulty custom reader. Late read results have no store side effects. */
async function boundedPreview(read: () => Promise<CommandResyncEvidence | undefined>, signal?: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => signal?.aborted ? undefined : read()).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        abort = () => resolve(undefined);
        timer = setTimeout(abort, 400);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
