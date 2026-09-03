import { describe, expect, test, vi } from "vitest";

import {
  StateReconciliationCoordinator,
  type ReconciliationSnapshot
} from "../../src/state/reconciliation-coordinator.js";

const snapshot: ReconciliationSnapshot = {
  devices: [{ deviceId: "device-a", locationId: "location-a" }],
  locations: [{ locationId: "location-a", name: "Home" }],
  rooms: [{ roomId: "room-a", locationId: "location-a", name: "Living room" }],
  pageCount: 2,
  fetchedAtMs: 100
};

describe("StateReconciliationCoordinator", () => {
  test("coalesces concurrent triggers into one Advanced inventory request", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = vi.fn(async () => {
      await gate;
      return snapshot;
    });
    const apply = vi.fn();
    const coordinator = new StateReconciliationCoordinator({ load, apply, now: () => 200 });

    const startup = coordinator.request("startup");
    const reconnect = coordinator.request("reconnect");
    release?.();
    await Promise.all([startup, reconnect]);

    expect(load).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(snapshot, "startup");
    expect(coordinator.snapshot()).toMatchObject({
      inFlight: false,
      lastReason: "startup",
      lastSyncAtMs: 200,
      deviceCount: 1,
      locationCount: 1,
      pageCount: 2,
      failureCount: 0
    });
  });

  test("isolates a failed sync and permits a later retry", async () => {
    const load = vi
      .fn<() => Promise<ReconciliationSnapshot>>()
      .mockRejectedValueOnce(new Error("endpoint changed"))
      .mockResolvedValueOnce(snapshot);
    const apply = vi.fn();
    const coordinator = new StateReconciliationCoordinator({ load, apply });

    await expect(coordinator.request("startup")).rejects.toThrowError("endpoint changed");
    expect(coordinator.snapshot()).toMatchObject({ inFlight: false, failureCount: 1 });
    await expect(coordinator.request("reconnect")).resolves.toBeUndefined();
    expect(apply).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({ failureCount: 1, lastReason: "reconnect" });
  });
});
