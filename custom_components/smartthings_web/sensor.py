"""Read-only sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import (
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
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
)


@dataclass(frozen=True)
class SensorDescription:
    name: str
    device_class: SensorDeviceClass | None = None
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    default_unit: str | None = None


SENSOR_STATES = {
    "temperature": SensorDescription(
        "Temperature", SensorDeviceClass.TEMPERATURE, default_unit=UnitOfTemperature.CELSIUS
    ),
    "humidity": SensorDescription(
        "Humidity", SensorDeviceClass.HUMIDITY, default_unit=PERCENTAGE
    ),
    "battery": SensorDescription(
        "Battery", SensorDeviceClass.BATTERY, default_unit=PERCENTAGE
    ),
    "power": SensorDescription(
        "Power", SensorDeviceClass.POWER, default_unit=UnitOfPower.WATT
    ),
    "energy": SensorDescription(
        "Energy",
        SensorDeviceClass.ENERGY,
        SensorStateClass.TOTAL_INCREASING,
        UnitOfEnergy.KILO_WATT_HOUR,
    ),
    "voltage": SensorDescription(
        "Voltage", SensorDeviceClass.VOLTAGE, default_unit=UnitOfElectricPotential.VOLT
    ),
    "current": SensorDescription(
        "Current", SensorDeviceClass.CURRENT, default_unit=UnitOfElectricCurrent.AMPERE
    ),
    "illuminance": SensorDescription(
        "Illuminance", SensorDeviceClass.ILLUMINANCE, default_unit=LIGHT_LUX
    ),
    "carbonDioxide": SensorDescription(
        "Carbon dioxide", SensorDeviceClass.CO2, default_unit="ppm"
    ),
    "fineDustLevel": SensorDescription(
        "PM2.5", SensorDeviceClass.PM25, default_unit="µg/m³"
    ),
    "veryFineDustLevel": SensorDescription(
        "PM1", SensorDeviceClass.PM1, default_unit="µg/m³"
    ),
    "dustLevel": SensorDescription(
        "PM10", SensorDeviceClass.PM10, default_unit="µg/m³"
    ),
    "rssi": SensorDescription(
        "RSSI", SensorDeviceClass.SIGNAL_STRENGTH, default_unit="dBm"
    ),
    "lqi": SensorDescription("LQI", state_class=None),
    "signalMetrics": SensorDescription("Received Signal Metrics", state_class=None),
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
            for state in device.states.values():
                if not sensor_state_allowed(state.attribute):
                    continue
                description = SENSOR_STATES.get(state.attribute) or SensorDescription(
                    _attribute_name(state.attribute), state_class=None
                )
                unique_id = "_".join((device.device_id, *state.key))
                if unique_id not in known:
                    known.add(unique_id)
                    entities.append(SmartThingsWebSensor(runtime, device, state, description))
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
    ) -> None:
        super().__init__(runtime, device, state, description.name)
        self.description = description
        self._attr_device_class = description.device_class
        self._attr_state_class = description.state_class

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
        if state and state.unit:
            return {
                "C": "°C",
                "F": "°F",
                "Î¼g/m^3": "µg/m³",
                "µg/m^3": "µg/m³",
            }.get(state.unit, state.unit)
        return self.description.default_unit


def _attribute_name(attribute: str) -> str:
    """Turn normalized camelCase attributes into readable entity names."""
    return re.sub(r"(?<!^)(?=[A-Z])", " ", attribute).replace("_", " ").strip().title()
