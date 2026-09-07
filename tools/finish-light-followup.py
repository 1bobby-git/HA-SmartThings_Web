from pathlib import Path

p = Path('bridge/tests/command/command-service.test.ts')
s = p.read_text()
needle = '  test.each(scalars)("rejects %s outside the current catalog range before sending",'
assert s.count(needle) == 1
fragment = '''  test.each(scalars)("continues from delayed power confirmation to %s without replaying either command", async (attribute, setter, desired, minimum, maximum) => {
    vi.useFakeTimers();
    const store = readyDeviceStore();
    const capability = `identifier_plan_${attribute.toLowerCase()}`;
    let power = "off", scalar: number = minimum;
    let nextPower = power, nextScalar = scalar;
    let visibleAfter = Infinity;
    let stamp = new Date(Date.now() - 10_000).toISOString();
    const body = () => ({ items: [{ deviceId: "dev_001", locationId: "loc_001", status: {
      components: { main: {
        identifier_switch: { switch: { value: power, timestamp: stamp } },
        [capability]: { [attribute]: { value: scalar, timestamp: stamp } }
      } }
    } }] });
    store.observeAdvancedDeviceSnapshot(body());
    observeAdvancedCatalog(store, [advancedCommand(capability, setter, {
      component: "main", arguments: [{ name: "value", required: true, sensitive: false,
        schema: { type: "integer", minimum, maximum } }]
    })]);
    const executeDeviceAction = vi.fn(async (input: DeviceActionExecutionInput) => {
      if (input.command === "on") nextPower = "on";
      else if (input.command === setter) nextScalar = input.arguments[0] as number;
      else throw new Error("unexpected_command");
      visibleAfter = Date.now() + 1_500;
      return { state: "ACCEPTED" as const, transport: "advanced" as const,
        sentAtMs: Date.now(), acceptedAtMs: Date.now() };
    });
    const resync = vi.fn(async (): Promise<CommandResyncEvidence> => {
      if (Date.now() >= visibleAfter) {
        power = nextPower; scalar = nextScalar; stamp = new Date().toISOString();
      }
      const observedStates = store.observeCommandDeviceStatus(body(), "dev_001", "loc_001");
      return { source: "advanced_device_status", deviceId: "dev_001", locationId: "loc_001",
        authoritativeSnapshot: false, startedAtMs: Date.now(), observedStates };
    });
    const service = new SafeCommandService({ devices: store, status: connectedStatus(),
      executor: { executeDeviceAction }, timeoutMs: 30_000, resyncAfterMs: 1_000, resync });
    try {
      const plan = (async () => {
        const first = await service.execute(command("on", "request_plan_power"));
        const second = await service.execute({ targetType: "device", targetId: "dev_001",
          component: "main", capability, attribute, command: setter, arguments: [desired],
          requireAdvanced: true, confirm: true, clientRequestId: "request_plan_scalar" });
        return [first.status, second.status];
      })();
      const completed = expect(plan).resolves.toEqual(["confirmed", "confirmed"]);
      await vi.advanceTimersByTimeAsync(4_001); await completed;
      expect(executeDeviceAction.mock.calls.map(([input]) => input.command)).toEqual(["on", setter]);
      expect(power).toBe("on"); expect(scalar).toBe(desired);
      expect(resync).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(resync).toHaveBeenCalledTimes(4);
    } finally { store.close(); vi.useRealTimers(); }
  });

'''
p.write_text(s.replace(needle, fragment + needle))
p = Path('docs/LIGHT_CONFIRMATION_1.8.19.md')
s = p.read_text().replace('사용자 로그: `light.turn_on`에서 `command_confirmation_timeout`.', '사용자는 전구가 실제로 켜지고 HA 로그북에도 켜짐이 기록되지만 이후 밝기·색상 조절이 되지 않는다고 보고했습니다. 앞선 오류는 `light.turn_on`의 `command_confirmation_timeout`입니다. 이 로그만으로 전원·밝기·색상 중 어느 단계의 확인이 실패했는지는 확정하지 않습니다.')
s = s.replace('검사는 지연된 상태 읽기,', '검사는 전원 켜짐 확인 후 밝기·색상·색온도 후속 명령까지 이어지는 지연 상태 응답,')
p.write_text(s)
