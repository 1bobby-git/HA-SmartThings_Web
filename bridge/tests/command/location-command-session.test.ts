import { describe, expect, test, vi } from "vitest";
import { runLocationCommandSession } from "../../src/command/location-command-session.js";
import { SafeCommandService, type CommandResyncEvidence, type SafeCommandExecutor } from "../../src/command/command-service.js";
import { DeviceStore } from "../../src/state/device-store.js";
import { RuntimeStatusStore } from "../../src/state/runtime-state.js";

type LocationInput = Parameters<NonNullable<SafeCommandExecutor["executeLocationAction"]>>[0];

function frame(store: DeviceStore, direction: "sent" | "received", text: string) {
  store.observe({ __sanitized: true, source: "playwright-websocket-frame",
    receivedAt: new Date().toISOString(),
    payload: { direction, frame: { payload: text, truncated: false } },
    payloadHash: `${direction}:${text}` });
}
function security(store: DeviceStore, value: string, time = "2026-09-01T00:00:01Z", location = "loc_001") {
  frame(store, "received", `42${JSON.stringify(["api/subscription SECURITY_ARM_STATE_EVENT", {
    data: { location_id: location, arm_state: value, event_time: time }
  }])}`);
}
function fixture(dispatch: (store: DeviceStore, input: LocationInput) => Promise<void>, options: {
  timeoutMs?: number;
  resync?: () => Promise<CommandResyncEvidence | undefined>;
} = {}) {
  const store = new DeviceStore();
  frame(store, "sent", '4225["find","api/location",{}]');
  frame(store, "received", `4325${JSON.stringify([null, [
    { locationId: "loc_001", name: "Synthetic home", armState: "DISARMED", updatedAt: "2026-09-01T00:00:00Z" },
    { locationId: "loc_002", name: "Synthetic other", armState: "DISARMED", updatedAt: "2026-09-01T00:00:00Z" }
  ]])}`);
  const now = Date.now();
  const status = new RuntimeStatusStore({ now: () => now, initial: {
    state: "CONNECTED", chromiumRunning: true, keeperPresent: true, authenticated: true,
    pushConnected: true, parserHealthy: true, initialSnapshotComplete: true, dbAvailable: true,
    heartbeatAtMs: now, initialSnapshotCompletedAtMs: now, lastSnapshotAtMs: now,
    lastParserSuccessAtMs: now, lastPushAtMs: now
  } });
  const diagnostics: Array<{ phase: string; observedStateMatches: boolean }> = [];
  const execute = vi.fn((input: LocationInput) => dispatch(store, input));
  const resync = vi.fn(options.resync ?? (async () => undefined));
  const service = new SafeCommandService({ devices: store, status,
    executor: { executeLocationAction: execute }, timeoutMs: options.timeoutMs ?? 80,
    resyncAfterMs: 5, resync, onLocationDiagnostic: (item) => diagnostics.push(item) });
  return { store, service, execute, resync, diagnostics };
}
function request(id = "request_location_session", timeout?: number) {
  return { targetType: "location", targetId: "loc_001", command: "armAway",
    arguments: [], clientRequestId: id, ...(timeout === undefined ? {} : { timeout }) };
}

