import type {
  BridgeDevice,
  BridgeDeviceState,
  BridgeDeviceStoreEvent,
  BridgeJsonValue,
  DeviceStore
} from "../state/device-store.js";
import type { RuntimeStatusStore } from "../state/runtime-state.js";

export interface SafeCommandRequest {
  deviceId: string;
  component: string;
  capability: string;
  command: "on" | "off";
  arguments: BridgeJsonValue[];
  clientRequestId: string;
}

export interface SafeCommandResult {
  schemaVersion: 1;
  clientRequestId: string;
  status: "confirmed" | "already_confirmed";
  sequence: number;
  transport: "smartthings_web_ui";
  confirmation: "device_event" | "current_state";
}

export interface SafeCommandExecutor {
  executeSwitch(input: { deviceName: string }): Promise<void>;
}

export type SafeCommandErrorCode =
  | "invalid_body"
  | "unknown_key"
  | "invalid_device_id"
  | "invalid_component"
  | "invalid_capability"
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
  | "command_target_not_found"
  | "command_target_ambiguous"
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
  resync: () => Promise<unknown>;
}

interface DedupeEntry {
  fingerprint: string;
  result: Promise<SafeCommandResult>;
}

const requestKeys = [
  "deviceId",
  "component",
  "capability",
  "command",
  "arguments",
  "clientRequestId"
] as const;
const tokenPattern = /^[A-Za-z0-9_.:-]{1,160}$/u;
const devicePattern = /^dev_[0-9]{3,32}$/u;
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
    const previous = this.#queues.get(request.deviceId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.#execute(request));
    const queueTail = operation.then(
      () => undefined,
      () => undefined
    );
    this.#queues.set(request.deviceId, queueTail);
    void queueTail.finally(() => {
      if (this.#queues.get(request.deviceId) === queueTail) {
        this.#queues.delete(request.deviceId);
      }
    });
    return operation;
  }

  async #execute(request: SafeCommandRequest): Promise<SafeCommandResult> {
    const runtime = this.options.status.getSnapshot();
    if (
      runtime.state !== "CONNECTED" ||
      !runtime.pushConnected ||
      !runtime.parserHealthy ||
      !runtime.initialSnapshotComplete
    ) {
      throw new SafeCommandError("bridge_not_connected");
    }

    const snapshot = this.options.devices.snapshot();
    const device = snapshot.devices.find((candidate) => candidate.id === request.deviceId);
    if (!device) throw new SafeCommandError("device_not_found");
    if (!device.online) throw new SafeCommandError("device_offline");
    const state = findSwitchState(device, request);
    if (!state) throw new SafeCommandError("capability_not_found");
    if (state.value === request.command) {
      return {
        schemaVersion: 1,
        clientRequestId: request.clientRequestId,
        status: "already_confirmed",
        sequence: snapshot.sequence,
        transport: "smartthings_web_ui",
        confirmation: "current_state"
      };
    }

    const confirmation = waitForState({
      devices: this.options.devices,
      request,
      afterSequence: snapshot.sequence,
      timeoutMs: this.options.timeoutMs,
      resync: this.options.resync
    });
    try {
      await this.options.executor.executeSwitch({ deviceName: device.name });
    } catch (error) {
      confirmation.cancel();
      const code = error instanceof Error ? error.message : "";
      if (isExecutorErrorCode(code)) throw new SafeCommandError(code);
      throw new SafeCommandError("command_execution_failed");
    }

    const sequence = await confirmation.result;
    return {
      schemaVersion: 1,
      clientRequestId: request.clientRequestId,
      status: "confirmed",
      sequence,
      transport: "smartthings_web_ui",
      confirmation: "device_event"
    };
  }
}

function validateRequest(input: unknown): SafeCommandRequest {
  if (!isRecord(input)) throw new SafeCommandError("invalid_body");
  if (Object.keys(input).some((key) => !requestKeys.includes(key as (typeof requestKeys)[number]))) {
    throw new SafeCommandError("unknown_key");
  }
  if (typeof input.deviceId !== "string" || !devicePattern.test(input.deviceId)) {
    throw new SafeCommandError("invalid_device_id");
  }
  if (typeof input.component !== "string" || !tokenPattern.test(input.component)) {
    throw new SafeCommandError("invalid_component");
  }
  if (typeof input.capability !== "string" || !tokenPattern.test(input.capability)) {
    throw new SafeCommandError("invalid_capability");
  }
  if (input.command !== "on" && input.command !== "off") {
    throw new SafeCommandError("unsupported_command");
  }
  if (!Array.isArray(input.arguments) || input.arguments.length !== 0) {
    throw new SafeCommandError("invalid_arguments");
  }
  if (
    typeof input.clientRequestId !== "string" ||
    !clientRequestPattern.test(input.clientRequestId)
  ) {
    throw new SafeCommandError("invalid_client_request_id");
  }
  return {
    deviceId: input.deviceId,
    component: input.component,
    capability: input.capability,
    command: input.command,
    arguments: [],
    clientRequestId: input.clientRequestId
  };
}

function findSwitchState(
  device: BridgeDevice,
  request: SafeCommandRequest
): BridgeDeviceState | undefined {
  return device.states.find(
    (state) =>
      state.component === request.component &&
      state.capability === request.capability &&
      state.attribute === "switch"
  );
}

function waitForState(options: {
  devices: DeviceStore;
  request: SafeCommandRequest;
  afterSequence: number;
  timeoutMs: number;
  resync: () => Promise<unknown>;
}): { result: Promise<number>; cancel: () => void } {
  let settled = false;
  let unsubscribe: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let rejectResult: (error: SafeCommandError) => void = () => undefined;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
  const result = new Promise<number>((resolve, reject) => {
    rejectResult = reject;
    unsubscribe = options.devices.subscribe((event: BridgeDeviceStoreEvent) => {
      if (
        event.type !== "state" ||
        event.sequence <= options.afterSequence ||
        event.deviceId !== options.request.deviceId ||
        event.state.component !== options.request.component ||
        event.state.capability !== options.request.capability ||
        event.state.attribute !== "switch" ||
        event.state.value !== options.request.command
      ) {
        return;
      }
      cleanup();
      resolve(event.sequence);
    });
    timer = setTimeout(() => {
      cleanup();
      void options
        .resync()
        .catch(() => undefined)
        .finally(() => reject(new SafeCommandError("command_confirmation_timeout")));
    }, options.timeoutMs);
  });
  return {
    result,
    cancel: () => {
      cleanup();
      rejectResult(new SafeCommandError("command_execution_failed"));
      void result.catch(() => undefined);
    }
  };
}

function isExecutorErrorCode(value: string): value is SafeCommandErrorCode {
  return [
    "command_browser_unavailable",
    "command_login_required",
    "command_target_not_found",
    "command_target_ambiguous",
    "command_control_not_found",
    "command_control_ambiguous"
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
