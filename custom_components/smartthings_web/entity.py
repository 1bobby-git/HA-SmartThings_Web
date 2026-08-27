"""Base entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.helpers import entity_registry as er
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


_LAUNDRY_APPLIANCE_TYPES = {"dryer", "washer"}

_DEVICE_TYPE_ICONS = {
    "air_conditioner": "mdi:air-conditioner",
    "air_purifier": "mdi:air-purifier",
    "camera": "mdi:cctv",
    "camera_security": "mdi:cctv",
    "contact_sensor": "mdi:door",
    "dishwasher": "mdi:dishwasher",
    "dryer": "mdi:tumble-dryer",
    "fan": "mdi:fan",
    "hub": "mdi:hub",
    "light": "mdi:lightbulb",
    "motion_sensor": "mdi:motion-sensor",
    "refrigerator": "mdi:fridge",
    "speaker": "mdi:speaker",
    "switch": "mdi:toggle-switch",
    "temp_humidity_sensor": "mdi:thermometer-water",
    "washer": "mdi:washing-machine",
}


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


def _device_icon_for(device: BridgeDevice) -> str | None:
    """Return a safe fallback icon when SmartThings has no static picture."""
    candidates = []
    if device.presentation is not None:
        candidates.append(device.presentation.asset_type)
    candidates.append(device.device_type)
    for candidate in candidates:
        normalized = _normalized_device_type(candidate)
        icon = _DEVICE_TYPE_ICONS.get(normalized)
        if icon is not None:
            return icon
    return None


def _normalized_device_type(value: str | None) -> str:
    return (value or "").strip().lower().replace("-", "_")


def migrate_entity_original_name(
    hass: object,
    domain: str,
    unique_id: str,
    original_name: str | None,
) -> None:
    """Refine an existing generated name while preserving user overrides."""
    if original_name is None:
        return
    registry = er.async_get(hass)
    entity_id = registry.async_get_entity_id(domain, DOMAIN, unique_id)
    if entity_id is None:
        return
    entry = registry.async_get(entity_id)
    if entry is None or entry.original_name == original_name:
        return
    registry.async_update_entity(entity_id, original_name=original_name)


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
        if name is not None:
            self._attr_name = name
        self._attr_unique_id = entity_unique_id(device.device_id, state)
        self._attr_device_info = device_info_for(device)

    @property
    def available(self) -> bool:
        """Return device availability."""
        device = self.runtime.inventory.devices.get(self.device_id)
        if device is None:
            return False
        if device.online:
            return True
        return (
            device.states.get(self.state_key) is not None
            and _offline_laundry_state_is_readable(device)
        )

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
        if name is not None:
            self._attr_name = name
        self._attr_unique_id = f"{device.device_id}_{suffix}"
        self._attr_device_info = device_info_for(device)
        entity_picture = _entity_picture_for(device)
        if entity_picture is not None:
            self._attr_entity_picture = entity_picture
        else:
            icon = _device_icon_for(device)
            if icon is not None:
                self._attr_icon = icon

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


def _offline_laundry_state_is_readable(device: BridgeDevice) -> bool:
    """Keep pushed laundry values visible while the appliance is powered down."""
    if (device.device_type or "").strip().lower() not in _LAUNDRY_APPLIANCE_TYPES:
        return False
    for state in device.states.values():
        value = str(state.value).strip().lower()
        if state.attribute == "switch" and value == "off":
            return True
        if state.attribute == "machineState" and value in {"none", "stop"}:
            return True
        if state.attribute == "operatingState" and value == "ready":
            return True
    return False
