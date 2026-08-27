"""Regression tests for pushed SmartThings sensor value typing."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
sensor_module = ModuleType("homeassistant.components.sensor")


class SensorDeviceClass:
    """Minimal HA sensor device-class values used by the integration."""

    BATTERY = "battery"
    ATMOSPHERIC_PRESSURE = "atmospheric_pressure"
    CO2 = "carbon_dioxide"
    CURRENT = "current"
    ENERGY = "energy"
    HUMIDITY = "humidity"
    ILLUMINANCE = "illuminance"
    PM1 = "pm1"
    PM10 = "pm10"
    PM25 = "pm25"
    POWER = "power"
    SIGNAL_STRENGTH = "signal_strength"
    SOUND_PRESSURE = "sound_pressure"
    TEMPERATURE = "temperature"
    DURATION = "duration"
    VOLATILE_ORGANIC_COMPOUNDS_PARTS = "volatile_organic_compounds_parts"
    VOLTAGE = "voltage"


class SensorStateClass:
    """Minimal HA sensor state-class values used by the integration."""

    MEASUREMENT = "measurement"
    TOTAL_INCREASING = "total_increasing"


class SensorEntity:
    """Minimal HA sensor entity attribute behavior."""

    @property
    def device_class(self) -> str | None:
        return getattr(self, "_attr_device_class", None)

    @property
    def state_class(self) -> str | None:
        return getattr(self, "_attr_state_class", None)


sensor_module.SensorDeviceClass = SensorDeviceClass  # type: ignore[attr-defined]
sensor_module.SensorEntity = SensorEntity  # type: ignore[attr-defined]
sensor_module.SensorStateClass = SensorStateClass  # type: ignore[attr-defined]
sys.modules["homeassistant.components.sensor"] = sensor_module

const_module = ModuleType("homeassistant.const")
const_module.EntityCategory = SimpleNamespace(DIAGNOSTIC="diagnostic")  # type: ignore[attr-defined]
const_module.LIGHT_LUX = "lx"  # type: ignore[attr-defined]
const_module.PERCENTAGE = "%"  # type: ignore[attr-defined]
const_module.UnitOfElectricCurrent = SimpleNamespace(AMPERE="A")  # type: ignore[attr-defined]
const_module.UnitOfElectricPotential = SimpleNamespace(VOLT="V")  # type: ignore[attr-defined]
const_module.UnitOfEnergy = SimpleNamespace(KILO_WATT_HOUR="kWh")  # type: ignore[attr-defined]
const_module.UnitOfPower = SimpleNamespace(WATT="W")  # type: ignore[attr-defined]
const_module.UnitOfTemperature = SimpleNamespace(CELSIUS="°C")  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebEntity:
    """Minimal pushed entity base that resolves the live Bridge state."""

    def __init__(
        self, runtime: object, device: object, state: object, _name: str | None
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]
        self._attr_name = _name

    @property
    def bridge_state(self) -> object | None:
        device = self.runtime.inventory.devices.get(self.device_id)  # type: ignore[attr-defined]
        return device.states.get(self.state_key) if device else None


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
entity_module.migrate_entity_original_name = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.models import (  # noqa: E402
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)
from smartthings_web.sensor import SENSOR_STATES, SmartThingsWebSensor  # noqa: E402


class SmartThingsWebSensorTests(unittest.TestCase):
    """Keep string status content without violating HA numeric sensor contracts."""

    def test_known_numeric_attribute_tracks_the_live_value_type(self) -> None:
        state = BridgeState(
            "main",
            "batteryHealth",
            "battery",
            "normal",
            None,
            "2026-08-26T03:32:13Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Safe",
            None,
            True,
            states={state.key: state},
        )
        inventory = BridgeInventory(1, True, "0.1.66", "4:test", {}, {}, {device.device_id: device})
        runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)
        sensor = SmartThingsWebSensor(runtime, device, state, SENSOR_STATES["battery"])

        self.assertEqual(sensor.native_value, "normal")
        self.assertIsNone(sensor.device_class)
        self.assertIsNone(sensor.state_class)
        self.assertIsNone(sensor.native_unit_of_measurement)

        device.states[state.key] = BridgeState(
            "main",
            "batteryHealth",
            "battery",
            93,
            "%",
            "2026-08-26T03:33:13Z",
        )

        self.assertEqual(sensor.native_value, 93)
        self.assertEqual(sensor.device_class, SensorDeviceClass.BATTERY)
        self.assertEqual(sensor.state_class, SensorStateClass.MEASUREMENT)
        self.assertEqual(sensor.native_unit_of_measurement, "%")

    def test_explicit_duplicate_name_overrides_translation_key(self) -> None:
        state = BridgeState(
            "outdoor",
            "temperatureMeasurement",
            "temperature",
            31,
            "C",
            "2026-08-27T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Thermometer",
            None,
            True,
            states={state.key: state},
        )
        inventory = BridgeInventory(
            1, True, "0.1.93", "4:test", {}, {}, {device.device_id: device}
        )
        runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)

        sensor = SmartThingsWebSensor(
            runtime,
            device,
            state,
            SENSOR_STATES["temperature"],
            name_override="Temperature (Outdoor)",
        )

        self.assertEqual(sensor._attr_name, "Temperature (Outdoor)")
        self.assertIsNone(sensor._attr_translation_key)

    def test_signal_metrics_dict_uses_web_display_value(self) -> None:
        state = BridgeState(
            "main",
            "legendabsolute60149.signalMetrics",
            "signalMetrics",
            {"lqi": 184, "rssi": -95},
            None,
            "2026-04-01T11:28:55Z",
        )
        device = BridgeDevice(
            "dev_window",
            "loc_001",
            None,
            "거실창문센서",
            "custom_window_h",
            True,
            states={state.key: state},
        )
        inventory = BridgeInventory(
            1, True, "0.1.98", "4:test", {}, {}, {device.device_id: device}
        )
        runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)
        sensor = SmartThingsWebSensor(runtime, device, state, SENSOR_STATES["signalMetrics"])

        self.assertEqual(
            sensor.native_value,
            "KST-9: 2026/04/01 11:28 LQI: 184 RSSI: -95dbm",
        )
        self.assertEqual(sensor.extra_state_attributes, {"value": {"lqi": 184, "rssi": -95}})


if __name__ == "__main__":
    unittest.main()
