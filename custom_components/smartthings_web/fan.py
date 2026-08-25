"""Fan and air-purifier controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.fan import FanEntity, FanEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .entity import SmartThingsWebDeviceEntity
from .models import BridgeControl, BridgeDevice, SmartThingsWebRuntime, is_fan_device, option_values


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create fan entities for fan and air-purifier devices."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not is_fan_device(device):
                continue
            if device.device_id in known:
                continue
            known.add(device.device_id)
            entities.append(SmartThingsWebFan(runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebFan(SmartThingsWebDeviceEntity, FanEntity):
    """One fan-like SmartThings device."""

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice) -> None:
        super().__init__(runtime, device, "fan", None)

    @property
    def percentage(self) -> int | None:
        """Return the current fan percentage."""
        device = self.bridge_device
        if device is None:
            return None
        for attribute in ("fanSpeed", "level"):
            state = _state(device, attribute)
            if isinstance(state, (int, float)) and not isinstance(state, bool):
                return max(0, min(100, int(state)))
        return None

    @property
    def supported_features(self) -> FanEntityFeature:
        """Expose only fan controls backed by pushed state or detail metadata."""
        features = FanEntityFeature(0)
        if self.percentage is not None:
            features |= FanEntityFeature.SET_SPEED
        if self.preset_modes:
            features |= FanEntityFeature.PRESET_MODE
        return features

    @property
    def is_on(self) -> bool | None:
        """Return whether the fan-like device is on."""
        switch = _state(self.bridge_device, "switch")
        if isinstance(switch, str):
            return switch.lower() == "on"
        mode = self.preset_mode
        return None if mode is None else mode.lower() != "off"

    @property
    def preset_modes(self) -> list[str] | None:
        """Return supported purifier/fan modes."""
        device = self.bridge_device
        if device is None:
            return None
        for attribute in ("supportedAirPurifierModes", "supportedFanModes"):
            modes = option_values(_state(device, attribute))
            if modes:
                return modes
        device = self.bridge_device
        for control in device.controls.values():
            if control.kind == "enumerated" and control.attribute in {
                "airPurifierMode",
                "fanMode",
            } and control.options:
                return list(control.options)
        return None

    @property
    def preset_mode(self) -> str | None:
        """Return current purifier/fan mode."""
        device = self.bridge_device
        if device is None:
            return None
        for attribute in ("airPurifierMode", "fanMode"):
            value = _state(device, attribute)
            if isinstance(value, str):
                return value
        return None

    async def async_set_percentage(self, percentage: int) -> None:
        """Set fan speed without optimistic state mutation."""
        attribute = "fanSpeed" if _state(self.bridge_device, "fanSpeed") is not None else "level"
        await self._async_command("setNumber", [percentage], attribute=attribute)

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        """Set purifier/fan mode without optimistic state mutation."""
        attribute = "airPurifierMode" if _state(self.bridge_device, "airPurifierMode") is not None else "fanMode"
        await self._async_command("setFanMode", [preset_mode], attribute=attribute)

    async def async_turn_on(self, percentage: int | None = None, **kwargs: object) -> None:
        """Turn on the fan-like device."""
        await self._async_command("on", [])
        if percentage is not None:
            await self.async_set_percentage(percentage)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Turn off the fan-like device."""
        await self._async_command("off", [])

    async def _async_command(
        self, command: str, arguments: list[object], attribute: str | None = None
    ) -> None:
        target_attribute = attribute or _attribute_for_command(command)
        state = _state_obj(self.bridge_device, target_attribute)
        control = _control_for(self.bridge_device, target_attribute)
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component if control else state.component if state else None,
                capability=control.capability if control else state.capability if state else None,
                attribute=control.attribute if control else state.attribute if state else None,
                control_id=control.control_id if control else None,
                control_label=control.label if control else None,
                command=command,
                arguments=arguments,
            )
        except BridgeClientError as err:
            raise HomeAssistantError("SmartThings Web did not confirm fan state") from err


def _state(device: BridgeDevice | None, attribute: str) -> object | None:
    if device is None:
        return None
    for state in device.states.values():
        if state.attribute == attribute:
            return state.value
    return None


def _state_obj(device: BridgeDevice | None, attribute: str):
    if device is None:
        return None
    for state in device.states.values():
        if state.attribute == attribute:
            return state
    return None


def _control_for(device: BridgeDevice | None, command: str) -> BridgeControl | None:
    if device is None:
        return None
    command_lower = command.lower()
    for control in device.controls.values():
        if control.kind == "value":
            continue
        values = [control.control_id, control.label or "", control.attribute or "", *control.commands]
        if any(command_lower in value.lower() for value in values):
            return control
    return None


def _attribute_for_command(command: str) -> str:
    return "switch" if command in {"on", "off"} else command
