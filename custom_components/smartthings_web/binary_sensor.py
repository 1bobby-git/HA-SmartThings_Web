"""Read-only binary sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity
from .models import (
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    disambiguated_state_names,
)


@dataclass(frozen=True)
class BinaryDescription:
    name: str
    translation_key: str
    on_value: str
    device_class: BinarySensorDeviceClass | None
    entity_category: EntityCategory | None = None


BINARY_STATES = {
    "acceleration": BinaryDescription(
        "Acceleration", "acceleration", "active", BinarySensorDeviceClass.MOVING
    ),
    "contact": BinaryDescription(
        "Contact", "contact", "open", BinarySensorDeviceClass.OPENING
    ),
    "doorState": BinaryDescription(
        "Door", "door", "open", BinarySensorDeviceClass.OPENING
    ),
    "filterStatus": BinaryDescription(
        "Filter status", "filter_status", "replace", BinarySensorDeviceClass.PROBLEM
    ),
    "motion": BinaryDescription(
        "Motion", "motion", "active", BinarySensorDeviceClass.MOTION
    ),
    "water": BinaryDescription(
        "Moisture", "moisture", "wet", BinarySensorDeviceClass.MOISTURE
    ),
    "presence": BinaryDescription(
        "Presence", "presence", "present", BinarySensorDeviceClass.PRESENCE
    ),
    "sound": BinaryDescription(
        "Sound", "sound", "detected", BinarySensorDeviceClass.SOUND
    ),
    "tamper": BinaryDescription(
        "Tamper",
        "tamper",
        "detected",
        BinarySensorDeviceClass.TAMPER,
        EntityCategory.DIAGNOSTIC,
    ),
    "gas": BinaryDescription(
        "Gas", "gas", "detected", BinarySensorDeviceClass.GAS
    ),
    "smoke": BinaryDescription(
        "Smoke", "smoke", "detected", BinarySensorDeviceClass.SMOKE
    ),
    "carbonMonoxide": BinaryDescription(
        "Carbon monoxide",
        "carbon_monoxide",
        "detected",
        BinarySensorDeviceClass.CO,
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
            candidates = [
                (state, description)
                for state in device.states.values()
                if (description := BINARY_STATES.get(state.attribute)) is not None
            ]
            name_overrides = disambiguated_state_names(
                (state, description.name) for state, description in candidates
            )
            for state, description in candidates:
                unique_id = "_".join((device.device_id, *state.key))
                if unique_id not in known:
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebBinarySensor(
                            runtime,
                            device,
                            state,
                            description,
                            name_override=name_overrides.get(state.key),
                        )
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
        name_override: str | None = None,
    ) -> None:
        super().__init__(runtime, device, state, name_override)
        self.description = description
        self._attr_translation_key = (
            None if name_override is not None else description.translation_key
        )
        self._attr_entity_category = description.entity_category
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
