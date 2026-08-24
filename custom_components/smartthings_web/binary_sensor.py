"""Read-only binary sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity
from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime


@dataclass(frozen=True)
class BinaryDescription:
    name: str
    on_value: str
    device_class: BinarySensorDeviceClass | None


BINARY_STATES = {
    "contact": BinaryDescription("Contact", "open", BinarySensorDeviceClass.DOOR),
    "motion": BinaryDescription("Motion", "active", BinarySensorDeviceClass.MOTION),
    "water": BinaryDescription("Moisture", "wet", BinarySensorDeviceClass.MOISTURE),
    "presence": BinaryDescription("Presence", "present", BinarySensorDeviceClass.PRESENCE),
    "sound": BinaryDescription("Sound", "detected", BinarySensorDeviceClass.SOUND),
    "tamper": BinaryDescription("Tamper", "detected", BinarySensorDeviceClass.TAMPER),
    "gas": BinaryDescription("Gas", "detected", BinarySensorDeviceClass.GAS),
    "smoke": BinaryDescription("Smoke", "detected", BinarySensorDeviceClass.SMOKE),
    "carbonMonoxide": BinaryDescription(
        "Carbon monoxide", "detected", BinarySensorDeviceClass.CO
    ),
    "switch": BinaryDescription("Switch", "on", None),
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create supported binary sensors."""
    runtime = entry.runtime_data
    async_add_entities(
        SmartThingsWebBinarySensor(runtime, device, state, description)
        for device in runtime.inventory.devices.values()
        if device.location_id == runtime.location_id
        for state in device.states.values()
        if (description := BINARY_STATES.get(state.attribute)) is not None
    )


class SmartThingsWebBinarySensor(SmartThingsWebEntity, BinarySensorEntity):
    """One pushed SmartThings binary state."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        description: BinaryDescription,
    ) -> None:
        super().__init__(runtime, device, state, description.name)
        self.description = description
        self._attr_device_class = description.device_class

    @property
    def is_on(self) -> bool | None:
        """Return the current binary value."""
        state = self.bridge_state
        if state is None:
            return None
        return str(state.value).lower() == self.description.on_value.lower()
