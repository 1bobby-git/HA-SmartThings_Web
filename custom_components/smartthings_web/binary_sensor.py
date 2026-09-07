"""Read-only binary sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity, migrate_entity_original_name
from .models import (
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    disambiguated_state_names,
    is_readonly_appliance_switch,
    location_name,
    occupancy_source_states,
    occupancy_value,
    people_count_value,
    web_state_label,
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
    "occupancy": BinaryDescription(
        "Occupancy", "occupancy", "occupied", BinarySensorDeviceClass.OCCUPANCY
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
    "switch": BinaryDescription(
        "Power",
        "power",
        "on",
        getattr(BinarySensorDeviceClass, "POWER", None),
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
    migrated_names: dict[str, str] = {}

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            candidates = _binary_sensor_candidates(device)
            web_labels = {
                state.key: web_state_label(device, state)
                for state, _description in candidates
            }
            name_overrides = disambiguated_state_names(
                (
                    (state, web_labels[state.key] or description.name)
                    for state, description in candidates
                ),
                all_states=device.states.values(),
                main_presence_name=(
                    location_name(runtime.inventory, device.location_id)
                    if device.location_id in runtime.inventory.locations
                    else None
                ),
            )
            for state, description in candidates:
                unique_id = "_".join((device.device_id, *state.key))
                name_override = name_overrides.get(state.key) or web_labels[state.key]
                if (
                    name_override is not None
                    and migrated_names.get(unique_id) != name_override
                ):
                    migrate_entity_original_name(
                        hass,
                        "binary_sensor",
                        unique_id,
                        name_override,
                    )
                    migrated_names[unique_id] = name_override
                if unique_id not in known:
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebBinarySensor(
                            runtime,
                            device,
                            state,
                            description,
                            name_override=name_override,
                        )
                    )
            for state in occupancy_source_states(device):
                unique_id = f"{device.device_id}_{state.component}_occupancy"
                if unique_id not in known:
                    known.add(unique_id)
                    entities.append(SmartThingsWebOccupancySensor(runtime, device, state))
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
        super().__init__(
            runtime,
            device,
            state,
            name_override,
            object_id_name=(
                "presence"
                if state.attribute == "presence"
                and sum(
                    candidate.attribute == "presence"
                    for candidate in device.states.values()
                )
                == 1
                else None
            ),
        )
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
        if state.attribute == "occupancy":
            return occupancy_value(state.value)
        return str(state.value).lower() == self.description.on_value.lower()


class SmartThingsWebOccupancySensor(SmartThingsWebEntity, BinarySensorEntity):
    """Read-only occupancy from an explicit state, falling back to current people count."""

    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _attr_translation_key = "occupancy"

    def __init__(
        self, runtime: SmartThingsWebRuntime, device: BridgeDevice, state: BridgeState,
    ) -> None:
        super().__init__(runtime, device, state, None, object_id_name="occupancy")
        self.component = state.component
        # Stable across late capability discovery and direct/count source changes.
        self._attr_unique_id = f"{device.device_id}_{state.component}_occupancy"

    @property
    def bridge_state(self) -> BridgeState | None:
        device = self.bridge_device
        if device is None or device.location_id != self.runtime.location_id:
            return None
        return next((state for state in occupancy_source_states(device)
                     if state.component == self.component), None)

    @property
    def available(self) -> bool:
        return super().available and self.bridge_state is not None

    @property
    def is_on(self) -> bool | None:
        state = self.bridge_state
        if state is None:
            return None
        if state.attribute == "occupancy":
            return occupancy_value(state.value)
        count = people_count_value(state)
        return count > 0 if count is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        state = self.bridge_state
        return {
            "smartthings_occupancy_source": state.attribute if state else None,
            "smartthings_derived": state.attribute == "peopleCounter" if state else None,
            "smartthings_people_count": people_count_value(state),
            "smartthings_updated_at": state.updated_at if state else None,
        }

    async def async_added_to_hass(self) -> None:
        """Observe this device only; topology changes can change source/availability."""
        self.async_on_remove(self.runtime.subscribe_device(self.device_id, self.async_write_ha_state))


def _binary_sensor_candidates(
    device: BridgeDevice,
) -> list[tuple[BridgeState, BinaryDescription]]:
    """Return pushed binary states, including read-only appliance power."""
    candidates: list[tuple[BridgeState, BinaryDescription]] = []
    for state in device.states.values():
        description = BINARY_STATES.get(state.attribute)
        if state.attribute == "switch" and not is_readonly_appliance_switch(device):
            description = None
        if description is not None and state.attribute != "occupancy":
            candidates.append((state, description))
    return candidates


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
