"""Climate entities for SmartThings Web."""

from __future__ import annotations

from typing import Any

from homeassistant.components.climate import ClimateEntity, ClimateEntityFeature, HVACMode
from homeassistant.const import UnitOfTemperature
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
    climate_controls,
    is_climate_device,
    primary_state_attributes,
)


MODE_TO_HVAC = {
    "auto": HVACMode.AUTO,
    "cool": HVACMode.COOL,
    "dry": HVACMode.DRY,
    "eco": HVACMode.AUTO,
    "fan": HVACMode.FAN_ONLY,
    "fan_only": HVACMode.FAN_ONLY,
    "fanonly": HVACMode.FAN_ONLY,
    "heat": HVACMode.HEAT,
    "off": HVACMode.OFF,
}

TEMPERATURE_ATTRIBUTES = {
    "coolingSetpoint",
    "heatingSetpoint",
    "targetTemperature",
}

CLIMATE_EXTRA_ATTRIBUTES = {
    "coolingSetpoint",
    "heatingSetpoint",
    "supportedThermostatModes",
    "targetTemperature",
    "thermostatMode",
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create climate entities and discover new ones from inventory pushes."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not is_climate_device(device):
                continue
            unique_id = f"{device.device_id}_climate"
            if unique_id in known:
                continue
            known.add(unique_id)
            entities.append(SmartThingsWebClimate(runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebClimate(SmartThingsWebDeviceEntity, ClimateEntity):
    """One thermostat-like SmartThings device."""

    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_target_temperature_step = 0.5

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice) -> None:
        super().__init__(runtime, device, "climate", None)

    @property
    def supported_features(self) -> ClimateEntityFeature:
        """Expose only climate actions backed by observed controls."""
        controls = climate_controls(self.bridge_device) if self.bridge_device else []
        features = ClimateEntityFeature(0)
        if _temperature_control(controls, self.hvac_mode) is not None:
            features |= ClimateEntityFeature.TARGET_TEMPERATURE
        return features

    @property
    def hvac_modes(self) -> list[HVACMode]:
        """Return supported thermostat modes."""
        modes = _mode_options(self.bridge_device)
        values = [MODE_TO_HVAC[mode] for mode in modes if mode in MODE_TO_HVAC]
        return values or [HVACMode.OFF]

    @property
    def hvac_mode(self) -> HVACMode | None:
        """Return current thermostat mode."""
        value = _state_value(self.bridge_device, "thermostatMode")
        return MODE_TO_HVAC.get(_normalize_mode(value)) if value is not None else None

    @property
    def current_temperature(self) -> float | None:
        """Return current temperature."""
        return _numeric_state(self.bridge_device, "temperature")

    @property
    def target_temperature(self) -> float | None:
        """Return pushed target/setpoint temperature."""
        for attribute in ("targetTemperature", "coolingSetpoint", "heatingSetpoint"):
            value = _numeric_state(self.bridge_device, attribute)
            if value is not None:
                return value
        return None

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Keep pushed thermostat metadata on the primary climate entity."""
        device = self.bridge_device
        if device is None:
            return {}
        return primary_state_attributes(device, CLIMATE_EXTRA_ATTRIBUTES)

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        """Set thermostat mode without optimistic state mutation."""
        controls = climate_controls(self.bridge_device) if self.bridge_device else []
        control = _mode_control(controls)
        if control is None:
            raise HomeAssistantError("SmartThings Web climate mode control is unavailable")
        bridge_mode = _bridge_mode_for_hvac(control, hvac_mode)
        if bridge_mode is None:
            raise HomeAssistantError("SmartThings Web climate mode is unavailable")
        await self._execute(control, "setOption", [bridge_mode])

    async def async_set_temperature(self, **kwargs: Any) -> None:
        """Set target temperature without optimistic state mutation."""
        temperature = kwargs.get("temperature")
        if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
            raise HomeAssistantError("SmartThings Web climate temperature is invalid")
        controls = climate_controls(self.bridge_device) if self.bridge_device else []
        control = _temperature_control(controls, self.hvac_mode)
        if control is None:
            raise HomeAssistantError("SmartThings Web climate temperature control is unavailable")
        await self._execute(control, "setNumber", [float(temperature)])

    async def _execute(
        self, control: BridgeControl, fallback_command: str, arguments: list[object]
    ) -> None:
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component,
                capability=control.capability,
                attribute=control.attribute,
                control_id=control.control_id,
                control_label=control.label,
                command=fallback_command,
                arguments=arguments,
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("climate command", err)) from err


def _mode_options(device: BridgeDevice | None) -> list[str]:
    if device is None:
        return []
    for control in climate_controls(device):
        if control.attribute == "thermostatMode" and control.options:
            return [_normalize_mode(value) for value in control.options]
    return []


def _mode_control(controls: list[BridgeControl]) -> BridgeControl | None:
    matches = [
        control
        for control in controls
        if control.kind == "enumerated" and control.attribute == "thermostatMode"
    ]
    return matches[0] if len(matches) == 1 else None


def _bridge_mode_for_hvac(control: BridgeControl, hvac_mode: HVACMode) -> str | None:
    """Return the exact observed SmartThings option for one HA HVAC mode."""
    return next(
        (
            option
            for option in control.options
            if MODE_TO_HVAC.get(_normalize_mode(option)) == hvac_mode
        ),
        None,
    )


def _temperature_control(
    controls: list[BridgeControl], hvac_mode: HVACMode | None = None
) -> BridgeControl | None:
    candidates = [
        control
        for control in controls
        if control.kind == "slider" and control.attribute in TEMPERATURE_ATTRIBUTES
    ]
    target = [
        control for control in candidates if control.attribute == "targetTemperature"
    ]
    if len(target) == 1:
        return target[0]
    if len(target) > 1:
        return None
    mode_attribute = {
        HVACMode.COOL: "coolingSetpoint",
        HVACMode.HEAT: "heatingSetpoint",
    }.get(hvac_mode)
    if mode_attribute is not None:
        matches = [
            control for control in candidates if control.attribute == mode_attribute
        ]
        return matches[0] if len(matches) == 1 else None
    return candidates[0] if len(candidates) == 1 else None


def _state_value(device: BridgeDevice | None, attribute: str) -> object | None:
    if device is None:
        return None
    for state in device.states.values():
        if state.attribute == attribute:
            return state.value
    return None


def _numeric_state(device: BridgeDevice | None, attribute: str) -> float | None:
    value = _state_value(device, attribute)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _normalize_mode(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value.lower().replace(" ", "_").replace("-", "_")
