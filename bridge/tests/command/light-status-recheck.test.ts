import { afterEach, expect, test, vi } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
import { readLightCommandStatus } from "../../src/command/light-status-recheck.js";
const stores: DeviceStore[] = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });
const t = "2026-09-08T00:00:00Z";
const row = (value: unknown, timestamp: string | null = t, attribute = "level", component = "main", deviceId = "dev_001", locationId = "loc_001") =>
  ({ items: [{ deviceId, locationId, label: "Test lamp", type: "light",
    status: { components: { [component]: { switchLevel: { [attribute]: { value, timestamp } } } } } }] });
function setup() {
  const store = new DeviceStore(); stores.push(store);
  store.observeAdvancedDeviceSnapshot(row(10));
  const current = () => store.commandState("dev_001", "loc_001", "main", "switchLevel", "level")!;
  return { store, current };
}

test.each([null, t])("two agreeing exact reads repair %s timestamp without inventing an event date", async (timestamp) => {
  const { store, current } = setup(); const sequence = store.currentSequence();
  const read = vi.fn(async () => row(60, timestamp));
  const observed = await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
  expect(read).toHaveBeenCalledTimes(2);
  expect(observed[0]!.updatedAt).toBe(timestamp);
  expect(current()).toMatchObject({ value: 60, updatedAt: t, commandReadVerified: true, source: "COMMAND_STATUS_RECHECK" });
  expect(store.currentSequence()).toBeGreaterThan(sequence);
  // Ordinary replay must still be rejected using the retained upstream watermark.
  store.observeAdvancedDeviceSnapshot(row(10, t));
  expect(current().value).toBe(60);
});

test("generic status reads retain strict timestamp semantics", async () => {
  const { store, current } = setup(); const read = vi.fn(async () => row(60, null));
  await readLightCommandStatus(store, "dev_001", "loc_001", read);
  expect(read).toHaveBeenCalledOnce(); expect(current().value).toBe(10);
});

test.each(["disagree", "second_fails", "new_command", "new_push", "wrong_device", "wrong_location", "other_component", "older_date", "security_attribute"])
  ("%s cannot authorize a stale or out-of-scope repair", async (failure) => {
    const { store, current } = setup();
    if (failure === "security_attribute") store.observeAdvancedDeviceSnapshot(row("DISARMED", t, "armState"));
    let calls = 0;
    const read = vi.fn(async () => {
      calls++;
      if (calls === 2) {
        if (failure === "second_fails") throw Error("network failure");
        if (failure === "new_command") store.beginLightCommand("dev_001");
        if (failure === "new_push") store.observeAdvancedDeviceSnapshot(row(70, "2026-09-08T00:00:01Z"));
      }
      return row(failure === "security_attribute" ? "ARMED_AWAY" : failure === "disagree" && calls === 2 ? 40 : 60,
        failure === "older_date" ? "2026-09-07T00:00:00Z" : null,
        failure === "security_attribute" ? "armState" : "level",
        failure === "other_component" ? "other" : "main",
        failure === "wrong_device" ? "dev_002" : "dev_001",
        failure === "wrong_location" ? "loc_002" : "loc_001");
    });
    await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
    expect(current().value).toBe(failure === "new_push" ? 70 : 10);
    if (failure === "security_attribute") expect(store.commandState("dev_001", "loc_001", "main", "switchLevel", "armState")!.value).toBe("DISARMED");
  });

test("normal newer timestamp uses one GET and no exceptional proof marker", async () => {
  const { store, current } = setup(); const read = vi.fn(async () => row(60, "2026-09-08T00:00:01Z"));
  await readLightCommandStatus(store, "dev_001", "loc_001", read, "main");
  expect(read).toHaveBeenCalledOnce(); expect(current().value).toBe(60);
  expect(current().commandReadVerified).toBeUndefined();
});
