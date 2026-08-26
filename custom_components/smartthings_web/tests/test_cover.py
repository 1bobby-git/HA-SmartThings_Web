"""Regression tests for fail-closed SmartThings cover control selection."""

from __future__ import annotations

from enum import IntFlag
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
cover_module = ModuleType("homeassistant.components.cover")


class CoverEntity:
    """Minimal HA cover entity stub."""


class CoverEntityFeature(IntFlag):
    """Minimal HA cover feature stub."""

    OPEN = 1
    CLOSE = 2
    STOP = 4
    SET_POSITION = 8


cover_module.CoverEntity = CoverEntity  # type: ignore[attr-defined]
cover_module.CoverEntityFeature = CoverEntityFeature  # type: ignore[attr-defined]
sys.modules["homeassistant.components.cover"] = cover_module

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
    """Minimal integration device entity base stub."""


entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.cover import _find_control, _position_control  # noqa: E402
from smartthings_web.models import BridgeControl  # noqa: E402


class SmartThingsWebCoverControlTests(unittest.TestCase):
    """Reject ambiguous observed cover controls instead of choosing one."""

    def test_duplicate_command_and_position_controls_fail_closed(self) -> None:
        open_controls = [
            BridgeControl(
                f"open_{index}",
                "button",
                "Open shade",
                attribute="windowShade",
                commands=("openShade",),
            )
            for index in range(2)
        ]
        position_controls = [
            BridgeControl(
                f"position_{index}",
                "slider",
                "Shade level",
                attribute="shadeLevel",
                minimum=0,
                maximum=100,
            )
            for index in range(2)
        ]

        self.assertIsNone(_find_control(open_controls, "open", "openShade"))
        self.assertIsNone(_position_control(position_controls))
        self.assertIs(_find_control(open_controls[:1], "openShade"), open_controls[0])
        self.assertIs(_position_control(position_controls[:1]), position_controls[0])


if __name__ == "__main__":
    unittest.main()
