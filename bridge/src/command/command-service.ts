import type {
  BridgeDevice,
  BridgeDeviceState,
  BridgeDeviceStoreEvent,
  BridgeJsonValue,
  DeviceStore
} from "../state/device-store.js";
import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface SafeCommandRequest {
  targetType: "device" | "scene" | "location";
  targetId: string;
  deviceId?: string;
  component?: string;
  capability?: string;
  attribute?: string;
  command: string;
  arguments: BridgeJsonValue[];
  clientRequestId: string;
  controlId?: string;
  controlLabel?: string;
}

export interface SafeCommandResult {
  schemaVersion: 1;
  clientRequestId: string;
  status: "confirmed" | "already_confirmed";
  sequence: number;
  transport: "smartthings_web_ui";
  confirmation: "device_event" | "inventory_snapshot" | "security_arm_state_event" | "current_state";
}

type DeviceActionCommand =
  | "on"
  | "off"
  | "refresh"
  | "press"
  | "setNumber"
  | "setVolume"
  | "play"
  | "pause"
  | "stop"
  | "nextTrack"
  | "previousTrack"
  | "mute"
  | "unmute"
  | "playTrackAndResume"
  | "setFanMode"
  | "setOption"
  | "open"
  | "close"
  | "stop"
  | "pause"
  | "openShade"
  | "closeShade"
  | "setPosition";

type LocationAction = "armAway" | "armStay" | "disarm";

export interface SafeCommandExecutor {
  executeDeviceAction?(input: {
    action: string;
    arguments: BridgeJsonValue[];
    attribute: string;
    capability: string;
    command: DeviceActionCommand;
    component: string;
    deviceName: string;
    locationId: string;
    locationNames: Readonly<Record<string, string>>;
    roomName?: string;
    controlId?: string;
    controlLabel?: string;
    optionLabel?: string;
    optionCommand?: string;
  }): Promise<void>;
  executeScene?(input: {
    action?: string;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
    sceneName: string;
  }): Promise<void>;
  executeLocationAction?(input: {
    action: LocationAction;
    locationId: string;
    locationNames?: Readonly<Record<string, string>>;
  }): Promise<void>;
}

export type SafeCommandErrorCode =
  | "invalid_body"
  | "unknown_key"
  | "invalid_device_id"
  | "invalid_component"
  | "invalid_capability"
  | "invalid_control_id"
  | "invalid_control_label"
  | "invalid_client_request_id"
  | "invalid_arguments"
  | "unsupported_command"
  | "bridge_not_connected"
  | "device_not_found"
  | "device_offline"
  | "capability_not_found"
  | "client_request_conflict"
  | "command_browser_unavailable"
  | "command_login_required"
  | "command_location_mismatch"
  | "command_location_unknown"
  | "command_location_picker_not_found"
  | "command_location_target_not_found"
  | "command_location_change_failed"
  | "command_room_not_found"
  | "command_target_not_found"
  | "command_target_ambiguous"
  | "command_search_not_found"
  | "command_search_ambiguous"
  | "command_control_not_found"
  | "command_control_ambiguous"
  | "command_execution_failed"
  | "command_confirmation_timeout";

export class SafeCommandError extends Error {
  constructor(readonly code: SafeCommandErrorCode) {
    super(code);
    this.name = "SafeCommandError";
  }
}

interface SafeCommandServiceOptions {
  devices: DeviceStore;
  status: RuntimeStatusStore;
  executor: SafeCommandExecutor;
  timeoutMs: number;
  confirmationStabilityMs?: number;
  resync: () => Promise<unknown>;
}

interface DedupeEntry {
  fingerprint: string;
  result: Promise<SafeCommandResult>;
}

type ResolvedDeviceRequest = SafeCommandRequest & {
  optionLabel?: string;
  optionCommand?: string;
};

