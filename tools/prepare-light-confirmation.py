from pathlib import Path

r = Path('.')
def edit(path, old, new):
    p = r / path
    text = p.read_text()
    assert text.count(old) == 1, (path, text.count(old))
    p.write_text(text.replace(old, new))

edit('bridge/src/state/device-store.ts', '  observeAdvancedDeviceSnapshot(body: unknown, options: AdvancedDeviceSnapshotOptions = {}): void {', '''  observeCommandDeviceStatus(
    body: unknown, deviceId: string, locationId: string
  ): BridgeDeviceState[] {
    // Preserve the exact response separately from the merged cache. A read can
    // confirm an unchanged scalar without inventing an event or advancing SSE.
    const device = this.#devices.get(deviceId);
    const rows = advancedDeviceRows(body);
    if (!device || device.locationId !== locationId || rows?.length !== 1) return [];
    const row = rows[0]!;
    if (normalizedAdvancedId(row.deviceId ?? row.id, "device", this.#normalizeAdvancedAlias) !== deviceId ||
        normalizedAdvancedId(row.locationId, "location", this.#normalizeAdvancedAlias) !== locationId) return [];
    const states = advancedDeviceStates(row, this.#identifierRole, this.#normalizeStateToken,
      this.#normalizeAdvancedAlias, "COMMAND_STATUS_RECHECK");
    this.observeAdvancedDeviceSnapshot({ items: [row] }, { source: "COMMAND_STATUS_RECHECK" });
    return states.map(cloneState);
  }

  observeAdvancedDeviceSnapshot(body: unknown, options: AdvancedDeviceSnapshotOptions = {}): void {''')
edit('bridge/src/runtime.ts', '''        devices.observeAdvancedDeviceSnapshot(redactor(rawSnapshot), {
          source: "COMMAND_STATUS_RECHECK"
        });''', '''        const observedStates = devices.observeCommandDeviceStatus(
          redactor(rawSnapshot), request.deviceId, device.locationId
        );''')
edit('bridge/src/runtime.ts', '''          source: "advanced_device_status",
          authoritativeSnapshot: false,
          startedAtMs''', '''          source: "advanced_device_status",
          authoritativeSnapshot: false,
          deviceId: request.deviceId,
          locationId: device.locationId,
          observedStates,
          startedAtMs''')
edit('bridge/src/command/command-service.ts', '''  source: "advanced_device_status" | "advanced_inventory" | "location_status";
  locationId?: string;''', '''  source: "advanced_device_status" | "advanced_inventory" | "location_status";
  deviceId?: string;
  observedStates?: readonly BridgeDeviceState[];
  locationId?: string;''')
edit('bridge/src/command/command-service.ts', '''    const queued = request.targetType === "location"
''', '''    const queued = request.targetType !== "scene"
''')
edit('bridge/src/command/command-service.ts', '''        request: effective,
        attribute,
        desired,
        afterSequence: snapshot.sequence,''', '''        request: effective,
        locationId: device.locationId,
        attribute,
        desired,
        afterSequence: snapshot.sequence,''')
