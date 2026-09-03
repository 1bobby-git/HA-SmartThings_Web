"""Push-driven SmartThings button events."""

from __future__ import annotations

from homeassistant.components.event import EventDeviceClass, EventEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity
from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime, token_values


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create official-style button event entities from pushed button state."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for state in device.states.values():
                unique_id = "_".join((device.device_id, *state.key))
                if state.attribute != "button" or unique_id in known:
                    continue
                known.add(unique_id)
                entities.append(SmartThingsWebButtonEvent(runtime, device, state))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebButtonEvent(SmartThingsWebEntity, EventEntity):
    """Emit every distinct pushed button event, including repeated presses."""

    _attr_device_class = EventDeviceClass.BUTTON
    _attr_translation_key = "button"

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
    ) -> None:
        super().__init__(runtime, device, state, None)
        self._last_event_signature = (
            runtime.inventory.sequence,
            state.updated_at,
            state.value,
        )

    @property
    def event_types(self) -> list[str]:
        """Return the observed SmartThings supported button values."""
        device = self.runtime.inventory.devices.get(self.device_id)
        supported: list[str] = []
        if device is not None:
            for state in device.states.values():
                if state.component == self.state_key[0] and state.attribute == "supportedButtonValues":
                    supported.extend(token_values(state.value))
        current = self.bridge_state
        if current is not None and isinstance(current.value, str):
            supported.append(current.value)
        return list(dict.fromkeys(supported or ["pushed", "held", "double"]))

    async def async_added_to_hass(self) -> None:
        """Trigger only when a newer pushed button occurrence is applied."""

        def handle_update() -> None:
            state = self.bridge_state
            if state is None:
                return
            signature = (
                self.runtime.inventory.sequence,
                state.updated_at,
                state.value,
            )
            if signature == self._last_event_signature:
                return
            self._last_event_signature = signature
            if isinstance(state.value, str) and state.value in self.event_types:
                self._trigger_event(state.value)
            self.async_write_ha_state()

        self.async_on_remove(
            self.runtime.subscribe_state(self.device_id, self.state_key, handle_update)
        )
