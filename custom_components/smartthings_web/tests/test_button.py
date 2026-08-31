"""Tests for SmartThings Web button discovery and action safety."""

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

button_module = ModuleType("homeassistant.components.button")


class ButtonEntity:
    """Minimal HA button entity stub."""


button_module.ButtonEntity = ButtonEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.button"] = button_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
exceptions_module.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions_module

const_module = ModuleType("homeassistant.const")
const_module.EntityCategory = SimpleNamespace(CONFIG="config")  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebDeviceEntity:
    """Minimal base entity for button integration."""

    def __init__(self, runtime: object, device: object, *_args: object) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self._attr_suggested_object_id = f"{device.device_id}_{_args[0]}"
        self._attr_entity_picture = "https://client.smartthings.com/icons/oneui/custom/on"
        self._attr_icon = "mdi:device-artwork"

    @property
    def bridge_device(self):
        return self.runtime.inventory.devices.get(self.device_id)


entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
entity_module.suggested_entity_object_id = (  # type: ignore[attr-defined]
    lambda _runtime, _device, entity_name=None: f"window_sensor_{entity_name}"
)
sys.modules["smartthings_web.entity"] = entity_module

bridge_client_module = ModuleType("smartthings_web.bridge_client")


class BridgeClientError(Exception):
    """Bridge command transport placeholder."""


class BridgeAuthError(BridgeClientError):
    """Bridge authentication placeholder."""


class SmartThingsWebBridgeClient:
    """Bridge client placeholder for later imports in unittest discovery."""


class ReadOnlyBridgeClient:
    """Read-only bridge client placeholder for later imports in unittest discovery."""


def bridge_error_message(action: str, _err: Exception) -> str:
    return f"failed: {action}"


bridge_client_module.BridgeAuthError = BridgeAuthError  # type: ignore[attr-defined]
bridge_client_module.BridgeClientError = BridgeClientError  # type: ignore[attr-defined]
bridge_client_module.SmartThingsWebBridgeClient = SmartThingsWebBridgeClient  # type: ignore[attr-defined]
bridge_client_module.ReadOnlyBridgeClient = ReadOnlyBridgeClient  # type: ignore[attr-defined]
bridge_client_module.bridge_error_message = bridge_error_message  # type: ignore[attr-defined]
sys.modules["smartthings_web.bridge_client"] = bridge_client_module

sys.modules.pop("smartthings_web.button", None)
if hasattr(package, "button"):
    delattr(package, "button")

from smartthings_web.button import SmartThingsWebButton, async_setup_entry  # noqa: E402
from smartthings_web.models import BridgeControl, BridgeDevice, BridgeInventory, SmartThingsWebRuntime  # noqa: E402


class _FakeEntry:
    def __init__(self, runtime: SmartThingsWebRuntime) -> None:
        self.runtime_data = runtime
        self.unload_callbacks: list[object] = []

    def async_on_unload(self, callback: object) -> None:
        self.unload_callbacks.append(callback)


class ButtonDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    """Discover only user-observed button controls as button entities."""

    def _bootstrap_runtime(self, device: BridgeDevice) -> SmartThingsWebRuntime:
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.89",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={device.device_id: device},
        )
        return SmartThingsWebRuntime(object(), "loc_001", inventory)

    async def test_no_button_is_created_without_observed_button_controls(self) -> None:
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={},
        )
        runtime = self._bootstrap_runtime(device)
        added: list[SmartThingsWebButton] = []

        await async_setup_entry(object(), _FakeEntry(runtime), added.extend)

        self.assertEqual(len(added), 0)

    async def test_refresh_button_is_created_only_when_control_is_observed(self) -> None:
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={
                "refresh": BridgeControl(
                    "refresh",
                    "button",
                    "Refresh",
                    commands=("refresh",),
                ),
                "toggle": BridgeControl(
                    "toggle",
                    "toggle",
                    "Power",
                    commands=("on", "off"),
                ),
            },
        )
        runtime = self._bootstrap_runtime(device)
        added: list[SmartThingsWebButton] = []

        await async_setup_entry(object(), _FakeEntry(runtime), added.extend)

        self.assertEqual(len(added), 1)
        self.assertEqual(added[0].control.control_id, "refresh")
        self.assertEqual(added[0]._attr_translation_key, "refresh")
        self.assertEqual(added[0]._attr_suggested_object_id, "window_sensor_refresh")
        self.assertEqual(added[0].entity_id, "button.window_sensor_refresh")

    async def test_refresh_button_is_a_config_entity_with_refresh_icon(self) -> None:
        control = BridgeControl(
            "refresh",
            "button",
            "Refresh",
            component="main",
            capability="refresh",
            commands=("refresh",),
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Window sensor",
            "sensor",
            True,
            controls={control.control_id: control},
        )
        runtime = self._bootstrap_runtime(device)

        button = SmartThingsWebButton(runtime, device, control)

        self.assertEqual(button._attr_translation_key, "refresh")
        self.assertEqual(button._attr_entity_category, "config")
        self.assertEqual(button._attr_icon, "mdi:refresh")
        self.assertIsNone(button._attr_entity_picture)

    async def test_observed_refresh_button_sends_refresh_command(self) -> None:
        control = BridgeControl(
            "refresh",
            "button",
            "Refresh",
            component="main",
            capability="refresh",
            commands=("refresh",),
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Window sensor",
            "sensor",
            True,
            controls={control.control_id: control},
        )
        client = type("Client", (), {"async_execute_command": AsyncMock()})()
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.90",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={device.device_id: device},
        )
        runtime = SmartThingsWebRuntime(client, "loc_001", inventory)

        await SmartThingsWebButton(runtime, device, control).async_press()

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_001",
            control_id="refresh",
            control_label="Refresh",
            component="main",
            capability="refresh",
            attribute=None,
            command="refresh",
            arguments=[],
        )


if __name__ == "__main__":
    unittest.main()