const oldRequestKeys = ["deviceId", "component", "capability", "command", "arguments", "clientRequestId"] as const;
const newRequestKeys = ["targetType", "targetId", "component", "capability", "attribute", "command", "arguments", "clientRequestId", "controlId", "controlLabel"] as const;
const tokenPattern = /^[A-Za-z0-9_.:-]{1,160}$/u;
const devicePattern = /^dev_[0-9]{3,32}$/u;
const targetPattern = /^(?:dev|loc|identifier)_[A-Za-z0-9_]{3,64}$/u;
const clientRequestPattern = /^[A-Za-z0-9_-]{8,128}$/u;
const dedupeLimit = 1_000;

export class SafeCommandService {
  readonly #dedupe = new Map<string, DedupeEntry>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(private readonly options: SafeCommandServiceOptions) {}

  async execute(input: unknown): Promise<SafeCommandResult> {
    const request = validateRequest(input);
    const fingerprint = JSON.stringify(request);
    const existing = this.#dedupe.get(request.clientRequestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new SafeCommandError("client_request_conflict");
      }
      return existing.result;
    }
    const result = this.#enqueue(request);
    this.#dedupe.set(request.clientRequestId, { fingerprint, result });
    while (this.#dedupe.size > dedupeLimit) {
      const oldest = this.#dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#dedupe.delete(oldest);
    }
    return result;
  }

  #enqueue(request: SafeCommandRequest): Promise<SafeCommandResult> {
    const previous = this.#queues.get(request.targetId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.#execute(request));
    const queueTail = operation.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(request.targetId, queueTail);
    void queueTail.finally(() => {
      if (this.#queues.get(request.targetId) === queueTail) this.#queues.delete(request.targetId);
    });
    return operation;
  }

  async #execute(request: SafeCommandRequest): Promise<SafeCommandResult> {
    const runtime = this.options.status.getSnapshot();
    if (runtime.state !== "CONNECTED" || !runtime.pushConnected || !runtime.parserHealthy || !runtime.initialSnapshotComplete) {
      throw new SafeCommandError("bridge_not_connected");
    }
    const snapshot = this.options.devices.snapshot();
    const locationNames = Object.fromEntries(snapshot.locations.map((location) => [location.id, location.name]));
    if (request.targetType === "scene") return await this.#executeScene(request, snapshot, locationNames);
    if (request.targetType === "location") return await this.#executeLocation(request, snapshot, locationNames);
    return await this.#executeDevice(request, snapshot, locationNames);
  }

  async #executeDevice(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    const device = snapshot.devices.find((candidate) => candidate.id === request.targetId);
    if (!device) throw new SafeCommandError("device_not_found");
    if (!device.online) throw new SafeCommandError("device_offline");
    const effective = resolveDeviceRequest(device, request);
    if (!effective.component || !effective.capability) throw new SafeCommandError("capability_not_found");
    const attribute = effective.attribute ?? "switch";
    validateCommandAttribute(effective.command, attribute);
    const state = findState(device, effective.component, effective.capability, attribute);
    if (!state && !allowsMissingCurrentState(effective.command)) throw new SafeCommandError("capability_not_found");
    if (!isSupportedDeviceCommand(effective.command)) throw new SafeCommandError("unsupported_command");
    const matchAny = confirmsAnyNewDeviceState(effective);
    const desired = matchAny ? undefined : desiredValueFor(effective.command, effective.arguments, state);
    if (!matchAny && desired === undefined) throw new SafeCommandError("invalid_arguments");
    if (state && desired !== undefined && JSON.stringify(state.value) === JSON.stringify(desired)) return alreadyConfirmed(effective.clientRequestId, snapshot.sequence);
    const confirmation = waitForState({
      devices: this.options.devices,
      request: effective,
      attribute,
      desired,
      afterSequence: snapshot.sequence,
      stabilityMs: this.options.confirmationStabilityMs ?? 0,
      resync: this.options.resync
    });
    const roomName = device.roomId ? snapshot.rooms.find((room) => room.id === device.roomId)?.name : undefined;
    try {
      if (!this.options.executor.executeDeviceAction) throw new SafeCommandError("command_execution_failed");
      await this.options.executor.executeDeviceAction({
        action: effective.command,
        arguments: effective.arguments,
        attribute,
        capability: effective.capability,
        command: effective.command as DeviceActionCommand,
        component: effective.component,
        deviceName: device.name,
        locationId: device.locationId,
        locationNames,
        ...(roomName ? { roomName } : {}),
        ...(effective.controlId ? { controlId: effective.controlId } : {}),
        ...(effective.controlLabel ? { controlLabel: effective.controlLabel } : {}),
        ...(effective.optionLabel ? { optionLabel: effective.optionLabel } : {}),
        ...(effective.optionCommand ? { optionCommand: effective.optionCommand } : {})
      });
    } catch (error) {
      confirmation.cancel();
      throw commandError(error);
    }
    confirmation.startTimeout(this.options.timeoutMs);
    const evidence = await confirmation.result;
    return confirmed(
      request.clientRequestId,
      evidence.sequence,
      evidence.source === "inventory_snapshot" ? "inventory_snapshot" : "device_event"
    );
  }

  async #executeScene(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    if (request.command !== "execute" || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    const scene = snapshot.scenes.find((candidate) => candidate.id === request.targetId);
    if (!scene) throw new SafeCommandError("device_not_found");
    const confirmation = waitForAnyDeviceEventInLocation({
      devices: this.options.devices,
      locationId: scene.locationId,
      afterSequence: snapshot.sequence,
      resync: this.options.resync
    });
    try {
      if (!this.options.executor.executeScene) throw new SafeCommandError("command_execution_failed");
      await this.options.executor.executeScene({ action: request.command, locationId: scene.locationId, locationNames, sceneName: scene.name });
    } catch (error) {
      confirmation.cancel();
      throw commandError(error);
    }
    confirmation.startTimeout(this.options.timeoutMs);
    return confirmed(request.clientRequestId, (await confirmation.result).sequence, "device_event");
  }

  async #executeLocation(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    const location = snapshot.locations.find((candidate) => candidate.id === request.targetId);
    if (!location) throw new SafeCommandError("device_not_found");
    const desired = armStateForCommand(request.command);
    if (!desired || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    if (location.armState?.toUpperCase() === desired) return alreadyConfirmed(request.clientRequestId, snapshot.sequence);
    const confirmation = waitForLocationArmState({
      devices: this.options.devices,
      locationId: request.targetId,
      desired,
      afterSequence: snapshot.sequence,
      resync: this.options.resync
    });
    try {
      if (!this.options.executor.executeLocationAction) throw new SafeCommandError("command_execution_failed");
      await this.options.executor.executeLocationAction({ action: request.command as LocationAction, locationId: request.targetId, locationNames });
    } catch (error) {
      confirmation.cancel();
      throw commandError(error);
    }
    confirmation.startTimeout(this.options.timeoutMs);
    return confirmed(
      request.clientRequestId,
      (await confirmation.result).sequence,
      "security_arm_state_event"
    );
  }
}

