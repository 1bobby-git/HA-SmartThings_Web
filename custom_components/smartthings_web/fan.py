"""Fan and air-purifier controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.fan import FanEntity, FanEntityFeature
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
    is_fan_device,
    primary_state_attributes,
    safe_observed_control,
    token_values,
)


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
        for attribute in ("fanSpeed", "percent", "level"):
            state = _state(device, attribute)
            if isinstance(state, (int, float)) and not isinstance(state, bool):
                return max(0, min(100, int(state)))
        return None

    @property
    def supported_features(self) -> FanEntityFeature:
        """Expose only fan controls backed by pushed state or detail metadata."""
        features = FanEntityFeature(0)
        device = self.bridge_device
        mode_control = _mode_control(device)
        modes = list(mode_control.options) if mode_control is not None else []
        mode_power = any(mode.lower() == "off" for mode in modes) and any(
            mode.lower() != "off" for mode in modes
        )
        if device is not None and (_has_switch_power(device) or mode_power):
            features |= FanEntityFeature.TURN_ON | FanEntityFeature.TURN_OFF
        if _speed_control(device) is not None:
            features |= FanEntityFeature.SET_SPEED
        if mode_control is not None:
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
        control = _mode_control(device)
        if control is not None:
            return list(control.options)
        for attribute in (
            "supportedAirPurifierModes",
            "supportedAcFanModes",
            "supportedFanModes",
        ):
            modes = token_values(_state(device, attribute))
            if modes:
                return modes
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

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Keep pushed fan and purifier metadata on the primary fan entity."""
        device = self.bridge_device
        if device is None:
            return {}
        attributes = {
            "airPurifierMode",
            "fanMode",
            "fanSpeed",
            "level",
            "percent",
            "switch",
            "supportedAcFanModes",
            "supportedAirPurifierModes",
            "supportedFanModes",
        }
        return primary_state_attributes(device, attributes)

    async def async_set_percentage(self, percentage: int) -> None:
        """Set fan speed without optimistic state mutation."""
        control = _speed_control(self.bridge_device)
        if control is None or control.attribute is None:
            raise HomeAssistantError("SmartThings Web fan has no observed speed control")
        await self._async_command(
            "setNumber", [percentage], attribute=control.attribute
        )

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        """Set purifier/fan mode without optimistic state mutation."""
        control = _mode_control(self.bridge_device)
        if control is None or control.attribute is None:
            raise HomeAssistantError("SmartThings Web fan has no observed mode control")
        await self._async_command(
            "setFanMode", [preset_mode], attribute=control.attribute
        )

    async def async_turn_on(
        self,
        percentage: int | None = None,
        preset_mode: str | None = None,
        **kwargs: object,
    ) -> None:
        """Turn on the fan-like device."""
        switch_power = _has_switch_power(self.bridge_device)
        if switch_power:
            await self._async_command("on", [])
        else:
            mode = preset_mode or _turn_on_mode(self.preset_mode, self.preset_modes)
            control = _mode_control(self.bridge_device)
            if mode is None or control is None or control.attribute is None:
                raise HomeAssistantError("SmartThings Web fan has no observed on control")
            await self._async_command(
                "setFanMode", [mode], attribute=control.attribute
            )
        if percentage is not None:
            await self.async_set_percentage(percentage)
        if preset_mode is not None and switch_power:
            await self.async_set_preset_mode(preset_mode)

    async def async_turn_off(self, **kwargs: object) -> None:
        """Turn off the fan-like device."""
        if _has_switch_power(self.bridge_device):
            await self._async_command("off", [])
        elif any(mode.lower() == "off" for mode in self.preset_modes or []):
            control = _mode_control(self.bridge_device)
            if control is None or control.attribute is None:
                raise HomeAssistantError("SmartThings Web fan has no observed off control")
            await self._async_command(
                "setFanMode", ["off"], attribute=control.attribute
            )
        else:
            raise HomeAssistantError("SmartThings Web fan has no observed off control")

    async def _async_command(
        self, command: str, arguments: list[object], attribute: str | None = None
    ) -> None:
        target_attribute = attribute or _attribute_for_command(command)
        state = _state_obj(self.bridge_device, target_attribute)
        control = _control_for(
            self.bridge_device,
            target_attribute,
            state.component if state is not None else None,
        )
        if control is None:
            raise HomeAssistantError(
                f"SmartThings Web fan has no observed {target_attribute} control"
            )
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
            raise HomeAssistantError(bridge_error_message("fan command", err)) from err


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


def _control_for(
    device: BridgeDevice | None, command: str, component: str | None = None
) -> BridgeControl | None:
    if device is None:
        return None
    exact = [
        control
        for control in device.controls.values()
        if control.kind != "value"
        and safe_observed_control(control)
        and control.attribute == command
        and (component is None or control.component == component)
    ]
    return exact[0] if len(exact) == 1 else None


def _attribute_for_command(command: str) -> str:
    return "switch" if command in {"on", "off"} else command


def _has_switch_power(device: BridgeDevice | None) -> bool:
    if device is None:
        return False
    return any(
        control.kind == "toggle"
        and control.attribute == "switch"
        and safe_observed_control(control)
        for control in device.controls.values()
    )


def _speed_control(device: BridgeDevice | None) -> BridgeControl | None:
    if device is None:
        return None
    controls = [
        control
        for control in device.controls.values()
        if control.kind == "slider"
        and control.attribute in {"fanSpeed", "percent", "level"}
        and safe_observed_control(control)
    ]
    return controls[0] if len(controls) == 1 else None


def _mode_control(device: BridgeDevice | None) -> BridgeControl | None:
    if device is None:
        return None
    controls = [
        control
        for control in device.controls.values()
        if control.kind == "enumerated"
        and control.attribute in {"airPurifierMode", "fanMode"}
        and bool(control.options)
        and safe_observed_control(control)
    ]
    return controls[0] if len(controls) == 1 else None


def _turn_on_mode(current: str | None, supported: list[str] | None) -> str | None:
    if current and current.lower() != "off":
        return current
    modes = [mode for mode in supported or [] if mode.lower() != "off"]
    return next((mode for mode in modes if mode.lower() == "auto"), modes[0] if modes else None)
