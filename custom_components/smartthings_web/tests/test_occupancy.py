"""Exercise real occupancy entities with isolated HA stand-ins (no account access)."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import unittest


class OccupancyIsolationTest(unittest.TestCase):
    def test_occupancy_in_isolated_runtime(self):
        result = subprocess.run([sys.executable, __file__, "--isolated"],
                                capture_output=True, text=True, timeout=40, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


def isolated_suite():
    import asyncio
    from copy import deepcopy
    from types import ModuleType, SimpleNamespace as NS
    from unittest.mock import AsyncMock

    root = Path(__file__).resolve().parents[1]
    package = ModuleType("smartthings_web")
    package.__path__ = [str(root)]
    package.SmartThingsWebConfigEntry = object
    sys.modules["smartthings_web"] = package
    for name in ("homeassistant", "homeassistant.components", "homeassistant.helpers"):
        module = ModuleType(name); module.__path__ = []; sys.modules[name] = module

    class Entity:
        def async_on_remove(self, remove):
            self.remove_callback = remove
        def async_write_ha_state(self):
            self.writes = getattr(self, "writes", 0) + 1

    classes = NS(CO="carbon_monoxide", DOOR="door", GAS="gas", MOISTURE="moisture",
                 MOTION="motion", MOVING="moving", OCCUPANCY="occupancy", OPENING="opening",
                 POWER="power", PRESENCE="presence", PROBLEM="problem", SMOKE="smoke",
                 SOUND="sound", TAMPER="tamper", WINDOW="window")
    for name, values in {
        "homeassistant.components.binary_sensor": {"BinarySensorDeviceClass": classes, "BinarySensorEntity": type("BinarySensorEntity", (), {})},
        "homeassistant.const": {"EntityCategory": NS(DIAGNOSTIC="diagnostic")},
        "homeassistant.core": {"HomeAssistant": object},
        "homeassistant.helpers.entity_platform": {"AddConfigEntryEntitiesCallback": object},
        "homeassistant.helpers.entity": {"Entity": Entity},
        "homeassistant.helpers.device_registry": {"DeviceInfo": dict},
        "homeassistant.helpers.entity_registry": {"async_get": lambda _: NS(async_get_entity_id=lambda *args: None)},
        "homeassistant.util": {"slugify": lambda value: value.lower().replace(" ", "_")},
    }.items():
        module = ModuleType(name); module.__dict__.update(values); sys.modules[name] = module

    from smartthings_web.binary_sensor import (async_setup_entry, SmartThingsWebOccupancySensor,
        SmartThingsWebBinarySensor, BINARY_STATES)
    from smartthings_web.models import (BridgeState, BridgeDevice, BridgeInventory,
        SmartThingsWebRuntime, BridgeAdvancedDeviceMetadata, BridgeCommandDescriptor,
        BridgeCommandArgument, device_model, occupancy_source_states, entity_unique_id)
    from smartthings_web.bridge_client import parse_inventory

    def state(attribute="peopleCounter", value=0, component="identifier_main", capability="identifier_counter"):
        return BridgeState(component, capability, attribute, value, None,
                           "2026-09-07T00:00:00Z", component_role="main")

    class Cases(unittest.IsolatedAsyncioTestCase):
        def setUp(self):
            self.state = state()
            self.device = BridgeDevice("dev_344", "loc_001", "identifier_room", "Counter", "motion_sensor_1", True,
                                       states={self.state.key: self.state})
            self.runtime = SmartThingsWebRuntime(NS(async_execute_command=AsyncMock()), "loc_001",
                BridgeInventory(1, True, "test", "5", {}, {}, {self.device.device_id: self.device}))
            self.entity = SmartThingsWebOccupancySensor(self.runtime, self.device, self.state)

        def test_zero_is_clear_positive_is_occupied_and_no_state_is_mutated(self):
            self.assertEqual(self.entity._attr_device_class, "occupancy")
            self.assertIs(self.entity.is_on, False)
            for value in (1, 3, 65535, 3.0):
                self.state.value = value
                before = deepcopy(self.device.states)
                self.assertIs(self.entity.is_on, True)
                self.assertEqual(self.device.states, before)
            self.runtime.client.async_execute_command.assert_not_called()

        def test_invalid_count_is_unknown_not_clear(self):
            for value in (None, -1, True, False, "0", "3", 0.5, float("nan"), float("inf"), 2**53, {}, []):
                with self.subTest(value=value):
                    self.state.value = value
                    self.assertIsNone(self.entity.is_on)
                    self.assertTrue(self.entity.available)

        async def test_counter_device_discovery_once_and_existing_state_ids_preserved(self):
            added = []
            initial_id = entity_unique_id(self.device.device_id, self.state)
            entry = NS(runtime_data=self.runtime, async_on_unload=lambda cb: None)
            await async_setup_entry(None, entry, added.extend)
            self.assertEqual(len(added), 1)
            self.runtime._notify_listeners()
            self.assertEqual(len(added), 1)
            self.assertEqual(added[0]._attr_unique_id, "dev_344_identifier_main_occupancy")
            self.assertNotEqual(added[0]._attr_unique_id, initial_id)
            self.assertEqual(entity_unique_id(self.device.device_id, self.state), initial_id)

        async def test_late_count_state_and_other_locations(self):
            self.device.states.clear()
            other = deepcopy(self.device); other.device_id = "dev_999"; other.location_id = "loc_002"
            other.states = {self.state.key: self.state}
            self.runtime.inventory.devices[other.device_id] = other
            added = []
            await async_setup_entry(None, NS(runtime_data=self.runtime, async_on_unload=lambda cb: None), added.extend)
            self.assertEqual(added, [])
            self.device.states[self.state.key] = self.state
            self.runtime._notify_listeners()
            self.assertEqual(len(added), 1)
            self.assertEqual(added[0].device_id, "dev_344")

        def test_command_catalog_without_reading_does_not_invent_occupancy(self):
            self.device.states.clear()
            self.device.commands = (BridgeCommandDescriptor("identifier_main", "identifier_counter", 1,
                "setPeopleCounter", (BridgeCommandArgument("value", True, False,
                {"type": "integer", "minimum": 0, "maximum": 65535}),),
                "advanced", "state", "setPeopleCounter", "capability"),)
            self.assertEqual(device_model(self.device), "재실 센서 (인원 카운터)")
            self.assertEqual(occupancy_source_states(self.device), [])
            self.assertIsNone(self.entity.is_on)

        def test_explicit_occupancy_replaces_count_source_without_identity_change(self):
            original = self.entity._attr_unique_id
            self.state.value = 7
            direct = state("occupancy", "unoccupied", capability="identifier_occupancy")
            self.device.states[direct.key] = direct
            self.assertIs(self.entity.is_on, False)
            self.assertEqual(self.entity._attr_unique_id, original)
            self.assertEqual(len(occupancy_source_states(self.device)), 1)
            self.assertFalse(self.entity.extra_state_attributes["smartthings_derived"])
            fresh = SmartThingsWebOccupancySensor(self.runtime, self.device, direct)
            self.assertEqual(fresh._attr_unique_id, original)

        def test_explicit_unknown_does_not_fall_back_to_count(self):
            self.state.value = 7
            direct = state("occupancy", None, capability="identifier_occupancy")
            self.device.states[direct.key] = direct
            self.assertIsNone(self.entity.is_on)

        def test_multiple_sources_are_ambiguous_not_added_together(self):
            duplicate = state(value=5, capability="identifier_othercounter")
            self.device.states[duplicate.key] = duplicate
            self.assertFalse(self.entity.available)
            self.assertIsNone(self.entity.is_on)
            explicit = state("occupancy", True)
            self.device.states[explicit.key] = explicit
            self.assertTrue(self.entity.available)
            self.assertIs(self.entity.is_on, True)
            duplicate = state("occupancy", False, capability="identifier_duplicate")
            self.device.states[duplicate.key] = duplicate
            self.assertFalse(self.entity.available)

        def test_components_are_independent(self):
            child = state(value=5, component="identifier_child")
            self.device.states[child.key] = child
            other = SmartThingsWebOccupancySensor(self.runtime, self.device, child)
            self.assertIs(self.entity.is_on, False)
            self.assertIs(other.is_on, True)
            self.assertNotEqual(self.entity._attr_unique_id, other._attr_unique_id)

        def test_offline_removed_and_missing_device_unavailable(self):
            self.device.online = False
            self.assertFalse(self.entity.available)
            self.device.online = True
            self.device.states.clear()
            self.assertFalse(self.entity.available)
            self.runtime.inventory.devices.clear()
            self.assertFalse(self.entity.available)
            self.assertIsNone(self.entity.is_on)

        def test_device_moved_to_another_location_is_unavailable(self):
            self.state.value = 3
            self.device.location_id = "loc_002"
            self.assertFalse(self.entity.available)
            self.assertIsNone(self.entity.is_on)
            self.assertIsNone(self.entity.extra_state_attributes["smartthings_occupancy_source"])

        async def test_device_subscription_tracks_new_source_and_unsubscribes(self):
            await self.entity.async_added_to_hass()
            self.state.value = 2
            self.runtime._notify_listeners(device_ids={"dev_344"}, notify_global=False)
            self.assertEqual(self.entity.writes, 1)
            self.assertIs(self.entity.is_on, True)
            self.entity.remove_callback()
            self.runtime._notify_listeners(device_ids={"dev_344"}, notify_global=False)
            self.assertEqual(self.entity.writes, 1)

        def test_motion_freeze_direction_and_mobile_presence_do_not_imply_occupancy(self):
            self.device.states.clear()
            for attr, value in [("motion", "active"), ("presence", "present"), ("freeze", "on"), ("inOutDir", "ready")]:
                sample = state(attr, value)
                self.device.states[sample.key] = sample
            self.assertEqual(occupancy_source_states(self.device), [])
            for attr, expected in [("motion", "motion"), ("presence", "presence")]:
                sample = next(s for s in self.device.states.values() if s.attribute == attr)
                old = SmartThingsWebBinarySensor(self.runtime, self.device, sample, BINARY_STATES[attr])
                self.assertEqual(old._attr_device_class, expected)

        def test_explicit_occupancy_encodings_and_invalid_values(self):
            direct = state("occupancy", None)
            self.device.states = {direct.key: direct}
            for value in (True, 1, "occupied", "present", "on", "detected"):
                direct.value = value; self.assertIs(self.entity.is_on, True)
            for value in (False, 0, "unoccupied", "not present", "off", "clear"):
                direct.value = value; self.assertIs(self.entity.is_on, False)
            for value in (None, "unknown", "ready", "active", 2, {}):
                direct.value = value; self.assertIsNone(self.entity.is_on)

        def test_categories_inform_display_not_sensor_state(self):
            self.device.states.clear()
            self.device.advanced = BridgeAdvancedDeviceMetadata(sensor_categories=(("identifier_main", ("PresenceSensor",)),))
            self.assertEqual(device_model(self.device), "재실 센서")
            self.assertEqual(occupancy_source_states(self.device), [])
            self.device.advanced = BridgeAdvancedDeviceMetadata(sensor_categories=(("identifier_main", ("MobilePresence", "PresenceSensor")),))
            self.assertNotEqual(device_model(self.device), "재실 센서")

        def test_reported_hardware_model_is_retained(self):
            model = state("mnmo", "Example Model")
            self.device.states[model.key] = model
            self.assertEqual(device_model(self.device), "Example Model")

        def test_category_parser_only_copies_public_names_and_pseudonyms(self):
            base = {"schemaVersion": 1, "devices": [{"id": "dev_001", "locationId": "loc_001", "name": "Device",
                "states": [], "advanced": {"sensorCategories": {"identifier_main": ["PresenceSensor"]},
                "privateField": "not copied"}}]}
            parsed = parse_inventory(base).devices["dev_001"]
            self.assertEqual(parsed.advanced.sensor_categories, (("identifier_main", ("PresenceSensor",)),))
            self.assertEqual(device_model(parsed), "재실 센서")
            for bad in ({"raw-id": ["PresenceSensor"]}, {"identifier_main": ["PrivateCategory"]},
                        {"identifier_main": "PresenceSensor"}, {"identifier_main": [{}]}):
                base["devices"][0]["advanced"]["sensorCategories"] = bad
                self.assertIsNone(parse_inventory(base).devices["dev_001"].advanced)

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Cases)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    isolated_suite() if "--isolated" in sys.argv else unittest.main()
