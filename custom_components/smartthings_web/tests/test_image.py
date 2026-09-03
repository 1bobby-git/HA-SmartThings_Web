"""Tests for SmartThings Web camera image entities."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import sys
from types import ModuleType
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))

homeassistant_util = ModuleType("homeassistant.util")
homeassistant_util.slugify = lambda value: re.sub(  # type: ignore[attr-defined]
    r"[\s_-]+",
    "_",
    re.sub(r"(?u)[^\w\s-]", "", str(value).strip().lower()),
)
sys.modules["homeassistant.util"] = homeassistant_util

components = sys.modules.setdefault(
    "homeassistant.components", ModuleType("homeassistant.components")
)
components.__path__ = []  # type: ignore[attr-defined]
image_component = ModuleType("homeassistant.components.image")


class ImageEntity:
    """Minimal Home Assistant image entity surface."""

    def __init__(self, hass: object) -> None:
        self.hass = hass

    def async_update_token(self) -> None:
        """Stand in for Home Assistant image-token rotation."""


image_component.ImageEntity = ImageEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.image"] = image_component

core = ModuleType("homeassistant.core")
core.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core

helpers = sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
helpers.__path__ = []  # type: ignore[attr-defined]

entity_registry = ModuleType("homeassistant.helpers.entity_registry")
entity_registry.async_get = lambda _hass: None  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_registry"] = entity_registry

device_registry = ModuleType("homeassistant.helpers.device_registry")


class DeviceInfo(dict[str, object]):
    """Minimal DeviceInfo constructor."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(kwargs)


device_registry.DeviceInfo = DeviceInfo  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.device_registry"] = device_registry

entity_helper = ModuleType("homeassistant.helpers.entity")


class Entity:
    """Minimal Home Assistant entity base."""


entity_helper.Entity = Entity  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity"] = entity_helper

entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

bridge_client = ModuleType("smartthings_web.bridge_client")


class BridgeClientError(Exception):
    """Minimal Bridge client failure."""


class BridgeAuthError(BridgeClientError):
    """Minimal Bridge auth failure."""


class SmartThingsWebBridgeClient:
    """Bridge client placeholder for later imports in unittest discovery."""


class ReadOnlyBridgeClient:
    """Read-only bridge client placeholder for later imports in unittest discovery."""


def bridge_error_message(action: str, _err: Exception) -> str:
    return f"failed: {action}"


bridge_client.BridgeAuthError = BridgeAuthError  # type: ignore[attr-defined]
bridge_client.BridgeClientError = BridgeClientError  # type: ignore[attr-defined]
bridge_client.SmartThingsWebBridgeClient = SmartThingsWebBridgeClient  # type: ignore[attr-defined]
bridge_client.ReadOnlyBridgeClient = ReadOnlyBridgeClient  # type: ignore[attr-defined]
bridge_client.bridge_error_message = bridge_error_message  # type: ignore[attr-defined]
sys.modules["smartthings_web.bridge_client"] = bridge_client

from smartthings_web.models import (  # noqa: E402
    BridgeDevice,
    BridgeDevicePresentation,
    BridgeInventory,
    BridgeImageUpdate,
    SmartThingsWebRuntime,
)

sys.modules.pop("smartthings_web.entity", None)
if hasattr(package, "entity"):
    delattr(package, "entity")

image_spec = importlib.util.spec_from_file_location(
    "smartthings_web.image_under_test",
    PACKAGE_ROOT / "image.py",
)
assert image_spec is not None and image_spec.loader is not None
image_under_test = importlib.util.module_from_spec(image_spec)
sys.modules[image_spec.name] = image_under_test
image_spec.loader.exec_module(image_under_test)
SmartThingsWebImage = image_under_test.SmartThingsWebImage


