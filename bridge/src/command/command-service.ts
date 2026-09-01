import type {
  BridgeDevice,
  BridgeDeviceState,
  BridgeDeviceStoreEvent,
  BridgeJsonValue,
  BridgeSceneExpectedState,
  DeviceStore
} from "../state/device-store.js";
import type {
  CommandTransportName,
  CommandTransportReceipt
} from "./command-router.js";
import type { AdvancedCommandDescriptor } from "../advanced/command-catalog-types.js";
import { safeAdvancedCommandReason } from "../advanced/safe-command-policy.js";
import { createHealthReport } from "../server/health.js";
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
  confirm?: boolean;
  timeout?: number;
}

export interface SafeCommandResult {
  schemaVersion: 1;
  clientRequestId: string;
  status: "confirmed" | "already_confirmed" | "accepted_unconfirmed";
  sequence: number;
  transport: "smartthings_web_ui" | CommandTransportName;
  confirmation:
    | "device_event"
    | "inventory_snapshot"
    | "security_arm_state_event"
    | "current_state"
    | "accepted_receipt";
  lifecycle:
    | "CONFIRMED_BY_EVENT"
    | "CONFIRMED_BY_STATUS"
    | "ACCEPTED_UNCONFIRMED";
}

export type DeviceActionCommand =
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
  | "fastForward"
  | "rewind"
  | "mute"
  | "unmute"
  | "playTrackAndResume"
  | "setInputSource"
  | "setRepeat"
  | "setShuffle"
  | "setFanMode"
  | "setOption"
  | "open"
  | "close"
  | "openShade"
  | "closeShade"
  | "setPosition";

type LocationAction = "armAway" | "armStay" | "disarm";

export interface DeviceActionExecutionInput {
    action: string;
    arguments: BridgeJsonValue[];
    attribute: string;
    capability: string;
    capabilityVersion?: number;
    command: string;
    component: string;
    deviceId: string;
    deviceName: string;
    locationId: string;
    locationNames: Readonly<Record<string, string>>;
    roomName?: string;
    controlId?: string;
    controlLabel?: string;
    optionLabel?: string;
    optionCommand?: string;
    nativeCommand?: string;
    requireAdvanced?: boolean;
    requireLocationNative?: boolean;
}

export interface ComponentActionExecutionInput {
  deviceId: string;
  component: string;
  capability: string;
  capabilityVersion: number;
  command: "on" | "off";
  arguments: BridgeJsonValue[];
}

export interface ComponentTransactionExecutionInput {
  actions: ComponentActionExecutionInput[];
  rollbackActions: ComponentActionExecutionInput[];
}

