"""Tests for SmartThings Web Home Monitor alarm panel."""

from __future__ import annotations

from enum import IntFlag
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
alarm_module = ModuleType("homeassistant.components.alarm_control_panel")


class AlarmControlPanelEntity:
    """Minimal HA alarm panel entity stub with Core code validation."""

    _attr_code_arm_required = True
    _attr_code_format = None

    @property
    def code_arm_required(self) -> bool:
        return self._attr_code_arm_required

    @property
    def code_format(self) -> object | None:
        return self._attr_code_format

    async def async_handle_alarm_arm_home(self, code: str | None = None) -> None:
        if not code and self.code_arm_required:
            raise ValueError("Arming requires a code")
        await self.async_alarm_arm_home(code)

    async def async_handle_alarm_arm_away(self, code: str | None = None) -> None:
        if not code and self.code_arm_required:
            raise ValueError("Arming requires a code")
        await self.async_alarm_arm_away(code)


class AlarmControlPanelEntityFeature(IntFlag):
    """Minimal HA alarm panel feature flags."""

    ARM_HOME = 1
    ARM_AWAY = 2


alarm_module.AlarmControlPanelEntity = AlarmControlPanelEntity  # type: ignore[attr-defined]
alarm_module.AlarmControlPanelEntityFeature = AlarmControlPanelEntityFeature  # type: ignore[attr-defined]
sys.modules["homeassistant.components.alarm_control_panel"] = alarm_module

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

previous_bridge_client_module = sys.modules.get("smartthings_web.bridge_client")
bridge_client_module = ModuleType("smartthings_web.bridge_client")


class BridgeClientError(Exception):
    """Bridge command transport placeholder."""


def bridge_error_message(action: str, _err: Exception) -> str:
    return f"failed: {action}"


bridge_client_module.BridgeClientError = BridgeClientError  # type: ignore[attr-defined]
bridge_client_module.bridge_error_message = bridge_error_message  # type: ignore[attr-defined]
sys.modules["smartthings_web.bridge_client"] = bridge_client_module

previous_const_module = sys.modules.get("smartthings_web.const")
const_module = ModuleType("smartthings_web.const")
const_module.DOMAIN = "smartthings_web"  # type: ignore[attr-defined]
sys.modules["smartthings_web.const"] = const_module

from smartthings_web.alarm_control_panel import (  # noqa: E402
    SmartThingsWebHomeMonitor,
    async_setup_entry,
)
if previous_bridge_client_module is None:
    sys.modules.pop("smartthings_web.bridge_client", None)
else:
    sys.modules["smartthings_web.bridge_client"] = previous_bridge_client_module
if previous_const_module is None:
    sys.modules.pop("smartthings_web.const", None)
else:
    sys.modules["smartthings_web.const"] = previous_const_module
from smartthings_web.models import (  # noqa: E402
    BridgeInventory,
    BridgeLocation,
    SmartThingsWebRuntime,
)


class _FakeEntry:
    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime_data = runtime
        self.unload_callbacks: list[object] = []

    def async_on_unload(self, callback: object) -> None:
        self.unload_callbacks.append(callback)


def _runtime(location: BridgeLocation | str | None) -> SmartThingsWebRuntime:
    locations: dict[str, BridgeLocation | str] = {}
    if location is not None:
        locations["loc_001"] = location
    return SmartThingsWebRuntime(
        object(),
        "loc_001",
        BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.128",
            protocol_version="4:test",
            locations=locations,
            rooms={},
            devices={},
        ),
    )


