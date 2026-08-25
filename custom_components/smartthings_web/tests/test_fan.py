"""Regression tests for SmartThings fan command features."""

from __future__ import annotations

from enum import IntFlag
from inspect import signature
from pathlib import Path
import sys
from types import ModuleType
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
fan_module = ModuleType("homeassistant.components.fan")


class FanEntity:
    """Minimal HA fan entity stub."""


class FanEntityFeature(IntFlag):
    """Minimal HA fan feature stub."""

    SET_SPEED = 1
    PRESET_MODE = 2
    TURN_ON = 4
    TURN_OFF = 8


fan_module.FanEntity = FanEntity  # type: ignore[attr-defined]
fan_module.FanEntityFeature = FanEntityFeature  # type: ignore[attr-defined]
sys.modules["homeassistant.components.fan"] = fan_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
exceptions_module.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
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

from smartthings_web.fan import SmartThingsWebFan  # noqa: E402
from smartthings_web.models import BridgeDevice, BridgeState  # noqa: E402


class SmartThingsWebFanTests(unittest.TestCase):
    """Expose implemented power methods when pushed switch state exists."""

    def test_switch_backed_fan_advertises_turn_on_and_turn_off(self) -> None:
        switch = BridgeState(
            "main",
            "switch",
            "switch",
            "on",
            None,
            "2026-08-25T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Air purifier",
            None,
            True,
            states={switch.key: switch},
            controls={},
        )

        features = SmartThingsWebFan(object(), device).supported_features

        self.assertTrue(features & FanEntityFeature.TURN_ON)
        self.assertTrue(features & FanEntityFeature.TURN_OFF)

    def test_turn_on_accepts_current_home_assistant_positional_arguments(self) -> None:
        """Match HA's percentage and preset-mode fan service call contract."""
        parameters = list(signature(SmartThingsWebFan.async_turn_on).parameters)

        self.assertEqual(parameters[:3], ["self", "percentage", "preset_mode"])


if __name__ == "__main__":
    unittest.main()