export interface SafeCommandExecutor {
  executeDeviceAction?(
    input: DeviceActionExecutionInput
  ): Promise<void | CommandTransportReceipt | "location_native" | "dom">;
  executeComponentTransaction?(
    input: ComponentTransactionExecutionInput
  ): Promise<CommandTransportReceipt[]>;
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

export interface CommandResyncEvidence {
  source: "advanced_device_status" | "advanced_inventory";
  authoritativeSnapshot: boolean;
  startedAtMs: number;
}

export interface CommandResyncRequest {
  deviceId?: string;
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
  | "component_command_partial_failure"
  | "component_command_rollback_failed"
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
  resyncAfterMs?: number;
  confirmationStabilityMs?: number;
  resync: (request?: CommandResyncRequest) => Promise<CommandResyncEvidence | undefined>;
  onPendingCountChange?: (count: number) => void;
  onResult?: (result: SafeCommandResult) => void;
}

interface DedupeEntry {
  fingerprint: string;
  result: Promise<SafeCommandResult>;
}

interface ComponentVectorState {
  deviceId: string;
  component: string;
  capability: string;
  attribute: string;
  value: BridgeJsonValue;
}

interface ComponentSwitchPlan {
  componentTransaction?: {
    forward: ComponentTransactionExecutionInput;
    rollback: ComponentTransactionExecutionInput;
  };
  webTransaction?: {
    forward: DeviceActionTransactionInput;
    rollback: DeviceActionTransactionInput;
  };
  desiredVector: ComponentVectorState[];
  originalVector: ComponentVectorState[];
  verificationDeviceIds: string[];
}

interface DeviceActionTransactionInput {
  actions: DeviceActionExecutionInput[];
  rollbackActions: DeviceActionExecutionInput[];
}

type DeviceActionExecutionResult =
  | void
  | CommandTransportReceipt
  | "location_native"
  | "dom";

interface ComponentSwitchEntry {
  deviceId: string;
  state: BridgeDeviceState;
  capabilityVersion: number;
  originalCommand: "on" | "off";
  desiredCommand: "on" | "off";
  desiredValue: BridgeJsonValue;
}

type ResolvedDeviceRequest = SafeCommandRequest & {
  advancedDescriptor?: AdvancedCommandDescriptor;
  optionLabel?: string;
  optionCommand?: string;
  nativeCommand?: string;
  requireAdvanced?: boolean;
};

const oldRequestKeys = ["deviceId", "component", "capability", "command", "arguments", "clientRequestId", "confirm", "timeout"] as const;
const newRequestKeys = ["targetType", "targetId", "component", "capability", "attribute", "command", "arguments", "clientRequestId", "controlId", "controlLabel", "confirm", "timeout"] as const;
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
    const result = this.#enqueue(request).then((value) => {
      this.options.onResult?.(value);
      return value;
    });
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
    this.options.onPendingCountChange?.(this.#queues.size);
    void queueTail.finally(() => {
      if (this.#queues.get(request.targetId) === queueTail) {
        this.#queues.delete(request.targetId);
        this.options.onPendingCountChange?.(this.#queues.size);
      }
    });
    return operation;
  }

  async #execute(request: SafeCommandRequest): Promise<SafeCommandResult> {
    const runtime = this.options.status.getSnapshot();
    if (runtime.state !== "CONNECTED" || !createHealthReport(runtime).ready) {
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
    const attribute = effective.attribute ?? (effective.advancedDescriptor?.confirmation === "accepted_receipt" ? effective.command : "switch");
    validateCommandAttribute(effective.command, attribute, effective.controlId);
    const state = findState(device, effective.component, effective.capability, attribute);
    if (!state && !allowsMissingCurrentState(effective.command, effective.advancedDescriptor)) {
      throw new SafeCommandError(
        effective.advancedDescriptor?.confirmation === "state"
          ? "unsupported_command"
          : "capability_not_found"
      );
    }
    const matchAny = confirmsAnyNewDeviceState(effective);
    const desired = matchAny ? undefined : desiredValueFor(effective.command, effective.arguments, state);
    if (!matchAny && desired === undefined) {
      throw new SafeCommandError(
        effective.advancedDescriptor?.confirmation === "state"
          ? "unsupported_command"
          : "invalid_arguments"
      );
    }
    const componentPlan =
      effective.confirm === false || !state
        ? undefined
        : buildComponentSwitchPlan(
            device,
            effective,
            state,
            this.options.devices,
            snapshot,
            locationNames
          );
    if (componentPlan) {
      if (componentVectorMatches(snapshot, componentPlan.desiredVector)) {
        return alreadyConfirmed(effective.clientRequestId, snapshot.sequence);
      }
      return await this.#executeComponentPlan(effective, componentPlan);
    }
    if (state && desired !== undefined && stateValuesEqual(state.value, desired)) return alreadyConfirmed(effective.clientRequestId, snapshot.sequence);
    const roomName = device.roomId ? snapshot.rooms.find((room) => room.id === device.roomId)?.name : undefined;
    const capabilityVersion = this.options.devices.capabilityVersion(
      effective.targetId,
      effective.component,
      effective.capability
    );
    const exactCapabilityVersion =
      effective.advancedDescriptor?.capabilityVersion ?? capabilityVersion;
    const executionInput: DeviceActionExecutionInput = {
      action: effective.command,
      arguments: effective.arguments,
      attribute,
      capability: effective.capability,
      ...(exactCapabilityVersion === undefined ? {} : { capabilityVersion: exactCapabilityVersion }),
      command: effective.command,
      component: effective.component,
      deviceId: effective.targetId,
      deviceName: device.name,
      locationId: device.locationId,
      locationNames,
      ...(roomName ? { roomName } : {}),
      ...(effective.controlId ? { controlId: effective.controlId } : {}),
      ...(effective.controlLabel ? { controlLabel: effective.controlLabel } : {}),
      ...(effective.optionLabel ? { optionLabel: effective.optionLabel } : {}),
      ...(effective.optionCommand ? { optionCommand: effective.optionCommand } : {}),
      ...(effective.nativeCommand ? { nativeCommand: effective.nativeCommand } : {}),
      ...(effective.requireAdvanced ? { requireAdvanced: true } : {})
    };
    if (
      effective.advancedDescriptor?.confirmation === "accepted_receipt" ||
      isStatelessCommand(effective.command) ||
      effective.confirm === false
    ) {
      try {
        if (!this.options.executor.executeDeviceAction) {
          throw new SafeCommandError("command_execution_failed");
        }
        const receipt = await this.options.executor.executeDeviceAction(executionInput);
        return acceptedUnconfirmed(
          effective.clientRequestId,
          snapshot.sequence,
          transportForExecution(receipt)
        );
      } catch (error) {
        throw commandError(error);
      }
    }
    let receiptCommandId: string | undefined;
    let advancedSentAtMs: number | undefined;
    const wait = effective.command === "refresh"
      ? waitForRefreshCommand({
          devices: this.options.devices,
          deviceId: effective.targetId,
          afterSequence: snapshot.sequence,
          resync: () => this.options.resync({ deviceId: effective.targetId })
        })
      : matchAny
        ? waitForAnyDeviceEvent({
            devices: this.options.devices,
            deviceId: effective.targetId,
            afterSequence: snapshot.sequence,
            resync: () => this.options.resync({ deviceId: effective.targetId })
          })
      : waitForState({
          devices: this.options.devices,
          request: effective,
          attribute,
          desired,
          afterSequence: snapshot.sequence,
          stabilityMs: this.options.confirmationStabilityMs ?? 0,
          resync: () => this.options.resync({ deviceId: effective.targetId }),
          minimumEventTimeMs: () =>
            advancedSentAtMs ??
            (state?.updatedAt ? Date.parse(state.updatedAt) : undefined),
          expectedCommandId: () => receiptCommandId
        });
    let executionResult: void | CommandTransportReceipt | "location_native" | "dom";
    try {
      if (!this.options.executor.executeDeviceAction) throw new SafeCommandError("command_execution_failed");
      executionResult = await this.options.executor.executeDeviceAction(executionInput);
      if (executionResult && typeof executionResult === "object") {
        receiptCommandId = executionResult.commandId;
        if (executionResult.transport === "advanced") {
          advancedSentAtMs = executionResult.sentAtMs;
        }
      }
    } catch (error) {
      wait.cancel();
      throw commandError(error);
    }
    wait.startTimeout(
      effective.timeout === undefined ? this.options.timeoutMs : effective.timeout * 1_000,
      this.options.resyncAfterMs,
      Date.now()
    );
    const evidence = await wait.result;
    return confirmed(
      request.clientRequestId,
      evidence.sequence,
      evidence.source === "inventory_snapshot" ? "inventory_snapshot" : "device_event",
      transportForExecution(executionResult)
    );
  }

  async #executeComponentPlan(
    request: ResolvedDeviceRequest,
    plan: ComponentSwitchPlan
  ): Promise<SafeCommandResult> {
    const componentExecute = this.options.executor.executeComponentTransaction?.bind(
      this.options.executor
    );
    let executeForward: () => Promise<ReadonlyArray<DeviceActionExecutionResult>>;
    let executeRollback: () => Promise<ReadonlyArray<DeviceActionExecutionResult>>;
    const webTransaction = plan.webTransaction;
    const componentTransaction = plan.componentTransaction;
    if (webTransaction && !componentTransaction) {
      executeForward = async () =>
        await this.#executeDeviceActionTransaction(webTransaction.forward);
      executeRollback = async () =>
        await this.#executeDeviceActionTransaction(webTransaction.rollback);
    } else if (componentTransaction && !webTransaction && componentExecute) {
      executeForward = async () => await componentExecute(componentTransaction.forward);
      executeRollback = async () => await componentExecute(componentTransaction.rollback);
    } else {
      throw new SafeCommandError("command_execution_failed");
    }
    const timeoutMs =
      request.timeout === undefined ? this.options.timeoutMs : request.timeout * 1_000;
    const confirmation = waitForComponentVector({
      devices: this.options.devices,
      expected: plan.desiredVector,
      afterSequence: this.options.devices.currentSequence(),
      resync: () => this.#resyncComponentPlan(plan)
    });
    let executionTransport: SafeCommandResult["transport"] = "advanced";
    try {
      const receipts = await executeForward();
      if (webTransaction) executionTransport = transportForExecutions(receipts);
    } catch (error) {
      confirmation.cancel();
      throw commandError(error);
    }
    confirmation.startTimeout(timeoutMs, this.options.resyncAfterMs, Date.now());
    try {
      const evidence = await confirmation.result;
      return confirmed(
        request.clientRequestId,
        evidence.sequence,
        "inventory_snapshot",
        executionTransport
      );
    } catch (error) {
      if (
        !(error instanceof SafeCommandError) ||
        error.code !== "command_confirmation_timeout"
      ) {
        throw error;
      }
    }
    const rollbackConfirmation = waitForComponentVector({
      devices: this.options.devices,
      expected: plan.originalVector,
      afterSequence: this.options.devices.currentSequence(),
      resync: () => this.#resyncComponentPlan(plan)
    });
    try {
      await executeRollback();
    } catch {
      rollbackConfirmation.cancel();
      throw new SafeCommandError("component_command_rollback_failed");
    }
    rollbackConfirmation.startTimeout(
      timeoutMs,
      this.options.resyncAfterMs,
      Date.now()
    );
    try {
      await rollbackConfirmation.result;
    } catch {
      throw new SafeCommandError("component_command_rollback_failed");
    }
    throw new SafeCommandError("command_confirmation_timeout");
  }

  async #executeDeviceActionTransaction(
    input: DeviceActionTransactionInput
  ): Promise<DeviceActionExecutionResult[]> {
    const execute = this.options.executor.executeDeviceAction?.bind(this.options.executor);
    if (!execute) throw new Error("command_execution_failed");
    const receipts: DeviceActionExecutionResult[] = [];
    const completed: number[] = [];
    for (const [index, action] of input.actions.entries()) {
      try {
        const receipt = await execute(action);
        if (
          action.requireLocationNative === true &&
          transportForExecution(receipt) !== "location_native"
        ) {
          throw new Error("command_control_not_found");
        }
        receipts.push(receipt);
        completed.push(index);
      } catch (error) {
        if (completed.length === 0) throw error;
        let rollbackFailed = false;
        for (const completedIndex of completed.reverse()) {
          const rollback = input.rollbackActions[completedIndex];
          if (!rollback) {
            rollbackFailed = true;
            continue;
          }
          try {
            await execute(rollback);
          } catch {
            rollbackFailed = true;
          }
        }
        throw new Error(
          rollbackFailed
            ? "component_command_rollback_failed"
            : "component_command_partial_failure"
        );
      }
    }
    return receipts;
  }

  async #resyncComponentPlan(
    plan: ComponentSwitchPlan
  ): Promise<CommandResyncEvidence | undefined> {
    const evidence = await Promise.all(
      plan.verificationDeviceIds.map((deviceId) => this.options.resync({ deviceId }))
    );
    const verified = evidence.filter(
      (item): item is CommandResyncEvidence =>
        item !== undefined && item.source === "advanced_device_status"
    );
    if (verified.length !== evidence.length) {
      return undefined;
    }
    return {
      source: "advanced_device_status",
      authoritativeSnapshot: false,
      startedAtMs: Math.min(...verified.map((item) => item.startedAtMs))
    };
  }

  async #executeScene(
    request: SafeCommandRequest,
    snapshot: ReturnType<DeviceStore["snapshot"]>,
    locationNames: Readonly<Record<string, string>>
  ): Promise<SafeCommandResult> {
    if (request.command !== "execute" || request.arguments.length !== 0) throw new SafeCommandError("unsupported_command");
    const scene = snapshot.scenes.find((candidate) => candidate.id === request.targetId);
    if (!scene) throw new SafeCommandError("device_not_found");
    const expectedStates = scene.expectedStates ?? [];
    if (expectedStates.length === 0) throw new SafeCommandError("command_confirmation_timeout");
    const alreadySatisfied = sceneExpectedStatesMatchSnapshot(snapshot, expectedStates);
    const confirmation = waitForSceneExpectedStates({
      devices: this.options.devices,
      expectedStates,
      afterSequence: snapshot.sequence,
      resync: this.options.resync,
      ...(alreadySatisfied
        ? {
            confirmInventoryEvents: false,
            acceptsResyncEvidence: (evidence, minStartedAtMs) =>
              evidence?.authoritativeSnapshot === true &&
              typeof evidence.startedAtMs === "number" &&
              (minStartedAtMs === undefined || evidence.startedAtMs >= minStartedAtMs) &&
              sceneExpectedStatesMatchSnapshot(this.options.devices.snapshot(), expectedStates)
          }
        : {})
    });
    try {
      if (!this.options.executor.executeScene) throw new SafeCommandError("command_execution_failed");
      await this.options.executor.executeScene({ action: request.command, locationId: scene.locationId, locationNames, sceneName: scene.name });
    } catch (error) {
      confirmation.cancel();
      throw commandError(error);
    }
    confirmation.startTimeout(
      this.options.timeoutMs,
      alreadySatisfied ? 0 : this.options.resyncAfterMs,
      alreadySatisfied ? Date.now() : undefined
    );
    const evidence = await confirmation.result;
    return confirmed(
      request.clientRequestId,
      evidence.sequence,
      evidence.source === "inventory_snapshot" ? "inventory_snapshot" : "device_event"
    );
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
    confirmation.startTimeout(this.options.timeoutMs, this.options.resyncAfterMs);
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
  } else if (
    input.command === "setOption" ||
    input.command === "setInputSource" ||
    input.command === "setRepeat"
  ) {
    if (
      input.arguments.length !== 1 ||
      typeof input.arguments[0] !== "string" ||
      !safeControlLabel(input.arguments[0])
    ) {
      throw new SafeCommandError("invalid_arguments");
    }
  } else if (input.command === "setShuffle") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "boolean") {
      throw new SafeCommandError("invalid_arguments");
    }
  } else if (input.command === "setPosition") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "number" || !Number.isFinite(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (input.command === "playTrackAndResume") {
    if (input.arguments.length !== 1 || typeof input.arguments[0] !== "string" || input.arguments[0].length < 1 || input.arguments[0].length > 2048 || /[\u0000-\u001f\u007f]/u.test(input.arguments[0])) throw new SafeCommandError("invalid_arguments");
  } else if (isSupportedDeviceCommand(input.command) && input.arguments.length !== 0) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (typeof input.clientRequestId !== "string" || !clientRequestPattern.test(input.clientRequestId)) throw new SafeCommandError("invalid_client_request_id");
  if (input.confirm !== undefined && typeof input.confirm !== "boolean") {
    throw new SafeCommandError("invalid_arguments");
  }
  if (
    input.timeout !== undefined &&
    (typeof input.timeout !== "number" ||
      !Number.isSafeInteger(input.timeout) ||
      input.timeout < 1 ||
      input.timeout > 120)
  ) {
    throw new SafeCommandError("invalid_arguments");
  }
  return {
    targetType,
    targetId,
    ...(deviceId ? { deviceId } : {}),
    ...(typeof input.component === "string" ? { component: input.component } : {}),
    ...(typeof input.capability === "string" ? { capability: input.capability } : {}),
    ...(typeof input.attribute === "string" ? { attribute: input.attribute } : {}),
    ...(typeof input.controlId === "string" ? { controlId: input.controlId } : {}),
    ...(typeof input.controlLabel === "string" ? { controlLabel: input.controlLabel } : {}),
    ...(typeof input.confirm === "boolean" ? { confirm: input.confirm } : {}),
    ...(typeof input.timeout === "number" ? { timeout: input.timeout } : {}),
    command: input.command,
    arguments: input.arguments.map((value) => jsonValue(value) as BridgeJsonValue),
    clientRequestId: input.clientRequestId
  };
}

