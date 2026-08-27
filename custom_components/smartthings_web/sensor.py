"""Read-only sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import (
    EntityCategory,
    LIGHT_LUX,
    PERCENTAGE,
    UnitOfElectricCurrent,
    UnitOfElectricPotential,
    UnitOfEnergy,
    UnitOfPower,
    UnitOfTemperature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity
from .models import (
    BridgeDevice,
    BridgeState,
    SmartThingsWebRuntime,
    disambiguated_state_names,
    firmware_states,
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
    sensor_state_owned_by_primary_domain,
)


@dataclass(frozen=True)
class SensorDescription:
    name: str
    translation_key: str | None = None
    device_class: SensorDeviceClass | None = None
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    default_unit: str | None = None
    entity_category: EntityCategory | None = None
    enabled_default: bool = True


SENSOR_STATES = {
    "temperature": SensorDescription(
        "Temperature",
        "temperature",
        SensorDeviceClass.TEMPERATURE,
        default_unit=UnitOfTemperature.CELSIUS,
    ),
    "humidity": SensorDescription(
        "Humidity", "humidity", SensorDeviceClass.HUMIDITY, default_unit=PERCENTAGE
    ),
    "battery": SensorDescription(
        "Battery",
        "battery",
        SensorDeviceClass.BATTERY,
        default_unit=PERCENTAGE,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "power": SensorDescription(
        "Power", "power", SensorDeviceClass.POWER, default_unit=UnitOfPower.WATT
    ),
    "energy": SensorDescription(
        "Energy",
        "energy",
        SensorDeviceClass.ENERGY,
        SensorStateClass.TOTAL_INCREASING,
        UnitOfEnergy.KILO_WATT_HOUR,
    ),
    "voltage": SensorDescription(
        "Voltage",
        "voltage",
        SensorDeviceClass.VOLTAGE,
        default_unit=UnitOfElectricPotential.VOLT,
    ),
    "current": SensorDescription(
        "Current",
        "current",
        SensorDeviceClass.CURRENT,
        default_unit=UnitOfElectricCurrent.AMPERE,
    ),
    "illuminance": SensorDescription(
        "Illuminance",
        "illuminance",
        SensorDeviceClass.ILLUMINANCE,
        default_unit=LIGHT_LUX,
    ),
    "carbonDioxide": SensorDescription(
        "Carbon dioxide", "carbon_dioxide", SensorDeviceClass.CO2, default_unit="ppm"
    ),
    "fineDustLevel": SensorDescription(
        "PM2.5", "fine_dust", SensorDeviceClass.PM25, default_unit="µg/m³"
    ),
    "veryFineDustLevel": SensorDescription(
        "PM1", "very_fine_dust", SensorDeviceClass.PM1, default_unit="µg/m³"
    ),
    "dustLevel": SensorDescription(
        "PM10", "dust", SensorDeviceClass.PM10, default_unit="µg/m³"
    ),
    "rssi": SensorDescription(
        "RSSI",
        "rssi",
        SensorDeviceClass.SIGNAL_STRENGTH,
        default_unit="dBm",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "lqi": SensorDescription(
        "LQI",
        "lqi",
        state_class=None,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "signalMetrics": SensorDescription(
        "Received Signal Metrics",
        "signal_metrics",
        state_class=None,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "airQuality": SensorDescription(
        "Air quality", "air_quality", default_unit="CAQI"
    ),
    "atmosphericPressure": SensorDescription(
        "Atmospheric pressure",
        "atmospheric_pressure",
        SensorDeviceClass.ATMOSPHERIC_PRESSURE,
    ),
    "filterLifeRemaining": SensorDescription(
        "Filter life remaining", "filter_life_remaining", default_unit=PERCENTAGE
    ),
    "tvocLevel": SensorDescription(
        "TVOC",
        "tvoc",
        SensorDeviceClass.VOLATILE_ORGANIC_COMPOUNDS_PARTS,
        default_unit="ppm",
    ),
    "formaldehydeLevel": SensorDescription(
        "Formaldehyde", "formaldehyde", default_unit="ppm"
    ),
    "odorLevel": SensorDescription("Odor", "odor", state_class=None),
    "soundPressureLevel": SensorDescription(
        "Sound pressure",
        "sound_pressure",
        SensorDeviceClass.SOUND_PRESSURE,
        default_unit="dB",
    ),
    "peopleCounter": SensorDescription("People", "people", state_class=SensorStateClass.MEASUREMENT),
    "remainingTime": SensorDescription(
        "Remaining time", "remaining_time", SensorDeviceClass.DURATION, default_unit="min"
    ),
    "operationTime": SensorDescription(
        "Operation time", "operation_time", SensorDeviceClass.DURATION, default_unit="min"
    ),
    "checkInterval": SensorDescription(
        "Check interval",
        "check_interval",
        SensorDeviceClass.DURATION,
        default_unit="s",
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "imageTransferProgress": SensorDescription(
        "Image transfer progress",
        "image_transfer_progress",
        default_unit=PERCENTAGE,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "captureTime": SensorDescription(
        "Capture time", "capture_time", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "clip": SensorDescription(
        "Clip metadata", "clip", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "image": SensorDescription(
        "Image metadata", "image", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "stream": SensorDescription(
        "Stream metadata", "stream", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "supportedSoundTypes": SensorDescription(
        "Supported sound types",
        "supported_sound_types",
        state_class=None,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    "status": SensorDescription(
        "Status", "status", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "healthStatus": SensorDescription(
        "Health status", "health_status", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "DeviceWatch-DeviceStatus": SensorDescription(
        "Device status", "device_status", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
    "value": SensorDescription(
        "Value", "value", state_class=None, entity_category=EntityCategory.DIAGNOSTIC
    ),
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create supported sensors."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id:
                continue
            firmware_keys = {item.key for item in firmware_states(device).values()}
            candidates: list[tuple[BridgeState, SensorDescription]] = []
            for state in device.states.values():
                if not sensor_state_allowed(
                    state.attribute,
                    firmware=state.key in firmware_keys,
                    primary_domain=sensor_state_owned_by_primary_domain(device, state),
                ):
                    continue
                description = SENSOR_STATES.get(state.attribute) or SensorDescription(
                    _attribute_name(state.attribute),
                    state_class=None,
                    entity_category=EntityCategory.DIAGNOSTIC,
                )
                candidates.append((state, description))
            name_overrides = disambiguated_state_names(
                (state, description.name) for state, description in candidates
            )
            for state, description in candidates:
                unique_id = "_".join((device.device_id, *state.key))
                if unique_id not in known:
                    known.add(unique_id)
                    entities.append(
                        SmartThingsWebSensor(
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


class SmartThingsWebSensor(SmartThingsWebEntity, SensorEntity):
    """One pushed SmartThings scalar state."""

    def __init__(
        self,
        runtime: SmartThingsWebRuntime,
        device: BridgeDevice,
        state: BridgeState,
        description: SensorDescription,
        name_override: str | None = None,
    ) -> None:
        name = (
            name_override
            if name_override is not None
            else None if description.translation_key else description.name
        )
        super().__init__(
            runtime,
            device,
            state,
            name,
        )
        self.description = description
        self._attr_translation_key = (
            None if name_override is not None else description.translation_key
        )
        self._attr_entity_category = description.entity_category
        self._attr_entity_registry_enabled_default = description.enabled_default

    @property
    def device_class(self) -> SensorDeviceClass | None:
        """Use a numeric device class only while the pushed value is numeric."""
        state = self.bridge_state
        if state is None or isinstance(state.value, bool) or not isinstance(
            state.value, (int, float)
        ):
            return None
        return self.description.device_class

    @property
    def state_class(self) -> SensorStateClass | None:
        """Use a numeric state class only while the pushed value is numeric."""
        state = self.bridge_state
        if state is None or isinstance(state.value, bool) or not isinstance(
            state.value, (int, float)
        ):
            return None
        return self.description.state_class

    @property
    def native_value(self) -> Any:
        """Return the current scalar value."""
        state = self.bridge_state
        return sensor_native_value(state.value) if state else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose normalized complex values without forcing them into HA's state string."""
        state = self.bridge_state
        return sensor_extra_attributes(state.value) if state else {}

    @property
    def native_unit_of_measurement(self) -> str | None:
        """Return the reported unit."""
        state = self.bridge_state
        if state and type(state.value) not in (int, float):
            return None
        if state and state.unit:
            return {
                "C": "°C",
                "F": "°F",
                "sec": "s",
                "Sec": "s",
                "Î¼g/m^3": "µg/m³",
                "µg/m^3": "µg/m³",
            }.get(state.unit, state.unit)
        return self.description.default_unit


def _attribute_name(attribute: str) -> str:
    """Turn normalized camelCase attributes into readable entity names."""
    return re.sub(r"(?<!^)(?=[A-Z])", " ", attribute).replace("_", " ").strip().title()
