from pathlib import Path
import json

assert json.loads(Path('package.json').read_text())['version'] == '1.8.19'

def edit(path, old, new):
    p = Path(path)
    s = p.read_text()
    assert s.count(old) == 1, (path, s.count(old), old[:80])
    p.write_text(s.replace(old, new))

edit('bridge/src/command/advanced-first-executor.ts', '''    try {
      return await new OrderedCommandRouter({
        advanced: this.advanced
      }).execute(routed);
    } catch (error) {''', '''    this.#diagnostic({ transport: "advanced", stage: "dispatch", outcome: "attempt" });
    try {
      const receipt = await new OrderedCommandRouter({
        advanced: this.advanced
      }).execute(routed);
      this.#diagnostic({ transport: "advanced", stage: "receipt", outcome: "accepted" });
      return receipt;
    } catch (error) {
      this.#diagnostic({ transport: "advanced", stage: "dispatch", outcome: "failed",
        code: safeCommandCode(error) });''')
edit('bridge/src/command/command-service.ts', 'import { normalizeLocationArmState }', 'import { deviceCommandTrace, type DeviceCommandPhase } from "./device-command-diagnostics.js";\nimport { normalizeLocationArmState }')
edit('bridge/src/command/command-service.ts', '  onPendingCountChange?: (count: number) => void;', '  onPendingCountChange?: (count: number) => void;\n  onDeviceDiagnostic?: (message: string) => void;')
edit('bridge/src/command/command-service.ts', '    let receiptCommandId: string | undefined;', '''    const traceStartedAt = Date.now();
    let reads = 0;
    const trace = (phase: DeviceCommandPhase, counts: Readonly<Record<string, number>> = {}) => {
      try {
        this.options.onDeviceDiagnostic?.(deviceCommandTrace(
          { ...effective, attribute }, phase,
          { elapsed_ms: Math.max(0, Date.now() - traceStartedAt), ...counts }
        ));
      } catch {
        // Logging must not change delivery, confirmation, or failure semantics.
      }
    };
    const resyncTarget = async () => {
      reads += 1;
      let evidence: CommandResyncEvidence | undefined;
      try {
        evidence = await this.options.resync({ deviceId: effective.targetId });
      } catch (error) {
        trace("status_read_failed", { read: reads });
        throw error;
      }
      try {
        const observed = Array.isArray(evidence?.observedStates) ? evidence.observedStates : [];
        const exact = observed.filter((entry) => entry.component === effective.component &&
          entry.capability === effective.capability && entry.attribute === attribute);
        const cached = this.options.devices.commandState(effective.targetId, device.locationId,
          effective.component, effective.capability, attribute);
        trace("status_read", {
          read: reads, observed: observed.length, target: exact.length,
          target_matches: Number(exact.length === 1 && desired !== undefined && stateValuesEqual(exact[0]!.value, desired)),
          cache_matches: Number(cached !== undefined && desired !== undefined && stateValuesEqual(cached.value, desired))
        });
      } catch {
        // An unexpected diagnostic shape must not discard the original read.
      }
      return evidence;
    };
    let receiptCommandId: string | undefined;''')
edit('bridge/src/command/command-service.ts', '''        stabilityMs: this.options.confirmationStabilityMs ?? 0,
        resync: () => this.options.resync({ deviceId: effective.targetId }),''', '''        stabilityMs: this.options.confirmationStabilityMs ?? 0,
        resync: resyncTarget,''')
edit('bridge/src/command/command-service.ts', '''      executionResult = await this.options.executor.executeDeviceAction(executionInput);
      if (executionResult''', '''      trace("dispatch");
      executionResult = await this.options.executor.executeDeviceAction(executionInput);
      trace("accepted");
      if (executionResult''')
edit('bridge/src/command/command-service.ts', '''    } catch (error) {
      wait.cancel();
      throw commandError(error);
    }''', '''    } catch (error) {
      trace("failed");
      wait.cancel();
      throw commandError(error);
    }''')
edit('bridge/src/command/command-service.ts', '''    const evidence = await wait.result;
    return confirmed(
      request.clientRequestId,
      evidence.sequence,
      evidence.source === "inventory_snapshot" ? "inventory_snapshot" : "device_event",
      transportForExecution(executionResult)
    );''', '''    try {
      const evidence = await wait.result;
      trace("confirmed", { reads });
      return confirmed(
        request.clientRequestId,
        evidence.sequence,
        evidence.source === "inventory_snapshot" ? "inventory_snapshot" : "device_event",
        transportForExecution(executionResult)
      );
    } catch (error) {
      trace("failed", { reads });
      throw error;
    }''')
edit('bridge/src/command/command-service.ts', '''    const device = options.devices.snapshot().devices.find((entry) => entry.id === options.request.targetId);
    return device?.locationId === options.locationId && device.online ? exactState(device.states) : undefined;''', '''    return options.devices.commandState(options.request.targetId, options.locationId,
      options.request.component, options.request.capability, options.attribute);''')
