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
    ("contactSensor", "contact"): BinaryDescription("Contact", "open", BinarySensorDeviceClass.DOOR),
    ("motionSensor", "motion"): BinaryDescription("Motion", "active", BinarySensorDeviceClass.MOTION),
    ("waterSensor", "water"): BinaryDescription("Moisture", "wet", BinarySensorDeviceClass.MOISTURE),
    ("presenceSensor", "presence"): BinaryDescription("Presence", "present", BinarySensorDeviceClass.PRESENCE),
    ("soundSensor", "sound"): BinaryDescription("Sound", "detected", BinarySensorDeviceClass.SOUND),
    ("tamperAlert", "tamper"): BinaryDescription("Tamper", "detected", BinarySensorDeviceClass.TAMPER),
    ("gasDetector", "gas"): BinaryDescription("Gas", "detected", BinarySensorDeviceClass.GAS),
    ("smokeDetector", "smoke"): BinaryDescription("Smoke", "detected", BinarySensorDeviceClass.SMOKE),
    ("carbonMonoxideDetector", "carbonMonoxide"): BinaryDescription(
        "Carbon monoxide", "detected", BinarySensorDeviceClass.CO
    ),
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
        if (description := BINARY_STATES.get((state.capability, state.attribute))) is not None
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