function validateRequest(input: unknown): SafeCommandRequest {
  if (!isRecord(input)) throw new SafeCommandError("invalid_body");
  const keys = Object.keys(input);
  if ("targetType" in input || "targetId" in input) {
    if (keys.some((key) => !newRequestKeys.includes(key as (typeof newRequestKeys)[number]))) throw new SafeCommandError("unknown_key");
    if (input.targetType !== "device" && input.targetType !== "scene" && input.targetType !== "location") throw new SafeCommandError("unsupported_command");
    if (typeof input.targetId !== "string" || !targetPattern.test(input.targetId)) throw new SafeCommandError("invalid_device_id");
    if (input.targetType === "scene" && !input.targetId.startsWith("identifier_")) throw new SafeCommandError("unsupported_command");
    return normalizeRequest(input.targetType, input.targetId, input);
  }
  if (keys.some((key) => !oldRequestKeys.includes(key as (typeof oldRequestKeys)[number]))) throw new SafeCommandError("unknown_key");
  if (typeof input.deviceId !== "string" || !devicePattern.test(input.deviceId)) throw new SafeCommandError("invalid_device_id");
  if (input.command !== "on" && input.command !== "off") throw new SafeCommandError("unsupported_command");
  return normalizeRequest("device", input.deviceId, input, input.deviceId);
}