edit('bridge/src/state/device-store.ts', '  /** Avoid cloning every device and capability while checking a location command. */', r'''  /** Read one exact online target without cloning the whole inventory per event. */
  commandState(
    deviceId: string, locationId: string,
    component: string | undefined, capability: string | undefined, attribute: string
  ): BridgeDeviceState | undefined {
    const device = this.#devices.get(deviceId);
    if (!device || !device.online || device.locationId !== locationId || !component || !capability) {
      return undefined;
    }
    const state = device.states.get(`${component}\u0000${capability}\u0000${attribute}`);
    if (!state) return undefined;
    if (CAMERA_IMAGE_ATTRIBUTES.has(attribute) && !snapshotDeviceStates(device).includes(state)) {
      return undefined;
    }
    return cloneState(state);
  }

  /** Avoid cloning every device and capability while checking a location command. */''')
edit('bridge/src/runtime.ts', '    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),', '    onDeviceDiagnostic: (message) => log.info(`device_command:${message}`),\n    onPendingCountChange: (count) => status.update({ pendingCommandCount: count }),')
edit('custom_components/smartthings_web/light.py', '''            try:
                await self._async_command("on")
                for attribute, value in plan:''', '''            try:
                # Attribute updates on an observed-on light do not require a
                # second ON transaction. Keep explicit ON and unknown/off states
                # on the existing confirmed power path; never assume power from
                # the requested brightness or color.
                if not plan or self.is_on is not True:
                    await self._async_command("on")
                for attribute, value in plan:''')
edit('custom_components/smartthings_web/fan.py', '    BridgeDevice,\n', '    BridgeDevice,\n    BridgeState,\n')
edit('custom_components/smartthings_web/fan.py', '    token_values,\n', '    token_values,\n    toggle_control_for_state,\n')
edit('custom_components/smartthings_web/fan.py', '''        switch = _state(self.bridge_device, "switch")
        if isinstance(switch, str):
            return switch.lower() == "on"''', '''        power = _power_binding(self.bridge_device)
        states = _power_states(self.bridge_device)
        state = power[0] if power is not None else states[0] if len(states) == 1 else None
        if state is not None:
            switch = state.value
            if isinstance(switch, str) and switch.strip().lower() in {"on", "off"}:
                return switch.strip().lower() == "on"
            return None''')
edit('custom_components/smartthings_web/fan.py', '''        state = _state_obj(self.bridge_device, target_attribute)
        control = _control_for(
            self.bridge_device,
            target_attribute,
            state.component if state is not None else None,
        )''', '''        if target_attribute == "switch":
            # Use the same exact binding for feature flags, state, and dispatch.
            # An action and its detail swatch are not two different switches.
            power = _power_binding(self.bridge_device)
            state, control = power if power is not None else (None, None)
        else:
            state = _state_obj(self.bridge_device, target_attribute)
            control = _control_for(
                self.bridge_device,
                target_attribute,
                state.component if state is not None else None,
            )''')
edit('custom_components/smartthings_web/fan.py', '''def _has_switch_power(device: BridgeDevice | None) -> bool:
    if device is None:
        return False
    return any(
        control.kind == "toggle"
        and control.attribute == "switch"
        and safe_observed_control(control)
        for control in device.controls.values()
    )''', '''def _power_states(device: BridgeDevice | None) -> list[BridgeState]:
    """Prefer an explicit main component, never the first inserted sibling."""
    if device is None:
        return []
    states = [state for state in device.states.values() if state.attribute == "switch"]
    main = [state for state in states
            if (state.component_role or state.component).strip().lower() == "main"]
    return main or states


def _power_binding(device: BridgeDevice | None) -> tuple[BridgeState, BridgeControl] | None:
    """Resolve one exact power state/control with the shared toggle policy."""
    if device is None:
        return None
    bindings = []
    for state in _power_states(device):
        control = toggle_control_for_state(device, state)
        if control is not None and safe_observed_control(control):
            bindings.append((state, control))
    return bindings[0] if len(bindings) == 1 else None


def _has_switch_power(device: BridgeDevice | None) -> bool:
    return _power_binding(device) is not None''')
p = Path('custom_components/smartthings_web/tests/test_light_capabilities.py')
s = p.read_text()
marker = '        def test_hue_supports_color_temperature_and_color_without_web_sliders(self):'
assert s.count(marker) == 1
p.write_text(s.replace(marker, Path('tools/control-repair-light-tests.txt').read_text() + marker))
for name in ['package.json', 'package-lock.json', 'protocol/version.json', 'bridge/src/runtime.ts', 'bridge/tests/runtime.test.ts', 'tests/addon-config.test.ts', 'tests/protocol-version-contract.test.ts', 'addon/smartthings_web_bridge/config.yaml', 'custom_components/smartthings_web/manifest.json']:
    p = Path(name)
    s = p.read_text()
    assert '1.8.19' in s, name
    p.write_text(s.replace('1.8.19', '1.8.20'))
notes = Path('tools/control-repair-notes.txt').read_text()
for name in ['CHANGELOG.md', 'addon/smartthings_web_bridge/CHANGELOG.md']:
    p = Path(name)
    p.write_text(notes + p.read_text())
