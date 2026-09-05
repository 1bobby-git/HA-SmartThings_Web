from pathlib import Path


def patch(path, old, new):
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one exact anchor, got {text.count(old)}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


patch("bridge/src/command/command-service.ts", '''      diagnostic(error instanceof Error && error.message === "command_confirmation_timeout" ? "timed_out" : "failed");
      throw commandError(error);''', '''      const timedOut = error instanceof Error && error.message === "command_confirmation_timeout";
      diagnostic(timedOut ? "timed_out" : "failed");
      // The completion hook now rejects inside the executor await. Preserve its failure code.
      if (timedOut) throw new SafeCommandError("command_confirmation_timeout");
      if (error instanceof SafeCommandError) throw error;
      throw commandError(error);''')

patch("bridge/src/state/device-store.ts", '''      changed = setIfChanged(this.#locations, id, { id, name }) || changed;''', '''      // Advanced locations are metadata, not a security-state observation.
      // Replacing the row with {id, name} erased a newer armState on every resync.
      const current = this.#locations.get(id);
      changed = setIfChanged(this.#locations, id, { ...current, id, name }) || changed;''')
patch("bridge/src/state/device-store.ts", '''        const updatedAt = validTimestamp(row.updatedAt ?? row.updated_at ?? row.timestamp);
        changed =
          setIfChanged(this.#locations, id, {
            id,
            name,
            ...(armState ? { armState } : {}),
            ...(armState || updatedAt ? { updatedAt } : {})
          }) || changed;''', '''        const updatedAt = validTimestamp(row.updatedAt ?? row.updated_at ?? row.timestamp);
        const current = this.#locations.get(id);
        const acceptArmState = armState !== undefined && (
          current?.armState === undefined || !current.updatedAt ||
          !isOlderOrUndated(updatedAt, current.updatedAt)
        );
        changed =
          setIfChanged(this.#locations, id, {
            ...current,
            id,
            name,
            ...(acceptArmState ? { armState, updatedAt } : {}),
            ...(!current && !armState && updatedAt ? { updatedAt } : {})
          }) || changed;''')

path = Path("bridge/tests/command/command-service.test.ts")
text = path.read_text(encoding="utf-8")
text += '''

describe("Home Monitor location metadata preservation", () => {
  const setup = () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:02Z")));
    return store;
  };
  const location = (store: DeviceStore) => store.snapshot().locations.find((item) => item.id === "loc_001");
  const metadata = (store: DeviceStore, name = "Home") => store.observeAdvancedInventorySnapshot({
    locations: [{ locationId: "loc_001", name }]
  });
  const consumerMetadata = (store: DeviceStore, updatedAt?: string) => {
    store.observe(sent('4226["find","api/location",{}]'));
    store.observe(received(`4326${JSON.stringify([null, [{ locationId: "loc_001", name: "Home",
      ...(updatedAt ? { updatedAt } : {}) }]])}`));
  };

  test("Advanced metadata must not erase observed security state or emit duplicate inventory", () => {
    const store = setup();
    const before = location(store);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    metadata(store);
    metadata(store);
    expect(location(store)).toEqual(before);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("a location rename preserves the security state and its timestamp", () => {
    const store = setup();
    metadata(store, "Renamed home");
    expect(location(store)).toMatchObject({ name: "Renamed home", armState: "ARMED_AWAY",
      updatedAt: "2026-08-25T00:00:02.000Z" });
  });

  test("a metadata-only consumer location snapshot retains the security state", () => {
    const store = setup();
    const before = location(store);
    consumerMetadata(store);
    expect(location(store)).toEqual(before);
  });

  test("a metadata timestamp is not a security timestamp", () => {
    const store = setup();
    consumerMetadata(store, "2026-09-01T00:00:00Z");
    store.observe(received(securityEventFrame("DISARMED", "2026-08-25T00:00:03Z")));
    expect(location(store)?.armState).toBe("DISARMED");
  });

  test("an older or undated snapshot cannot revert a newer security event", () => {
    const store = setup();
    const before = location(store);
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:01Z");
    expect(location(store)).toEqual(before);
    observeLocationSnapshot(store, "DISARMED", "invalid-time");
    expect(location(store)).toEqual(before);
  });

  test("a newer explicit consumer security snapshot is still applied", () => {
    const store = setup();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:03Z");
    expect(location(store)?.armState).toBe("DISARMED");
  });

  test("metadata never invents an arm state for a new location", () => {
    const store = new DeviceStore();
    metadata(store);
    expect(location(store)?.armState).toBeUndefined();
  });

  test("metadata reconciliation does not invalidate fresh pending command evidence", async () => {
    const store = readyDeviceStore();
    observeLocationSnapshot(store, "DISARMED", "2026-08-25T00:00:00Z");
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      timeoutMs: 100, resync: async () => undefined,
      executor: { executeLocationAction: async (input) => {
        store.observe(received(securityEventFrame("ARMED_AWAY", "2026-08-25T00:00:02Z")));
        metadata(store);
        await input.waitForConfirmation!();
      } }
    });
    await expect(service.execute({ targetType: "location", targetId: "loc_001",
      command: "armAway", arguments: [], clientRequestId: "request_hm_metadata" }))
      .resolves.toMatchObject({ status: "confirmed", confirmation: "security_arm_state_event" });
  });
});
'''
# Preserve the format actually returned by validTimestamp; compare to baseline elsewhere.
text = text.replace('updatedAt: "2026-08-25T00:00:02.000Z" });', 'updatedAt: location(setup())?.updatedAt });')
path.write_text(text, encoding="utf-8")

path = Path("addon/smartthings_web_bridge/CHANGELOG.md")
text = path.read_text(encoding="utf-8")
text = text.replace("## 1.8.5\n", '''## 1.8.5

- Advanced 위치 메타데이터의 `{id, name}` 갱신이 이미 수신한 Home Monitor `armState`와 보안 timestamp를 삭제하던 결함을 수정했습니다. 상태 없는 위치 응답은 기존 보안 상태를 유지하고, 오래되거나 날짜 없는 소비자 스냅샷이 최신 보안 이벤트를 되돌리지 못하게 했습니다. 동일 메타데이터 재수신은 추가 인벤토리 이벤트를 생성하지 않습니다.
''', 1)
path.write_text(text, encoding="utf-8")
path = Path("README.md")
with path.open("a", encoding="utf-8") as stream:
    stream.write("\nAdvanced 위치 메타데이터 갱신은 이미 관찰된 Home Monitor 보안 상태를 지우지 않습니다. 보안 상태가 없는 응답이나 오래된 스냅샷을 최신 보안 상태로 취급하지 않습니다.\n")
print("Applied observed security-state preservation and safe timeout propagation")
