"""Base entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime, entity_unique_id


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
        self._attr_device_info = DeviceInfo(
            identifiers={("smartthings_web", device.device_id)},
            name=device.name,
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
