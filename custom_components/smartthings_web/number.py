"""Numeric controls for SmartThings Web."""

from __future__ import annotations

import re

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    control_label,
    entity_unique_id,
    number_controls,
    numeric_range_for,
    safe_observed_control,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create numeric controls and discover new ones from inventory pushes."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for control in number_controls(device):
                state = _matching_state(device, control)
                unique_id = (
                    entity_unique_id(device.device_id, state)
                    if state
                    else f"{device.device_id}_number_{control.control_id}"
                )
                if unique_id in known:
                    continue
                known.add(unique_id)
                entities.append(
                    SmartThingsWebNumber(
                        runtime,
                        device,
                        state,
                        control,
                    )
                )
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebNumber(SmartThingsWebDeviceEntity, NumberEntity):
    """One numeric SmartThings slider/setpoint."""

    _attr_mode = NumberMode.SLIDER

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState | None,
        control: BridgeControl | None,
    ) -> None:
        self.state_key = state.key if state else None
        self.control = control
        suffix = "_".join(state.key) if state else f"number_{control.control_id}" if control else "number"
        name = control_label(control, _name(control.attribute or "Number")) if control else _name(state.attribute) if state else "Number"
        super().__init__(runtime, device, suffix, name)
        if control and control.minimum is not None and control.maximum is not None:
            minimum = control.minimum
            maximum = control.maximum
            step = control.step or 1.0
        elif state is not None:
            minimum, maximum, step = numeric_range_for(device, state)
        else:
            minimum, maximum, step = (0.0, 100.0, 1.0)
        self._attr_native_min_value = minimum
        self._attr_native_max_value = maximum
        self._attr_native_step = step
        self._attr_native_unit_of_measurement = state.unit if state else None

    @property
    def available(self) -> bool:
        """Stay available only while the exact observed slider still exists."""
        return super().available and self._current_control is not None

    @property
    def native_value(self) -> float | None:
        """Return the last pushed numeric value."""
        state = self._current_state
        if state is None or isinstance(state.value, bool) or not isinstance(state.value, (int, float)):
            return None
        return float(state.value)

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Preserve the exact pushed slider payload on the number entity."""
        state = self._current_state
        if state is None:
            return {}
        return {
            "smartthings_raw_value": state.value,
            "smartthings_updated_at": state.updated_at,
        }

    async def async_set_native_value(self, value: float) -> None:
        """Request a numeric value without optimistic state mutation."""
        state = self._current_state
        control = self._current_control
        if control is None:
            raise HomeAssistantError("SmartThings Web number has no observed slider control")
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command=_command_for(control, state),
                arguments=[value],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("number command", err)) from err

    @property
    def _current_state(self) -> BridgeState | None:
        device = self.bridge_device
        if device is None:
            return None
        if self.state_key is not None:
            return device.states.get(self.state_key)
        return None

    @property
    def _current_control(self) -> BridgeControl | None:
        device = self.bridge_device
        if device is None or self.control is None:
            return None
        control = device.controls.get(self.control.control_id)
        original = self.control
        state_key = self.state_key
        return (
            control
            if control is not None
            and control.kind == "slider"
            and safe_observed_control(control)
            and control.attribute == original.attribute
            and (
                original.component is None
                or control.component == original.component
            )
            and (
                original.capability is None
                or control.capability == original.capability
            )
            and (
                state_key is None
                or (
                    control.attribute == state_key[2]
                    and (control.component is None or control.component == state_key[0])
                    and (control.capability is None or control.capability == state_key[1])
                )
            )
            else None
        )


def _name(attribute: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", attribute).replace("_", " ").strip().title()


def _matching_state(device: BridgeDevice, control: BridgeControl) -> BridgeState | None:
    matches = [
        state
        for state in device.states.values()
        if state.attribute == control.attribute
        and (control.component is None or state.component == control.component)
        and (control.capability is None or state.capability == control.capability)
    ]
    return matches[0] if len(matches) == 1 else None


def _command_for(
    control: BridgeControl | None, state: BridgeState | None
) -> str:
    attribute = control.attribute if control else state.attribute if state else None
    if attribute == "volume":
        return "setVolume"
    if attribute == "shadeLevel":
        return "setPosition"
    return "setNumber"