function normalizeRequest(targetType: SafeCommandRequest["targetType"], targetId: string, input: Record<string, unknown>, deviceId?: string): SafeCommandRequest {
  if (input.component !== undefined && (typeof input.component !== "string" || !tokenPattern.test(input.component))) throw new SafeCommandError("invalid_component");
  if (input.capability !== undefined && (typeof input.capability !== "string" || !tokenPattern.test(input.capability))) throw new SafeCommandError("invalid_capability");
  if (input.attribute !== undefined && (typeof input.attribute !== "string" || !tokenPattern.test(input.attribute))) throw new SafeCommandError("invalid_capability");
  if (input.controlId !== undefined && (typeof input.controlId !== "string" || !tokenPattern.test(input.controlId))) throw new SafeCommandError("invalid_control_id");
  if (input.controlLabel !== undefined && !safeControlLabel(input.controlLabel)) throw new SafeCommandError("invalid_control_label");
  if (typeof input.command !== "string" || !tokenPattern.test(input.command)) throw new SafeCommandError("unsupported_command");
  if (!Array.isArray(input.arguments) || input.arguments.some((value) => jsonValue(value) === undefined)) throw new SafeCommandError("invalid_arguments");
  if (input.command === "setNumber" || input.command === "setVolume") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "number" || !Number.isFinite(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.command === "setFanMode") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "string" || !tokenPattern.test(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.command === "setOption") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "string" || !safeControlLabel(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.command === "setPosition") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "number" || !Number.isFinite(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.command === "playTrackAndResume") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "string" || input.arguments[0].length < 1 || input.arguments[0].length > 2048 || /[\u0000-\u001f\u007f]/u.test(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.arguments.length !== 0) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (typeof input.clientRequestId !== "string" || !clientRequestPattern.test(input.clientRequestId)) throw new SafeCommandError("invalid_client_request_id");
  return {
    targetType,
    targetId,
    ...(deviceId ? { deviceId } : {}),
    ...(typeof input.component === "string" ? { component: input.component } : {}),
    ...(typeof input.capability === "string" ? { capability: input.capability } : {}),
    ...(typeof input.attribute === "string" ? { attribute: input.attribute } : {}),
    ...(typeof input.controlId === "string" ? { controlId: input.controlId } : {}),
    ...(typeof input.controlLabel === "string" ? { controlLabel: input.controlLabel } : {}),
    command: input.command,
    arguments: input.arguments.map((value) => jsonValue(value) as BridgeJsonValue),
    clientRequestId: input.clientRequestId
  };
}

function findState(device: BridgeDevice, component: string, capability: string, attribute: string): BridgeDeviceState | undefined {
  return device.states.find((state) => state.component === component && state.capability === capability && state.attribute === attribute);
}

function waitForState(options: { devices: DeviceStore; request: SafeCommandRequest; attribute: string; desired: BridgeJsonValue | undefined; afterSequence: number; stabilityMs: number; resync: () => Promise<unknown> }): ConfirmationWait {
  const snapshotMatches = () => {
    if (options.desired === undefined) return false;
    const device = options.devices
      .snapshot()
      .devices.find((candidate) => candidate.id === options.request.targetId);
    const state = device?.states.find(
      (candidate) =>
        candidate.component === options.request.component &&
        candidate.capability === options.request.capability &&
        candidate.attribute === options.attribute
    );
    return state !== undefined && JSON.stringify(state.value) === JSON.stringify(options.desired);
  };
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    stabilityMs: options.stabilityMs,
    resync: options.resync,
    matches: (event) =>
      (event.type === "state" &&
        event.deviceId === options.request.targetId &&
        event.state.component === options.request.component &&
        event.state.capability === options.request.capability &&
        event.state.attribute === options.attribute &&
        (options.desired === undefined ||
          JSON.stringify(event.state.value) === JSON.stringify(options.desired))) ||
      (event.type === "inventory" && snapshotMatches()),
    invalidates: (event) =>
      options.desired !== undefined &&
      ((event.type === "state" &&
        event.deviceId === options.request.targetId &&
        event.state.component === options.request.component &&
        event.state.capability === options.request.capability &&
        event.state.attribute === options.attribute &&
        JSON.stringify(event.state.value) !== JSON.stringify(options.desired)) ||
        (event.type === "inventory" && !snapshotMatches())),
    matchesSnapshot: snapshotMatches
  });
}

