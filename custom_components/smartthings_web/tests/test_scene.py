"""Tests for SmartThings Web scene discovery and activation."""

from __future__ import annotations

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
scene_module = ModuleType("homeassistant.components.scene")


class Scene:
    """Minimal HA scene entity stub."""


scene_module.Scene = Scene  # type: ignore[attr-defined]
sys.modules["homeassistant.components.scene"] = scene_module

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

from smartthings_web.scene import SmartThingsWebScene, async_setup_entry  # noqa: E402
if previous_bridge_client_module is None:
    sys.modules.pop("smartthings_web.bridge_client", None)
else:
    sys.modules["smartthings_web.bridge_client"] = previous_bridge_client_module
from smartthings_web.models import (  # noqa: E402
    BridgeInventory,
    BridgeScene,
    SmartThingsWebRuntime,
)


class _FakeEntry:
    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime_data = runtime
        self.unload_callbacks: list[object] = []

    def async_on_unload(self, callback: object) -> None:
        self.unload_callbacks.append(callback)


def _runtime(*scenes: BridgeScene) -> SmartThingsWebRuntime:
    inventory = BridgeInventory(
        sequence=1,
        ready=True,
        bridge_version="0.1.128",
        protocol_version="4:test",
        locations={"loc_001": "Home", "loc_other": "Other"},
        rooms={},
        devices={},
        scenes={scene.scene_id: scene for scene in scenes},
    )
    return SmartThingsWebRuntime(object(), "loc_001", inventory)


class SmartThingsWebSceneTests(unittest.IsolatedAsyncioTestCase):
    """Expose only same-location SmartThings scenes and exact execute commands."""

    async def test_setup_discovers_same_location_scenes_and_future_pushes_once(self) -> None:
        current = BridgeScene(
            "scene_morning",
            "loc_001",
            "Morning",
            "2026-08-29T00:00:00Z",
        )
        other_location = BridgeScene(
            "scene_elsewhere",
            "loc_other",
            "Elsewhere",
            "2026-08-29T00:00:00Z",
        )
        runtime = _runtime(current, other_location)
        added: list[SmartThingsWebScene] = []

        await async_setup_entry(object(), _FakeEntry(runtime), added.extend)

        self.assertEqual([entity.scene_id for entity in added], ["scene_morning"])
        self.assertEqual(added[0]._attr_name, "Morning")
        self.assertEqual(added[0]._attr_unique_id, "scene_morning_scene")
        self.assertTrue(added[0].available)

        runtime.inventory.scenes["scene_evening"] = BridgeScene(
            "scene_evening",
            "loc_001",
            "Evening",
            "2026-08-29T00:01:00Z",
        )
        for listener in tuple(runtime.listeners):
            listener()
        for listener in tuple(runtime.listeners):
            listener()

        self.assertEqual(
            [entity.scene_id for entity in added],
            ["scene_morning", "scene_evening"],
        )

    async def test_scene_becomes_unavailable_when_removed_or_moved_from_location(self) -> None:
        scene = BridgeScene("scene_night", "loc_001", "Night")
        runtime = _runtime(scene)
        entity = SmartThingsWebScene(runtime, scene)

        self.assertTrue(entity.available)

        runtime.inventory.scenes["scene_night"] = BridgeScene(
            "scene_night",
            "loc_other",
            "Night",
        )
        self.assertFalse(entity.available)

        runtime.inventory.scenes.clear()
        self.assertFalse(entity.available)

    async def test_activate_sends_exact_scene_execute_payload(self) -> None:
        scene = BridgeScene("scene_night", "loc_001", "Night")
        client = SimpleNamespace(async_execute_command=AsyncMock())
        runtime = _runtime(scene)
        runtime.client = client
        entity = SmartThingsWebScene(runtime, scene)

        await entity.async_activate()

        client.async_execute_command.assert_awaited_once_with(
            target_type="scene",
            target_id="scene_night",
            command="execute",
            arguments=[],
        )


if __name__ == "__main__":
    unittest.main()