p = r / 'bridge/src/command/command-service.ts'
s = p.read_text()
a = s.index('function waitForState(')
b = s.index('\nfunction waitForSceneExpectedStates', a)
s = s[:a] + '''function waitForState(options: { devices: DeviceStore; request: SafeCommandRequest; locationId: string; attribute: string; desired: BridgeJsonValue | undefined; afterSequence: number; stabilityMs: number; resync: CommandResync; minimumEventTimeMs?: () => number | undefined; expectedCommandId?: () => string | undefined }): ConfirmationWait {
  const exactState = (states: readonly BridgeDeviceState[]) => {
    const matches = states.filter((state) => state.component === options.request.component &&
      state.capability === options.request.capability && state.attribute === options.attribute);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const currentState = () => {
    const device = options.devices.snapshot().devices.find((entry) => entry.id === options.request.targetId);
    return device?.locationId === options.locationId && device.online ? exactState(device.states) : undefined;
  };
  const before = currentState();
  const matchesValue = (state: BridgeDeviceState | undefined) =>
    state !== undefined && options.desired !== undefined && stateValuesEqual(state.value, options.desired);
  const snapshotMatches = () => matchesValue(currentState());
  const targetUpdated = () => {
    const current = currentState();
    return current !== undefined && (!before || !stateValuesEqual(current.value, before.value) ||
      (current.updatedAt !== null && (before.updatedAt === null || Date.parse(current.updatedAt) > Date.parse(before.updatedAt))));
  };
  return waitForPredicate({
    devices: options.devices,
    afterSequence: options.afterSequence,
    stabilityMs: options.stabilityMs,
    resync: options.resync,
    boundedStateRechecks: true,
    matches: (event) =>
      (event.type === "state" &&
        event.deviceId === options.request.targetId &&
        event.state.component === options.request.component &&
        event.state.capability === options.request.capability &&
        event.state.attribute === options.attribute &&
        (options.desired === undefined || stateValuesEqual(event.state.value, options.desired))) ||
      (event.type === "inventory" && targetUpdated() && snapshotMatches()),
    invalidates: (event) =>
      options.desired !== undefined &&
      ((event.type === "state" &&
        event.deviceId === options.request.targetId &&
        event.state.component === options.request.component &&
        event.state.capability === options.request.capability &&
        event.state.attribute === options.attribute &&
        !stateValuesEqual(event.state.value, options.desired)) ||
        (event.type === "inventory" && !snapshotMatches())),
    // Another device's inventory change is not proof for this target.
    matchesSnapshot: () => targetUpdated() && snapshotMatches(),
    acceptsResyncEvidence: (evidence, minStartedAtMs) => {
      if (options.stabilityMs > 0 || !evidence || evidence.source !== "advanced_device_status" ||
          evidence.deviceId !== options.request.targetId || evidence.locationId !== options.locationId ||
          !Array.isArray(evidence.observedStates) || minStartedAtMs === undefined ||
          !Number.isFinite(evidence.startedAtMs) || evidence.startedAtMs < minStartedAtMs) return false;
      // Successful POST receipt is not enough. Require the exact scalar in a
      // post-dispatch GET and the current cache; never use missing/stale targets.
      return matchesValue(exactState(evidence.observedStates)) && snapshotMatches();
    },
    acceptsEvidence: (evidence) => {
      if (evidence.source !== "event") return true;
      const minimumEventTimeMs = options.minimumEventTimeMs?.();
      if (minimumEventTimeMs !== undefined && evidence.eventTime &&
          Date.parse(evidence.eventTime) <= minimumEventTimeMs) return false;
      const expectedCommandId = options.expectedCommandId?.();
      return !expectedCommandId || !evidence.commandId || expectedCommandId === evidence.commandId;
    }
  });
}
''' + s[b:]
s = s.replace('boundedLocationRechecks?: boolean }): ConfirmationWait', 'boundedLocationRechecks?: boolean; boundedStateRechecks?: boolean }): ConfirmationWait')
s = s.replace('if (options.boundedLocationRechecks === true) {', 'if (options.boundedLocationRechecks === true || options.boundedStateRechecks === true) {')
p.write_text(s)

edit('custom_components/smartthings_web/light.py', 'import asyncio\nfrom datetime import datetime', 'import asyncio\nfrom collections.abc import AsyncIterator\nfrom contextlib import asynccontextmanager\nfrom datetime import datetime\nimport logging')
edit('custom_components/smartthings_web/light.py', '\n\nasync def async_setup_entry(', '\n\n_LOGGER = logging.getLogger(__name__)\n_COMMAND_QUEUE_TIMEOUT = 10\n_STATE_CATCHUP_TIMEOUT = 3\n\n\nasync def async_setup_entry(')
p = r / 'custom_components/smartthings_web/light.py'
s = p.read_text().replace('async with self._command_lock:', 'async with _command_slot(self._command_lock):')
s = s.replace('''                    await self._async_command("off")
                    return''', '''                    try:
                        await self._async_command("off")
                    finally:
                        await self._async_catch_up_state()
                    return''')
