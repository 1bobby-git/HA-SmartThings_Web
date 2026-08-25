"""Numeric controls for SmartThings Web."""

from __future__ import annotations

import re

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    control_label,
    entity_unique_id,
    number_controls,
    number_state_allowed,
    numeric_range_for,
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
            controls = number_controls(device)
            if controls:
                for control in controls:
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
                continue
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                if number_state_allowed(device, state) and unique_id not in known:
                    known.add(unique_id)
                    entities.append(SmartThingsWebNumber(runtime, device, state, None))
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
    def native_value(self) -> float | None:
        """Return the last pushed numeric value."""
        state = self._current_state
        if state is None or isinstance(state.value, bool) or not isinstance(state.value, (int, float)):
            return None
        return float(state.value)

    async def async_set_native_value(self, value: float) -> None:
        """Request a numeric value without optimistic state mutation."""
        state = self._current_state
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=self.control.component if self.control else state.component if state else None,
                capability=self.control.capability if self.control else state.capability if state else None,
                attribute=self.control.attribute if self.control else state.attribute if state else None,
                control_id=self.control.control_id if self.control else None,
                control_label=self.control.label if self.control else None,
                command="setNumber",
                arguments=[value],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(
                "SmartThings Web did not confirm the requested number state"
            ) from err

    @property
    def _current_state(self) -> BridgeState | None:
        device = self.bridge_device
        if device is None:
            return None
        if self.state_key is not None:
            return device.states.get(self.state_key)
        return None


def _name(attribute: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", attribute).replace("_", " ").strip().title()


def _matching_state(device: BridgeDevice, control: BridgeControl) -> BridgeState | None:
    return next(
        (
            state
            for state in device.states.values()
            if state.attribute == control.attribute
            and (control.component is None or state.component == control.component)
        ),
        None,
    )
