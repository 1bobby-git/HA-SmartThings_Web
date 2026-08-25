"""Fail-closed light controls for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.light import ColorMode, LightEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebEntity
from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime, control_kind


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
                if control_kind(device, state) == "light" and unique_id not in known:
                    known.add(unique_id)
                    entities.append(SmartThingsWebLight(runtime, device, state))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebLight(SmartThingsWebEntity, LightEntity):
    """One light whose commands are confirmed by a newer push event."""

    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(
        self, runtime: SmartThingsWebRuntime, device: BridgeDevice, state: BridgeState
    ) -> None:
        super().__init__(runtime, device, state, None)

    @property
    def is_on(self) -> bool | None:
        """Return the last pushed switch state."""
        state = self.bridge_state
        if state is None:
            return None
        return str(state.value).lower() == "on"

    async def async_turn_on(self, **kwargs: object) -> None:
        """Request ON without optimistic state mutation."""
        await self._async_command("on")

    async def async_turn_off(self, **kwargs: object) -> None:
        """Request OFF without optimistic state mutation."""
        await self._async_command("off")

    async def _async_command(self, command: str) -> None:
        try:
            await self.runtime.client.async_execute_switch(
                self.device_id, self.state_key[0], self.state_key[1], command
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("light command", err)) from err