class SmartThingsWebImageTests(unittest.TestCase):
    """Keep device artwork from replacing camera-image proxy output."""

    def test_camera_image_does_not_publish_device_artwork_as_entity_picture(self) -> None:
        device = BridgeDevice(
            "camera_001",
            "loc_001",
            None,
            "Home Camera 360",
            "camera_security",
            True,
            presentation=BridgeDevicePresentation(
                icon_url="https://client.smartthings.com/icons/oneui/camera/on",
                inactive_icon_url="https://client.smartthings.com/icons/oneui/camera/off",
            ),
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.93", "4", {}, {}, {device.device_id: device}),
        )

        entity = SmartThingsWebImage(object(), runtime, device)

        self.assertNotIn("_attr_entity_picture", entity.__dict__)

    def test_camera_image_rotates_token_for_cache_only_image_events(self) -> None:
        device = BridgeDevice(
            "camera_001",
            "loc_001",
            None,
            "Home Camera 360",
            "camera_security",
            True,
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.126", "4", {}, {}, {device.device_id: device}),
        )
        entity = SmartThingsWebImage(object(), runtime, device)
        token_updates = 0
        writes = 0

        def update_token() -> None:
            nonlocal token_updates
            token_updates += 1

        def write_state() -> None:
            nonlocal writes
            writes += 1

        entity.async_update_token = update_token  # type: ignore[method-assign]
        entity.async_write_ha_state = write_state  # type: ignore[method-assign]
        entity.async_on_remove = lambda _callback: None  # type: ignore[method-assign]
        self.assertIsNone(entity.image_last_updated)

        runtime.image_updates[device.device_id] = BridgeImageUpdate(
            1, "2026-08-25T02:00:00.000Z", "image/jpeg"
        )
        self.assertEqual(entity.image_last_updated.isoformat(), "2026-08-25T02:00:00+00:00")
        import asyncio

        asyncio.run(entity.async_added_to_hass())
        runtime._notify_listeners(device_ids={device.device_id}, notify_global=False)

        self.assertEqual(token_updates, 1)
        self.assertEqual(writes, 1)

    def test_runtime_ignores_stale_camera_image_cache_events(self) -> None:
        device = BridgeDevice(
            "camera_001",
            "loc_001",
            None,
            "Home Camera 360",
            "camera_security",
            True,
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.126", "4", {}, {}, {device.device_id: device}),
        )

        self.assertTrue(
            runtime.apply_image_event(
                {
                    "schemaVersion": 1,
                    "type": "image",
                    "sequence": 2,
                    "deviceId": device.device_id,
                    "image": {
                        "capturedAt": "2026-08-25T02:00:01.000Z",
                        "contentType": "image/jpeg",
                    },
                }
            )
        )
        self.assertFalse(
            runtime.apply_image_event(
                {
                    "schemaVersion": 1,
                    "type": "image",
                    "sequence": 1,
                    "deviceId": device.device_id,
                    "image": {
                        "capturedAt": "2026-08-25T02:00:00.000Z",
                        "contentType": "image/jpeg",
                    },
                }
            )
        )

    def test_runtime_accepts_newer_camera_image_after_bridge_sequence_reset(self) -> None:
        device = BridgeDevice(
            "camera_001",
            "loc_001",
            None,
            "Home Camera 360",
            "camera_security",
            True,
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.126", "4", {}, {}, {device.device_id: device}),
        )
        self.assertTrue(
            runtime.apply_image_event(
                {
                    "schemaVersion": 1,
                    "type": "image",
                    "sequence": 12,
                    "deviceId": device.device_id,
                    "image": {
                        "capturedAt": "2026-08-25T02:00:01.000Z",
                        "contentType": "image/jpeg",
                    },
                }
            )
        )

        self.assertTrue(
            runtime.apply_image_event(
                {
                    "schemaVersion": 1,
                    "type": "image",
                    "sequence": 1,
                    "deviceId": device.device_id,
                    "image": {
                        "capturedAt": "2026-08-25T02:00:02.000Z",
                        "contentType": "image/jpeg",
                    },
                }
            )
        )
        self.assertEqual(runtime.image_updates[device.device_id].sequence, 1)


if __name__ == "__main__":
    unittest.main()