function findState(device: BridgeDevice, component: string, capability: string, attribute: string): BridgeDeviceState | undefined {
  return device.states.find((state) => state.component === component && state.capability === capability && state.attribute === attribute);
}

type CommandResync = () => Promise<CommandResyncEvidence | undefined>;

function waitForState(options: { devices: DeviceStore; request: SafeCommandRequest; attribute: string; desired: BridgeJsonValue | undefined; afterSequence: number; stabilityMs: number; resync: CommandResync; minimumEventTimeMs?: () => number | undefined; expectedCommandId?: () => string | undefined }): ConfirmationWait {
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
    return state !== undefined && stateValuesEqual(state.value, options.desired);
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
          stateValuesEqual(event.state.value, options.desired))) ||
      (event.type === "inventory" && snapshotMatches()),
    invalidates: (event) =>
      options.desired !== undefined &&
      ((event.type === "state" &&
        event.deviceId === options.request.targetId &&
        event.state.component === options.request.component &&
        event.state.capability === options.request.capability &&
        event.state.attribute === options.attribute &&
        !stateValuesEqual(event.state.value, options.desired)) ||
        (event.type === "inventory" && !snapshotMatches())),
    matchesSnapshot: snapshotMatches,
    acceptsEvidence: (evidence) => {
      if (evidence.source !== "event") return true;
      const minimumEventTimeMs = options.minimumEventTimeMs?.();
      if (
        minimumEventTimeMs !== undefined &&
        evidence.eventTime &&
        Date.parse(evidence.eventTime) <= minimumEventTimeMs
      ) {
        return false;
      }
      const expectedCommandId = options.expectedCommandId?.();
      return !expectedCommandId || !evidence.commandId || expectedCommandId === evidence.commandId;
    }
  });
}

function waitForSceneExpectedStates(options: {
  devices: DeviceStore;
  expectedStates: BridgeSceneExpectedState[];
  afterSequence: number;
  resync: CommandResync;
  confirmInventoryEvents?: boolean;
  acceptsResyncEvidence?: (evidence: CommandResyncEvidence | undefined, minStartedAtMs?: number) => boolean;
}): ConfirmationWait {
  const expectedByKey = new Map(options.expectedStates.map((expected) => [sceneExpectedStateKey(expected), expected]));
  const observed = new Set<string>();
  const rebuildObservedFromSnapshot = (): boolean => {
    const snapshot = options.devices.snapshot();
    observed.clear();
    for (const expected of expectedByKey.values()) {
      const matches = snapshot.devices.some((device) =>
        device.id === expected.deviceId &&
        device.states.some(
          (state) =>
            state.component === expected.component &&
            state.capability === expected.capability &&
            state.attribute === expected.attribute &&
            stateValuesEqual(state.value, expected.value)
        )
      );
      if (matches) observed.add(sceneExpectedStateKey(expected));
    }
    return observed.size === expectedByKey.size;
  };
  const updateObserved = (state: BridgeDeviceState, deviceId: string): "match" | "mismatch" | "unrelated" => {
    const key = sceneStateKey(deviceId, state.component, state.capability, state.attribute);
    const expected = expectedByKey.get(key);
    if (!expected) return "unrelated";
    if (stateValuesEqual(state.value, expected.value)) {
      observed.add(key);
      return "match";
    }
    observed.delete(key);
    return "mismatch";
  };
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) =>
      event.type === "inventory"
        ? options.confirmInventoryEvents !== false && rebuildObservedFromSnapshot()
        : updateObserved(event.state, event.deviceId) === "match" &&
          observed.size === expectedByKey.size,
    invalidates: (event) =>
      event.type === "inventory"
        ? options.confirmInventoryEvents !== false && !rebuildObservedFromSnapshot()
        : updateObserved(event.state, event.deviceId) === "mismatch",
    ...(options.confirmInventoryEvents === false
      ? {}
      : { matchesSnapshot: rebuildObservedFromSnapshot }),
    ...(options.acceptsResyncEvidence
      ? { acceptsResyncEvidence: options.acceptsResyncEvidence }
      : {})
  });
}

function sceneExpectedStatesMatchSnapshot(
  snapshot: ReturnType<DeviceStore["snapshot"]>,
  expectedStates: readonly BridgeSceneExpectedState[]
): boolean {
  return expectedStates.every((expected) =>
    snapshot.devices.some((device) =>
      device.id === expected.deviceId &&
      device.states.some(
        (state) =>
          state.component === expected.component &&
          state.capability === expected.capability &&
          state.attribute === expected.attribute &&
          stateValuesEqual(state.value, expected.value)
      )
    )
  );
}

function sceneExpectedStateKey(expected: BridgeSceneExpectedState): string {
  return sceneStateKey(expected.deviceId, expected.component, expected.capability, expected.attribute);
}

function sceneStateKey(deviceId: string, component: string, capability: string, attribute: string): string {
  return `${deviceId}\u0000${component}\u0000${capability}\u0000${attribute}`;
}

function waitForAnyDeviceEvent(options: {
  devices: DeviceStore;
  deviceId: string;
  afterSequence: number;
  resync: CommandResync;
}): ConfirmationWait {
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => event.type === "state" && event.deviceId === options.deviceId
  });
}

function waitForRefreshCommand(options: {
  devices: DeviceStore;
  deviceId: string;
  afterSequence: number;
  resync: CommandResync;
}): ConfirmationWait {
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => event.type === "state" && event.deviceId === options.deviceId,
    acceptsResyncEvidence: (evidence, minStartedAtMs) =>
      evidence?.authoritativeSnapshot === true &&
      typeof evidence.startedAtMs === "number" &&
      (minStartedAtMs === undefined || evidence.startedAtMs >= minStartedAtMs) &&
      options.devices.snapshot().devices.some((device) => device.id === options.deviceId)
  });
}