a = s.index('            await self._async_command("on")\n')
b = s.index('\n    async def async_turn_off', a)
block = s[a:b]
s = s[:a] + '            try:\n' + ''.join('    '+line+'\n' if line else '\n' for line in block.rstrip().split('\n')) + '            finally:\n                await self._async_catch_up_state()\n' + s[b:]
s = s.replace('''        async with _command_slot(self._command_lock):
            await self._async_command("off")

    async def _async_command''', '''        async with _command_slot(self._command_lock):
            try:
                await self._async_command("off")
            finally:
                await self._async_catch_up_state()

    async def _async_catch_up_state(self) -> None:
        """Read the Bridge once after a plan, even if a later step failed.

        This catches up a lagging SSE stream without changing request/receipt
        values into state or masking the original command failure.
        """
        try:
            async with asyncio.timeout(_STATE_CATCHUP_TIMEOUT):
                inventory = await self.runtime.client.async_get_inventory()
                self.runtime.apply_inventory(inventory)
        except (BridgeClientError, TimeoutError):
            _LOGGER.debug("SmartThings Web light state catch-up unavailable; waiting for events")

    async def _async_command''')
s = s.replace('bridge_error_message("light command", err)', 'bridge_error_message(f"light {command} command", err)', 1)
s = s.replace('bridge_error_message("light command", err)', 'bridge_error_message(f"light {attribute} command", err)', 1)
s += '''\n\n@asynccontextmanager
async def _command_slot(lock: asyncio.Lock) -> AsyncIterator[None]:
    """Reject queued stale UI requests, but never interrupt a dispatched command."""
    try:
        async with asyncio.timeout(_COMMAND_QUEUE_TIMEOUT):
            await lock.acquire()
    except TimeoutError as err:
        raise HomeAssistantError("SmartThings Web light command failed: command_queue_timeout") from err
    try:
        yield
    finally:
        lock.release()
'''
p.write_text(s)
edit('custom_components/smartthings_web/tests/test_light_capabilities.py', '''            self.entity = SmartThingsWebLight(self.runtime, self.device, self.states[0])''', '''            self.client.async_get_inventory = AsyncMock(side_effect=lambda: deepcopy(self.runtime.inventory))
            self.entity = SmartThingsWebLight(self.runtime, self.device, self.states[0])''')
for path, needle, fragment in [
    ('bridge/tests/command/command-service.test.ts', '  test.each(scalars)("rejects %s outside the current catalog range before sending",', 'tools/light-confirmation-node.txt'),
    ('custom_components/smartthings_web/tests/test_light_capabilities.py', '        def test_hue_supports_color_temperature', 'tools/light-confirmation-python.txt'),
]:
    p = r / path
    text = p.read_text()
    at = text.index(needle)
    p.write_text(text[:at] + (r / fragment).read_text() + text[at:])
for path in ['package.json', 'package-lock.json', 'protocol/version.json', 'bridge/src/runtime.ts', 'bridge/tests/runtime.test.ts', 'tests/addon-config.test.ts', 'tests/protocol-version-contract.test.ts', 'addon/smartthings_web_bridge/config.yaml', 'custom_components/smartthings_web/manifest.json']:
    p = r / path
    text = p.read_text()
    assert '1.8.18' in text, path
    p.write_text(text.replace('1.8.18', '1.8.19'))
notes = (r / 'tools/light-confirmation-notes.txt').read_text()
for path in ['CHANGELOG.md', 'addon/smartthings_web_bridge/CHANGELOG.md']:
    p = r / path
    p.write_text(notes + p.read_text())
