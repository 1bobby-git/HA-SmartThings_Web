import { afterEach, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
import { readLightCommandStatus } from "../../src/command/light-status-recheck.js";

const stores: DeviceStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
const timestamp = "2026-09-15T04:39:00Z";
const target = { component: "main", capability: "switch" };
const row = (value: string, updatedAt: string | null = timestamp,
  deviceId = "dev_120", locationId = "loc_001") => ({ items: [{ deviceId, locationId,
  status: { components: { main: { switch: { switch: { value, timestamp: updatedAt } } } } } }] });
function fixture() {
  const store = new DeviceStore(); stores.push(store);
  store.observeAdvancedDeviceSnapshot(row("on"));
  return { store, current: () => store.commandState("dev_120", "loc_001", "main", "switch", "switch")! };
}

test.each([null, timestamp])("exact switch corroboration repairs a %s timestamp without fabricating event time", async (updatedAt) => {
  const { store, current } = fixture(); const read = vi.fn(async () => row("off", updatedAt));
  const proof = await readLightCommandStatus(store, "dev_120", "loc_001", read, undefined, target);
  expect(read).toHaveBeenCalledTimes(2);
  expect(proof[0]!.updatedAt).toBe(updatedAt);
  expect(current()).toMatchObject({ value: "off", updatedAt: timestamp, commandReadVerified: true });
  store.observeAdvancedDeviceSnapshot(row("on"));
  expect(current().value).toBe("off");
});

test("unscoped status reads remain strict", async () => {
  const { store, current } = fixture(); const read = vi.fn(async () => row("off", null));
  await readLightCommandStatus(store, "dev_120", "loc_001", read);
  expect(read).toHaveBeenCalledOnce(); expect(current().value).toBe("on");
});

test.each(["new_device_command", "new_light_command", "new_push", "disagree", "second_failure", "wrong_device", "wrong_location"])
  ("%s invalidates switch corroboration", async (failure) => {
    const { store, current } = fixture(); let count = 0;
    const read = vi.fn(async () => {
      if (++count === 2) {
        if (failure === "new_device_command") store.beginDeviceCommand("dev_120");
        if (failure === "new_light_command") store.beginLightCommand("dev_120");
        if (failure === "new_push") store.observeAdvancedDeviceSnapshot(row("on", "2026-09-15T04:39:01Z"));
        if (failure === "second_failure") throw Error("GET failed");
        if (failure === "disagree") return row("on", null);
        if (failure === "wrong_device") return row("off", null, "dev_999");
        if (failure === "wrong_location") return row("off", null, "dev_120", "loc_999");
      }
      return row("off", null);
    });
    await readLightCommandStatus(store, "dev_120", "loc_001", read, undefined, target);
    expect(current().value).toBe("on"); expect(read).toHaveBeenCalledTimes(2);
  });

test("one requested switch cannot authorize another attribute or capability", async () => {
  const { store, current } = fixture();
  const extended = (value: string, at: string | null) => ({ items: [{ deviceId: "dev_120", locationId: "loc_001",
    status: { components: { main: {
      switch: { switch: { value, timestamp: at } },
      other: { switch: { value, timestamp: at } },
      switchLevel: { level: { value: value === "off" ? 60 : 10, timestamp: at } }
    } } } }] });
  store.observeAdvancedDeviceSnapshot(extended("on", timestamp));
  await readLightCommandStatus(store, "dev_120", "loc_001", async () => extended("off", null), undefined, target);
  expect(current().value).toBe("off");
  expect(store.commandState("dev_120", "loc_001", "main", "other", "switch")!.value).toBe("on");
  expect(store.commandState("dev_120", "loc_001", "main", "switchLevel", "level")!.value).toBe(10);
});
