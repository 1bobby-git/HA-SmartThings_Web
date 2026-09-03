"""Select entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    control_label,
    safe_observed_control,
    select_controls,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create select entities from observed enumerated controls with options."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for control in select_controls(device):
                unique_id = f"{device.device_id}_select_{control.control_id}"
                if unique_id in known:
                    continue
                known.add(unique_id)
                entities.append(SmartThingsWebSelect(runtime, device, control))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebSelect(SmartThingsWebDeviceEntity, SelectEntity):
    """One observed enumerated SmartThings control."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        control: BridgeControl,
    ) -> None:
        self.control = control
        super().__init__(
            runtime,
            device,
            f"select_{control.control_id}",
            control_label(control, control.attribute or "Option"),
        )
        self._attr_options = list(control.options)

    @property
    def available(self) -> bool:
        """Stay available only while the exact observed option control exists."""
        return super().available and self._current_control is not None

    @property
    def current_option(self) -> str | None:
        """Return the current selected value from pushed state."""
        control = self._current_control
        if control is None or control.attribute is None:
            return None
        device = self.bridge_device
        if device is None:
            return None
        for state in device.states.values():
            if (
                state.attribute == control.attribute
                and (control.component is None or state.component == control.component)
                and isinstance(state.value, str)
            ):
                return state.value
        return None

    @property
    def options(self) -> list[str]:
        """Return the latest exact options from the observed web control."""
        control = self._current_control
        return list(control.options) if control is not None else []

    async def async_select_option(self, option: str) -> None:
        """Set an option without optimistic state mutation."""
        if option not in self.options:
            raise HomeAssistantError("SmartThings Web select option is invalid")
        control = self._current_control
        if control is None:
            raise HomeAssistantError("SmartThings Web select control is unavailable")
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command="setOption",
                arguments=[option],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("select command", err)) from err

    @property
    def _current_control(self) -> BridgeControl | None:
        device = self.bridge_device
        if device is None:
            return None
        control = device.controls.get(self.control.control_id)
        return (
            control
            if control is not None
            and control.kind == "enumerated"
            and safe_observed_control(control)
            else None
        )
