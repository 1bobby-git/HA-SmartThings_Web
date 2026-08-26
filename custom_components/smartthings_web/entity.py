"""Base entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN
from .models import (
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    _safe_device_asset_url,
    device_hardware_version,
    device_manufacturer,
    device_model,
    device_software_version,
    entity_unique_id,
)


def device_info_for(device: BridgeDevice) -> DeviceInfo:
    """Return official-style registry metadata available from the web snapshot."""
    return DeviceInfo(
        identifiers={(DOMAIN, device.device_id)},
        name=device.name,
        manufacturer=device_manufacturer(device),
        model=device_model(device),
        hw_version=device_hardware_version(device),
        sw_version=device_software_version(device),
        configuration_url="https://account.smartthings.com",
    )


def _entity_picture_for(device: BridgeDevice) -> str | None:
    """Return an allowlisted SmartThings entity-picture URL for this device."""
    if device.presentation is None:
        return None
    preferred = device.presentation.icon_url if device.online else None
    fallback = (
        device.presentation.inactive_icon_url
        if device.presentation.inactive_icon_url is not None
        else device.presentation.icon_url
    )
    if device.online:
        return (
            _safe_device_asset_url(preferred, animation=False)
            or _safe_device_asset_url(fallback, animation=False)
        )
    return _safe_device_asset_url(fallback, animation=False)


class SmartThingsWebEntity(Entity):
    """Base SmartThings Web push entity."""

    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        name: str | None,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id
        self.state_key = state.key
        self._attr_name = name
        self._attr_unique_id = entity_unique_id(device.device_id, state)
        self._attr_device_info = device_info_for(device)
        self._attr_entity_picture = _entity_picture_for(device)

    @property
    def available(self) -> bool:
        """Return device availability."""
        device = self.runtime.inventory.devices.get(self.device_id)
        return device is not None and device.online

    @property
    def bridge_state(self) -> BridgeState | None:
        """Return the current state."""
        device = self.bridge_device
        return device.states.get(self.state_key) if device else None

    @property
    def bridge_device(self) -> BridgeDevice | None:
        """Return the latest immutable device snapshot backing this state entity."""
        return self.runtime.inventory.devices.get(self.device_id)

    async def async_added_to_hass(self) -> None:
        """Subscribe to Bridge pushes."""
        self.async_on_remove(
            self.runtime.subscribe_state(
                self.device_id, self.state_key, self.async_write_ha_state
            )
        )


class SmartThingsWebDeviceEntity(Entity):
    """Base entity attached to one SmartThings device."""

    _attr_should_poll = False
    _attr_has_entity_name = True

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        suffix: str,
        name: str | None,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id
        self._attr_name = name
        self._attr_unique_id = f"{device.device_id}_{suffix}"
        self._attr_device_info = device_info_for(device)
        self._attr_entity_picture = _entity_picture_for(device)

    @property
    def available(self) -> bool:
        """Return device availability."""
        device = self.runtime.inventory.devices.get(self.device_id)
        return device is not None and device.online

    @property
    def bridge_device(self) -> BridgeDevice | None:
        """Return the current device."""
        return self.runtime.inventory.devices.get(self.device_id)

    async def async_added_to_hass(self) -> None:
        """Subscribe to Bridge pushes."""
        self.async_on_remove(
            self.runtime.subscribe_device(self.device_id, self.async_write_ha_state)
        )
