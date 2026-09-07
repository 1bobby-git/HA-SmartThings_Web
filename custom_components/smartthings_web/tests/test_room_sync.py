"""Run the actual registration callback against small HA registry stand-ins."""
from __future__ import annotations

import ast
from copy import deepcopy
from pathlib import Path
import sys
from types import SimpleNamespace as NS
import unittest

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from models import (BridgeDevice, BridgeState, BridgeInventory, SmartThingsWebRuntime,
                    BridgeCommandArgument, BridgeCommandDescriptor,
                    BridgeDevicePresentation, device_model, is_people_counter)
from room_assignment import resolve_room_area, sync_device_area


class Areas:
    def __init__(self):
        self.items = [NS(id="living", name="거실"), NS(id="bathroom", name="화장실")]

    def async_list_areas(self):
        return self.items

    def async_get_or_create(self, name):
        result = NS(id=f"new_{len(self.items)}", name=name)
        self.items.append(result)
        return result


class Devices:
    def __init__(self, area="living", owner="entry"):
        self.device = NS(id="ha_device", area_id=area, config_entry_id=owner, manufacturer=None)
        self.writes = []

    def async_get(self, identifier):
        return self.device if identifier == self.device.id else None

    def async_get_or_create(self, **kwargs):
        return self.device

    def async_update_device(self, identifier, **kwargs):
        assert identifier == self.device.id
        self.writes.append(kwargs)
        for key, value in kwargs.items():
            setattr(self.device, key, value)


def registration(follow=True, source="advanced", ready=True):
    device = BridgeDevice("dev_001", "loc_001", "identifier_room", "Counter", "motion_sensor_1", True,
                          room_source=source)
    inventory = BridgeInventory(1, ready, "test", "5", {},
                                {"identifier_room": ("loc_001", "화장실")}, {device.device_id: device})
    runtime = SmartThingsWebRuntime(object(), "loc_001", inventory)
    devices, areas = Devices(), Areas()
    scope = dict(dr=NS(async_get=lambda _: devices), ar=NS(async_get=lambda _: areas),
                 hass=object(), runtime=runtime, entry=NS(options={"sync_rooms": follow}, entry_id="entry"),
                 location_id="loc_001", registered_metadata={}, CONF_SYNC_ROOMS="sync_rooms", DEFAULT_SYNC_ROOMS=True,
                 resolve_room_area=resolve_room_area, sync_device_area=sync_device_area,
                 room_free_display_name=lambda _r, d: d.name,
                 device_info_for=lambda d, **kw: {"name": d.name, "model": device_model(d)})
    tree = ast.parse((ROOT / "__init__.py").read_text())
    setup = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_setup_entry")
    callback = next(n for n in setup.body if isinstance(n, ast.FunctionDef) and n.name == "register_devices")
    exec(compile(ast.Module(body=[callback], type_ignores=[]), str(ROOT / "__init__.py"), "exec"), scope)
    return scope["register_devices"], runtime, devices, areas


