"""Regression tests for button events and firmware aggregation."""

from __future__ import annotations

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

event_module = ModuleType("homeassistant.components.event")


class EventDeviceClass(str, Enum):
    """Minimal HA event class."""

    BUTTON = "button"


class EventEntity:
    """Minimal HA event entity."""

    def _trigger_event(self, event_type: str) -> None:
        self.triggered.append(event_type)


event_module.EventDeviceClass = EventDeviceClass  # type: ignore[attr-defined]
event_module.EventEntity = EventEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.event"] = event_module

update_module = ModuleType("homeassistant.components.update")


class UpdateDeviceClass(str, Enum):
    """Minimal HA update class."""

    FIRMWARE = "firmware"


class UpdateEntity:
    """Minimal HA update entity."""


update_module.UpdateDeviceClass = UpdateDeviceClass  # type: ignore[attr-defined]
update_module.UpdateEntity = UpdateEntity  # type: ignore[attr-defined]
sys.modules["homeassistant.components.update"] = update_module

const_module = ModuleType("homeassistant.const")


class EntityCategory(str, Enum):
    """Minimal HA entity category."""

    CONFIG = "config"


const_module.EntityCategory = EntityCategory  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class _BaseEntity:
    def async_on_remove(self, callback: object) -> None:
        self.remove_callback = callback

    def async_write_ha_state(self) -> None:
        self.write_count += 1


class SmartThingsWebEntity(_BaseEntity):
    """Minimal state-backed integration entity."""

    def __init__(self, runtime: object, device: object, state: object, *_args: object) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.state_key = state.key  # type: ignore[attr-defined]
        self.triggered: list[str] = []
        self.write_count = 0

    @property
    def bridge_state(self):
        device = self.runtime.inventory.devices.get(self.device_id)
        return device.states.get(self.state_key) if device is not None else None


class SmartThingsWebDeviceEntity(_BaseEntity):
    """Minimal device-backed integration entity."""

    def __init__(self, runtime: object, device: object, *_args: object) -> None:
        self.runtime = runtime
        self.device_id = device.device_id  # type: ignore[attr-defined]
        self.write_count = 0

    @property
    def bridge_device(self):
        return self.runtime.inventory.devices.get(self.device_id)


entity_module.SmartThingsWebEntity = SmartThingsWebEntity  # type: ignore[attr-defined]
entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
entity_module.device_info_for = lambda *_args, **_kwargs: {}  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.event import SmartThingsWebButtonEvent  # noqa: E402
from smartthings_web.models import (  # noqa: E402
    BridgeDevice,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)
from smartthings_web.update import SmartThingsWebFirmwareUpdate  # noqa: E402


class SmartThingsWebEventUpdateTests(unittest.IsolatedAsyncioTestCase):
    """Keep momentary events and firmware rows consolidated without polling."""

    async def test_repeated_button_pushes_trigger_distinct_events(self) -> None:
        button = BridgeState(
            "main", "button", "button", "pushed", None, "2026-08-26T00:00:00Z"
        )
        supported = BridgeState(
            "main",
            "button",
            "supportedButtonValues",
            ["pushed", "held", "double"],
            None,
            "2026-08-26T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_button",
            "loc_001",
            None,
            "Button",
            "button",
            True,
            states={button.key: button, supported.key: supported},
        )
        inventory = BridgeInventory(
            1, True, "0.1.79", "4", {}, {}, {device.device_id: device}
        )
        runtime = SmartThingsWebRuntime(SimpleNamespace(), "loc_001", inventory)
        entity = SmartThingsWebButtonEvent(runtime, device, button)
        await entity.async_added_to_hass()

        for sequence in (2, 3):
            self.assertTrue(
                runtime.apply_state(
                    {
                        "type": "state",
                        "sequence": sequence,
                        "deviceId": "dev_button",
                        "state": {
                            "component": "main",
                            "capability": "button",
                            "attribute": "button",
                            "value": "pushed",
                            "updatedAt": "2026-08-26T00:00:00Z",
                        },
                    }
                )
            )

        self.assertEqual(entity.triggered, ["pushed", "pushed"])
        self.assertEqual(entity.write_count, 2)

    async def test_firmware_fields_form_one_read_only_update_entity(self) -> None:
        values = {
            "currentVersion": "1.0 (100)",
            "availableVersion": "1.1 (110)",
            "updateAvailable": True,
            "state": "normalOperation",
            "lastUpdateStatus": "success",
        }
        states = [
            BridgeState(
                "main",
                "firmwareUpdate",
                attribute,
                value,
                None,
                "2026-08-26T00:00:00Z",
            )
            for attribute, value in values.items()
        ]
        device = BridgeDevice(
            "dev_firmware",
            "loc_001",
            None,
            "Sensor",
            "sensor",
            True,
            states={state.key: state for state in states},
        )
        runtime = SimpleNamespace(
            inventory=SimpleNamespace(devices={device.device_id: device})
        )
        entity = SmartThingsWebFirmwareUpdate(runtime, device)

        self.assertEqual(entity.installed_version, "1.0 (100)")
        self.assertEqual(entity.latest_version, "1.1 (110)")
        self.assertTrue(entity.version_is_newer("1.1 (110)", "1.0 (100)"))
        self.assertEqual(entity.extra_state_attributes["lastUpdateStatus"], "success")


if __name__ == "__main__":
    unittest.main()
