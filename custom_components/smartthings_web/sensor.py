"""Read-only sensors for SmartThings Web."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE, UnitOfElectricCurrent, UnitOfElectricPotential, UnitOfEnergy, UnitOfIlluminance, UnitOfPower, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .entity import SmartThingsWebEntity
from .models import BridgeDevice, BridgeState, SmartThingsWebRuntime


@dataclass(frozen=True)
class SensorDescription:
    name: str
    device_class: SensorDeviceClass | None = None
    state_class: SensorStateClass | None = SensorStateClass.MEASUREMENT
    default_unit: str | None = None


SENSOR_STATES = {
    ("temperatureMeasurement", "temperature"): SensorDescription("Temperature", SensorDeviceClass.TEMPERATURE, default_unit=UnitOfTemperature.CELSIUS),
    ("relativeHumidityMeasurement", "humidity"): SensorDescription("Humidity", SensorDeviceClass.HUMIDITY, default_unit=PERCENTAGE),
    ("battery", "battery"): SensorDescription("Battery", SensorDeviceClass.BATTERY, default_unit=PERCENTAGE),
    ("powerMeter", "power"): SensorDescription("Power", SensorDeviceClass.POWER, default_unit=UnitOfPower.WATT),
    ("energyMeter", "energy"): SensorDescription("Energy", SensorDeviceClass.ENERGY, SensorStateClass.TOTAL_INCREASING, UnitOfEnergy.KILO_WATT_HOUR),
    ("voltageMeasurement", "voltage"): SensorDescription("Voltage", SensorDeviceClass.VOLTAGE, default_unit=UnitOfElectricPotential.VOLT),
    ("currentMeasurement", "current"): SensorDescription("Current", SensorDeviceClass.CURRENT, default_unit=UnitOfElectricCurrent.AMPERE),
    ("illuminanceMeasurement", "illuminance"): SensorDescription("Illuminance", SensorDeviceClass.ILLUMINANCE, default_unit=UnitOfIlluminance.LUX),
    ("carbonDioxideMeasurement", "carbonDioxide"): SensorDescription("Carbon dioxide", SensorDeviceClass.CO2, default_unit="ppm"),
    ("fineDustSensor", "fineDustLevel"): SensorDescription("PM2.5", SensorDeviceClass.PM25, default_unit="µg/m³"),
    ("veryFineDustSensor", "veryFineDustLevel"): SensorDescription("PM1", SensorDeviceClass.PM1, default_unit="µg/m³"),
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create supported sensors."""
    runtime = entry.runtime_data
    async_add_entities(
        SmartThingsWebSensor(runtime, device, state, description)
        for device in runtime.inventory.devices.values()
        if device.location_id == runtime.location_id
        for state in device.states.values()
        if (description := SENSOR_STATES.get((state.capability, state.attribute))) is not None
    )


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
        return state.value if state and isinstance(state.value, (str, int, float)) else None

    @property
    def native_unit_of_measurement(self) -> str | None:
        """Return the reported unit."""
        state = self.bridge_state
        if state and state.unit:
            return {"C": "°C", "F": "°F"}.get(state.unit, state.unit)
        return self.description.default_unit