function waitForLocationArmState(options: { devices: DeviceStore; locationId: string; desired: string; afterSequence: number; resync: CommandResync }): ConfirmationWait {
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    matches: (event) => event.type === "inventory" && options.devices.snapshot().locations.some((location) => location.id === options.locationId && location.armState?.toUpperCase() === options.desired)
  });
}

function waitForComponentVector(options: {
  devices: DeviceStore;
  expected: readonly ComponentVectorState[];
  afterSequence: number;
  resync: CommandResync;
}): ConfirmationWait {
  const matchesSnapshot = () =>
    componentVectorMatches(options.devices.snapshot(), options.expected);
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    resync: options.resync,
    // Push events may update the vector, but only a successful Advanced status
    // refresh can confirm or restore an aggregate component transaction.
    matches: () => false,
    acceptsResyncEvidence: (evidence, minStartedAtMs) =>
      evidence !== undefined &&
      evidence.source === "advanced_device_status" &&
      (minStartedAtMs === undefined || evidence.startedAtMs >= minStartedAtMs) &&
      matchesSnapshot(),
    forceFinalResync: true
  });
}

interface ConfirmationWait {
  result: Promise<ConfirmationEvidence>;
  cancel: () => void;
  startTimeout: (timeoutMs: number, resyncAfterMs?: number, minResyncStartedAtMs?: number) => void;
}

interface ConfirmationEvidence {
  sequence: number;
  source: "event" | "inventory_snapshot";
  eventTime?: string;
  commandId?: string;
}

