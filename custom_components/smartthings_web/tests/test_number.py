"""Regression tests for exact SmartThings number-control binding."""

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
number_module = ModuleType("homeassistant.components.number")


class NumberEntity:
    """Minimal HA number entity stub."""


class NumberMode(str, Enum):
    """Minimal HA number mode stub."""

    SLIDER = "slider"
    BOX = "box"


number_module.NumberEntity = NumberEntity  # type: ignore[attr-defined]
number_module.NumberMode = NumberMode  # type: ignore[attr-defined]
sys.modules["homeassistant.components.number"] = number_module

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

    def __init__(self, runtime: object, device: object, *_args: object) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]

    @property
    def bridge_device(self):
        return self.runtime.inventory.devices.get(self.device_id)

    @property
    def available(self) -> bool:
        device = self.bridge_device
        return device is not None and device.online


entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.models import BridgeControl, BridgeDevice, BridgeState  # noqa: E402
from smartthings_web.number import SmartThingsWebNumber  # noqa: E402


class SmartThingsWebNumberTests(unittest.TestCase):
    """Keep number entities safe and practical for their exact observed control."""

    def test_people_counter_caps_uint16_range_and_uses_single_step(self) -> None:
        state = BridgeState(
            "main",
            "peopleCounter",
            "numberOfPeople",
            9,
            None,
            "2026-09-12T11:00:00Z",
        )
        control = BridgeControl(
            "people_counter",
            "slider",
            "Number of people",
            component="main",
            capability="peopleCounter",
            attribute="numberOfPeople",
            minimum=0,
            maximum=65535,
            step=10,
        )
        device = BridgeDevice(
            "dev_people",
            "loc_001",
            None,
            "Counter sensor",
            "sensor",
            True,
            states={state.key: state},
            controls={control.control_id: control},
        )
        runtime = SimpleNamespace(
            inventory=SimpleNamespace(devices={device.device_id: device}),
            client=SimpleNamespace(),
        )

        entity = SmartThingsWebNumber(runtime, device, state, control)

        self.assertEqual(entity._attr_native_min_value, 0)
        self.assertEqual(entity._attr_native_max_value, 100.0)
        self.assertEqual(entity._attr_native_step, 1.0)
        self.assertEqual(entity.native_value, 9.0)

    def test_unrelated_large_number_range_is_not_capped(self) -> None:
        state = BridgeState(
            "main",
            "motion",
            "detectionFrequency",
            60,
            "s",
            "2026-09-12T11:00:00Z",
        )
        control = BridgeControl(
            "frequency_slider",
            "slider",
            "Detection frequency",
            component="main",
            capability="motion",
            attribute="detectionFrequency",
            minimum=0,
            maximum=3600,
            step=5,
        )
        device = BridgeDevice(
            "dev_motion_range",
            "loc_001",
            None,
            "Motion sensor",
            "sensor",
            True,
            states={state.key: state},
            controls={control.control_id: control},
        )
        runtime = SimpleNamespace(
            inventory=SimpleNamespace(devices={device.device_id: device}),
            client=SimpleNamespace(),
        )

        entity = SmartThingsWebNumber(runtime, device, state, control)

        self.assertEqual(entity._attr_native_max_value, 3600)
        self.assertEqual(entity._attr_native_step, 5)

    def test_reused_control_id_cannot_retarget_a_different_slider(self) -> None:
        state = BridgeState(
            "main",
            "motion",
            "detectionFrequency",
            60,
            "s",
            "2026-08-26T00:00:00Z",
        )
        control = BridgeControl(
            "shared_slider",
            "slider",
            "Detection frequency",
            component="main",
            capability="motion",
            attribute="detectionFrequency",
            minimum=0,
            maximum=3600,
            step=1,
        )
        device = BridgeDevice(
            "dev_motion",
            "loc_001",
            None,
            "Motion sensor",
            "sensor",
            True,
            states={state.key: state},
            controls={control.control_id: control},
        )
        runtime = SimpleNamespace(
            inventory=SimpleNamespace(devices={device.device_id: device}),
            client=SimpleNamespace(),
        )
        entity = SmartThingsWebNumber(runtime, device, state, control)

        self.assertTrue(entity.available)

        device.controls[control.control_id] = BridgeControl(
            "shared_slider",
            "slider",
            "Speaker volume",
            component="main",
            capability="audioVolume",
            attribute="volume",
            minimum=0,
            maximum=100,
            step=1,
        )

        self.assertFalse(entity.available)
        with self.assertRaises(exceptions_module.HomeAssistantError):
            asyncio.run(entity.async_set_native_value(50))


if __name__ == "__main__":
    unittest.main()
