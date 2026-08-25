"""Cover entities for SmartThings Web."""

from __future__ import annotations

from typing import Any

from homeassistant.components.cover import CoverEntity, CoverEntityFeature
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
    control_supports_command,
    cover_controls,
    is_cover_device,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create cover entities and discover new ones from inventory pushes."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not is_cover_device(device):
                continue
            unique_id = f"{device.device_id}_cover"
            if unique_id in known:
                continue
            known.add(unique_id)
            entities.append(SmartThingsWebCover(runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebCover(SmartThingsWebDeviceEntity, CoverEntity):
    """One SmartThings shade/cover."""

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice) -> None:
        super().__init__(runtime, device, "cover", None)

    @property
    def supported_features(self) -> CoverEntityFeature:
        """Expose only cover actions backed by observed controls."""
        controls = cover_controls(self.bridge_device) if self.bridge_device else []
        features = CoverEntityFeature(0)
        if _find_control(controls, "open", "openShade"):
            features |= CoverEntityFeature.OPEN
        if _find_control(controls, "close", "closeShade"):
            features |= CoverEntityFeature.CLOSE
        if _find_control(controls, "stop", "pause"):
            features |= CoverEntityFeature.STOP
        if _position_control(controls):
            features |= CoverEntityFeature.SET_POSITION
        return features

    @property
    def is_closed(self) -> bool | None:
        """Return whether the shade is closed."""
        value = _state_value(self.bridge_device, "windowShade")
        if value is None:
            return None
        return str(value).lower() in {"closed", "close"}

    @property
    def current_cover_position(self) -> int | None:
        """Return shade position when SmartThings reports one."""
        value = _state_value(self.bridge_device, "shadeLevel")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        return max(0, min(100, int(round(float(value)))))

    async def async_open_cover(self, **kwargs: Any) -> None:
        """Open the cover without optimistic state mutation."""
        await self._async_command("open", "openShade")

    async def async_close_cover(self, **kwargs: Any) -> None:
        """Close the cover without optimistic state mutation."""
        await self._async_command("close", "closeShade")

    async def async_stop_cover(self, **kwargs: Any) -> None:
        """Stop/pause the cover without optimistic state mutation."""
        await self._async_command("stop", "pause")

    async def async_set_cover_position(self, **kwargs: Any) -> None:
        """Set cover position without optimistic state mutation."""
        position = kwargs.get("position")
        if isinstance(position, bool) or not isinstance(position, (int, float)):
            raise HomeAssistantError("SmartThings Web cover position is invalid")
        controls = cover_controls(self.bridge_device) if self.bridge_device else []
        control = _position_control(controls)
        if control is None:
            raise HomeAssistantError("SmartThings Web cover has no position control")
        await self._execute(control, "setPosition", [int(position)])

    async def _async_command(self, *commands: str) -> None:
        controls = cover_controls(self.bridge_device) if self.bridge_device else []
        control = _find_control(controls, *commands)
        if control is None:
            raise HomeAssistantError("SmartThings Web cover command is unavailable")
        await self._execute(control, commands[0], [])

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
            raise HomeAssistantError(bridge_error_message("cover command", err)) from err


def _find_control(controls: list[BridgeControl], *commands: str) -> BridgeControl | None:
    return next(
        (
            control
            for control in controls
            if any(control_supports_command(control, command) for command in commands)
        ),
        None,
    )


def _position_control(controls: list[BridgeControl]) -> BridgeControl | None:
    return next(
        (
            control
            for control in controls
            if control.kind == "slider" and control.attribute == "shadeLevel"
        ),
        None,
    )


def _state_value(device: BridgeDevice | None, attribute: str) -> object | None:
    if device is None:
        return None
    for state in device.states.values():
        if state.attribute == attribute:
            return state.value
    return None
