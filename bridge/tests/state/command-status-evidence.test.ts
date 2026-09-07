import { describe, expect, test } from "vitest";
import { DeviceStore } from "../../src/state/device-store.js";
const row = (value: number, timestamp = "2026-09-07T00:00:00Z") => ({deviceId: "dev_001", locationId: "loc_001",
  status: {components: {main: {identifier_light: {hue: {value, timestamp}}}}}});
function fixture() { const store = new DeviceStore(); store.observeAdvancedDeviceSnapshot({items: [row(50)]}); return store; }
describe("Exact command status evidence", () => {
  test("unchanged response is copied without forcing sequence/timestamp changes", () => {
    const store = fixture(), before = store.snapshot();
    const proof = store.observeCommandDeviceStatus({items: [row(50)]}, "dev_001", "loc_001");
    expect(proof).toHaveLength(1); expect(proof[0]).toMatchObject({value: 50, source: "COMMAND_STATUS_RECHECK"});
    proof[0]!.value = 99; expect(store.snapshot()).toEqual(before); store.close();
  });
  test.each([{}, {items: []}, {items: [row(20), row(30)]}, {items: [{...row(20), deviceId: "dev_002"}]},
    {items: [{...row(20), locationId: "loc_002"}]}])("rejects missing, mixed or wrong target responses", (body) => {
    const store = fixture(), before = store.snapshot();
    expect(store.observeCommandDeviceStatus(body, "dev_001", "loc_001")).toEqual([]);
    expect(store.snapshot()).toEqual(before); store.close();
  });
  test("preserves newer event order even though proof records the older raw read", () => {
    const store = fixture(); store.observeAdvancedDeviceSnapshot({items: [row(60, "2026-09-07T00:00:02Z")]});
    const proof = store.observeCommandDeviceStatus({items: [row(50)]}, "dev_001", "loc_001");
    expect(proof[0]!.value).toBe(50); expect(store.snapshot().devices[0]!.states[0]!.value).toBe(60); store.close();
  });
  test("new actual status updates inventory without creating extra devices", () => {
    const store = fixture(), seq = store.currentSequence();
    store.observeCommandDeviceStatus({items: [row(70, "2026-09-07T00:00:03Z")]}, "dev_001", "loc_001");
    expect(store.currentSequence()).toBe(seq + 1); expect(store.snapshot().devices).toHaveLength(1);
    expect(store.snapshot().devices[0]!.states[0]!.value).toBe(70); store.close();
  });
});
