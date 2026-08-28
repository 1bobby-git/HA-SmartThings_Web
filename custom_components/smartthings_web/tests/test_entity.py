"""Tests for push-to-entity listener delivery."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))

device_registry = ModuleType("homeassistant.helpers.device_registry")


class DeviceInfo(dict[str, object]):
    """Minimal DeviceInfo constructor used by the entity base."""

    def __init__(self, **kwargs: object) -> None:
        super().__init__(kwargs)


device_registry.DeviceInfo = DeviceInfo  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.device_registry"] = device_registry

entity_registry = ModuleType("homeassistant.helpers.entity_registry")
entity_registry.async_get = lambda _hass: None  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_registry"] = entity_registry

entity_helper = ModuleType("homeassistant.helpers.entity")


class Entity:
    """Minimal Home Assistant entity lifecycle surface."""

    def __init__(self) -> None:
        self.write_count = 0
        self.remove_callbacks: list[object] = []

    def async_write_ha_state(self) -> None:
        self.write_count += 1

    def async_on_remove(self, callback: object) -> None:
        self.remove_callbacks.append(callback)


entity_helper.Entity = Entity  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity"] = entity_helper

from smartthings_web.models import (  # noqa: E402
    BridgeDevice,
    BridgeDevicePresentation,
    BridgeInventory,
    BridgeState,
    SmartThingsWebRuntime,
)

entity_spec = importlib.util.spec_from_file_location(
    "smartthings_web.entity_under_test",
    PACKAGE_ROOT / "entity.py",
)
assert entity_spec is not None and entity_spec.loader is not None
entity_under_test = importlib.util.module_from_spec(entity_spec)
sys.modules[entity_spec.name] = entity_under_test
entity_spec.loader.exec_module(entity_under_test)
SmartThingsWebEntity = entity_under_test.SmartThingsWebEntity
SmartThingsWebDeviceEntity = entity_under_test.SmartThingsWebDeviceEntity
migrate_entity_original_name = entity_under_test.migrate_entity_original_name


class FakeEntityRegistry:
    """Minimal registry used to prove existing entity display-name migration."""

    def __init__(self) -> None:
        self.entry = type(
            "RegistryEntry",
            (),
            {
                "entity_id": "sensor.kitchen_refrigerator_temperature",
                "original_name": "Temperature (1)",
                "name": None,
            },
        )()
        self.updated: list[tuple[str, str]] = []

    def async_get_entity_id(self, domain: str, platform: str, unique_id: str) -> str | None:
        if (domain, platform, unique_id) == (
            "sensor",
            "smartthings_web",
            "dev_001_freezer_temperatureMeasurement_temperature",
        ):
            return self.entry.entity_id
        return None

    def async_get(self, entity_id: str) -> object | None:
        return self.entry if entity_id == self.entry.entity_id else None

    def async_update_entity(self, entity_id: str, *, original_name: str) -> None:
        self.updated.append((entity_id, original_name))
        self.entry.original_name = original_name


class SmartThingsWebEntityPushTests(unittest.IsolatedAsyncioTestCase):
    """Prove a Bridge state push reaches Home Assistant state writing."""

    def test_existing_generated_name_is_refined_without_overwriting_user_name(self) -> None:
        registry = FakeEntityRegistry()
        entity_under_test.er.async_get = lambda _hass: registry

        migrate_entity_original_name(
            object(),
            "sensor",
            "dev_001_freezer_temperatureMeasurement_temperature",
            "Temperature (냉동실)",
        )
        migrate_entity_original_name(
            object(),
            "sensor",
            "dev_001_freezer_temperatureMeasurement_temperature",
            "Temperature (냉동실)",
        )

        self.assertEqual(
            registry.updated,
            [
                (
                    "sensor.kitchen_refrigerator_temperature",
                    "Temperature (냉동실)",
                )
            ],
        )

    async def test_runtime_push_writes_entity_state_and_unsubscribes_on_remove(self) -> None:
        initial = BridgeState(
            "main",
            "relativeHumidityMeasurement",
            "humidity",
            51,
            "%",
            "2026-08-26T06:00:00.000Z",
        )
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Humidity sensor",
            "multi_sensor",
            True,
            states={initial.key: initial, battery.key: battery},
        )
        inventory = BridgeInventory(
            1,
            True,
            "0.1.77",
            "4:test",
            {},
            {},
            {device.device_id: device},
        )
        runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)
        entity = SmartThingsWebEntity(runtime, device, initial, None)
        unrelated = SmartThingsWebEntity(runtime, device, battery, None)
        device_entity = SmartThingsWebDeviceEntity(runtime, device, "device", None)
        Entity.__init__(entity)
        Entity.__init__(unrelated)
        Entity.__init__(device_entity)

        await entity.async_added_to_hass()
        await unrelated.async_added_to_hass()
        await device_entity.async_added_to_hass()
        changed = runtime.apply_state(
            {
                "schemaVersion": 1,
                "type": "state",
                "sequence": 2,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "relativeHumidityMeasurement",
                    "attribute": "humidity",
                    "value": 62.8,
                    "unit": "%",
                    "updatedAt": "2026-08-26T06:00:01.000Z",
                },
            }
        )

        self.assertTrue(changed)
        self.assertEqual(entity.write_count, 1)
        self.assertEqual(unrelated.write_count, 0)
        self.assertEqual(device_entity.write_count, 1)
        self.assertEqual(entity.bridge_state.value, 62.8)  # type: ignore[union-attr]
        self.assertEqual(len(entity.remove_callbacks), 1)

        remove = entity.remove_callbacks[0]
        assert callable(remove)
        remove()
        runtime.apply_state(
            {
                "schemaVersion": 1,
                "type": "state",
                "sequence": 3,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "relativeHumidityMeasurement",
                    "attribute": "humidity",
                    "value": 63.1,
                    "unit": "%",
                    "updatedAt": "2026-08-26T06:00:02.000Z",
                },
            }
        )
        self.assertEqual(entity.write_count, 1)
        self.assertEqual(unrelated.write_count, 0)
        self.assertEqual(device_entity.write_count, 2)

    def test_state_entities_keep_platform_icons_while_primary_entity_uses_artwork(self) -> None:
        state = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Humidity sensor",
            "multi_sensor",
            True,
            presentation=BridgeDevicePresentation(
                icon_url="https://client.smartthings.com/icons/oneui/contact/on",
                inactive_icon_url="https://client.smartthings.com/icons/oneui/contact/off",
            ),
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", BridgeInventory(1, True, "0.1.89", "4", {}, {}, {device.device_id: device})
        )

        entity = SmartThingsWebDeviceEntity(runtime, device, "sensor", None)
        state_entity = SmartThingsWebEntity(runtime, device, state, None)
        Entity.__init__(entity)
        Entity.__init__(state_entity)

        self.assertEqual(
            entity._attr_entity_picture, "https://client.smartthings.com/icons/oneui/contact/on"
        )
        self.assertNotIn("_attr_entity_picture", state_entity.__dict__)
        self.assertNotIn("_attr_icon", state_entity.__dict__)
        self.assertNotIn("_attr_name", state_entity.__dict__)

    def test_device_info_display_name_only_rewrites_room_clone_names(self) -> None:
        state = BridgeState(
            "main",
            "switch",
            "switch",
            "on",
            None,
            "2026-08-26T06:00:00.000Z",
        )

        def _device(name: str, room_id: str | None) -> BridgeDevice:
            return BridgeDevice(
                "dev_001",
                "loc_001",
                room_id,
                name,
                "speaker",
                True,
                states={state.key: state},
            )

        rooms = {"room_001": ("loc_001", "거실")}
        clone = _device("거실", "room_001")
        distinct = _device("거실 스피커 2", "room_001")
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.99", "4:test", {}, rooms, {clone.device_id: clone}),
        )
        empty_runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.99", "4:test", {}, {}, {distinct.device_id: distinct}),
        )

        clone_entity = SmartThingsWebDeviceEntity(runtime, clone, "device", None)
        distinct_entity = SmartThingsWebDeviceEntity(runtime, distinct, "device", None)
        no_room_entity = SmartThingsWebDeviceEntity(empty_runtime, distinct, "device", None)

        self.assertEqual(clone_entity._attr_device_info["name"], "스피커")
        self.assertEqual(distinct_entity._attr_device_info["name"], "거실 스피커 2")
        self.assertEqual(no_room_entity._attr_device_info["name"], "거실 스피커 2")
        self.assertEqual(clone.name, "거실")
        self.assertEqual(distinct.name, "거실 스피커 2")

    def test_explicit_state_entity_name_is_preserved(self) -> None:
        state = BridgeState(
            "main",
            "customCapability",
            "temperatureRange",
            "20-30",
            None,
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Humidity sensor",
            "multi_sensor",
            True,
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", BridgeInventory(1, True, "0.1.92", "4", {}, {}, {device.device_id: device})
        )

        state_entity = SmartThingsWebEntity(
            runtime, device, state, "Temperature Range"
        )

        self.assertEqual(state_entity._attr_name, "Temperature Range")

    def test_device_entity_picture_falls_back_to_inactive_icon_when_offline(self) -> None:
        state = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Humidity sensor",
            "multi_sensor",
            False,
            presentation=BridgeDevicePresentation(
                icon_url="https://client.smartthings.com/icons/oneui/contact/on",
                inactive_icon_url="https://client.smartthings.com/icons/oneui/contact/off",
            ),
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", BridgeInventory(1, True, "0.1.89", "4", {}, {}, {device.device_id: device})
        )

        entity = SmartThingsWebDeviceEntity(runtime, device, "sensor", None)
        Entity.__init__(entity)

        self.assertEqual(
            entity._attr_entity_picture,
            "https://client.smartthings.com/icons/oneui/contact/off",
        )

    def test_device_entity_uses_type_icon_when_only_animation_asset_exists(self) -> None:
        state = BridgeState(
            "main",
            "bridge",
            "status",
            "online",
            None,
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "hub_001",
            "loc_001",
            None,
            "SmartThings Hub",
            "unknown",
            True,
            presentation=BridgeDevicePresentation(
                asset_type="hub",
                animation_url="https://app-asset.samsungiotcloud.com/assets/icons/published/hub/hub.json",
            ),
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", BridgeInventory(1, True, "0.1.95", "4", {}, {}, {device.device_id: device})
        )

        entity = SmartThingsWebDeviceEntity(runtime, device, "status", None)
        state_entity = SmartThingsWebEntity(runtime, device, state, None)
        Entity.__init__(entity)
        Entity.__init__(state_entity)

        self.assertNotIn("_attr_entity_picture", entity.__dict__)
        self.assertEqual(entity._attr_icon, "mdi:hub")
        self.assertNotIn("_attr_icon", state_entity.__dict__)
        self.assertNotIn("_attr_entity_picture", state_entity.__dict__)

    def test_offline_laundry_appliance_keeps_pushed_state_entities_available(self) -> None:
        state = BridgeState(
            "main",
            "dryerOperatingState",
            "machineState",
            "stop",
            None,
            "2026-08-26T13:01:14.077Z",
        )
        dryer = BridgeDevice(
            "dryer_001",
            "loc_001",
            None,
            "Dryer",
            "dryer",
            False,
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.93", "4", {}, {}, {dryer.device_id: dryer}),
        )

        state_entity = SmartThingsWebEntity(runtime, dryer, state, "Machine State")
        control_entity = SmartThingsWebDeviceEntity(runtime, dryer, "switch", "Power")

        self.assertTrue(state_entity.available)
        self.assertFalse(control_entity.available)

    def test_offline_safety_sensor_does_not_reuse_stale_state_as_available(self) -> None:
        state = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-26T13:01:14.077Z",
        )
        contact = BridgeDevice(
            "contact_001",
            "loc_001",
            None,
            "Window sensor",
            "contact_sensor",
            False,
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(),
            "loc_001",
            BridgeInventory(1, True, "0.1.93", "4", {}, {}, {contact.device_id: contact}),
        )

        state_entity = SmartThingsWebEntity(runtime, contact, state, "Contact")

        self.assertFalse(state_entity.available)

    def test_entity_picture_ignores_unsafe_inactive_icon_when_online(self) -> None:
        state = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Humidity sensor",
            "multi_sensor",
            True,
            presentation=BridgeDevicePresentation(
                icon_url="javascript:alert(1)",
                inactive_icon_url="https://client.smartthings.com/icons/oneui/contact/off",
            ),
            states={state.key: state},
        )
        runtime = SmartThingsWebRuntime(
            object(), "loc_001", BridgeInventory(1, True, "0.1.89", "4", {}, {}, {device.device_id: device})
        )

        entity = SmartThingsWebDeviceEntity(runtime, device, "sensor", None)
        Entity.__init__(entity)

        self.assertEqual(
            entity._attr_entity_picture,
            "https://client.smartthings.com/icons/oneui/contact/off",
        )


if __name__ == "__main__":
    unittest.main()
