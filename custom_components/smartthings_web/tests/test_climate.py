"""Regression tests for observed-only climate controls."""

from __future__ import annotations

from enum import Enum, IntFlag
from pathlib import Path
import sys
from types import ModuleType
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

homeassistant = sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
components = sys.modules.setdefault(
    "homeassistant.components", ModuleType("homeassistant.components")
)
climate_module = ModuleType("homeassistant.components.climate")


class ClimateEntity:
    """Minimal HA climate entity stub."""


class ClimateEntityFeature(IntFlag):
    """Minimal HA climate feature stub."""

    TARGET_TEMPERATURE = 1


class HVACMode(str, Enum):
    """Minimal HA HVAC mode stub."""

    AUTO = "auto"
    COOL = "cool"
    DRY = "dry"
    FAN_ONLY = "fan_only"
    HEAT = "heat"
    OFF = "off"


climate_module.ClimateEntity = ClimateEntity  # type: ignore[attr-defined]
climate_module.ClimateEntityFeature = ClimateEntityFeature  # type: ignore[attr-defined]
climate_module.HVACMode = HVACMode  # type: ignore[attr-defined]
sys.modules["homeassistant.components.climate"] = climate_module

const_module = ModuleType("homeassistant.const")


class UnitOfTemperature:
    """Minimal temperature unit stub."""

    CELSIUS = "C"


const_module.UnitOfTemperature = UnitOfTemperature  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
exceptions_module.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions_module

helpers = sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebDeviceEntity:
    """Minimal integration entity base stub."""

    def __init__(self, _runtime: object, device: object, *_args: object) -> None:
        self.bridge_device = device


entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.climate import (  # noqa: E402
    SmartThingsWebClimate,
    _bridge_mode_for_hvac,
    _mode_control,
    _temperature_control,
)
from smartthings_web.models import BridgeControl, BridgeDevice, BridgeState  # noqa: E402


class SmartThingsWebClimateTests(unittest.TestCase):
    """Expose and send only exact observed mode options."""

    def test_unobserved_current_mode_is_not_advertised_as_selectable(self) -> None:
        state = BridgeState(
            "main",
            "thermostatMode",
            "thermostatMode",
            "heat",
            None,
            "2026-08-25T00:00:00Z",
        )
        control = BridgeControl(
            "mode",
            "enumerated",
            "Mode",
            component="main",
            capability="thermostatMode",
            attribute="thermostatMode",
            commands=("setThermostatMode",),
            options=("off", "cool"),
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Thermostat",
            None,
            True,
            states={state.key: state},
            controls={control.control_id: control},
        )

        entity = SmartThingsWebClimate(object(), device)

        self.assertEqual(entity.hvac_modes, [HVACMode.OFF, HVACMode.COOL])
        self.assertNotIn(HVACMode.HEAT, entity.hvac_modes)

    def test_hvac_alias_maps_back_to_exact_observed_option(self) -> None:
        control = BridgeControl(
            "mode",
            "enumerated",
            "Mode",
            attribute="thermostatMode",
            options=("off", "eco"),
        )

        self.assertEqual(_bridge_mode_for_hvac(control, HVACMode.AUTO), "eco")

    def test_ambiguous_mode_controls_fail_closed(self) -> None:
        controls = [
            BridgeControl(
                f"mode_{index}",
                "enumerated",
                "Mode",
                attribute="thermostatMode",
                options=("off", "cool"),
            )
            for index in range(2)
        ]

        self.assertIsNone(_mode_control(controls))

    def test_temperature_control_follows_current_mode_without_guessing(self) -> None:
        cooling = BridgeControl(
            "cooling",
            "slider",
            "Cooling setpoint",
            attribute="coolingSetpoint",
            minimum=16,
            maximum=30,
        )
        heating = BridgeControl(
            "heating",
            "slider",
            "Heating setpoint",
            attribute="heatingSetpoint",
            minimum=5,
            maximum=30,
        )

        self.assertIs(_temperature_control([cooling, heating], HVACMode.COOL), cooling)
        self.assertIs(_temperature_control([cooling, heating], HVACMode.HEAT), heating)
        self.assertIsNone(_temperature_control([cooling, heating], HVACMode.AUTO))

        duplicate = BridgeControl(
            "cooling_duplicate",
            "slider",
            "Cooling setpoint 2",
            attribute="coolingSetpoint",
            minimum=16,
            maximum=30,
        )
        self.assertIsNone(
            _temperature_control([cooling, duplicate, heating], HVACMode.COOL)
        )


if __name__ == "__main__":
    unittest.main()
