// Regression coverage for raw matching GETs rejected by a stale switch cache.
describe("Exact switch status corroboration regression", () => {
  const switchTimestamp = "2026-09-15T04:39:00Z";
  const switchBody = (value: string, timestamp: string | null) => ({ items: [{
    deviceId: "dev_120", locationId: "loc_001", label: "Regression switch", type: "switch",
    status: { components: { main: { switch: { switch: { value, timestamp } } } } }
  }] });
  const switchRequest = (command = "off") => ({ targetType: "device", targetId: "dev_120",
    component: "main", capability: "switch", attribute: "switch", command,
    arguments: [], clientRequestId: "switch_status_regression_request" });

  test.each([null, switchTimestamp])("confirms same-value GETs with %s timestamps without retransmitting", async (timestamp) => {
    vi.useFakeTimers();
    const store = new DeviceStore();
    try {
      const { readLightCommandStatus } = await import("../../src/command/light-status-recheck.js");
      store.observeAdvancedDeviceSnapshot(switchBody("on", switchTimestamp));
      const executeDeviceAction = vi.fn(async () => ({ state: "ACCEPTED" as const,
        transport: "advanced" as const, acceptedAtMs: Date.now(), sentAtMs: Date.now() }));
      const read = vi.fn(async () => switchBody("off", timestamp));
      const onDeviceDiagnostic = vi.fn();
      const beginDeviceCommand = vi.spyOn(store, "beginDeviceCommand");
      const resync = vi.fn(async (request?: import("../../src/command/command-service.js").CommandResyncRequest) => {
        const startedAtMs = Date.now();
        const observedStates = await readLightCommandStatus(store, "dev_120", "loc_001",
          read, request?.lightComponent, request?.switchTarget);
        return { source: "advanced_device_status" as const, deviceId: "dev_120", locationId: "loc_001",
          authoritativeSnapshot: false, startedAtMs, observedStates };
      });
      const service = new SafeCommandService({ devices: store, status: connectedStatus(),
        executor: { executeDeviceAction }, timeoutMs: 300, resyncAfterMs: 1, resync, onDeviceDiagnostic });
      const pending = service.execute(switchRequest()).then(value => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }));
      await vi.advanceTimersByTimeAsync(400);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ status: "confirmed", lifecycle: "CONFIRMED_BY_STATUS" });
      expect(executeDeviceAction).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(2);
      expect(beginDeviceCommand).toHaveBeenCalledOnce();
      expect(resync).toHaveBeenCalledWith({ deviceId: "dev_120", switchTarget: { component: "main", capability: "switch" } });
      expect(store.commandState("dev_120", "loc_001", "main", "switch", "switch"))
        .toMatchObject({ value: "off", updatedAt: switchTimestamp, commandReadVerified: true });
      expect(onDeviceDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "read", matches: true, cacheMatches: true }));
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });

  test.each([null, switchTimestamp])("raw matches with %s alone remain insufficient without a switch proof", async (timestamp) => {
    vi.useFakeTimers();
    const store = new DeviceStore();
    try {
      const { readLightCommandStatus } = await import("../../src/command/light-status-recheck.js");
      store.observeAdvancedDeviceSnapshot(switchBody("on", switchTimestamp));
      const executeDeviceAction = vi.fn(async () => ({ state: "ACCEPTED" as const,
        transport: "advanced" as const, acceptedAtMs: Date.now(), sentAtMs: Date.now() }));
      const onDeviceDiagnostic = vi.fn();
      const service = new SafeCommandService({ devices: store, status: connectedStatus(),
        executor: { executeDeviceAction }, timeoutMs: 300, resyncAfterMs: 1, onDeviceDiagnostic,
        resync: async () => {
          const startedAtMs = Date.now();
          // Deliberately retain the old generic route to reproduce the original failure.
          const observedStates = await readLightCommandStatus(store, "dev_120", "loc_001",
            async () => switchBody("off", timestamp));
          return { source: "advanced_device_status", deviceId: "dev_120", locationId: "loc_001",
            authoritativeSnapshot: false, startedAtMs, observedStates };
        }
      });
      const rejection = expect(service.execute(switchRequest())).rejects.toMatchObject({ code: "command_confirmation_timeout" });
      await vi.advanceTimersByTimeAsync(400);
      await rejection;
      expect(executeDeviceAction).toHaveBeenCalledOnce();
      expect(onDeviceDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "read", matches: true, cacheMatches: false }));
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });
});