class RoomSyncTests(unittest.TestCase):
    def test_existing_wrong_area_is_repaired_once_after_opt_in(self):
        run, _, devices, _ = registration()
        run(); run()
        self.assertEqual(devices.writes, [{"area_id": "bathroom"}])

    def test_default_preserves_existing_manual_or_legacy_area(self):
        run, _, devices, _ = registration(follow=False)
        run()
        self.assertEqual(devices.writes, [])

    def test_cached_or_unconfirmed_source_cannot_move_device(self):
        for source, ready in [(None, True), ("web", True), ("advanced", False)]:
            with self.subTest(source=source, ready=ready):
                run, _, devices, _ = registration(source=source, ready=ready)
                run()
                self.assertEqual(devices.writes, [])

    def test_late_proof_retries_even_when_room_id_and_name_did_not_change(self):
        run, runtime, devices, _ = registration(source=None)
        run()
        runtime.inventory.devices["dev_001"].room_source = "advanced"
        run()
        self.assertEqual(devices.device.area_id, "bathroom")

    def test_ready_transition_retries_registration(self):
        run, runtime, devices, _ = registration(ready=False)
        run(); runtime.inventory.ready = True; run()
        self.assertEqual(devices.device.area_id, "bathroom")

    def test_other_location_room_cannot_move_or_clear(self):
        run, runtime, devices, _ = registration()
        runtime.inventory.rooms["identifier_room"] = ("loc_002", "화장실")
        run()
        self.assertEqual(devices.writes, [])

    def test_unknown_room_cannot_clear_existing_area(self):
        run, runtime, devices, _ = registration()
        runtime.inventory.rooms.clear()
        run()
        self.assertEqual(devices.writes, [])

    def test_explicit_confirmed_null_room_clears_only_in_follow_mode(self):
        for follow in [False, True]:
            run, runtime, devices, _ = registration(follow=follow)
            runtime.inventory.devices["dev_001"].room_id = None
            run()
            self.assertEqual(devices.device.area_id, None if follow else "living")

    def test_ambiguous_area_names_neither_move_nor_clear(self):
        run, runtime, devices, areas = registration()
        runtime.inventory.rooms["identifier_room"] = ("loc_001", " ROOM ")
        areas.items.extend([NS(id="a", name="Room"), NS(id="b", name="room")])
        run()
        self.assertEqual(devices.writes, [])
        self.assertEqual(len(areas.items), 4)

    def test_other_owner_and_legacy_shared_devices_are_untouched(self):
        for device in [NS(id="ha_device", area_id="living", config_entry_id="other"),
                       NS(id="ha_device", area_id="living", config_entries={"entry", "other"})]:
            registry = Devices(); registry.device = device
            self.assertFalse(sync_device_area(registry, "ha_device", "entry", "bathroom",
                                             follow_room=True, room_confirmed=True))
            self.assertEqual(registry.writes, [])

    def test_room_move_keeps_registry_identity(self):
        run, runtime, devices, _ = registration()
        run()
        runtime.inventory.rooms["identifier_room"] = ("loc_001", "거실")
        run()
        self.assertEqual(devices.device.id, "ha_device")
        self.assertEqual(devices.writes, [{"area_id": "bathroom"}, {"area_id": "living"}])

    def test_inventory_provenance_change_notifies_discovery_and_is_not_sticky(self):
        _, runtime, _, _ = registration(source=None)
        callbacks=[]; runtime.subscribe(lambda: callbacks.append(1))
        latest=deepcopy(runtime.inventory); latest.sequence += 1
        latest.devices["dev_001"].room_source = "advanced"
        runtime.apply_inventory(latest)
        self.assertEqual(callbacks, [1])
        latest=deepcopy(runtime.inventory); latest.sequence += 1
        latest.devices["dev_001"].room_source = None
        runtime.apply_inventory(latest)
        self.assertEqual(callbacks, [1, 1])
        self.assertIsNone(runtime.inventory.devices["dev_001"].room_source)


class CounterModelTests(unittest.TestCase):
    def device(self):
        return BridgeDevice("dev_001", "loc_001", None, "Device", "motion_sensor_1", True,
                            presentation=BridgeDevicePresentation(asset_type="motion_sensor_1"))

    def test_reported_model_precedes_generic_icon_type(self):
        device=self.device()
        state=BridgeState("main", "hardware", "mnmo", "Example Counter 100", None, None)
        device.states[state.key]=state
        self.assertEqual(device_model(device), "Example Counter 100")

    def test_actual_people_state_precedes_motion_presentation(self):
        device=self.device()
        state=BridgeState("main", "custom", "peopleCounter", 0, None, None)
        device.states[state.key]=state
        self.assertEqual(device_model(device), "재실 센서 (인원 카운터)")

    def test_observed_counter_contract_precedes_motion_presentation(self):
        device=self.device()
        command=BridgeCommandDescriptor("main", "identifier_counter", 1, "setPeopleCounter",
            (BridgeCommandArgument("value", True, False, {"type":"integer", "minimum":0, "maximum":65535}),),
            "advanced", "state", "setPeopleCounter", "capability")
        device.commands=(command,)
        self.assertTrue(is_people_counter(device))
        self.assertEqual(device_model(device), "재실 센서 (인원 카운터)")
        self.assertEqual(device.states, {})  # No guessed reading/binding is created.

    def test_label_and_motion_icon_alone_are_not_counter_evidence(self):
        device=self.device(); device.name="카운터센서"
        self.assertFalse(is_people_counter(device))
        self.assertEqual(device_model(device), "모션 센서")

    def test_boolean_or_negative_people_values_are_not_count_evidence(self):
        for value in [True, -1, "3"]:
            device=self.device()
            state=BridgeState("main", "custom", "peopleCounter", value, None, None)
            device.states[state.key]=state
            self.assertFalse(is_people_counter(device))


