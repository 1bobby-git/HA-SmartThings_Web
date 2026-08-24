"""Base entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime


class SmartThingsWebEntity(Entity):
    """Base read-only SmartThings Web entity."""

    _attr_has_entity_name = True

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        name: str,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id
        self.state_key = state.key
        self._attr_name = name
        self._attr_unique_id = "_".join((device.device_id, *state.key, state.attribute))
        self._attr_device_info = DeviceInfo(
            identifiers={("smartthings_web", device.device_id)},
            name=device.name,
            manufacturer="SmartThings Web",
            model=device.device_type,
        )

    @property
    def available(self) -> bool:
        """Return device availability."""
        device = self.runtime.inventory.devices.get(self.device_id)
        return device is not None and device.online

    @property
    def bridge_state(self) -> BridgeState | None:
        """Return the current state."""
        device = self.runtime.inventory.devices.get(self.device_id)
        return device.states.get(self.state_key) if device else None

    async def async_added_to_hass(self) -> None:
        """Subscribe to Bridge pushes."""
        self.async_on_remove(self.runtime.subscribe(self.async_write_ha_state))

