"""Fail-closed light controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_COLOR_TEMP_KELVIN,
    ColorMode,
    LightEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    control_kind,
    numeric_range_for,
    primary_state_attributes,
    safe_observed_control,
    toggle_control_for_state,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create only lights with light-specific state evidence."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                if (
                    control_kind(device, state) == "light"
                    and (toggle := toggle_control_for_state(device, state)) is not None
                    and safe_observed_control(toggle)
                    and unique_id not in known
                ):
                    known.add(unique_id)
                    entities.append(SmartThingsWebLight(runtime, device, state))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebLight(SmartThingsWebEntity, LightEntity):
    """One light whose commands are confirmed by a newer push event."""

    def __init__(
        self, runtime: SmartThingsWebRuntime, device: BridgeDevice, state: BridgeState
    ) -> None:
        super().__init__(runtime, device, state, None)
        level_control = _control(device, "level")
        color_temperature_control = _control(device, "colorTemperature")
        if color_temperature_control is not None:
            self._attr_color_mode = ColorMode.COLOR_TEMP
            self._attr_supported_color_modes = {ColorMode.COLOR_TEMP}
            color_temperature_state = _state(device, "colorTemperature")
            if color_temperature_state is not None:
                minimum, maximum, _step = numeric_range_for(
                    device, color_temperature_state
                )
                self._attr_min_color_temp_kelvin = int(minimum)
                self._attr_max_color_temp_kelvin = int(maximum)
        elif level_control is not None:
            self._attr_color_mode = ColorMode.BRIGHTNESS
            self._attr_supported_color_modes = {ColorMode.BRIGHTNESS}
        else:
            self._attr_color_mode = ColorMode.ONOFF
            self._attr_supported_color_modes = {ColorMode.ONOFF}

    @property
    def available(self) -> bool:
        """Stay available only while the exact safe power toggle still exists."""
        device = self.bridge_device
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        return (
            super().available
            and control is not None
            and safe_observed_control(control)
        )

    @property
    def is_on(self) -> bool | None:
        """Return the last pushed switch state."""
        state = self.bridge_state
        if state is None:
            return None
        return str(state.value).lower() == "on"

    @property
    def brightness(self) -> int | None:
        """Return the pushed SmartThings level on Home Assistant's 0..255 scale."""
        state = _state(self.bridge_device, "level")
        if state is None or isinstance(state.value, bool) or not isinstance(
            state.value, (int, float)
        ):
            return None
        return round(max(0.0, min(100.0, float(state.value))) * 255 / 100)

    @property
    def color_temp_kelvin(self) -> int | None:
        """Return the pushed color temperature."""
        state = _state(self.bridge_device, "colorTemperature")
        if state is None or isinstance(state.value, bool) or not isinstance(
            state.value, (int, float)
        ):
            return None
        return int(state.value)

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Preserve pushed light metadata not represented by core light fields."""
        device = self.bridge_device
        if device is None:
            return {}
        attributes = {
            "colorTemperature",
            "colorTemperatureRange",
            "hue",
            "level",
            "levelRange",
            "saturation",
            "switch",
            "supportedColorModes",
        }
        return primary_state_attributes(
            device,
            attributes,
            component=self.state_key[0],
        )

    async def async_turn_on(self, **kwargs: object) -> None:
        """Request ON without optimistic state mutation."""
        await self._async_command("on")
        brightness = kwargs.get(ATTR_BRIGHTNESS)
        if isinstance(brightness, (int, float)) and not isinstance(brightness, bool):
            await self._async_set_number("level", round(float(brightness) * 100 / 255))
        color_temperature = kwargs.get(ATTR_COLOR_TEMP_KELVIN)
        if isinstance(color_temperature, (int, float)) and not isinstance(
            color_temperature, bool
        ):
            await self._async_set_number("colorTemperature", round(color_temperature))

    async def async_turn_off(self, **kwargs: object) -> None:
        """Request OFF without optimistic state mutation."""
        await self._async_command("off")

    async def _async_command(self, command: str) -> None:
        device = self.bridge_device
        state = device.states.get(self.state_key) if device is not None else None
        control = (
            toggle_control_for_state(device, state)
            if device is not None and state is not None
            else None
        )
        if control is None or not safe_observed_control(control):
            raise HomeAssistantError("SmartThings Web light has no observed power control")
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command=command,
                arguments=[],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("light command", err)) from err

    async def _async_set_number(self, attribute: str, value: int) -> None:
        device = self.bridge_device
        state = _state(device, attribute)
        control = _control(device, attribute)
        if state is None or control is None:
            raise HomeAssistantError(
                f"SmartThings Web light has no observed {attribute} slider"
            )
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command="setNumber",
                arguments=[value],
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("light command", err)) from err


def _state(device: BridgeDevice | None, attribute: str) -> BridgeState | None:
    if device is None:
        return None
    return next(
        (state for state in device.states.values() if state.attribute == attribute),
        None,
    )


def _control(device: BridgeDevice | None, attribute: str) -> BridgeControl | None:
    if device is None:
        return None
    matches = [
        control
        for control in device.controls.values()
        if control.kind == "slider"
        and control.attribute == attribute
        and safe_observed_control(control)
    ]
    return matches[0] if len(matches) == 1 else None