class SmartThingsWebHomeMonitorTests(unittest.IsolatedAsyncioTestCase):
    """Map location arm state to HA alarm state and exact arm commands."""

    async def test_setup_discovers_home_monitor_when_location_exists_without_arm_state(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "ExampleOffice", None))
        added: list[SmartThingsWebHomeMonitor] = []

        await async_setup_entry(object(), _FakeEntry(runtime), added.extend)

        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]._attr_name, "ExampleOffice Home Monitor")
        self.assertEqual(added[0]._attr_unique_id, "loc_001_home_monitor")
        self.assertTrue(added[0].available)
        self.assertIsNone(added[0].state)

    async def test_setup_waits_only_until_location_exists(self) -> None:
        runtime = _runtime(None)
        added: list[SmartThingsWebHomeMonitor] = []

        await async_setup_entry(object(), _FakeEntry(runtime), added.extend)
        self.assertEqual(added, [])

        runtime.inventory.locations["loc_001"] = BridgeLocation(
            "loc_001",
            "ExampleOffice",
            None,
        )
        for listener in tuple(runtime.listeners):
            listener()
        for listener in tuple(runtime.listeners):
            listener()

        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]._attr_name, "ExampleOffice Home Monitor")

    async def test_availability_tracks_location_presence_and_state_tracks_arm_state(self) -> None:
        runtime = _runtime(BridgeLocation("loc_001", "Home", "disarmed"))
        entity = SmartThingsWebHomeMonitor(runtime)

        cases = {
            "disarmed": "disarmed",
            "off": "disarmed",
            "stay": "armed_home",
            "armed_home": "armed_home",
            "armed_stay": "armed_home",
            "armedstay": "armed_home",
            "away": "armed_away",
            "armed_away": "armed_away",
            "armedaway": "armed_away",
            "pending": "pending",
        }
        for bridge_state, ha_state in cases.items():
            with self.subTest(bridge_state=bridge_state):
                runtime.inventory.locations["loc_001"] = BridgeLocation(
                    "loc_001",
                    "Home",
                    bridge_state,
                )
                self.assertTrue(entity.available)
                self.assertEqual(entity.state, ha_state)

        runtime.inventory.locations["loc_001"] = BridgeLocation("loc_001", "Home", None)
        self.assertTrue(entity.available)
        self.assertIsNone(entity.state)

        runtime.inventory.locations["loc_001"] = "Home"
        self.assertTrue(entity.available)
        self.assertIsNone(entity.state)

        runtime.inventory.locations.pop("loc_001")
        self.assertFalse(entity.available)
        self.assertIsNone(entity.state)

    async def test_core_arm_service_allows_no_code(self) -> None:
        client = SimpleNamespace(async_execute_command=AsyncMock())
        runtime = _runtime(BridgeLocation("loc_001", "ExampleOffice", None))
        runtime.client = client
        entity = SmartThingsWebHomeMonitor(runtime)

        self.assertFalse(entity.code_arm_required)
        self.assertIsNone(entity.code_format)
        await entity.async_handle_alarm_arm_home()
        await entity.async_handle_alarm_arm_away()

        self.assertEqual(
            client.async_execute_command.await_args_list,
            [
                unittest.mock.call(
                    target_type="location",
                    target_id="loc_001",
                    command="armStay",
                    arguments=[],
                ),
                unittest.mock.call(
                    target_type="location",
                    target_id="loc_001",
                    command="armAway",
                    arguments=[],
                ),
            ],
        )

    async def test_arm_methods_send_exact_location_command_payloads(self) -> None:
        client = SimpleNamespace(async_execute_command=AsyncMock())
        runtime = _runtime(BridgeLocation("loc_001", "Home", "disarmed"))
        runtime.client = client
        entity = SmartThingsWebHomeMonitor(runtime)

        await entity.async_alarm_arm_home()
        await entity.async_alarm_arm_away()
        await entity.async_alarm_disarm()

        self.assertEqual(
            client.async_execute_command.await_args_list,
            [
                unittest.mock.call(
                    target_type="location",
                    target_id="loc_001",
                    command="armStay",
                    arguments=[],
                ),
                unittest.mock.call(
                    target_type="location",
                    target_id="loc_001",
                    command="armAway",
                    arguments=[],
                ),
                unittest.mock.call(
                    target_type="location",
                    target_id="loc_001",
                    command="disarm",
                    arguments=[],
                ),
            ],
        )


if __name__ == "__main__":
    unittest.main()