function waitForAnyDeviceEventInLocation(options: { devices: DeviceStore; locationId: string; afterSequence: number; resync: () => Promise<unknown> }): ConfirmationWait {
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => {
      if (event.type !== "state") return false;
      const device = options.devices.snapshot().devices.find((candidate) => candidate.id === event.deviceId);
      return device?.locationId === options.locationId;
    }
  });
}

function waitForLocationArmState(options: { devices: DeviceStore; locationId: string; desired: string; afterSequence: number; resync: () => Promise<unknown> }): ConfirmationWait {
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => event.type === "inventory" && options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired)
  });
}

interface ConfirmationWait {
  result: Promise<ConfirmationEvidence>;
  cancel: () => void;
  startTimeout: (timeoutMs: number) => void;
}

interface ConfirmationEvidence {
  sequence: number;
  source: "event" | "inventory_snapshot";
}

function waitForPredicate(options: { devices: DeviceStore; afterSequence: number; resync: () => Promise<unknown>; matches: (event: BridgeDeviceStoreEvent) => boolean; invalidates?: (event: BridgeDeviceStoreEvent) => boolean; matchesSnapshot?: () => boolean; stabilityMs?: number }): ConfirmationWait {
  let settled = false;
  let interactionComplete = false;
  let unsubscribe: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let stabilityTimer: NodeJS.Timeout | undefined;
  let pendingEvidence: ConfirmationEvidence | undefined;
  let rejectResult: (error: SafeCommandError) => void = () => undefined;
  let resolveResult: (evidence: ConfirmationEvidence) => void = () => undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (stabilityTimer) clearTimeout(stabilityTimer);
    unsubscribe();
  };
  const resolvePending = () => {
    if (settled || !interactionComplete || !pendingEvidence) return;
    if ((options.stabilityMs ?? 0) > 0) {
      if (stabilityTimer) clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(() => {
        stabilityTimer = undefined;
        if (settled || !pendingEvidence) return;
        const evidence = pendingEvidence;
        cleanup();
        resolveResult(evidence);
      }, options.stabilityMs);
      return;
    }
    const evidence = pendingEvidence;
    cleanup();
    resolveResult(evidence);
  };
  const result = new Promise<ConfirmationEvidence>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
    unsubscribe = options.devices.subscribe((event) => {
      if (event.sequence <= options.afterSequence) return;
      if (options.invalidates?.(event)) {
        pendingEvidence = undefined;
        if (stabilityTimer) {
          clearTimeout(stabilityTimer);
          stabilityTimer = undefined;
        }
        return;
      }
      if (!options.matches(event)) return;
      pendingEvidence = {
        sequence: event.sequence,
        source: event.type === "inventory" ? "inventory_snapshot" : "event"
      };
      resolvePending();
    });
  });
  return {
    result,
    startTimeout: (timeoutMs) => {
      if (settled || timer) return;
      interactionComplete = true;
      resolvePending();
      if (settled) return;
      timer = setTimeout(() => {
        timer = undefined;
        void options
          .resync()
          .catch(() => undefined)
          .then(async () => {
            if (settled) return;
            const stabilityMs = Math.max(0, options.stabilityMs ?? 0);
            if (stabilityMs > 0 && options.matchesSnapshot?.() === true) {
              await new Promise<void>((resolve) => setTimeout(resolve, stabilityMs));
              if (settled) return;
            }
            const sequence = options.devices.snapshot().sequence;
            if (
              sequence > options.afterSequence &&
              options.matchesSnapshot?.() === true
            ) {
              cleanup();
              resolveResult({ sequence, source: "inventory_snapshot" });
              return;
            }
            cleanup();
            rejectResult(new SafeCommandError("command_confirmation_timeout"));
          });
      }, timeoutMs);
    },
    cancel: () => {
      cleanup();
      rejectResult(new SafeCommandError("command_execution_failed"));
      void result.catch(() => undefined);
    }
  };
}