class RoomRegistryEventTests(unittest.IsolatedAsyncioTestCase):
    async def make_subscription(self, follow=True):
        import asyncio
        from types import ModuleType
        from unittest.mock import patch
        from room_assignment import subscribe_room_registry_changes
        run, runtime, devices, areas = registration(follow=follow)
        handlers = {}
        bus = NS(async_listen=lambda name, callback: (handlers.__setitem__(name, callback) or
                                                    (lambda: handlers.pop(name, None))))
        registry_module = ModuleType("homeassistant.helpers.device_registry")
        registry_module.async_get = lambda _: devices
        helpers = ModuleType("homeassistant.helpers")
        helpers.device_registry = registry_module
        hass = NS(loop=asyncio.get_running_loop(), bus=bus)
        with patch.dict(sys.modules, {"homeassistant.helpers": helpers,
                                     "homeassistant.helpers.device_registry": registry_module}):
            remove = subscribe_room_registry_changes(hass, "entry", run,
                            run.__globals__["registered_metadata"].clear)
        self.addCleanup(remove)
        run()
        return run, runtime, devices, areas, handlers, remove

    async def test_external_device_area_change_reconciles_unchanged_topology(self):
        import asyncio
        run, _, devices, _, handlers, _ = await self.make_subscription()
        devices.device.area_id = "living"
        run()  # Metadata cache still applies without an event.
        self.assertEqual(devices.device.area_id, "living")
        for _ in range(25):
            await handlers["device_registry_updated"](NS(event_type="device_registry_updated",
                data={"action": "update", "device_id": "ha_device", "changes": {"area_id": "bathroom"}}))
        await asyncio.sleep(0)
        self.assertEqual(devices.device.area_id, "bathroom")
        self.assertEqual(len(devices.writes), 2)  # One initial write plus one coalesced repair.

    async def test_area_edit_retries_previously_ambiguous_name(self):
        import asyncio
        run, runtime, devices, areas, handlers, _ = await self.make_subscription()
        runtime.inventory.rooms["identifier_room"] = ("loc_001", " ROOM ")
        areas.items.extend([NS(id="a", name="Room"), NS(id="b", name="room")])
        run()
        self.assertEqual(devices.device.area_id, "bathroom")
        areas.items = [area for area in areas.items if area.id != "b"]
        await handlers["area_registry_updated"](NS(event_type="area_registry_updated", data={"action": "remove"}))
        await asyncio.sleep(0)
        self.assertEqual(devices.device.area_id, "a")

    async def test_explicit_opt_out_retains_manual_device_area_after_event(self):
        import asyncio
        _, _, devices, _, handlers, _ = await self.make_subscription(follow=False)
        await handlers["device_registry_updated"](NS(event_type="device_registry_updated",
            data={"action": "update", "device_id": "ha_device", "changes": {"area_id": None}}))
        await asyncio.sleep(0)
        self.assertEqual(devices.device.area_id, "living")
        self.assertEqual(devices.writes, [])

    async def test_unrelated_device_changes_and_self_events_do_not_write_again(self):
        import asyncio
        _, _, devices, _, handlers, _ = await self.make_subscription()
        for data in [
            {"action": "update", "device_id": "another", "changes": {"area_id": None}},
            {"action": "update", "device_id": "ha_device", "changes": {"name": "Old"}},
            {"action": "update", "device_id": "ha_device", "changes": {"area_id": "living"}},
        ]:
            await handlers["device_registry_updated"](NS(event_type="device_registry_updated", data=data))
        await asyncio.sleep(0)
        self.assertEqual(len(devices.writes), 1)

    async def test_unload_cancels_pending_callback_and_listeners(self):
        import asyncio
        _, _, devices, _, handlers, remove = await self.make_subscription()
        devices.device.area_id = "living"
        await handlers["area_registry_updated"](NS(event_type="area_registry_updated", data={"action": "update"}))
        remove()
        await asyncio.sleep(0)
        self.assertEqual(devices.device.area_id, "living")
        self.assertEqual(handlers, {})

    def test_absent_option_automatically_repairs_verified_room(self):
        run, _, devices, _ = registration()
        run.__globals__["entry"].options.clear()
        run()
        self.assertEqual(devices.device.area_id, "bathroom")


if __name__ == "__main__":
    unittest.main()
