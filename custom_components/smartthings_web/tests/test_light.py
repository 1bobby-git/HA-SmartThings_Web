"""Regression tests for observed SmartThings light controls."""

from __future__ import annotations

import asyncio
from enum import Enum
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
light_module = ModuleType("homeassistant.components.light")


class ColorMode(str, Enum):
    """Minimal HA light color modes."""

    ONOFF = "onoff"
    BRIGHTNESS = "brightness"
    COLOR_TEMP = "color_temp"


class LightEntity:
    """Minimal HA light entity stub."""


light_module.ATTR_BRIGHTNESS = "brightness"  # type: ignore[attr-defined]
light_module.ATTR_COLOR_TEMP_KELVIN = "color_temp_kelvin"  # type: ignore[attr-defined]
light_module.ColorMode = ColorMode  # type: ignore[attr-defined]
light_module.LightEntity = LightEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.light"] = light_module

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


class SmartThingsWebEntity:
    """Minimal integration entity base stub."""

    def __init__(
        self,
        runtime: object,
        device: object,
        state: object,
        *_args: object,
        **_kwargs: object,
    ) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]

    @property
    def bridge_device(self):
        return self.runtime.inventory.devices.get(self.device_id)

    @property
    def bridge_state(self):
        device = self.bridge_device
        return device.states.get(self.state_key) if device is not None else None

    @property
    def available(self) -> bool:
        device = self.bridge_device
        return device is not None and device.online


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.light import SmartThingsWebLight, async_setup_entry  # noqa: E402
from smartthings_web.models import (  # noqa: E402
    BridgeControl,
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)


class SmartThingsWebLightTests(unittest.TestCase):
    """Map exact observed power and range controls to one light entity."""

    def test_setup_exposes_advanced_catalog_backed_light_toggle(self) -> None:
        switch = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-08-26T00:00:00Z",
        )
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            40,
            "%",
            "2026-08-26T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_light",
            "loc_001",
            None,
            "Mood Light",
            "light",
            True,
            states={switch.key: switch, level.key: level},
            controls={
                "advanced:main:switch:switch": BridgeControl(
                    "advanced:main:switch:switch",
                    "toggle",
                    "Power",
                    component=switch.component,
                    capability=switch.capability,
                    attribute=switch.attribute,
                    commands=("on", "off"),
                    transport="advanced",
                ),
                "advanced:main:switchLevel:level": BridgeControl(
                    "advanced:main:switchLevel:level",
                    "slider",
                    "Level",
                    component=level.component,
                    capability=level.capability,
                    attribute=level.attribute,
                    commands=("setLevel",),
                    transport="advanced",
                ),
            },
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(
                1,
                True,
                "0.1.154",
                "5:test",
                {"loc_001": "Home"},
                {},
                {device.device_id: device},
            ),
        )
        entry = SimpleNamespace(
            runtime_data=runtime,
            async_on_unload=lambda _callback: None,
        )
        added: list[SmartThingsWebLight] = []

        asyncio.run(async_setup_entry(object(), entry, added.extend))

        self.assertEqual([entity.state_key for entity in added], [switch.key])

    def test_light_preserves_raw_values_and_targets_exact_controls(self) -> None:
        states = [
            BridgeState("main", "switch", "switch", "off", None, "2026-08-26T00:00:00Z"),
            BridgeState("main", "switchLevel", "level", 40, "%", "2026-08-26T00:00:00Z"),
            BridgeState(
                "main",
                "colorTemperature",
                "colorTemperature",
                3000,
                "K",
                "2026-08-26T00:00:00Z",
            ),
        ]
        controls = [
            BridgeControl(
                "power",
                "toggle",
                "Power",
                component="main",
                capability="switch",
                attribute="switch",
                commands=("on", "off"),
            ),
            BridgeControl(
                "level",
                "slider",
                "Dimmer",
                component="main",
                capability="switchLevel",
                attribute="level",
                minimum=0,
                maximum=100,
                step=1,
            ),
            BridgeControl(
                "temperature",
                "slider",
                "Colour temperature",
                component="main",
                capability="colorTemperature",
                attribute="colorTemperature",
                minimum=1500,
                maximum=9000,
                step=1,
            ),
        ]
        device = BridgeDevice(
            "dev_light",
            "loc_001",
            None,
            "Lamp",
            "light",
            True,
            states={state.key: state for state in states},
            controls={control.control_id: control for control in controls},
        )

        class Client:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            async def async_execute_command(self, **kwargs: object) -> None:
                self.calls.append(kwargs)

        client = Client()
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={device.device_id: device}),
        )
        entity = SmartThingsWebLight(runtime, device, states[0])

        self.assertEqual(entity.brightness, 102)
        self.assertEqual(entity.color_temp_kelvin, 3000)
        self.assertEqual(entity.extra_state_attributes["switch"], "off")
        self.assertEqual(entity.extra_state_attributes["level"], 40)
        self.assertEqual(entity.extra_state_attributes["colorTemperature"], 3000)

        asyncio.run(entity.async_turn_on(brightness=128, color_temp_kelvin=3200))

        self.assertEqual(
            [call["control_id"] for call in client.calls],
            ["power", "level", "temperature"],
        )
        self.assertEqual(
            [call["command"] for call in client.calls],
            ["on", "setNumber", "setNumber"],
        )
        self.assertEqual(client.calls[1]["arguments"], [50])
        self.assertEqual(client.calls[2]["arguments"], [3200])

    def test_light_becomes_unavailable_when_reversible_control_is_lost(self) -> None:
        switch = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-08-26T00:00:00Z",
        )
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            40,
            "%",
            "2026-08-26T00:00:00Z",
        )
        control_id = "advanced:main:switch:switch"
        device = BridgeDevice(
            "dev_light",
            "loc_001",
            None,
            "Mood Light",
            "light",
            True,
            states={switch.key: switch, level.key: level},
            controls={
                control_id: BridgeControl(
                    control_id,
                    "toggle",
                    "Power",
                    component=switch.component,
                    capability=switch.capability,
                    attribute=switch.attribute,
                    commands=("on", "off"),
                    transport="advanced",
                ),
                "advanced:main:switchLevel:level": BridgeControl(
                    "advanced:main:switchLevel:level",
                    "slider",
                    "Level",
                    component=level.component,
                    capability=level.capability,
                    attribute=level.attribute,
                    commands=("setLevel",),
                    transport="advanced",
                ),
            },
        )
        runtime = SimpleNamespace(
            client=object(),
            inventory=SimpleNamespace(devices={device.device_id: device}),
        )
        entity = SmartThingsWebLight(runtime, device, switch)
        self.assertTrue(entity.available)

        device.controls[control_id] = BridgeControl(
            control_id,
            "toggle",
            "Power",
            component=switch.component,
            capability=switch.capability,
            attribute=switch.attribute,
            commands=("on",),
            transport="advanced",
        )

        self.assertFalse(entity.available)


if __name__ == "__main__":
    unittest.main()