function isSupportedDeviceCommand(command: string): boolean {
  return ["on", "off", "press", "setNumber", "setVolume", "mute", "unmute", "setFanMode", "setOption", "open", "close", "stop", "pause", "openShade", "closeShade", "setPosition", "fanSpeed", "volume", "play", "nextTrack", "previousTrack", "refresh", "playTrackAndResume"].includes(command);
}

function confirmsAnyNewDeviceState(request: SafeCommandRequest): boolean {
  const command = request.command;
  if ((command === "stop" || command === "pause") && request.controlId && COVER_ATTRIBUTES.has(request.attribute ?? "")) {
    return true;
  }
  return ["press", "refresh", "nextTrack", "previousTrack", "playTrackAndResume"].includes(command);
}

function allowsMissingCurrentState(command: string): boolean {
  return isControlBoundCommand(command) || command === "refresh";
}

function desiredValueFor(command: string, args: BridgeJsonValue[], state: BridgeDeviceState | undefined): BridgeJsonValue | undefined {
  if (command === "on" || command === "off") return command;
  if (command === "mute" && args.length === 0) return "muted";
  if (command === "unmute" && args.length === 0) return "unmuted";
  if (command === "play" && args.length === 0) return "playing";
  if (command === "pause" && args.length === 0) return "paused";
  if (command === "stop" && args.length === 0) return "stopped";
  if ((command === "open" || command === "openShade") && args.length === 0) return "open";
  if ((command === "close" || command === "closeShade") && args.length === 0) return "closed";
  if (args.length !== 1) return undefined;
  const value = args[0];
  if (command === "setOption" && typeof value === "string") return value;
  if (command === "setPosition" && typeof value === "number") return value;
  if (state && typeof state.value === "number" && typeof value !== "number") return undefined;
  if (state && typeof state.value === "string" && typeof value !== "string") return undefined;
  return value;
}

function armStateForCommand(command: string): string | undefined {
  return { armAway: "ARMED_AWAY", armStay: "ARMED_STAY", disarm: "DISARMED" }[command];
}

function resolveDeviceRequest(device: BridgeDevice, request: SafeCommandRequest): ResolvedDeviceRequest {
  if (request.command === "refresh" && (!request.component || !request.capability)) {
    const state = device.states[0];
    if (!state) throw new SafeCommandError("capability_not_found");
    return {
      ...request,
      component: state.component,
      capability: state.capability,
      attribute: request.attribute ?? state.attribute
    };
  }
  if (request.command === "on" || request.command === "off") {
    const attribute = request.attribute ?? "switch";
    const matching = (device.controls ?? []).filter(
      (control) =>
        control.kind === "toggle" &&
        control.component === request.component &&
        control.capability === request.capability &&
        control.attribute === attribute &&
        (!request.controlId || control.id === request.controlId)
    );
    if (matching.length > 1) throw new SafeCommandError("command_control_ambiguous");
    const control = matching[0];
    if (request.controlId && !control) throw new SafeCommandError("capability_not_found");
    if (control) {
      if (request.controlLabel && request.controlLabel !== control.label) {
        throw new SafeCommandError("invalid_control_label");
      }
      if (dangerousControl(control)) throw new SafeCommandError("unsupported_command");
      const hasExplicitCommand = Boolean(control.command || (control.commands?.length ?? 0) > 0);
      if (hasExplicitCommand && !controlSupportsCommand(control, request.command, false)) {
        throw new SafeCommandError("unsupported_command");
      }
      return {
        ...request,
        attribute,
        controlId: control.id,
        controlLabel: control.label
      };
    }
  }
  const observedFanMode = request.command === "setFanMode" && Boolean(request.controlId);
  const observedControlCommand = isControlBoundCommand(request.command) && Boolean(request.controlId);
  if (!observedControlCommand && !observedFanMode) {
    if (requiresObservedControl(request.command)) throw new SafeCommandError("invalid_control_id");
    return request;
  }
  if (!request.controlId) throw new SafeCommandError("invalid_control_id");
  const control = device.controls?.find((candidate) => candidate.id === request.controlId);
  if (!control) throw new SafeCommandError("capability_not_found");
  if (request.component && request.component !== control.component) throw new SafeCommandError("invalid_component");
  if (request.capability && request.capability !== control.capability) throw new SafeCommandError("invalid_capability");
  if (request.attribute && request.attribute !== control.attribute) throw new SafeCommandError("invalid_capability");
  if (request.controlLabel && request.controlLabel !== control.label) throw new SafeCommandError("invalid_control_label");
  const option = validateObservedControlCommand(control, request.command, request.arguments);
  return {
    ...request,
    component: control.component,
    capability: control.capability,
    attribute: control.attribute,
    controlLabel: control.label,
    ...(option?.label ? { optionLabel: option.label } : {}),
    ...(option?.command ? { optionCommand: option.command } : {})
  };
}

