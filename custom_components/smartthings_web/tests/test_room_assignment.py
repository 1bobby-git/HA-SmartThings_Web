"""Tests for delayed room discovery and unambiguous existing-area matching."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location(
    "stw_room_assignment_test", Path(__file__).parents[1] / "room_assignment.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
match = module.matching_room_area
repair = module.repair_missing_device_area


def area(identifier, name):
    return SimpleNamespace(id=identifier, name=name)


class Registry:
    def __init__(self, device):
        self.device = device
        self.writes = []

    def async_get(self, identifier):
        return self.device if self.device and self.device.id == identifier else None

    def async_update_device(self, identifier, **changes):
        self.writes.append((identifier, changes))
        for key, value in changes.items():
            setattr(self.device, key, value)


class RoomAssignmentTests(unittest.TestCase):
    def test_exact_existing_room(self):
        target = area("bathroom", "화장실")
        self.assertIs(match("화장실", [target]), target)

    def test_unicode_and_whitespace(self):
        target = area("living", "Living Room")
        self.assertIs(match("  Ｌｉｖｉｎｇ\u00a0Room  ", [target]), target)

    def test_korean_decomposed_unicode(self):
        import unicodedata
        target = area("bathroom", "화장실")
        self.assertIs(match(unicodedata.normalize("NFD", "화장실"), [target]), target)

    def test_exact_preferred_over_normalized_collision(self):
        exact = area("one", "Room")
        self.assertIs(match("Room", [exact, area("two", "room")]), exact)

    def test_normalized_collision_is_not_guessed(self):
        self.assertIsNone(match(" ROOM ", [area("one", "Room"), area("two", "room")]))

    def test_substring_does_not_match(self):
        self.assertIsNone(match("화장실", [area("one", "안방 화장실")]))

    def test_empty_or_missing_room(self):
        self.assertIsNone(match("  ", [area("one", " ")]))
        self.assertIsNone(match("화장실", []))

    def test_delayed_room_repairs_existing_device_once(self):
        registry = Registry(SimpleNamespace(id="device", area_id=None, config_entry_id="entry"))
        self.assertFalse(repair(registry, "device", "entry", None))
        self.assertTrue(repair(registry, "device", "entry", "bathroom"))
        self.assertFalse(repair(registry, "device", "entry", "bathroom"))
        self.assertEqual(len(registry.writes), 1)

    def test_user_area_is_preserved(self):
        registry = Registry(SimpleNamespace(id="device", area_id="manual", config_entry_id="entry"))
        self.assertFalse(repair(registry, "device", "entry", "bathroom"))
        self.assertEqual(registry.writes, [])

    def test_other_entry_is_not_modified(self):
        registry = Registry(SimpleNamespace(id="device", area_id=None, config_entry_id="other"))
        self.assertFalse(repair(registry, "device", "entry", "bathroom"))

    def test_legacy_single_owner_is_supported(self):
        registry = Registry(SimpleNamespace(id="device", area_id=None, config_entries={"entry"}))
        self.assertTrue(repair(registry, "device", "entry", "bathroom"))

    def test_legacy_shared_device_is_preserved(self):
        registry = Registry(SimpleNamespace(id="device", area_id=None, config_entries={"entry", "other"}))
        self.assertFalse(repair(registry, "device", "entry", "bathroom"))

    def test_missing_device_does_not_write(self):
        registry = Registry(None)
        self.assertFalse(repair(registry, "device", "entry", "bathroom"))


class AreaRegistry:
    def __init__(self, areas):
        self.entries = list(areas)
        self.created = []

    def async_list_areas(self):
        return self.entries

    def async_get_or_create(self, name):
        item = area(f"created_{len(self.created)}", name)
        self.created.append(name)
        self.entries.append(item)
        return item


class ResolveRoomAreaTests(unittest.TestCase):
    def test_existing_canonical_name_is_reused(self):
        original = area("bathroom", "화장실")
        registry = AreaRegistry([original])
        self.assertIs(module.resolve_room_area(registry, " 화장실 "), original)
        self.assertEqual(registry.created, [])

    def test_ambiguous_normalized_name_is_not_created(self):
        registry = AreaRegistry([area("a", "Room"), area("b", "room")])
        self.assertIsNone(module.resolve_room_area(registry, " ROOM "))
        self.assertEqual(registry.created, [])

    def test_unknown_area_is_created_once(self):
        registry = AreaRegistry([])
        first = module.resolve_room_area(registry, " 화장실 ")
        self.assertIs(module.resolve_room_area(registry, "화장실"), first)
        self.assertEqual(registry.created, ["화장실"])

    def test_blank_room_does_not_create_an_area(self):
        registry = AreaRegistry([])
        self.assertIsNone(module.resolve_room_area(registry, " "))
        self.assertEqual(registry.created, [])

    def test_resolved_area_repairs_only_missing_assignment(self):
        areas = AreaRegistry([area("bathroom", "화장실")])
        devices = Registry(SimpleNamespace(id="device", area_id=None, config_entry_id="entry"))
        target = module.resolve_room_area(areas, "화장실")
        self.assertTrue(repair(devices, "device", "entry", target.id))
        self.assertFalse(repair(devices, "device", "entry", target.id))
        self.assertEqual(devices.writes, [("device", {"area_id": "bathroom"})])


if __name__ == "__main__":
    unittest.main()