describe("Home Monitor command session", () => {
  test("keeps the page open until a delayed security event confirms the command", async () => {
    const order: string[] = [];
    let closed = false;
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      order.push("click");
      setTimeout(() => {
        if (closed) return;
        order.push("security-event");
        security(store, "ARMED_AWAY");
      }, 10);
    }, async () => { closed = true; order.push("close"); }, input.waitForConfirmation));
    await expect(f.service.execute(request())).resolves.toMatchObject({
      status: "confirmed", confirmation: "security_arm_state_event"
    });
    expect(order).toEqual(["click", "security-event", "close"]);
    expect(f.diagnostics.map((item) => item.phase)).toEqual(["dispatching", "waiting", "confirmed"]);
    expect(f.diagnostics.at(-1)?.observedStateMatches).toBe(true);
    expect(JSON.stringify(f.diagnostics)).not.toContain("Synthetic home");
  });

  test("preserves an event arriving before the click returns", async () => {
    let closes = 0;
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      security(store, "ARMED_AWAY");
    }, async () => { closes++; }, input.waitForConfirmation));
    await expect(f.service.execute(request())).resolves.toMatchObject({ status: "confirmed" });
    expect(closes).toBe(1);
  });

  test("does not reuse matching evidence superseded by a newer opposite state", async () => {
    let closes = 0;
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      security(store, "ARMED_AWAY");
      security(store, "DISARMED", "2026-09-01T00:00:02Z");
    }, async () => { closes++; }, input.waitForConfirmation));
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(closes).toBe(1);
    expect(f.diagnostics.at(-1)?.observedStateMatches).toBe(false);
  });

  test("does not confirm from another location or an Advanced refresh receipt", async () => {
    let closes = 0;
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      security(store, "ARMED_AWAY", "2026-09-01T00:00:01Z", "loc_002");
    }, async () => { closes++; }, input.waitForConfirmation), {
      resync: async () => ({ source: "advanced_inventory", authoritativeSnapshot: true, startedAtMs: Date.now() })
    });
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(closes).toBe(1);
    expect(f.resync).toHaveBeenCalled();
  });

  test("bounds request timeout even when every resync remains unresolved", async () => {
    vi.useFakeTimers();
    try {
      let closed = false;
      const f = fixture(async (_store, input) => runLocationCommandSession(async () => undefined,
        async () => { closed = true; }, input.waitForConfirmation), {
          timeoutMs: 20, resync: () => new Promise(() => undefined)
        });
      let outcome: unknown;
      const work = f.service.execute(request("request_custom_timeout", 1)).catch((error: unknown) => { outcome = error; });
      await vi.advanceTimersByTimeAsync(100);
      expect(outcome).toBeUndefined();
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(901);
      await work;
      expect(outcome).toMatchObject({ code: "command_confirmation_timeout" });
      expect(closed).toBe(true);
      const count = f.diagnostics.length;
      security(f.store, "ARMED_AWAY");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.diagnostics).toHaveLength(count);
      expect(f.resync.mock.calls.length).toBeLessThanOrEqual(2);
    } finally { vi.useRealTimers(); }
  });

  test("closes on dispatch failure without waiting or issuing a second click", async () => {
    let closes = 0;
    const f = fixture(async (_store, input) => runLocationCommandSession(async () => {
      throw new Error("command_control_not_found");
    }, async () => { closes++; }, input.waitForConfirmation));
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: "command_control_not_found" });
    expect(closes).toBe(1);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.resync).not.toHaveBeenCalled();
    expect(f.diagnostics.map((item) => item.phase)).toEqual(["dispatching", "failed"]);
  });

  test("preserves the confirmation error if page cleanup also fails", async () => {
    const f = fixture(async (_store, input) => runLocationCommandSession(async () => undefined,
      async () => { throw new Error("closed browser"); }, input.waitForConfirmation));
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
  });

  test("supports custom executors that ignore the optional lifetime hook", async () => {
    const f = fixture(async (store) => { security(store, "ARMED_AWAY"); });
    await expect(f.service.execute(request())).resolves.toMatchObject({ status: "confirmed" });
  });

  test("does not click again when the requested state has already been confirmed", async () => {
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      security(store, "ARMED_AWAY");
    }, async () => undefined, input.waitForConfirmation));
    await f.service.execute(request("request_first_arm"));
    await expect(f.service.execute(request("request_second_arm"))).resolves.toMatchObject({ status: "already_confirmed" });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  test("serializes the next command until the first page is closed", async () => {
    const order: string[] = [];
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      order.push(`click:${input.action}`);
      setTimeout(() => security(store, input.action === "armAway" ? "ARMED_AWAY" : "DISARMED",
        input.action === "armAway" ? "2026-09-01T00:00:01Z" : "2026-09-01T00:00:02Z"), 10);
    }, async () => { order.push(`close:${input.action}`); }, input.waitForConfirmation));
    const arm = f.service.execute(request("request_serial_arm"));
    const disarm = f.service.execute({ ...request("request_serial_disarm"), command: "disarm" });
    await Promise.all([arm, disarm]);
    expect(order).toEqual(["click:armAway", "close:armAway", "click:disarm", "close:disarm"]);
  });
});


describe("Home Monitor low-latency confirmation", () => {
  test.each([
    ["armAway", "AWAY"], ["armAway", "armedaway"], ["armStay", "STAY"],
    ["armStay", "armed_home"], ["armStay", "armedstay"], ["disarm", "OFF"]
  ])("confirms %s from the observed %s event without waiting for the full timeout", async (command, value) => {
    const f = fixture(async (store, input) => runLocationCommandSession(async () => {
      security(store, value, "2026-09-01T00:00:02Z");
      store.observeAdvancedInventorySnapshot({ locations: [{ locationId: "loc_001", name: "Synthetic home" }] });
    }, async () => undefined, input.waitForConfirmation));
    if (command === "disarm") security(f.store, "STAY");
    await expect(f.service.execute({ ...request(`request_alias_${value}`), command })).resolves.toMatchObject({ status: "confirmed" });
    expect(f.resync).not.toHaveBeenCalled();
    expect(f.diagnostics.at(-1)?.observedStateMatches).toBe(true);
  });
  test("a Home Monitor recheck requests only its location, never a full device inventory", async () => {
    const f = fixture(async () => undefined);
    await expect(f.service.execute(request())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
    expect(f.resync.mock.calls.every((args) => (args as unknown[])[0] && JSON.stringify((args as unknown[])[0]) === '{"locationId":"loc_001"}')).toBe(true);
  });
  test("expires queued security requests without replaying them after the running command", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const f = fixture(async (store, input) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        security(store, "AWAY");
        await input.waitForConfirmation?.();
      });
      const first = f.service.execute(request("request_queue_first"));
      await vi.advanceTimersByTimeAsync(1);
      let failed: unknown;
      const second = f.service.execute({ ...request("request_queue_expired"), command: "armStay" }).catch((e: unknown) => { failed = e; });
      await vi.advanceTimersByTimeAsync(10_001);
      await second;
      expect(failed).toMatchObject({ code: "command_queue_timeout" });
      expect(f.execute).toHaveBeenCalledTimes(1);
      finish(); await first;
      await vi.advanceTimersByTimeAsync(1);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