function validateCommandAttribute(command: string, attribute: string): void {
  if (command === "setNumber" && !NUMBER_ATTRIBUTES.has(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
  if (command === "setVolume" && attribute !== "volume") {
    throw new SafeCommandError("unsupported_command");
  }
  if (command === "setFanMode" && attribute !== "fanMode" && attribute !== "airPurifierMode") {
    throw new SafeCommandError("unsupported_command");
  }
  if (command === "setOption" && !safeOptionAttribute(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
  if ((isCoverButtonCommand(command) || command === "setPosition") && !COVER_ATTRIBUTES.has(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
}

const NUMBER_ATTRIBUTES = new Set([
  "colorTemperature",
  "coolingSetpoint",
  "detectionFrequency",
  "fanSpeed",
  "heatingSetpoint",
  "level",
  "percent",
  "setpoint",
  "targetTemperature"
]);

const COVER_ATTRIBUTES = new Set([
  "shadeLevel",
  "supportedWindowShadeCommands",
  "windowShade"
]);

const dangerousControlPattern = /(?:^|[_\s:-])(?:lock|unlock|valve|door|garage)(?:$|[_\s:-])|doorstate/iu;

function isControlBoundCommand(command: string): boolean {
  return (
    requiresObservedControl(command) ||
    command === "setNumber" ||
    command === "setVolume"
  );
}

function requiresObservedControl(command: string): boolean {
  return (
    command === "press" ||
    command === "setOption" ||
    command === "setPosition" ||
    isCoverButtonCommand(command)
  );
}

function isCoverButtonCommand(command: string): boolean {
  return ["open", "close", "stop", "pause", "openShade", "closeShade"].includes(command);
}

function validateObservedControlCommand(
  control: NonNullable<BridgeDevice["controls"]>[number],
  command: string,
  args: BridgeJsonValue[]
): { label?: string; command?: string } | undefined {
  if (dangerousControl(control)) throw new SafeCommandError("unsupported_command");
  if (command === "press") {
    if (control.kind !== "button") throw new SafeCommandError("capability_not_found");
    return undefined;
  }
  if (command === "setOption" || command === "setFanMode") {
    if (control.kind !== "enumerated") throw new SafeCommandError("capability_not_found");
    const option = args[0];
    if (typeof option !== "string" || !(control.options ?? []).includes(option)) {
      throw new SafeCommandError("invalid_arguments");
    }
    if (
      command === "setOption"
        ? !safeOptionAttribute(control.attribute)
        : control.attribute !== "fanMode" && control.attribute !== "airPurifierMode"
    ) {
      throw new SafeCommandError("unsupported_command");
    }
    return {
      ...(control.optionLabels?.[option] ? { label: control.optionLabels[option] } : {}),
      ...(control.optionCommands?.[option] ? { command: control.optionCommands[option] } : {})
    };
  }
  if (command === "setNumber" || command === "setVolume") {
    if (control.kind !== "slider") throw new SafeCommandError("capability_not_found");
    const value = args[0];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SafeCommandError("invalid_arguments");
    }
    if (
      (control.min !== undefined && value < control.min) ||
      (control.max !== undefined && value > control.max)
    ) {
      throw new SafeCommandError("invalid_arguments");
    }
    return undefined;
  }
  if (command === "setPosition") {
    if (control.kind !== "slider" || control.attribute !== "shadeLevel") {
      throw new SafeCommandError("capability_not_found");
    }
    const position = args[0];
    if (typeof position !== "number" || !Number.isFinite(position)) {
      throw new SafeCommandError("invalid_arguments");
    }
    if ((control.min !== undefined && position < control.min) || (control.max !== undefined && position > control.max)) {
      throw new SafeCommandError("invalid_arguments");
    }
    if (!controlSupportsCommand(control, command, false)) throw new SafeCommandError("unsupported_command");
    return undefined;
  }
  if (isCoverButtonCommand(command)) {
    if (control.kind !== "button") throw new SafeCommandError("capability_not_found");
    if (!COVER_ATTRIBUTES.has(control.attribute)) throw new SafeCommandError("unsupported_command");
    if (!controlSupportsCommand(control, command, true)) throw new SafeCommandError("unsupported_command");
    return undefined;
  }
  throw new SafeCommandError("unsupported_command");
}

function controlSupportsCommand(
  control: NonNullable<BridgeDevice["controls"]>[number],
  command: string,
  requireExplicit: boolean
): boolean {
  const aliases: Record<string, string[]> = {
    open: ["open", "openshade"],
    openShade: ["openshade", "open"],
    close: ["close", "closeshade"],
    closeShade: ["closeshade", "close"],
    pause: ["pause", "stop"],
    stop: ["stop", "pause"],
    setPosition: ["setposition", "position", "shadelevel"],
    setOption: ["setoption"]
  };
  const expected = aliases[command] ?? [command.toLowerCase()];
  const explicitValues = [control.command, ...(control.commands ?? [])].filter((value): value is string => typeof value === "string");
  const values = explicitValues.length > 0
    ? explicitValues
    : requireExplicit
      ? []
      : [control.id, control.label, control.attribute];
  const normalized = values.map((value) => normalizeCommandToken(value));
  return expected.some((alias) => normalized.includes(alias));
}

function normalizeCommandToken(value: string): string {
  return value.toLowerCase().replace(/[\s_.:-]+/gu, "");
}

function dangerousControl(control: NonNullable<BridgeDevice["controls"]>[number]): boolean {
  return [control.capability, control.attribute, control.command, control.label, ...(control.commands ?? [])]
    .filter((value): value is string => typeof value === "string")
    .some((value) => dangerousControlPattern.test(value));
}

function safeOptionAttribute(attribute: string): boolean {
  if (!tokenPattern.test(attribute) || dangerousControlPattern.test(attribute)) return false;
  return !COVER_ATTRIBUTES.has(attribute);
}

function safeControlLabel(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) && !/\b(token|secret|cookie|session|csrf)\b/iu.test(value);
}

function alreadyConfirmed(clientRequestId: string, sequence: number): SafeCommandResult {
  return { schemaVersion: 1, clientRequestId, status: "already_confirmed", sequence, transport: "smartthings_web_ui", confirmation: "current_state" };
}

function confirmed(clientRequestId: string, sequence: number, confirmation: SafeCommandResult["confirmation"]): SafeCommandResult {
  return { schemaVersion: 1, clientRequestId, status: "confirmed", sequence, transport: "smartthings_web_ui", confirmation };
}

function commandError(error: unknown): SafeCommandError {
  const code = error instanceof Error ? error.message : "";
  if (isExecutorErrorCode(code)) return new SafeCommandError(code);
  return new SafeCommandError("command_execution_failed");
}

function isExecutorErrorCode(value: string): value is SafeCommandErrorCode {
  return ["command_browser_unavailable", "command_login_required", "command_location_mismatch", "command_location_unknown", "command_location_picker_not_found", "command_location_target_not_found", "command_location_change_failed", "command_room_not_found", "command_target_not_found", "command_target_ambiguous", "command_search_not_found", "command_search_ambiguous", "command_control_not_found", "command_control_ambiguous"].includes(value);
}

function jsonValue(value: unknown): BridgeJsonValue | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16_384) return undefined;
    return JSON.parse(serialized) as BridgeJsonValue;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
