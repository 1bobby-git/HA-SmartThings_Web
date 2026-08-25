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
    "acceleration": BinaryDescription(
        "Acceleration", "active", BinarySensorDeviceClass.MOVING
    ),
    "contact": BinaryDescription("Contact", "open", BinarySensorDeviceClass.OPENING),
    "doorState": BinaryDescription("Door", "open", BinarySensorDeviceClass.OPENING),
    "filterStatus": BinaryDescription(
        "Filter status", "replace", BinarySensorDeviceClass.PROBLEM
    ),
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
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create supported binary sensors."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            for state in device.states.values():
                description = BINARY_STATES.get(state.attribute)
                unique_id = "_".join((device.device_id, *state.key))
                if description is not None and unique_id not in known:
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebBinarySensor(runtime, device, state, description)
                    )
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


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
        self._attr_device_class = _device_class(device, state, description)

    @property
    def is_on(self) -> bool | None:
        """Return the current binary value."""
        state = self.bridge_state
        if state is None:
            return None
        return str(state.value).lower() == self.description.on_value.lower()


def _device_class(
    device: BridgeDevice, state: BridgeState, description: BinaryDescription
) -> BinarySensorDeviceClass | None:
    if state.attribute != "contact":
        return description.device_class
    identity = f"{device.name} {device.device_type or ''}".lower()
    if "window" in identity or "창문" in identity or "창호" in identity:
        return BinarySensorDeviceClass.WINDOW
    if "door" in identity or "문센서" in identity or "출입문" in identity:
        return BinarySensorDeviceClass.DOOR
    return BinarySensorDeviceClass.OPENING