function waitForPredicate(options: { devices: DeviceStore; afterSequence: number; resync: CommandResync; matches: (event: BridgeDeviceStoreEvent) => boolean; invalidates?: (event: BridgeDeviceStoreEvent) => boolean; matchesSnapshot?: () => boolean; acceptsResyncEvidence?: (evidence: CommandResyncEvidence | undefined, minStartedAtMs?: number) => boolean; acceptsEvidence?: (evidence: ConfirmationEvidence) => boolean; stabilityMs?: number; forceFinalResync?: boolean }): ConfirmationWait {
  let settled = false;
  let interactionComplete = false;
  let unsubscribe: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let resyncTimer: NodeJS.Timeout | undefined;
  let finalResyncTimer: NodeJS.Timeout | undefined;
  let stabilityTimer: NodeJS.Timeout | undefined;
  let resyncPromise: Promise<void> | undefined;
  let lastResyncStartedAfterSequence: number | undefined;
  let pendingEvidence: ConfirmationEvidence | undefined;
  let rejectResult: (error: SafeCommandError) => void = () => undefined;
  let resolveResult: (evidence: ConfirmationEvidence) => void = () => undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    if (resyncTimer) clearTimeout(resyncTimer);
    if (finalResyncTimer) clearTimeout(finalResyncTimer);
    if (stabilityTimer) clearTimeout(stabilityTimer);
    unsubscribe();
  };
  const resolvePending = () => {
    if (settled || !interactionComplete || !pendingEvidence) return;
    if (options.acceptsEvidence?.(pendingEvidence) === false) {
      pendingEvidence = undefined;
      return;
    }
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
        source: event.type === "inventory" ? "inventory_snapshot" : "event",
        ...(event.type === "state" && event.eventTime ? { eventTime: event.eventTime } : {}),
        ...(event.type === "state" && event.commandId ? { commandId: event.commandId } : {})
      };
      resolvePending();
    });
  });
  const settleFromSnapshot = async (
    minimumSequence = options.afterSequence
  ): Promise<boolean> => {
    if (settled || options.matchesSnapshot?.() !== true) return settled;
    const stabilityMs = Math.max(0, options.stabilityMs ?? 0);
    if (stabilityMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, stabilityMs));
      if (settled || options.matchesSnapshot?.() !== true) return settled;
    }
    const sequence = options.devices.snapshot().sequence;
    if (sequence <= minimumSequence) return false;
    cleanup();
    resolveResult({ sequence, source: "inventory_snapshot" });
    return true;
  };
  const settleFromResyncEvidence = (evidence: CommandResyncEvidence | undefined, minStartedAtMs: number | undefined): boolean => {
    if (settled || options.acceptsResyncEvidence?.(evidence, minStartedAtMs) !== true) return settled;
    cleanup();
    resolveResult({
      sequence: options.devices.snapshot().sequence,
      source: "inventory_snapshot"
    });
    return true;
  };
  const resyncAndCheck = (
    minStartedAtMs?: number,
    force = false
  ): Promise<void> => {
    const performResync = async (): Promise<void> => {
      if (settled) return;
      lastResyncStartedAfterSequence = options.devices.currentSequence();
      const evidence = await options.resync().catch(() => undefined);
      if (settleFromResyncEvidence(evidence, minStartedAtMs)) return;
      await settleFromSnapshot(lastResyncStartedAfterSequence);
    };
    if (force) return performResync();
    if (!resyncPromise) {
      resyncPromise = performResync();
    }
    return resyncPromise;
  };
  return {
    result,
    startTimeout: (timeoutMs, resyncAfterMs, minResyncStartedAtMs) => {
      if (settled || timer) return;
      interactionComplete = true;
      resolvePending();
      if (settled) return;
      const hasEarlyResync =
        resyncAfterMs !== undefined &&
        Number.isFinite(resyncAfterMs) &&
        resyncAfterMs >= 0 &&
        resyncAfterMs < timeoutMs;
      if (options.forceFinalResync === true) {
        const finalLeadMs = Math.min(5_000, Math.max(1, Math.floor(timeoutMs / 3)));
        const finalResyncAfterMs = Math.max(0, timeoutMs - finalLeadMs);
        if (hasEarlyResync && resyncAfterMs < finalResyncAfterMs) {
          resyncTimer = setTimeout(() => {
            resyncTimer = undefined;
            void resyncAndCheck(minResyncStartedAtMs);
          }, resyncAfterMs);
        }
        finalResyncTimer = setTimeout(() => {
          finalResyncTimer = undefined;
          void resyncAndCheck(minResyncStartedAtMs, true);
        }, finalResyncAfterMs);
        timer = setTimeout(() => {
          timer = undefined;
          if (settled) return;
          cleanup();
          rejectResult(new SafeCommandError("command_confirmation_timeout"));
        }, timeoutMs);
        return;
      }
      if (hasEarlyResync) {
        resyncTimer = setTimeout(() => {
          resyncTimer = undefined;
          void resyncAndCheck(minResyncStartedAtMs);
        }, resyncAfterMs);
      }
      timer = setTimeout(() => {
        timer = undefined;
        const finalCheck = hasEarlyResync
          ? settleFromSnapshot(lastResyncStartedAfterSequence ?? options.afterSequence)
          : resyncAndCheck(minResyncStartedAtMs).then(() =>
              settleFromSnapshot(lastResyncStartedAfterSequence ?? options.afterSequence)
            );
        void finalCheck.then((confirmedBySnapshot) => {
          if (settled || confirmedBySnapshot) return;
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
  return [
    "on",
    "off",
    "press",
    "setNumber",
    "setVolume",
    "mute",
    "unmute",
    "setFanMode",
    "setOption",
    "setInputSource",
    "setRepeat",
    "setShuffle",
    "open",
    "close",
    "stop",
    "pause",
    "openShade",
    "closeShade",
    "setPosition",
    "fanSpeed",
    "volume",
    "play",
    "nextTrack",
    "previousTrack",
    "fastForward",
    "rewind",
    "refresh",
    "playTrackAndResume"
  ].includes(command);
}

function confirmsAnyNewDeviceState(request: SafeCommandRequest): boolean {
  const command = request.command;
  if ((command === "stop" || command === "pause") && request.controlId && COVER_ATTRIBUTES.has(request.attribute ?? "")) {
    return true;
  }
  return ["press", "refresh", "nextTrack", "previousTrack", "playTrackAndResume"].includes(command);
}

function allowsMissingCurrentState(
  command: string,
  descriptor?: AdvancedCommandDescriptor
): boolean {
  return descriptor?.confirmation === "accepted_receipt" || isControlBoundCommand(command) || command === "refresh";
}

function desiredValueFor(command: string, args: BridgeJsonValue[], state: BridgeDeviceState | undefined): BridgeJsonValue | undefined {
  if (command === "on" || command === "off") {
    if (typeof state?.value === "boolean") return command === "on";
    if (typeof state?.value === "string") {
      const current = state.value.trim().toLowerCase();
      if (["enabled", "disabled"].includes(current)) {
        return command === "on" ? "enabled" : "disabled";
      }
      if (["true", "false"].includes(current)) {
        return command === "on" ? "true" : "false";
      }
      if (["active", "inactive"].includes(current)) {
        return command === "on" ? "active" : "inactive";
      }
    }
    return command;
  }
  if (command === "mute" && args.length === 0) return "muted";
  if (command === "unmute" && args.length === 0) return "unmuted";
  if (command === "play" && args.length === 0) return "playing";
  if (command === "pause" && args.length === 0) return "paused";
  if (command === "stop" && args.length === 0) return "stopped";
  if (command === "fastForward" && args.length === 0) return "fast forwarding";
  if (command === "rewind" && args.length === 0) return "rewinding";
  if ((command === "open" || command === "openShade") && args.length === 0) return "open";
  if ((command === "close" || command === "closeShade") && args.length === 0) return "closed";
  if (args.length !== 1) return undefined;
  const value = args[0];
  if (
    (command === "setOption" ||
      command === "setInputSource" ||
      command === "setRepeat") &&
    typeof value === "string"
  ) {
    return value;
  }
  if (command === "setShuffle" && typeof value === "boolean") {
    return shuffleDesiredValue(value, state);
  }
  if (command === "setPosition" && typeof value === "number") return value;
  if (state && typeof state.value === "number" && typeof value !== "number") return undefined;
  if (state && typeof state.value === "string" && typeof value !== "string") return undefined;
  return value;
}

function buildComponentSwitchPlan(
  device: BridgeDevice,
  request: ResolvedDeviceRequest,
  requestedState: BridgeDeviceState,
  devices: DeviceStore,
  snapshot: ReturnType<DeviceStore["snapshot"]>,
  locationNames: Readonly<Record<string, string>>
): ComponentSwitchPlan | undefined {
  const desiredCommand = request.command;
  if (
    (desiredCommand !== "on" && desiredCommand !== "off") ||
    componentRole(requestedState) !== "main"
  ) {
    return undefined;
  }
  const states = device.states
    .filter((state) => state.attribute === "switch" && state.componentRole !== undefined)
    .sort(compareSwitchComponents);
  if (states.length < 2) return undefined;
  if (
    dangerousControlText(device.type ?? "") ||
    (device.controls ?? []).some(dangerousControl)
  ) {
    throw new SafeCommandError("unsupported_command");
  }
  const entryFor = (
    deviceId: string,
    state: BridgeDeviceState
  ): ComponentSwitchEntry | undefined => {
    const capabilityVersion = devices.capabilityVersion(
      deviceId,
      state.component,
      state.capability
    );
    const originalCommand = switchCommandForValue(state);
    const desiredValue = desiredValueFor(request.command, [], state);
    if (
      capabilityVersion === undefined ||
      !Number.isSafeInteger(capabilityVersion) ||
      capabilityVersion < 0 ||
      originalCommand === undefined ||
      desiredValue === undefined
    ) {
      return undefined;
    }
    return {
      deviceId,
      state,
      capabilityVersion,
      originalCommand,
      desiredValue,
      desiredCommand
    };
  };
  const childDeviceIds = device.advanced?.childDeviceIds ?? [];
  const learnedChildMappings = devices.componentChildMappings(device.id);
  let parentVerificationStates: BridgeDeviceState[] = [];
  let safeEntries: ComponentSwitchEntry[];
  if (childDeviceIds.length > 0) {
    const childEntries = childMappedSwitchEntries(
      states,
      childDeviceIds,
      snapshot,
      entryFor,
      learnedChildMappings
    );
    if (!childEntries) throw new SafeCommandError("unsupported_command");
    const secondaryStates = states.filter((state) => componentRole(state) !== "main");
    const mappings = secondaryStates.map((state, index) => {
      const childEntry = childEntries[index];
      if (!childEntry) throw new SafeCommandError("unsupported_command");
      return {
        component: state.component,
        childDeviceId: childEntry.deviceId
      };
    });
    devices.rememberComponentChildMappings(
      device.id,
      mappings
    );
    safeEntries = childEntries;
    parentVerificationStates = states;
  } else {
    if (learnedChildMappings) throw new SafeCommandError("unsupported_command");
    const entries = states.map((state) => entryFor(device.id, state));
    if (entries.some((entry) => entry === undefined)) return undefined;
    safeEntries = entries.filter(
      (entry): entry is ComponentSwitchEntry => entry !== undefined
    );
  }
  const action = (
    entry: (typeof safeEntries)[number],
    command: "on" | "off"
  ): ComponentActionExecutionInput => ({
    deviceId: entry.deviceId,
    component: entry.state.component,
    capability: entry.state.capability,
    capabilityVersion: entry.capabilityVersion,
    command,
    arguments: []
  });
  const changed = safeEntries.filter((entry) =>
    !stateValuesEqual(entry.state.value, entry.desiredValue)
  );
  const webAction = (
    entry: (typeof safeEntries)[number],
    command: "on" | "off"
  ) => childWebAction(entry, command, snapshot, locationNames);
  const childMapped = childDeviceIds.length > 0;
  const webForward = childMapped
    ? changed.map((entry) => webAction(entry, entry.desiredCommand))
    : [];
  const webForwardRollback = childMapped
    ? changed.map((entry) => webAction(entry, entry.originalCommand))
    : [];
  const webRollback = childMapped
    ? safeEntries.map((entry) => webAction(entry, entry.originalCommand))
    : [];
  if (
    childMapped &&
    [...webForward, ...webForwardRollback, ...webRollback].some(
      (input) => input === undefined
    )
  ) {
    throw new SafeCommandError("unsupported_command");
  }
  const webForwardActions = webForward.filter(isDeviceActionExecutionInput);
  const webForwardRollbackActions = webForwardRollback.filter(
    isDeviceActionExecutionInput
  );
  const webRollbackActions = webRollback.filter(isDeviceActionExecutionInput);
  const executionPlan: Pick<
    ComponentSwitchPlan,
    "componentTransaction" | "webTransaction"
  > = childMapped
    ? {
        webTransaction: {
          forward: {
            actions: webForwardActions,
            rollbackActions: webForwardRollbackActions
          },
          rollback: {
            actions: webRollbackActions,
            rollbackActions: webRollbackActions
          }
        }
      }
    : {
        componentTransaction: {
          forward: {
            actions: changed.map((entry) => action(entry, entry.desiredCommand)),
            rollbackActions: changed.map((entry) => action(entry, entry.originalCommand))
          },
          rollback: {
            actions: safeEntries.map((entry) => action(entry, entry.originalCommand)),
            rollbackActions: safeEntries.map((entry) => action(entry, entry.originalCommand))
          }
        }
      };
  return {
    ...executionPlan,
    desiredVector: safeEntries.map((entry) => ({
      deviceId: entry.deviceId,
      component: entry.state.component,
      capability: entry.state.capability,
      attribute: entry.state.attribute,
      value: entry.desiredValue
    })).concat(parentVerificationStates.map((state) => {
      const value = desiredValueFor(desiredCommand, [], state);
      if (value === undefined) throw new SafeCommandError("invalid_arguments");
      return {
        deviceId: device.id,
        component: state.component,
        capability: state.capability,
        attribute: state.attribute,
        value
      };
    })),
    originalVector: safeEntries.map((entry) => ({
      deviceId: entry.deviceId,
      component: entry.state.component,
      capability: entry.state.capability,
      attribute: entry.state.attribute,
      value: entry.state.value
    })).concat(parentVerificationStates.map((state) => ({
      deviceId: device.id,
      component: state.component,
      capability: state.capability,
      attribute: state.attribute,
      value: state.value
    }))),
    verificationDeviceIds: [
      ...(childDeviceIds.length > 0 ? [device.id] : []),
      ...new Set(safeEntries.map((entry) => entry.deviceId))
    ]
  };
}

function childMappedSwitchEntries(
  parentStates: readonly BridgeDeviceState[],
  childDeviceIds: readonly string[],
  snapshot: ReturnType<DeviceStore["snapshot"]>,
  entryFor: (deviceId: string, state: BridgeDeviceState) => ComponentSwitchEntry | undefined,
  learnedMappings?: ReadonlyMap<string, string>
): ComponentSwitchEntry[] | undefined {
  const secondaryStates = parentStates.filter((state) => componentRole(state) !== "main");
  if (secondaryStates.length === 0 || secondaryStates.length !== childDeviceIds.length) {
    return undefined;
  }
  const candidates = childDeviceIds.map((deviceId) => {
    const device = snapshot.devices.find((item) => item.id === deviceId);
    const state = device?.states.find(
      (item) =>
        item.attribute === "switch" &&
        item.componentRole !== undefined &&
        componentRole(item) === "main"
    );
    if (
      !device ||
      !device.online ||
      !state ||
      !state.updatedAt ||
      dangerousControlText(device.type ?? "") ||
      (device.controls ?? []).some(dangerousControl)
    ) {
      return undefined;
    }
    return { device, state, updatedAt: state.updatedAt };
  });
  if (candidates.some((candidate) => candidate === undefined)) return undefined;
  const safeCandidates = candidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined
  );
  const assignments: ComponentSwitchEntry[][] = [];
  const visit = (
    parentIndex: number,
    remaining: typeof safeCandidates,
    entries: ComponentSwitchEntry[]
  ): void => {
    if (parentIndex === secondaryStates.length) {
      assignments.push(entries);
      return;
    }
    const parentState = secondaryStates[parentIndex];
    if (!parentState) return;
    const parentUpdatedAt = parentState.updatedAt;
    if (!parentUpdatedAt) return;
    const parentUpdatedAtMs = Date.parse(parentUpdatedAt);
    if (!Number.isFinite(parentUpdatedAtMs)) return;
    for (const [candidateIndex, candidate] of remaining.entries()) {
      const candidateUpdatedAtMs = Date.parse(candidate.updatedAt);
      if (!Number.isFinite(candidateUpdatedAtMs)) continue;
      const deltaMs = Math.abs(candidateUpdatedAtMs - parentUpdatedAtMs);
      if (
        deltaMs > 900 ||
        !stateValuesEqual(candidate.state.value, parentState.value)
      ) {
        continue;
      }
      const entry = entryFor(candidate.device.id, candidate.state);
      if (!entry) continue;
      visit(
        parentIndex + 1,
        remaining.filter((_item, index) => index !== candidateIndex),
        [...entries, entry]
      );
    }
  };
  visit(0, safeCandidates, []);
  if (assignments.length === 1) return assignments[0];
  if (!learnedMappings || learnedMappings.size !== secondaryStates.length) {
    return undefined;
  }
  const learnedChildIds = secondaryStates.map((state) => learnedMappings.get(state.component));
  if (
    learnedChildIds.some((deviceId) => deviceId === undefined) ||
    new Set(learnedChildIds).size !== childDeviceIds.length ||
    !childDeviceIds.every((deviceId) => learnedChildIds.includes(deviceId))
  ) {
    return undefined;
  }
  const entries = learnedChildIds.map((deviceId) => {
    const candidate = safeCandidates.find((item) => item.device.id === deviceId);
    return candidate ? entryFor(candidate.device.id, candidate.state) : undefined;
  });
  return entries.every((entry): entry is ComponentSwitchEntry => entry !== undefined)
    ? entries
    : undefined;
}

function childWebAction(
  entry: ComponentSwitchEntry,
  command: "on" | "off",
  snapshot: ReturnType<DeviceStore["snapshot"]>,
  locationNames: Readonly<Record<string, string>>
): DeviceActionExecutionInput | undefined {
  const device = snapshot.devices.find((item) => item.id === entry.deviceId);
  if (!device) return undefined;
  const matches = (device.controls ?? []).filter(
    (control) =>
      control.kind === "toggle" &&
      control.component === entry.state.component &&
      control.capability === entry.state.capability &&
      control.attribute === entry.state.attribute
  );
  const actionMatches = matches.filter((control) => control.id.startsWith("action:"));
  const control = matches.length === 1
    ? matches[0]
    : actionMatches.length === 1
      ? actionMatches[0]
      : undefined;
  if (
    !control ||
    dangerousControl(control) ||
    !controlSupportsCommand(control, command, false)
  ) {
    return undefined;
  }
  const nativeCommand = observedCommandFor(control, command) ?? command;
  const roomName = device.roomId
    ? snapshot.rooms.find((room) => room.id === device.roomId)?.name
    : undefined;
  return {
    action: command,
    arguments: [],
    attribute: entry.state.attribute,
    capability: entry.state.capability,
    capabilityVersion: entry.capabilityVersion,
    command,
    component: entry.state.component,
    deviceId: entry.deviceId,
    deviceName: device.name,
    locationId: device.locationId,
    locationNames,
    ...(roomName ? { roomName } : {}),
    controlId: control.id,
    controlLabel: control.label,
    nativeCommand,
    requireLocationNative: true
  };
}

function isDeviceActionExecutionInput(
  value: DeviceActionExecutionInput | undefined
): value is DeviceActionExecutionInput {
  return value !== undefined;
}

function switchCommandForValue(state: BridgeDeviceState): "on" | "off" | undefined {
  const onValue = desiredValueFor("on", [], state);
  const offValue = desiredValueFor("off", [], state);
  const isOn = stateValuesEqual(state.value, onValue);
  const isOff = stateValuesEqual(state.value, offValue);
  if (isOn === isOff) return undefined;
  return isOn ? "on" : "off";
}

function compareSwitchComponents(left: BridgeDeviceState, right: BridgeDeviceState): number {
  const leftOrder = switchComponentOrder(left);
  const rightOrder = switchComponentOrder(right);
  if (leftOrder.group !== rightOrder.group) return leftOrder.group - rightOrder.group;
  if (leftOrder.number !== rightOrder.number) return leftOrder.number - rightOrder.number;
  return leftOrder.token.localeCompare(rightOrder.token);
}

function switchComponentOrder(state: BridgeDeviceState): {
  group: number;
  number: number;
  token: string;
} {
  const token = componentRole(state);
  if (token === "main") return { group: 0, number: 0, token };
  const numbered = token.match(/^switch(\d+)$/u);
  if (numbered) return { group: 1, number: Number(numbered[1]), token };
  return { group: 2, number: 0, token };
}

function componentRole(state: BridgeDeviceState): string {
  const value = state.componentRole ?? state.component.replace(/^identifier_/u, "");
  return value.trim().toLowerCase();
}

function componentVectorMatches(
  snapshot: ReturnType<DeviceStore["snapshot"]>,
  expected: readonly ComponentVectorState[]
): boolean {
  return expected.every((item) => {
    const device = snapshot.devices.find((candidate) => candidate.id === item.deviceId);
    if (!device) return false;
    const state = findState(
      device,
      item.component,
      item.capability,
      item.attribute
    );
    return state !== undefined && stateValuesEqual(state.value, item.value);
  });
}

function armStateForCommand(command: string): string | undefined {
  return { armAway: "ARMED_AWAY", armStay: "ARMED_STAY", disarm: "DISARMED" }[command];
}

function shuffleDesiredValue(
  enabled: boolean,
  state: BridgeDeviceState | undefined
): BridgeJsonValue {
  if (typeof state?.value !== "string") return enabled;
  const current = state.value.trim().toLowerCase();
  const pairs: Array<readonly [string, string]> = [
    ["on", "off"],
    ["enabled", "disabled"],
    ["true", "false"],
    ["shuffled", "linear"]
  ];
  for (const [onValue, offValue] of pairs) {
    if (current === onValue || current === offValue) {
      return enabled ? onValue : offValue;
    }
  }
  return enabled ? "on" : "off";
}

function resolveDeviceRequest(device: BridgeDevice, request: SafeCommandRequest): ResolvedDeviceRequest {
  if (request.command === "refresh") {
    const matching = (device.controls ?? []).filter(
      (control) =>
        control.kind === "button" &&
        (!request.controlId || control.id === request.controlId) &&
        controlSupportsCommand(control, "refresh", true)
    );
    if (matching.length > 1) throw new SafeCommandError("command_control_ambiguous");
    const control = matching[0];
    if (!control) throw new SafeCommandError("invalid_control_id");
    if (request.controlLabel && request.controlLabel !== control.label) {
      throw new SafeCommandError("invalid_control_label");
    }
    if (dangerousControl(control)) throw new SafeCommandError("unsupported_command");
    const nativeCommand = observedCommandFor(control, "refresh");
    if (!nativeCommand) throw new SafeCommandError("unsupported_command");
    return {
      ...request,
      component: control.component,
      capability: control.capability,
      attribute: control.attribute,
      controlId: control.id,
      controlLabel: control.label,
      nativeCommand
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
      const supportsRequestedCommand =
        !hasExplicitCommand || controlSupportsCommand(control, request.command, false);
      if (!supportsRequestedCommand) {
        const current = findState(
          device,
          control.component,
          control.capability,
          attribute
        );
        const desired = desiredValueFor(request.command, request.arguments, current);
        if (!current || desired === undefined || !stateValuesEqual(current.value, desired)) {
          throw new SafeCommandError("unsupported_command");
        }
      }
      // Cake's captured toggle command exchanges use the canonical on/off token
      // even when the detail swatch omits a commands array. The observed toggle
      // identity still gates this path, so no unobserved writable control opens.
      const nativeCommand = supportsRequestedCommand
        ? observedCommandFor(control, request.command) ?? request.command
        : undefined;
      return {
        ...request,
        attribute,
        controlId: control.id,
        controlLabel: control.label,
        ...(nativeCommand ? { nativeCommand } : {}),
        ...(control.transport === "advanced" ? { requireAdvanced: true } : {})
      };
    }
    const descriptor = resolveAdvancedDescriptor(device, request);
    if (descriptor) return descriptor;
    throw new SafeCommandError("invalid_control_id");
  }
  if (request.attribute) {
    validateCommandAttribute(request.command, request.attribute, request.controlId);
  }
  if (request.command === "setFanMode" && !request.controlId) {
    throw new SafeCommandError("invalid_control_id");
  }
  const observedFanMode = request.command === "setFanMode";
  if (isControlBoundCommand(request.command) && !request.controlId) {
    throw new SafeCommandError("invalid_control_id");
  }
  const observedControlCommand = isControlBoundCommand(request.command);
  if (!observedControlCommand && !observedFanMode) {
    if (requiresObservedControl(request.command)) throw new SafeCommandError("invalid_control_id");
    const descriptor = resolveAdvancedDescriptor(device, request);
    if (descriptor) return descriptor;
    if (isSupportedDeviceCommand(request.command)) return request;
    throw new SafeCommandError("unsupported_command");
  }
  if (!request.controlId) throw new SafeCommandError("invalid_control_id");
  const control = device.controls?.find((candidate) => candidate.id === request.controlId);
  if (!control) throw new SafeCommandError("capability_not_found");
  if (request.component && request.component !== control.component) throw new SafeCommandError("invalid_component");
  if (request.capability && request.capability !== control.capability) throw new SafeCommandError("invalid_capability");
  if (request.attribute && request.attribute !== control.attribute) throw new SafeCommandError("invalid_capability");
  if (request.controlLabel && request.controlLabel !== control.label) throw new SafeCommandError("invalid_control_label");
  const option = validateObservedControlCommand(control, request.command, request.arguments);
  const nativeCommand = option?.command ?? nativeCommandFor(control, request.command);
  return {
    ...request,
    component: control.component,
    capability: control.capability,
    attribute: control.attribute,
    controlLabel: control.label,
    ...(nativeCommand ? { nativeCommand } : {}),
    ...(option?.label ? { optionLabel: option.label } : {}),
    ...(option?.command ? { optionCommand: option.command } : {}),
    ...(control.transport === "advanced" ? { requireAdvanced: true } : {})
  };
}

function resolveAdvancedDescriptor(
  device: BridgeDevice,
  request: SafeCommandRequest
): ResolvedDeviceRequest | undefined {
  if (!request.component || !request.capability) return undefined;
  const omitted = (device.commandOmissions ?? []).some(
    (omission) =>
      omission.component === request.component &&
      omission.capability === request.capability &&
      (omission.command === undefined || omission.command === request.command)
  );
  if (omitted) throw new SafeCommandError("unsupported_command");
  const matching = (device.advancedCommands ?? []).filter(
    (descriptor) =>
      descriptor.component === request.component &&
      descriptor.capability === request.capability &&
      descriptor.command === request.command
  );
  if (matching.length > 1) throw new SafeCommandError("command_control_ambiguous");
  const descriptor = matching[0];
  if (!descriptor) return undefined;
  if (safeAdvancedCommandReason(descriptor)) throw new SafeCommandError("unsupported_command");
  validateAdvancedDescriptorArguments(descriptor, request.arguments);
  return {
    ...request,
    component: descriptor.component,
    capability: descriptor.capability,
    advancedDescriptor: descriptor,
    requireAdvanced: true
  };
}

function validateAdvancedDescriptorArguments(
  descriptor: AdvancedCommandDescriptor,
  values: readonly BridgeJsonValue[]
): void {
  if (values.length > descriptor.arguments.length) throw new SafeCommandError("invalid_arguments");
  const lastRequiredIndex = descriptor.arguments.findLastIndex((argument) => argument.required);
  if (lastRequiredIndex >= values.length) throw new SafeCommandError("invalid_arguments");
  for (const [index, value] of values.entries()) {
    const argument = descriptor.arguments[index];
    if (!argument) throw new SafeCommandError("invalid_arguments");
    validateAdvancedDescriptorValue(argument.schema, value);
  }
}

function validateAdvancedDescriptorValue(
  schema: AdvancedCommandDescriptor["arguments"][number]["schema"],
  value: BridgeJsonValue
): void {
  if (schema.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (schema.type === "string") {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 2048 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new SafeCommandError("invalid_arguments");
    }
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    throw new SafeCommandError("invalid_arguments");
  }
  if (schema.type === "array" && !Array.isArray(value)) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (schema.type === "object" && !isRecord(value)) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (schema.enum && !schema.enum.some((candidate) => jsonValue(candidate) !== undefined && JSON.stringify(candidate) === JSON.stringify(value))) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) throw new SafeCommandError("invalid_arguments");
    if (schema.maximum !== undefined && value > schema.maximum) throw new SafeCommandError("invalid_arguments");
  }
}

function nativeCommandFor(
  control: NonNullable<BridgeDevice["controls"]>[number],
  requested: string
): string | undefined {
  if (
    (requested === "setOption" ||
      requested === "setFanMode" ||
      requested === "setInputSource" ||
      requested === "setRepeat" ||
      requested === "setShuffle") &&
    control.command
  ) {
    return control.command;
  }
  if (["press", "setNumber", "setVolume", "setPosition"].includes(requested) && control.command) {
    return control.command;
  }
  return observedCommandFor(control, requested);
}

function validateCommandAttribute(
  command: string,
  attribute: string,
  controlId?: string
): void {
  if (command === "setNumber" && !controlId && !NUMBER_ATTRIBUTES.has(attribute)) {
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
  if (command === "setInputSource" && !SOURCE_ATTRIBUTES.has(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
  if (command === "setRepeat" && !REPEAT_ATTRIBUTES.has(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
  if (command === "setShuffle" && !SHUFFLE_ATTRIBUTES.has(attribute)) {
    throw new SafeCommandError("unsupported_command");
  }
  if (
    (["open", "close", "openShade", "closeShade"].includes(command) ||
      command === "setPosition") &&
    !COVER_ATTRIBUTES.has(attribute)
  ) {
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

const SOURCE_ATTRIBUTES = new Set([
  "audioSource",
  "inputSource",
  "mediaSource",
  "source"
]);

const REPEAT_ATTRIBUTES = new Set([
  "mediaRepeat",
  "mediaRepeatMode",
  "playbackRepeatMode",
  "repeat",
  "repeatMode"
]);

const SHUFFLE_ATTRIBUTES = new Set([
  "playbackShuffle",
  "playbackShuffleMode",
  "shuffle",
  "shuffleMode",
  "shuffleStatus"
]);

function isControlBoundCommand(command: string): boolean {
  return (
    requiresObservedControl(command) ||
    command === "setNumber" ||
    command === "setVolume" ||
    command === "mute" ||
    command === "unmute" ||
    isMediaControlCommand(command)
  );
}

function isPlaybackOptionCommand(command: string): boolean {
  return ["play", "pause", "stop", "fastForward", "rewind"].includes(command);
}

function isEnumeratedMediaCommand(command: string): boolean {
  return isPlaybackOptionCommand(command) || ["nextTrack", "previousTrack"].includes(command);
}

function isMediaControlCommand(command: string): boolean {
  return (
    isPlaybackOptionCommand(command) ||
    [
      "nextTrack",
      "previousTrack",
      "playTrackAndResume",
      "setInputSource",
      "setRepeat",
      "setShuffle"
    ].includes(command)
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
  if (command === "mute" || command === "unmute") {
    if (control.kind !== "toggle" || control.attribute !== "mute") {
      throw new SafeCommandError("capability_not_found");
    }
    if (!controlSupportsCommand(control, command, false)) {
      throw new SafeCommandError("unsupported_command");
    }
    return undefined;
  }
  if (
    command === "setInputSource" ||
    command === "setRepeat" ||
    command === "setShuffle"
  ) {
    const value = args[0];
    if (
      command === "setShuffle"
        ? typeof value !== "boolean"
        : typeof value !== "string" || !safeControlLabel(value)
    ) {
      throw new SafeCommandError("invalid_arguments");
    }
    if (
      command === "setInputSource" &&
      !SOURCE_ATTRIBUTES.has(control.attribute)
    ) {
      throw new SafeCommandError("unsupported_command");
    }
    if (command === "setRepeat" && !REPEAT_ATTRIBUTES.has(control.attribute)) {
      throw new SafeCommandError("unsupported_command");
    }
    if (command === "setShuffle" && !SHUFFLE_ATTRIBUTES.has(control.attribute)) {
      throw new SafeCommandError("unsupported_command");
    }
    if (
      control.kind !== "button" &&
      control.kind !== "enumerated" &&
      control.kind !== "toggle"
    ) {
      throw new SafeCommandError("capability_not_found");
    }
    if (typeof value === "string" && (control.options ?? []).length > 0) {
      if (!control.options?.includes(value)) {
        throw new SafeCommandError("invalid_arguments");
      }
      return {
        ...(control.optionLabels?.[value]
          ? { label: control.optionLabels[value] }
          : {}),
        ...(control.optionCommands?.[value]
          ? { command: control.optionCommands[value] }
          : {})
      };
    }
    if (!controlSupportsCommand(control, command, true)) {
      throw new SafeCommandError("unsupported_command");
    }
    return undefined;
  }
  if (isMediaControlCommand(command)) {
    if (isEnumeratedMediaCommand(command) && control.kind === "enumerated") {
      const matches = Object.entries(control.optionCommands ?? {}).filter(
        ([, optionCommand]) => normalizeCommandToken(optionCommand) === normalizeCommandToken(command)
      );
      if (matches.length !== 1) throw new SafeCommandError("unsupported_command");
      const match = matches[0];
      if (!match) throw new SafeCommandError("unsupported_command");
      const [option, optionCommand] = match;
      return {
        label: control.optionLabels?.[option] ?? option,
        ...(optionCommand ? { command: optionCommand } : {})
      };
    }
    if (control.kind !== "button" || !controlSupportsCommand(control, command, true)) {
      throw new SafeCommandError("unsupported_command");
    }
    if (
      command === "playTrackAndResume" &&
      (args.length !== 1 || typeof args[0] !== "string" || args[0].length === 0)
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
  const explicitValues = [
    control.command,
    ...(control.commands ?? []),
    ...Object.values(control.optionCommands ?? {})
  ].filter((value): value is string => typeof value === "string");
  if (explicitValues.length > 0) {
    const expected = commandAliases(command);
    return explicitValues.some((value) => expected.includes(normalizeCommandToken(value)));
  }
  if (requireExplicit) return false;
  const expected = commandAliases(command);
  const normalized = [control.id, control.label, control.attribute].map((value) =>
    normalizeCommandToken(value)
  );
  return expected.some((alias) => normalized.includes(alias));
}

function observedCommandFor(
  control: NonNullable<BridgeDevice["controls"]>[number],
  requested: string
): string | undefined {
  const explicit = [
    control.command,
    ...(control.commands ?? []),
    ...Object.values(control.optionCommands ?? {})
  ].filter((value): value is string => typeof value === "string");
  const exact = normalizeCommandToken(requested);
  return explicit.find((value) => normalizeCommandToken(value) === exact) ??
    explicit.find((value) => nativeCommandAliases(requested).includes(normalizeCommandToken(value)));
}

function nativeCommandAliases(command: string): string[] {
  const aliases: Record<string, string[]> = {
    on: ["switchon", "enable", "enabled"],
    off: ["switchoff", "disable", "disabled"],
    open: ["openshade"],
    openShade: ["open"],
    close: ["closeshade"],
    closeShade: ["close"]
  };
  return aliases[command] ?? [];
}

function commandAliases(command: string): string[] {
  const aliases: Record<string, string[]> = {
    on: ["on", "switchon", "enable", "enabled"],
    off: ["off", "switchoff", "disable", "disabled"],
    open: ["open", "openshade"],
    openShade: ["openshade", "open"],
    close: ["close", "closeshade"],
    closeShade: ["closeshade", "close"],
    pause: ["pause", "stop"],
    stop: ["stop", "pause"],
    mute: ["mute", "unmute"],
    unmute: ["unmute", "mute"],
    setInputSource: ["setinputsource", "inputsource", "selectsource"],
    setRepeat: ["setrepeat", "repeat", "repeatmode"],
    setShuffle: ["setshuffle", "shuffle", "shufflemode"],
    setPosition: ["setposition", "position", "shadelevel"],
    setOption: ["setoption"]
  };
  return aliases[command] ?? [normalizeCommandToken(command)];
}

function normalizeCommandToken(value: string): string {
  return value.toLowerCase().replace(/[\s_.:-]+/gu, "");
}

function stateValuesEqual(
  actual: BridgeJsonValue,
  desired: BridgeJsonValue | undefined
): boolean {
  if (desired === undefined) return false;
  if (typeof actual === "string" && typeof desired === "string") {
    return actual.trim().toLowerCase() === desired.trim().toLowerCase();
  }
  if (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    typeof desired === "number" &&
    Number.isFinite(desired)
  ) {
    const tolerance = Math.max(1e-6, Math.abs(desired) * 1e-6);
    return Math.abs(actual - desired) <= tolerance;
  }
  return JSON.stringify(actual) === JSON.stringify(desired);
}

function dangerousControl(control: NonNullable<BridgeDevice["controls"]>[number]): boolean {
  return [
    control.id,
    control.capability,
    control.attribute,
    control.command,
    control.label,
    ...(control.commands ?? []),
    ...Object.values(control.optionCommands ?? {})
  ]
    .filter((value): value is string => typeof value === "string")
    .some(dangerousControlText);
}

function safeOptionAttribute(attribute: string): boolean {
  if (!tokenPattern.test(attribute) || dangerousControlText(attribute)) return false;
  return !COVER_ATTRIBUTES.has(attribute);
}

function dangerousControlText(value: string): boolean {
  const separated = value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
  const tokens = separated.split(/[^a-z0-9가-힣]+/u).filter(Boolean);
  if (
    tokens.some(
      (token) =>
        ["lock", "unlock", "valve", "door", "garage"].includes(token) ||
        /^(?:lock|unlock|valve|door|garage)\d*$/u.test(token)
    )
  ) {
    return true;
  }
  const compact = tokens.join("");
  if (/(?:door|lock|unlock|valve|garage)(?:state|control|command)/u.test(compact)) {
    return true;
  }
  return (
    /잠금|도어|차고|밸브|문\s*(?:열|닫)/u.test(value) ||
    tokens.some((token) => ["문", "현관문", "대문", "창문", "출입문", "방화문", "자동문"].includes(token))
  );
}

function safeControlLabel(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value) && !/\b(token|secret|cookie|session|csrf)\b/iu.test(value);
}

function alreadyConfirmed(clientRequestId: string, sequence: number): SafeCommandResult {
  return {
    schemaVersion: 1,
    clientRequestId,
    status: "already_confirmed",
    sequence,
    transport: "smartthings_web_ui",
    confirmation: "current_state",
    lifecycle: "CONFIRMED_BY_STATUS"
  };
}

function confirmed(
  clientRequestId: string,
  sequence: number,
  confirmation: SafeCommandResult["confirmation"],
  transport: SafeCommandResult["transport"] = "smartthings_web_ui"
): SafeCommandResult {
  return {
    schemaVersion: 1,
    clientRequestId,
    status: "confirmed",
    sequence,
    transport,
    confirmation,
    lifecycle:
      confirmation === "device_event" || confirmation === "security_arm_state_event"
        ? "CONFIRMED_BY_EVENT"
        : "CONFIRMED_BY_STATUS"
  };
}

function acceptedUnconfirmed(
  clientRequestId: string,
  sequence: number,
  transport: SafeCommandResult["transport"]
): SafeCommandResult {
  return {
    schemaVersion: 1,
    clientRequestId,
    status: "accepted_unconfirmed",
    sequence,
    transport,
    confirmation: "accepted_receipt",
    lifecycle: "ACCEPTED_UNCONFIRMED"
  };
}

function transportForExecution(
  result: void | CommandTransportReceipt | "location_native" | "dom"
): SafeCommandResult["transport"] {
  if (result === "location_native" || result === "dom") return result;
  if (result && typeof result === "object") return result.transport;
  return "smartthings_web_ui";
}

function transportForExecutions(
  results: ReadonlyArray<DeviceActionExecutionResult>
): SafeCommandResult["transport"] {
  const transports = results.map(transportForExecution);
  if (transports.includes("dom")) return "dom";
  if (transports.includes("location_native")) return "location_native";
  if (transports.includes("advanced")) return "advanced";
  if (transports.includes("internal")) return "internal";
  return "smartthings_web_ui";
}

function isStatelessCommand(command: string): boolean {
  return ["refresh", "press", "nextTrack", "previousTrack"].includes(command);
}

function commandError(error: unknown): SafeCommandError {
  const code = error instanceof Error ? error.message : "";
  if (isExecutorErrorCode(code)) return new SafeCommandError(code);
  return new SafeCommandError("command_execution_failed");
}

function isExecutorErrorCode(value: string): value is SafeCommandErrorCode {
  return ["command_browser_unavailable", "command_login_required", "command_location_mismatch", "command_location_unknown", "command_location_picker_not_found", "command_location_target_not_found", "command_location_change_failed", "command_room_not_found", "command_target_not_found", "command_target_ambiguous", "command_search_not_found", "command_search_ambiguous", "command_control_not_found", "command_control_ambiguous", "component_command_partial_failure", "component_command_rollback_failed"].includes(value);
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
