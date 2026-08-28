"""Regression tests for SmartThings Web setup migrations."""

from __future__ import annotations

from collections.abc import Callable
from enum import Enum
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)


def _install_homeassistant_stubs() -> None:
    homeassistant = ModuleType("homeassistant")
    sys.modules.setdefault("homeassistant", homeassistant)

    config_entries = ModuleType("homeassistant.config_entries")

    class ConfigEntry:
        @classmethod
        def __class_getitem__(cls, _item: object) -> type["ConfigEntry"]:
            return cls

    config_entries.ConfigEntry = ConfigEntry  # type: ignore[attr-defined]
    sys.modules["homeassistant.config_entries"] = config_entries

    const = ModuleType("homeassistant.const")

    class Platform(str, Enum):
        ALARM_CONTROL_PANEL = "alarm_control_panel"
        BINARY_SENSOR = "binary_sensor"
        BUTTON = "button"
        CLIMATE = "climate"
        COVER = "cover"
        EVENT = "event"
        FAN = "fan"
        IMAGE = "image"
        LIGHT = "light"
        MEDIA_PLAYER = "media_player"
        NUMBER = "number"
        SCENE = "scene"
        SELECT = "select"
        SENSOR = "sensor"
        SWITCH = "switch"
        UPDATE = "update"

    const.Platform = Platform  # type: ignore[attr-defined]
    sys.modules["homeassistant.const"] = const

    core = ModuleType("homeassistant.core")
    core.HomeAssistant = object  # type: ignore[attr-defined]
    sys.modules["homeassistant.core"] = core

    exceptions = ModuleType("homeassistant.exceptions")
    exceptions.ConfigEntryAuthFailed = type("ConfigEntryAuthFailed", (Exception,), {})
    exceptions.ConfigEntryNotReady = type("ConfigEntryNotReady", (Exception,), {})
    sys.modules["homeassistant.exceptions"] = exceptions

    helpers = ModuleType("homeassistant.helpers")
    sys.modules["homeassistant.helpers"] = helpers

    device_registry = ModuleType("homeassistant.helpers.device_registry")

    class DeviceInfo(dict[str, object]):
        def __init__(self, **kwargs: object) -> None:
            super().__init__(kwargs)

    device_registry.DeviceInfo = DeviceInfo  # type: ignore[attr-defined]
    device_registry.async_get = lambda _hass: SimpleNamespace(devices=[])  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.device_registry"] = device_registry

    entity = ModuleType("homeassistant.helpers.entity")
    entity.Entity = object  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.entity"] = entity

    entity_registry = ModuleType("homeassistant.helpers.entity_registry")
    entity_registry.async_get = lambda _hass: None  # type: ignore[attr-defined]
    entity_registry.async_entries_for_config_entry = lambda _registry, _entry_id: []  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.entity_registry"] = entity_registry

    issue_registry = ModuleType("homeassistant.helpers.issue_registry")
    issue_registry.IssueSeverity = SimpleNamespace(ERROR="error")  # type: ignore[attr-defined]
    issue_registry.async_create_issue = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    issue_registry.async_delete_issue = lambda *_args, **_kwargs: None  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.issue_registry"] = issue_registry

    aiohttp_client = ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda _hass: None  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client

    util = ModuleType("homeassistant.util")

    def _stub_slugify(value: object) -> str:
        import re as _re

        text = str(value).strip().lower()
        text = _re.sub(r"(?u)[^\w\s-]", "", text)
        return _re.sub(r"[\s_-]+", "_", text)

    util.slugify = _stub_slugify  # type: ignore[attr-defined]
    sys.modules["homeassistant.util"] = util

    area_registry_module = ModuleType("homeassistant.helpers.area_registry")

    class FakeAreaRegistry:
        areas = [
            SimpleNamespace(id="deiteorum"),
            SimpleNamespace(id="geosil"),
        ]

    area_registry_module.async_get = lambda _hass: FakeAreaRegistry()  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.area_registry"] = area_registry_module


_install_homeassistant_stubs()

from smartthings_web.__init__ import (  # noqa: E402
    _async_update_repairs,
    _control_mode,
    _event_loop,
    _migrate_entity_registry,
    _repair_loop,
    _subscribe_entity_registry_migration,
)
from smartthings_web.bridge_client import BridgeAuthError, BridgeClientError  # noqa: E402
from smartthings_web.const import (  # noqa: E402
    CONF_CONTROL_MODE,
    CONF_LOCATION_ID,
    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
    DOMAIN,
)
from smartthings_web.models import BridgeControl, BridgeDevice, BridgeInventory, BridgeState  # noqa: E402
import smartthings_web.__init__ as integration  # noqa: E402
import smartthings_web.naming as naming_module  # noqa: E402


class FakeRegistry:
    """Minimal entity registry surface used by setup migration."""

    def __init__(self, entries: list[SimpleNamespace]) -> None:
        self.entries = entries
        self.removed: list[str] = []
        self.updated: list[tuple[str, str]] = []
        self.renamed: list[tuple[str, str]] = []

    def async_remove(self, entity_id: str) -> None:
        self.removed.append(entity_id)
        self.entries = [e for e in self.entries if e.entity_id != entity_id]

    def async_get_entity_id(self, domain: str, platform: str, unique_id: str) -> str | None:
        for entry in self.entries:
            if entry.domain == domain and entry.platform == platform and entry.unique_id == unique_id:
                return entry.entity_id
        return None

    def async_get(self, entity_id: str) -> SimpleNamespace | None:
        return next(
            (entry for entry in self.entries if entry.entity_id == entity_id),
            None,
        )

    def async_get_or_create(
        self,
        domain: str,
        platform: str,
        unique_id: str,
        **kwargs: object,
    ) -> SimpleNamespace:
        entity_id = self.async_get_entity_id(domain, platform, unique_id)
        if entity_id is None:
            raise AssertionError("test registry must not create rows during migration")
        entry = self.async_get(entity_id)
        if entry is None:
            raise AssertionError(entity_id)
        for field_name, value in kwargs.items():
            if field_name == "config_entry":
                continue
            setattr(entry, field_name, value)
        return entry

    def async_update_entity(
        self,
        entity_id: str,
        *,
        new_unique_id: str | None = None,
        new_entity_id: str | None = None,
    ) -> None:
        entry = next((e for e in self.entries if e.entity_id == entity_id), None)
        if entry is None:
            raise KeyError(entity_id)
        if new_unique_id is not None:
            entry.unique_id = new_unique_id
            self.updated.append((entity_id, new_unique_id))
        if new_entity_id is not None:
            entry.entity_id = new_entity_id
            self.renamed.append((entity_id, new_entity_id))


class EntityRegistryMigrationTests(unittest.TestCase):
    """Keep stale fan cleanup tightly scoped to this config entry."""

    def test_removes_only_stale_fan_entities_for_current_location_devices(self) -> None:
        registry = FakeRegistry(
            [
                entity("fan.mood_light", "fan", "dev_light_fan"),
                entity("fan.air_purifier", "fan", "dev_purifier_fan"),
                entity("fan.other_location", "fan", "dev_other_fan"),
                entity("fan.custom", "fan", "custom_unique_id"),
                entity("sensor.mood_light_level", "sensor", "dev_light_fan"),
                entity("fan.other_integration", "fan", "dev_light_fan", platform="other"),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.31",
                protocol_version="1",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_light": level_only_device("dev_light", "loc_001", "Mood Light"),
                    "dev_purifier": fan_device("dev_purifier", "loc_001", "Air Purifier"),
                    "dev_other": level_only_device("dev_other", "loc_002", "Other Light"),
                },
            ),
        )

        self.assertEqual(registry.removed, ["fan.mood_light"])
        self.assertEqual(registry.updated, [])

    def test_removes_only_stale_media_player_entities_for_current_location_devices(self) -> None:
        registry = FakeRegistry(
            [
                entity("media_player.ari", "media_player", "dev_ari_media_player"),
                entity("media_player.speaker", "media_player", "dev_speaker_media_player"),
                entity("media_player.other_location", "media_player", "dev_other_media_player"),
                entity("media_player.custom", "media_player", "custom_unique_id"),
                entity(
                    "media_player.other_integration",
                    "media_player",
                    "dev_ari_media_player",
                    platform="other",
                ),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.95",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_ari": audio_accessory_device("dev_ari", "loc_001", "아리"),
                    "dev_speaker": media_device("dev_speaker", "loc_001", "거실 스피커"),
                    "dev_other": audio_accessory_device("dev_other", "loc_002", "다른 아리"),
                },
            ),
        )

        self.assertEqual(registry.removed, ["media_player.ari"])
        self.assertEqual(registry.updated, [])

    def test_removes_image_artifacts_only_from_non_camera_devices(self) -> None:
        registry = FakeRegistry(
            [
                entity("image.living_room_window", "image", "dev_window_image"),
                entity(
                    "sensor.living_room_window_image",
                    "sensor",
                    "dev_window_main_imageCapture_image",
                ),
                entity(
                    "sensor.living_room_window_image_transfer_progress",
                    "sensor",
                    "dev_window_main_imageCapture_imageTransferProgress",
                ),
                entity("sensor.living_room_window_battery", "sensor", "dev_window_main_battery_battery"),
                entity("image.home_camera", "image", "dev_camera_image"),
                entity(
                    "sensor.home_camera_image_transfer_progress",
                    "sensor",
                    "dev_camera_main_imageCapture_imageTransferProgress",
                ),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.98",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_window": window_sensor_with_image_artifacts(
                        "dev_window", "loc_001", "거실창문센서"
                    ),
                    "dev_camera": camera_device("dev_camera", "loc_001", "홈카메라 360"),
                },
            ),
        )

        self.assertEqual(
            registry.removed,
            [
                "image.living_room_window",
                "sensor.living_room_window_image",
                "sensor.living_room_window_image_transfer_progress",
            ],
        )
        self.assertEqual(registry.updated, [])

    def test_removes_currently_null_sensor_and_update_entities(self) -> None:
        registry = FakeRegistry(
            [
                entity("sensor.window_quantity", "sensor", "dev_window_main_metadata_quantity"),
                entity("sensor.window_battery", "sensor", "dev_window_main_battery_battery"),
                entity("update.window_firmware", "update", "dev_window_firmware_update"),
                entity("sensor.other_quantity", "sensor", "dev_other_main_metadata_quantity"),
                entity("update.other_firmware", "update", "dev_other_firmware_update"),
            ]
        )
        self.patch_registry(registry)
        contact = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-25T02:11:34Z",
        )
        battery = BridgeState(
            "main", "battery", "battery", 91, "%", "2026-04-01T17:21:43Z"
        )
        quantity = BridgeState(
            "main",
            "metadata",
            "quantity",
            None,
            None,
            "2026-04-01T11:28:55Z",
        )
        current = BridgeState(
            "main",
            "firmwareUpdate",
            "currentVersion",
            None,
            None,
            "2026-04-01T11:28:55Z",
        )
        available = BridgeState(
            "main",
            "firmwareUpdate",
            "availableVersion",
            None,
            None,
            "2026-04-01T11:28:55Z",
        )
        window = BridgeDevice(
            "dev_window",
            "loc_001",
            None,
            "거실창문센서",
            "custom_window_h",
            True,
            states={
                state.key: state
                for state in (contact, battery, quantity, current, available)
            },
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.98",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_window": window,
                    "dev_other": window_sensor_with_image_artifacts(
                        "dev_other", "loc_002", "다른 창문"
                    ),
                },
            ),
        )

        self.assertEqual(
            registry.removed,
            ["sensor.window_quantity", "update.window_firmware"],
        )
        self.assertEqual(registry.updated, [])

    def test_removes_duplicate_control_number_when_state_number_exists(self) -> None:
        registry = FakeRegistry(
            [
                entity("number.motion_detection_frequency", "number", "dev_motion_main_motion_detectionFrequency"),
                entity("number.motion_detection_frequency_2", "number", "dev_motion_number_detection_slider"),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.38",
                protocol_version="2",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_motion": slider_number_device("dev_motion", "loc_001", "Motion")
                },
            ),
        )

        self.assertEqual(registry.removed, ["number.motion_detection_frequency_2"])
        self.assertEqual(registry.updated, [])

    def test_removes_old_numbers_when_no_observed_slider_exists(self) -> None:
        registry = FakeRegistry(
            [
                entity("number.motion_detection_frequency", "number", "dev_motion_main_motion_detectionFrequency"),
                entity("number.motion_detection_frequency_2", "number", "dev_motion_number_detection_slider"),
            ]
        )
        self.patch_registry(registry)
        device = slider_number_device("dev_motion", "loc_001", "Motion")
        device.controls.clear()

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.38",
                protocol_version="2",
                locations={"loc_001": "Home"},
                rooms={},
                devices={"dev_motion": device},
            ),
        )

        self.assertEqual(
            registry.removed,
            [
                "number.motion_detection_frequency",
                "number.motion_detection_frequency_2",
            ],
        )
        self.assertEqual(registry.updated, [])

    def test_updates_control_number_unique_id_when_state_number_is_missing(self) -> None:
        registry = FakeRegistry(
            [
                entity("number.motion_detection_frequency", "number", "dev_motion_number_detection_slider"),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.38",
                protocol_version="2",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_motion": slider_number_device("dev_motion", "loc_001", "Motion")
                },
            ),
        )

        self.assertEqual(registry.removed, [])
        self.assertEqual(
            registry.updated,
            [
                (
                    "number.motion_detection_frequency",
                    "dev_motion_main_motion_detectionFrequency",
                )
            ],
        )

    def test_removes_one_repeated_room_prefix_from_generated_entity_ids(self) -> None:
        registry = FakeRegistry(
            [
                entity("climate.geosil_geosil_eeokeon", "climate", "dev_ac_climate"),
                entity(
                    "sensor.geosil_geosil_eeokeon_power",
                    "sensor",
                    "dev_ac_main_powerMeter_power",
                ),
                entity("sensor.room_room_custom", "sensor", "custom_unique_id"),
                entity(
                    "fan.geosil_geosil_eeokeon",
                    "fan",
                    "dev_ac_fan",
                    platform="other",
                ),
            ]
        )
        self.patch_registry(registry)
        state = BridgeState(
            "main",
            "powerMeter",
            "power",
            0,
            "W",
            "2026-08-27T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_ac",
            "loc_001",
            "room_living",
            "거실 에어컨",
            "floor_ac",
            True,
            states={state.key: state},
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.93",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_living": ("loc_001", "거실")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(
            registry.renamed,
            [
                ("climate.geosil_geosil_eeokeon", "climate.geosil_eeokeon"),
                (
                    "sensor.geosil_geosil_eeokeon_power",
                    "sensor.geosil_eeokeon_power",
                ),
            ],
        )

    def test_keeps_repeated_prefix_when_target_entity_id_already_exists(self) -> None:
        registry = FakeRegistry(
            [
                entity("climate.geosil_geosil_eeokeon", "climate", "dev_ac_climate"),
                entity("climate.geosil_eeokeon", "climate", "dev_other_climate"),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.93",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_ac": level_only_device("dev_ac", "loc_001", "거실 에어컨")
                },
            ),
        )

        self.assertEqual(registry.renamed, [])

    def test_keeps_repeated_prefix_when_target_belongs_to_another_entry(self) -> None:
        duplicate = entity(
            "climate.geosil_geosil_eeokeon",
            "climate",
            "dev_ac_climate",
        )
        official = entity(
            "climate.geosil_eeokeon",
            "climate",
            "official_dev_ac_climate",
            platform="smartthings",
        )
        registry = FakeRegistry([duplicate, official])
        self.patch_registry(registry, [duplicate])

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.94",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={
                    "dev_ac": level_only_device("dev_ac", "loc_001", "거실 에어컨")
                },
            ),
        )

        self.assertEqual(registry.renamed, [])

    def test_entity_id_and_legacy_unique_id_migrate_in_one_pass(self) -> None:
        registry = FakeRegistry(
            [
                entity(
                    "sensor.geosil_geosil_eeokeon_power",
                    "sensor",
                    "dev_ac_main_powerMeter_power_power",
                )
            ]
        )
        self.patch_registry(registry)
        state = BridgeState(
            "main",
            "powerMeter",
            "power",
            0,
            "W",
            "2026-08-27T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_ac",
            "loc_001",
            "room_living",
            "거실 에어컨",
            "floor_ac",
            True,
            states={state.key: state},
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.93",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_living": ("loc_001", "거실")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(
            registry.renamed,
            [
                (
                    "sensor.geosil_geosil_eeokeon_power",
                    "sensor.geosil_eeokeon_power",
                )
            ],
        )
        self.assertEqual(
            registry.updated,
            [("sensor.geosil_eeokeon_power", "dev_ac_main_powerMeter_power")],
        )

    def test_renames_frozen_room_prefixed_ids_once_device_names_are_clean(self) -> None:
        registry = FakeRegistry(
            [
                self._registry_entry(
                    "switch.deiteorum_status_home",
                    device_id="uuid_status",
                    unique_id="dev_status_main_switch_switch",
                ),
                self._registry_entry(
                    "switch.deiteorum_status_night",
                    device_id="uuid_status2",
                    unique_id="dev_status2_main_switch_switch",
                    name="내 스위치",
                ),
                self._registry_entry(
                    "switch.taken_target",
                    device_id="uuid_taken",
                    unique_id="dev_taken_main_switch_switch",
                ),
                self._registry_entry(
                    "switch.geosil_geosil_jomyeong",
                    device_id="uuid_double",
                    unique_id="dev_double_main_switch_switch",
                ),
            ]
        )
        # The exact target is occupied by another integration, so the current
        # ID must remain stable instead of rotating through numbered suffixes.
        registry.entries.insert(
            0,
            entity("switch.status_away", "switch", "other_integration_uid", platform="other"),
        )
        extra = self._registry_entry("switch.deiteorum_status_away", device_id="uuid_away", unique_id="dev_away_main_switch_switch")
        registry.entries.append(extra)
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(id="uuid_status", identifiers={(DOMAIN, "dev_status")}, area_id="deiteorum"),
                SimpleNamespace(id="uuid_taken", identifiers={(DOMAIN, "dev_taken")}, area_id="deiteorum"),
                SimpleNamespace(id="uuid_away", identifiers={(DOMAIN, "dev_away")}, area_id="deiteorum"),
            ]
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.100",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_d": ("loc_001", "Deiteorum"), "room_g": ("loc_001", "Geosil")},
                devices={
                    "dev_status": self._bridge_device("dev_status", "Status Home", room=None),
                    "dev_status2": self._bridge_device("dev_status2", "Status Night", room=None),
                    "dev_away": self._bridge_device("dev_away", "Status Away", room=None),
                    "dev_taken": self._bridge_device("dev_taken", "Taken Source", room=None),
                    "dev_double": self._bridge_device("dev_double", "조명", room="room_g"),
                    "dev_plain": level_only_device("dev_plain", "loc_001", "Plain Lamp"),
                },
            ),
        )

        self.assertEqual(
            registry.renamed,
            [
                ("switch.deiteorum_status_home", "switch.status_home"),
                ("switch.geosil_geosil_jomyeong", "switch.geosil_jomyeong"),
            ],
        )
        self.assertEqual(registry.updated, [])

    def test_numbered_entity_ids_do_not_rotate_across_migration_passes(self) -> None:
        """Never reinterpret HA collision suffixes as room-name cleanup."""
        states = [
            BridgeState("main", "capability", f"value_{index}", index, None, None)
            for index in range(2, 5)
        ]
        device = BridgeDevice(
            "dev_sensor",
            "loc_001",
            None,
            "센서",
            "sensor",
            True,
            states={state.key: state for state in states},
        )
        registry = FakeRegistry(
            [
                self._registry_entry(
                    f"sensor.value_{index}",
                    "uuid_sensor",
                    domain="sensor",
                    unique_id=f"dev_sensor_main_capability_value_{index}",
                )
                for index in range(2, 5)
            ]
        )
        self.patch_registry(registry)

        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.113",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(registry.renamed, [])

    def test_room_named_media_player_reclaims_room_slug_without_rotating(self) -> None:
        """Migrate legacy type-label IDs to the preserved room-name slug once."""
        legacy_media = self._registry_entry(
            "media_player.3_4",
            "uuid_living_speaker",
            domain="media_player",
            unique_id="dev_living_media_player",
        )
        legacy_media.object_id_base = "3_4"
        legacy_media.suggested_object_id = None
        registry = FakeRegistry(
            [
                entity("media_player.geosil", "media_player", "official_living", platform="other"),
                legacy_media,
            ]
        )
        self.patch_registry(registry)
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            25,
            "%",
            "2026-08-28T03:00:00Z",
        )
        mute = BridgeState(
            "main",
            "audioMute",
            "mute",
            "unmuted",
            None,
            "2026-08-28T03:00:00Z",
        )
        device = BridgeDevice(
            "dev_living",
            "loc_001",
            "room_living",
            "Geosil",
            "speaker",
            True,
            states={volume.key: volume, mute.key: mute},
        )
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.114",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_living": ("loc_001", "Geosil")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [("media_player.3_4", "media_player.geosil_4")],
        )
        self.assertEqual(legacy_media.suggested_object_id, "geosil_4")

    def test_actual_numbered_device_name_reclaims_id_from_collision_suffix(self) -> None:
        """Reserve geosil_4 for a device actually named Geosil 4."""
        exact_room = self._registry_entry(
            "media_player.geosil_4",
            "uuid_exact_room",
            domain="media_player",
            unique_id="dev_exact_media_player",
        )
        exact_room.object_id_base = None
        exact_room.suggested_object_id = "geosil"
        numbered_name = self._registry_entry(
            "media_player.4",
            "uuid_numbered_name",
            domain="media_player",
            unique_id="dev_four_media_player",
        )
        numbered_name.object_id_base = None
        numbered_name.suggested_object_id = "geosil_4"
        second_name = self._registry_entry(
            "media_player.geosil_2",
            "uuid_second_name",
            domain="media_player",
            unique_id="dev_two_media_player",
        )
        second_name.object_id_base = None
        second_name.suggested_object_id = "geosil_2"
        registry = FakeRegistry(
            [
                entity("media_player.geosil", "media_player", "official_living", platform="other"),
                exact_room,
                numbered_name,
                second_name,
            ]
        )
        self.patch_registry(registry)

        def speaker(device_id: str, name: str) -> BridgeDevice:
            volume = BridgeState(
                "main", "audioVolume", "volume", 25, "%", "2026-08-28T03:00:00Z"
            )
            mute = BridgeState(
                "main", "audioMute", "mute", "unmuted", None, "2026-08-28T03:00:00Z"
            )
            return BridgeDevice(
                device_id,
                "loc_001",
                "room_living",
                name,
                "speaker",
                True,
                states={volume.key: volume, mute.key: mute},
            )

        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.121",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_living": ("loc_001", "Geosil")},
            devices={
                "dev_exact": speaker("dev_exact", "Geosil"),
                "dev_four": speaker("dev_four", "Geosil 4"),
                "dev_two": speaker("dev_two", "Geosil 2"),
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(numbered_name.entity_id, "media_player.geosil_4")
        self.assertEqual(numbered_name.suggested_object_id, "geosil_4")
        self.assertEqual(exact_room.entity_id, "media_player.geosil_3")
        self.assertEqual(exact_room.suggested_object_id, "geosil_3")

    def test_dynamic_registry_migration_waits_for_discovered_entities(self) -> None:
        """Repair entity IDs created by platform discovery after inventory changes."""
        registry = FakeRegistry([])
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_window",
                    identifiers={(DOMAIN, "dev_window")},
                    area_id="geosil",
                    config_entries={"entry_001"},
                ),
            ]
        )
        scheduled: list[object] = []
        delayed: list[object] = []
        hass = SimpleNamespace(
            loop=SimpleNamespace(
                call_soon=lambda callback: scheduled.append(callback),
                call_later=lambda _delay, callback: (
                    delayed.append(callback) or SimpleNamespace(cancel=lambda: None)
                ),
            )
        )
        runtime = SimpleNamespace(
            inventory=BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.110",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_g": ("loc_001", "Geosil")},
                devices={
                    "dev_window": self._bridge_device("dev_window", "거실 창문센서", room="room_g")
                },
            ),
            subscribe=lambda _callback: (lambda: None),
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
            runtime_data=runtime,
            async_on_unload=lambda callback: None,
        )

        unsubscribe = _subscribe_entity_registry_migration(hass, entry)
        scheduled.pop(0)()
        self.assertEqual(registry.renamed, [])
        registry.entries.append(
            self._registry_entry(
                "button.geosil_geosil_cangmunsenseo_refresh",
                "uuid_window",
                domain="button",
                unique_id="dev_window_button_advanced:refresh:identifier_main:identifier_refresh",
            )
        )
        delayed.pop(0)()
        scheduled.pop(0)()

        self.assertEqual(
            registry.renamed,
            [
                (
                    "button.geosil_geosil_cangmunsenseo_refresh",
                    "button.geosil_cangmunsenseo_refresh",
                )
            ],
        )
        unsubscribe()

    def test_dynamic_registry_migration_ignores_value_only_inventory_changes(self) -> None:
        """Do not rescan the whole registry for ordinary pushed state values."""
        scheduled: list[object] = []
        delayed: list[object] = []
        runtime_callbacks: list[object] = []
        state = BridgeState(
            "main",
            "switch",
            "switch",
            "on",
            None,
            "2026-08-28T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_switch",
            "loc_001",
            "room_living",
            "Living Switch",
            "switch",
            True,
            states={state.key: state},
        )
        runtime = SimpleNamespace(
            inventory=BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.120",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_living": ("loc_001", "Living")},
                devices={device.device_id: device},
            ),
            subscribe=lambda callback: (
                runtime_callbacks.append(callback) or (lambda: None)
            ),
        )
        hass = SimpleNamespace(
            loop=SimpleNamespace(
                call_soon=lambda callback: scheduled.append(callback),
                call_later=lambda _delay, callback: (
                    delayed.append(callback) or SimpleNamespace(cancel=lambda: None)
                ),
            )
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
            runtime_data=runtime,
        )
        migrations: list[int] = []
        original_migration = integration._migrate_entity_registry
        integration._migrate_entity_registry = (
            lambda _hass, _entry, inventory: migrations.append(inventory.sequence)
        )
        try:
            unsubscribe = _subscribe_entity_registry_migration(hass, entry)
            scheduled.pop(0)()
            self.assertEqual(migrations, [1])

            runtime.inventory.sequence = 2
            runtime.inventory.devices[device.device_id].states[state.key] = BridgeState(
                "main",
                "switch",
                "switch",
                "off",
                None,
                "2026-08-28T00:00:01Z",
            )
            runtime_callbacks[0]()

            self.assertEqual(scheduled, [])
            self.assertEqual(migrations, [1])

            added_state = BridgeState(
                "main",
                "powerMeter",
                "power",
                5,
                "W",
                "2026-08-28T00:00:02Z",
            )
            runtime.inventory.sequence = 3
            runtime.inventory.devices[device.device_id].states[
                added_state.key
            ] = added_state
            runtime_callbacks[0]()
            scheduled.pop(0)()

            self.assertEqual(migrations, [1, 3])
            unsubscribe()
        finally:
            integration._migrate_entity_registry = original_migration

    def test_restores_room_token_that_belongs_to_the_smartthings_device_name(self) -> None:
        """Remove only a template room prefix, never the device-name token."""
        state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "not present",
            None,
            "2026-08-28T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_presence",
            "loc_001",
            "room_small",
            "Jageunbang Jaesilsenseo",
            "presence_sensor",
            True,
            states={state.key: state},
        )
        registry = FakeRegistry(
            [
                entity(
                    "binary_sensor.jaesilsenseo_presence",
                    "binary_sensor",
                    "dev_presence_main_presenceSensor_presence",
                )
            ]
        )
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.118",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_small": ("loc_001", "Jageunbang")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.jaesilsenseo_presence",
                    "binary_sensor.jageunbang_jaesilsenseo_presence",
                )
            ],
        )

    def test_g3_energy_room_cleanup_is_deterministic_from_device_name(self) -> None:
        """Keep the room once only when it is part of the SmartThings name."""
        energy = BridgeState(
            "main",
            "energyMeter",
            "energy",
            100,
            "Wh",
            "2026-08-28T00:00:00Z",
        )
        cases = (
            (
                "dev_named",
                "Jubang G3 Jeonweon",
                "sensor.g3_jeonweon_energy",
                "sensor.jubang_g3_jeonweon_energy",
            ),
            (
                "dev_plain",
                "G3 Jeonweon",
                "sensor.jubang_g3_jeonweon_energy",
                "sensor.g3_jeonweon_energy",
            ),
        )
        for device_id, device_name, initial_entity_id, expected_entity_id in cases:
            with self.subTest(device_name=device_name):
                device = BridgeDevice(
                    device_id,
                    "loc_001",
                    "room_kitchen",
                    device_name,
                    "outlet",
                    True,
                    states={energy.key: energy},
                )
                registry = FakeRegistry(
                    [
                        self._registry_entry(
                            initial_entity_id,
                            "uuid_g3",
                            domain="sensor",
                            unique_id=f"{device_id}_main_energyMeter_energy",
                        )
                    ]
                )
                self.patch_registry(registry)
                integration.dr.async_get = lambda _hass: SimpleNamespace(
                    devices=[
                        SimpleNamespace(
                            id="uuid_g3",
                            identifiers={(DOMAIN, device_id)},
                            area_id=None,
                        )
                    ]
                )
                inventory = BridgeInventory(
                    sequence=1,
                    ready=True,
                    bridge_version="0.1.120",
                    protocol_version="4",
                    locations={"loc_001": "Home"},
                    rooms={"room_kitchen": ("loc_001", "Jubang")},
                    devices={device.device_id: device},
                )
                entry = SimpleNamespace(
                    entry_id="entry_001",
                    data={CONF_LOCATION_ID: "loc_001"},
                )

                _migrate_entity_registry(object(), entry, inventory)
                first_pass = list(registry.renamed)
                _migrate_entity_registry(object(), entry, inventory)

                self.assertEqual(
                    first_pass,
                    [(initial_entity_id, expected_entity_id)],
                )
                self.assertEqual(registry.renamed, first_pass)

    def test_duplicate_room_template_prefix_is_removed_once_and_stays_removed(self) -> None:
        """Never recreate the room template after reducing it to the device name."""
        contact = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_door",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Doeosenseo",
            "contact_sensor",
            True,
            states={contact.key: contact},
        )
        registry = FakeRegistry(
            [
                entity(
                    "binary_sensor.hwajangsil_hwajangsil_doeosenseo_contact",
                    "binary_sensor",
                    "dev_door_main_contactSensor_contact",
                )
            ]
        )
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.hwajangsil_hwajangsil_doeosenseo_contact",
                    "binary_sensor.hwajangsil_doeosenseo_contact",
                )
            ],
        )

    def test_reclaims_numbered_id_and_repairs_the_restore_suggestion(self) -> None:
        """Keep HA's restore action on the same canonical generated entity ID."""
        state = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_door",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Doeosenseo",
            "contact_sensor",
            True,
            states={state.key: state},
        )
        other_state = BridgeState(
            "main",
            "energyMeter",
            "energy",
            12.5,
            "kWh",
            "2026-08-28T06:00:00Z",
        )
        other_device = BridgeDevice(
            "dev_g3",
            "loc_001",
            "room_kitchen",
            "Jubang G3 Jeonweon",
            "outlet",
            True,
            states={other_state.key: other_state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.hwajangsil_doeosenseo_contact_4",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_door_main_contactSensor_contact",
            device_id="uuid_door",
            name=None,
            disabled_by=None,
            original_name="Contact",
            object_id_base="contact",
            suggested_object_id="hwajangsil_hwajangsil_doeosenseo_contact_4",
        )
        registry = FakeRegistry(
            [
                registry_entry,
                # Keep another SmartThings Web device last. The numbered-ID
                # repair must resolve each row's owner instead of reusing the
                # last owner left behind by the stale-row pre-pass.
                SimpleNamespace(
                    entity_id="sensor.jubang_g3_jeonweon_energy",
                    domain="sensor",
                    platform=DOMAIN,
                    unique_id="dev_g3_main_energyMeter_energy",
                    device_id="uuid_g3",
                    name=None,
                    disabled_by=None,
                    original_name="Energy",
                    object_id_base="energy",
                    suggested_object_id=None,
                ),
            ]
        )
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={
                "room_bathroom": ("loc_001", "Hwajangsil"),
                "room_kitchen": ("loc_001", "Jubang"),
            },
            devices={
                device.device_id: device,
                other_device.device_id: other_device,
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.hwajangsil_doeosenseo_contact_4",
                    "binary_sensor.hwajangsil_doeosenseo_contact",
                )
            ],
        )
        self.assertEqual(
            registry_entry.suggested_object_id,
            "hwajangsil_doeosenseo_contact",
        )
        self.assertEqual(registry_entry.object_id_base, "contact")

    def test_rebases_stale_fallback_device_ids_to_current_device_name(self) -> None:
        """Repair IDs frozen before the Bridge learned the SmartThings name."""
        state_specs = [
            ("identifier_7091628e9151", "부모님댁", "presence"),
            ("identifier_bf4c9146a548", "친정집", "presence_2"),
            ("identifier_cd4f3cfbf2aa", "Home", "presence_3"),
            ("identifier_d5fc226da811", "회사", "presence_4"),
        ]
        states = [
            BridgeState(
                component,
                "presenceSensor",
                "presence",
                "present",
                None,
                "2026-08-28T06:00:00Z",
                component_role=role,
            )
            for component, role, _suffix in state_specs
        ]
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state for state in states},
        )
        registry_entries = [
            SimpleNamespace(
                entity_id=f"binary_sensor.smartthings_device_dev_426_{suffix}",
                domain="binary_sensor",
                platform=DOMAIN,
                unique_id=f"dev_426_{component}_presenceSensor_presence",
                device_id="uuid_phone",
                name=None,
                disabled_by=None,
                original_name=f"smartthings_device_dev_426_{suffix}",
                object_id_base=f"smartthings_device_dev_426_{suffix}",
                suggested_object_id=f"smartthings_device_dev_426_{suffix}",
            )
            for component, _role, suffix in state_specs
        ]
        custom_named_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_426_presence_custom",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_426_identifier_custom_presenceSensor_presence",
            device_id="uuid_phone",
            name="Do not rename",
            disabled_by=None,
            original_name="smartthings_device_dev_426_presence_custom",
            object_id_base="smartthings_device_dev_426_presence_custom",
            suggested_object_id="smartthings_device_dev_426_presence_custom",
        )
        registry = FakeRegistry([*registry_entries, custom_named_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertCountEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_426_presence",
                    "binary_sensor.gyeongsugyi_s22_presence_부모님댁",
                ),
                (
                    "binary_sensor.smartthings_device_dev_426_presence_2",
                    "binary_sensor.gyeongsugyi_s22_presence_친정집",
                ),
                (
                    "binary_sensor.smartthings_device_dev_426_presence_3",
                    "binary_sensor.gyeongsugyi_s22_presence_home",
                ),
                (
                    "binary_sensor.smartthings_device_dev_426_presence_4",
                    "binary_sensor.gyeongsugyi_s22_presence_회사",
                ),
            ],
        )
        self.assertEqual(
            [
                entry.suggested_object_id
                for entry in registry_entries
            ],
            [
                "gyeongsugyi_s22_presence_부모님댁",
                "gyeongsugyi_s22_presence_친정집",
                "gyeongsugyi_s22_presence_home",
                "gyeongsugyi_s22_presence_회사",
            ],
        )
        self.assertEqual(
            [entry.object_id_base for entry in registry_entries],
            [
                "presence_부모님댁",
                "presence_친정집",
                "presence_home",
                "presence_회사",
            ],
        )
        self.assertEqual(
            custom_named_entry.entity_id,
            "binary_sensor.smartthings_device_dev_426_presence_custom",
        )
        self.assertEqual(
            custom_named_entry.object_id_base,
            "smartthings_device_dev_426_presence_custom",
        )
        self.assertEqual(
            custom_named_entry.suggested_object_id,
            "smartthings_device_dev_426_presence_custom",
        )

    def test_rebased_role_metadata_does_not_accumulate_transliterated_suffixes(self) -> None:
        """Keep HA-transliterated role suffixes stable across repeated setup passes."""
        state_specs = [
            ("identifier_7091628e9151", "부모님댁", "presence"),
            ("identifier_bf4c9146a548", "친정집", "presence_2"),
            ("identifier_cd4f3cfbf2aa", "Home", "presence_3"),
            ("identifier_d5fc226da811", "회사", "presence_4"),
        ]
        states = [
            BridgeState(
                component,
                "presenceSensor",
                "presence",
                "present",
                None,
                "2026-08-28T06:00:00Z",
                component_role=role,
            )
            for component, role, _suffix in state_specs
        ]
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state for state in states},
        )
        registry_entries = [
            SimpleNamespace(
                entity_id=f"binary_sensor.smartthings_device_dev_426_{suffix}",
                domain="binary_sensor",
                platform=DOMAIN,
                unique_id=f"dev_426_{component}_presenceSensor_presence",
                device_id="uuid_phone",
                name=None,
                disabled_by=None,
                original_name=f"smartthings_device_dev_426_{suffix}",
                object_id_base=f"smartthings_device_dev_426_{suffix}",
                suggested_object_id=f"smartthings_device_dev_426_{suffix}",
            )
            for component, _role, suffix in state_specs
        ]
        registry = FakeRegistry(registry_entries)
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.127",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )
        original_integration_slugify = integration.slugify
        original_naming_slugify = naming_module.slugify

        def ha_style_slugify(value: object) -> str:
            text = str(value)
            for source, replacement in {
                "부모님댁": "bumonimdaeg",
                "친정집": "cinjeongjib",
                "회사": "hoesa",
            }.items():
                text = text.replace(source, replacement)
            return original_integration_slugify(text)

        integration.slugify = ha_style_slugify
        naming_module.slugify = ha_style_slugify
        try:
            for _ in range(5):
                _migrate_entity_registry(object(), entry, inventory)
        finally:
            integration.slugify = original_integration_slugify
            naming_module.slugify = original_naming_slugify

        self.assertEqual(
            [item.entity_id for item in registry_entries],
            [
                "binary_sensor.gyeongsugyi_s22_presence_bumonimdaeg",
                "binary_sensor.gyeongsugyi_s22_presence_cinjeongjib",
                "binary_sensor.gyeongsugyi_s22_presence_home",
                "binary_sensor.gyeongsugyi_s22_presence_hoesa",
            ],
        )
        self.assertEqual(
            [item.object_id_base for item in registry_entries],
            [
                "presence_bumonimdaeg",
                "presence_cinjeongjib",
                "presence_home",
                "presence_hoesa",
            ],
        )
        self.assertEqual(
            [item.suggested_object_id for item in registry_entries],
            [
                "gyeongsugyi_s22_presence_bumonimdaeg",
                "gyeongsugyi_s22_presence_cinjeongjib",
                "gyeongsugyi_s22_presence_home",
                "gyeongsugyi_s22_presence_hoesa",
            ],
        )

    def test_rebased_role_metadata_repairs_accumulated_restore_hints(self) -> None:
        """Collapse role suffixes already accumulated by earlier restore passes."""
        parent_state = BridgeState(
            "identifier_7091628e9151",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-28T06:00:00Z",
            component_role="부모님댁",
        )
        home_state = BridgeState(
            "identifier_cd4f3cfbf2aa",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-28T06:00:00Z",
            component_role="Home",
        )
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state for state in (parent_state, home_state)},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.gyeongsugyi_s22_presence_bumonimdaeg",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_426_identifier_7091628e9151_presenceSensor_presence",
            device_id="uuid_phone",
            name=None,
            disabled_by=None,
            original_name="Presence (부모님댁)",
            object_id_base=(
                "presence_bumonimdaeg_bumonimdaeg_bumonimdaeg_bumonimdaeg"
            ),
            suggested_object_id=(
                "gyeongsugyi_s22_presence_bumonimdaeg_bumonimdaeg_bumonimdaeg"
            ),
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.127",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )
        original_integration_slugify = integration.slugify
        original_naming_slugify = naming_module.slugify

        def ha_style_slugify(value: object) -> str:
            return original_integration_slugify(
                str(value).replace("부모님댁", "bumonimdaeg")
            )

        integration.slugify = ha_style_slugify
        naming_module.slugify = ha_style_slugify
        try:
            _migrate_entity_registry(object(), entry, inventory)
            _migrate_entity_registry(object(), entry, inventory)
        finally:
            integration.slugify = original_integration_slugify
            naming_module.slugify = original_naming_slugify

        self.assertEqual(
            registry_entry.entity_id,
            "binary_sensor.gyeongsugyi_s22_presence_bumonimdaeg",
        )
        self.assertEqual(registry_entry.object_id_base, "presence_bumonimdaeg")
        self.assertEqual(
            registry_entry.suggested_object_id,
            "gyeongsugyi_s22_presence_bumonimdaeg",
        )

    def test_fallback_id_repair_uses_original_name_when_it_is_not_stale(self) -> None:
        """Re-apply role suffixes instead of preserving stale duplicated suffixes."""
        state = BridgeState(
            "home",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-28T06:00:00Z",
        )
        sibling_state = BridgeState(
            "office",
            "presenceSensor",
            "presence",
            "not present",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state, sibling_state.key: sibling_state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_426_presence_3",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_426_home_presenceSensor_presence",
            device_id="uuid_phone",
            name=None,
            disabled_by=None,
            original_name="Presence (Home)",
            object_id_base="smartthings_device_dev_426_presence_3",
            suggested_object_id="smartthings_device_dev_426_presence_3",
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_426_presence_3",
                    "binary_sensor.gyeongsugyi_s22_presence_home",
                )
            ],
        )
        self.assertEqual(registry_entry.object_id_base, "presence_home")
        self.assertEqual(
            registry_entry.suggested_object_id,
            "gyeongsugyi_s22_presence_home",
        )

    def test_fallback_id_repair_uses_original_name_when_object_id_base_is_missing(self) -> None:
        """Repair stale original names even when HA omits object_id_base."""
        state = BridgeState(
            "home",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_426_presence_3",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_426_home_presenceSensor_presence",
            device_id="uuid_phone",
            name=None,
            disabled_by=None,
            original_name="smartthings_device_dev_426_presence_3",
            object_id_base=None,
            suggested_object_id="smartthings_device_dev_426_presence_3",
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_426_presence_3",
                    "binary_sensor.gyeongsugyi_s22_presence",
                )
            ],
        )
        self.assertEqual(registry_entry.object_id_base, "presence")
        self.assertEqual(
            registry_entry.suggested_object_id,
            "gyeongsugyi_s22_presence",
        )

    def test_fallback_id_repair_numbers_around_an_occupied_target(self) -> None:
        """Keep an occupied target intact while replacing an unreadable fallback."""
        state = BridgeState(
            "home",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_426",
            "loc_001",
            "room_family",
            "Gyeongsugyi S22",
            "mobile",
            True,
            states={state.key: state},
        )
        stale_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_426_presence_3",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_426_home_presenceSensor_presence",
            device_id="uuid_phone",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="smartthings_device_dev_426_presence_3",
            suggested_object_id="smartthings_device_dev_426_presence_3",
        )
        occupied_entry = SimpleNamespace(
            entity_id="binary_sensor.gyeongsugyi_s22_presence",
            domain="binary_sensor",
            platform="other_platform",
            unique_id="occupied",
            device_id="uuid_other",
            name=None,
            disabled_by=None,
            original_name=None,
            object_id_base=None,
            suggested_object_id=None,
        )
        registry = FakeRegistry([stale_entry, occupied_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_family": ("loc_001", "Family")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_426_presence_3",
                    "binary_sensor.gyeongsugyi_s22_presence_2",
                )
            ],
        )
        self.assertEqual(
            stale_entry.entity_id,
            "binary_sensor.gyeongsugyi_s22_presence_2",
        )
        self.assertEqual(
            occupied_entry.entity_id,
            "binary_sensor.gyeongsugyi_s22_presence",
        )
        self.assertEqual(
            stale_entry.object_id_base,
            "presence",
        )
        self.assertEqual(
            stale_entry.suggested_object_id,
            "gyeongsugyi_s22_presence_2",
        )

    def test_rebases_same_name_fallback_to_next_free_generated_id(self) -> None:
        """Use a stable numbered ID when a same-name device owns the base ID."""
        state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-29T00:00:00Z",
        )
        other_state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "not present",
            None,
            "2026-08-29T00:00:00Z",
        )
        stale_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_401_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_401_main_presenceSensor_presence",
            device_id="uuid_iphone_401",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="smartthings_device_dev_401_presence",
            suggested_object_id="smartthings_device_dev_401_presence",
        )
        base_entry = SimpleNamespace(
            entity_id="binary_sensor.iphone_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_580_main_presenceSensor_presence",
            device_id="uuid_iphone_580",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="presence",
            suggested_object_id="iphone_presence",
        )
        class ReplacingRegistry(FakeRegistry):
            def async_update_entity(
                self,
                entity_id: str,
                *,
                new_unique_id: str | None = None,
                new_entity_id: str | None = None,
            ) -> None:
                if new_entity_id is None:
                    super().async_update_entity(
                        entity_id,
                        new_unique_id=new_unique_id,
                    )
                    return
                current = self.async_get(entity_id)
                if current is None:
                    raise KeyError(entity_id)
                replacement = SimpleNamespace(**vars(current))
                replacement.entity_id = new_entity_id
                if new_unique_id is not None:
                    replacement.unique_id = new_unique_id
                    self.updated.append((entity_id, new_unique_id))
                self.entries = [
                    replacement if item is current else item for item in self.entries
                ]
                self.renamed.append((entity_id, new_entity_id))

        registry = ReplacingRegistry([stale_entry, base_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.129",
            protocol_version="4",
            locations={"loc_009": "Home"},
            rooms={},
            devices={
                "dev_401": BridgeDevice(
                    "dev_401",
                    "loc_009",
                    None,
                    "iPhone",
                    "MOBILE",
                    True,
                    states={state.key: state},
                ),
                "dev_580": BridgeDevice(
                    "dev_580",
                    "loc_009",
                    None,
                    "iPhone",
                    "MOBILE",
                    True,
                    states={other_state.key: other_state},
                ),
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_009"},
        )

        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_401_presence",
                    "binary_sensor.iphone_presence_2",
                )
            ],
        )
        self.assertEqual(base_entry.entity_id, "binary_sensor.iphone_presence")
        repaired_entry = registry.async_get("binary_sensor.iphone_presence_2")
        self.assertIsNotNone(repaired_entry)
        self.assertEqual(repaired_entry.object_id_base, "presence")
        self.assertEqual(repaired_entry.suggested_object_id, "iphone_presence_2")

        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(len(registry.renamed), 1)

    def test_same_name_fallback_skips_ids_owned_by_other_integrations(self) -> None:
        """Never overwrite occupied numbered IDs while repairing a duplicate name."""
        state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-29T00:00:00Z",
        )
        stale_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_401_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_401_main_presenceSensor_presence",
            device_id="uuid_iphone_401",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="smartthings_device_dev_401_presence",
            suggested_object_id="smartthings_device_dev_401_presence",
        )
        base_entry = SimpleNamespace(
            entity_id="binary_sensor.iphone_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_580_main_presenceSensor_presence",
            device_id="uuid_iphone_580",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="presence",
            suggested_object_id="iphone_presence",
        )
        occupied_entry = SimpleNamespace(
            entity_id="binary_sensor.iphone_presence_2",
            domain="binary_sensor",
            platform="other_platform",
            unique_id="occupied",
            device_id="uuid_other",
            name=None,
            disabled_by=None,
            original_name=None,
            object_id_base=None,
            suggested_object_id=None,
        )
        registry = FakeRegistry([stale_entry, base_entry, occupied_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.128",
            protocol_version="4",
            locations={"loc_009": "Home"},
            rooms={},
            devices={
                device_id: BridgeDevice(
                    device_id,
                    "loc_009",
                    None,
                    "iPhone",
                    "MOBILE",
                    True,
                    states={state.key: state},
                )
                for device_id in ("dev_401", "dev_580")
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_009"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            stale_entry.entity_id,
            "binary_sensor.iphone_presence_3",
        )
        self.assertEqual(base_entry.entity_id, "binary_sensor.iphone_presence")
        self.assertEqual(occupied_entry.entity_id, "binary_sensor.iphone_presence_2")
        self.assertEqual(stale_entry.object_id_base, "presence")
        self.assertEqual(stale_entry.suggested_object_id, "iphone_presence_3")

    def test_same_name_fallback_advances_past_a_reserved_state_id(self) -> None:
        """Try the next suffix when HA reserves an ID outside the registry."""
        state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-29T00:00:00Z",
        )
        stale_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_401_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_401_main_presenceSensor_presence",
            device_id="uuid_iphone_401",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="smartthings_device_dev_401_presence",
            suggested_object_id="smartthings_device_dev_401_presence",
        )
        base_entry = SimpleNamespace(
            entity_id="binary_sensor.iphone_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_580_main_presenceSensor_presence",
            device_id="uuid_iphone_580",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="presence",
            suggested_object_id="iphone_presence",
        )

        class ReservedStateRegistry(FakeRegistry):
            def async_update_entity(
                self,
                entity_id: str,
                *,
                new_unique_id: str | None = None,
                new_entity_id: str | None = None,
            ) -> None:
                if new_entity_id == "binary_sensor.iphone_presence_2":
                    raise ValueError("entity id is already reserved")
                super().async_update_entity(
                    entity_id,
                    new_unique_id=new_unique_id,
                    new_entity_id=new_entity_id,
                )

        registry = ReservedStateRegistry([stale_entry, base_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.129",
            protocol_version="4",
            locations={"loc_009": "Home"},
            rooms={},
            devices={
                device_id: BridgeDevice(
                    device_id,
                    "loc_009",
                    None,
                    "iPhone",
                    "MOBILE",
                    True,
                    states={state.key: state},
                )
                for device_id in ("dev_401", "dev_580")
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_009"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_401_presence",
                    "binary_sensor.iphone_presence_3",
                )
            ],
        )
        self.assertEqual(stale_entry.entity_id, "binary_sensor.iphone_presence_3")
        self.assertEqual(base_entry.entity_id, "binary_sensor.iphone_presence")
        self.assertEqual(stale_entry.object_id_base, "presence")
        self.assertEqual(stale_entry.suggested_object_id, "iphone_presence_3")

    def test_same_name_fallback_repair_preserves_user_named_rows(self) -> None:
        """Leave explicit user names untouched even when a duplicate base exists."""
        state = BridgeState(
            "main",
            "presenceSensor",
            "presence",
            "present",
            None,
            "2026-08-29T00:00:00Z",
        )
        stale_entry = SimpleNamespace(
            entity_id="binary_sensor.smartthings_device_dev_401_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_401_main_presenceSensor_presence",
            device_id="uuid_iphone_401",
            name="My iPhone presence",
            disabled_by=None,
            original_name="Presence",
            object_id_base="smartthings_device_dev_401_presence",
            suggested_object_id="smartthings_device_dev_401_presence",
        )
        base_entry = SimpleNamespace(
            entity_id="binary_sensor.iphone_presence",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_580_main_presenceSensor_presence",
            device_id="uuid_iphone_580",
            name=None,
            disabled_by=None,
            original_name="Presence",
            object_id_base="presence",
            suggested_object_id="iphone_presence",
        )
        registry = FakeRegistry([stale_entry, base_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.128",
            protocol_version="4",
            locations={"loc_009": "Home"},
            rooms={},
            devices={
                device_id: BridgeDevice(
                    device_id,
                    "loc_009",
                    None,
                    "iPhone",
                    "MOBILE",
                    True,
                    states={state.key: state},
                )
                for device_id in ("dev_401", "dev_580")
            },
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_009"},
            ),
            inventory,
        )

        self.assertEqual(registry.renamed, [])
        self.assertEqual(
            stale_entry.entity_id,
            "binary_sensor.smartthings_device_dev_401_presence",
        )
        self.assertEqual(
            stale_entry.object_id_base,
            "smartthings_device_dev_401_presence",
        )
        self.assertEqual(
            stale_entry.suggested_object_id,
            "smartthings_device_dev_401_presence",
        )

    def test_reserved_state_id_does_not_abort_numbered_id_repair(self) -> None:
        """Keep setup running when HA reserves an ID outside the registry."""
        state = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_door",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Doeosenseo",
            "contact_sensor",
            True,
            states={state.key: state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.hwajangsil_doeosenseo_contact_4",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_door_main_contactSensor_contact",
            device_id="uuid_door",
            name=None,
            disabled_by=None,
            original_name="Contact",
            object_id_base="contact",
            suggested_object_id=None,
        )

        class ReservedStateRegistry(FakeRegistry):
            def async_update_entity(
                self,
                entity_id: str,
                *,
                new_unique_id: str | None = None,
                new_entity_id: str | None = None,
            ) -> None:
                if new_entity_id == "binary_sensor.hwajangsil_doeosenseo_contact":
                    raise ValueError("entity id is already reserved")
                super().async_update_entity(
                    entity_id,
                    new_unique_id=new_unique_id,
                    new_entity_id=new_entity_id,
                )

        registry = ReservedStateRegistry([registry_entry])
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_001"},
            ),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.121",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(
            registry_entry.entity_id,
            "binary_sensor.hwajangsil_doeosenseo_contact_4",
        )
        self.assertEqual(
            registry_entry.suggested_object_id,
            "hwajangsil_doeosenseo_contact",
        )

    def test_live_door_id_repairs_missing_room_then_reclaims_numbered_suffix(self) -> None:
        """Settle the observed live ID on one room token with no collision suffix."""
        state = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_396",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Doeosenseo",
            "contact_sensor",
            True,
            states={state.key: state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.doeosenseo_contact_4",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_396_main_contactSensor_contact",
            device_id="uuid_door",
            name=None,
            disabled_by=None,
            original_name="Contact",
            object_id_base="contact",
            suggested_object_id=None,
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_door",
                    identifiers={(DOMAIN, "dev_396")},
                    area_id=None,
                )
            ]
        )
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.doeosenseo_contact_4",
                    "binary_sensor.hwajangsil_doeosenseo_contact_4",
                ),
                (
                    "binary_sensor.hwajangsil_doeosenseo_contact_4",
                    "binary_sensor.hwajangsil_doeosenseo_contact",
                ),
            ],
        )
        self.assertEqual(
            registry_entry.entity_id,
            "binary_sensor.hwajangsil_doeosenseo_contact",
        )

    def test_preserves_user_named_numbered_id_and_restore_suggestion(self) -> None:
        """Never reinterpret a user-named registry row as generated cleanup."""
        state = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-28T06:00:00Z",
        )
        device = BridgeDevice(
            "dev_door",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Doeosenseo",
            "contact_sensor",
            True,
            states={state.key: state},
        )
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.my_bathroom_contact_4",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id="dev_door_main_contactSensor_contact",
            device_id="uuid_door",
            name="My Bathroom Contact",
            disabled_by=None,
            original_name="Contact",
            object_id_base="contact",
            suggested_object_id="my_bathroom_contact_4",
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.120",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(registry.renamed, [])
        self.assertEqual(registry_entry.suggested_object_id, "my_bathroom_contact_4")

    def test_observed_refresh_reuses_id_freed_by_synthetic_refresh_cleanup(self) -> None:
        """Keep the real web button and reuse the entity ID freed in the same pass."""
        control_id = "advanced:refresh:identifier_main:identifier_ce45d79951c6"
        registry = FakeRegistry(
            [
                self._registry_entry(
                    "button.geosil_cangmunsenseo_refresh",
                    "uuid_window",
                    domain="button",
                    unique_id="dev_window_refresh",
                ),
                self._registry_entry(
                    "button.geosil_geosil_cangmunsenseo_refresh",
                    "uuid_window",
                    domain="button",
                    unique_id=f"dev_window_button_{control_id}",
                ),
            ]
        )
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_window",
                    identifiers={(DOMAIN, "dev_window")},
                    area_id="geosil",
                    config_entries={"entry_001"},
                ),
            ]
        )
        contact = BridgeState(
            "main",
            "contactSensor",
            "contact",
            "closed",
            None,
            "2026-08-26T06:00:00.000Z",
        )
        device = BridgeDevice(
            device_id="dev_window",
            location_id="loc_001",
            room_id="room_g",
            name="거실창문센서",
            device_type="contact_sensor",
            online=True,
            states={contact.key: contact},
            controls={
                control_id: BridgeControl(
                    control_id,
                    "button",
                    "Refresh",
                    capability="refresh",
                    attribute="refresh",
                    commands=("refresh",),
                )
            },
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.112",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_g": ("loc_001", "Geosil")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(registry.removed, ["button.geosil_cangmunsenseo_refresh"])
        self.assertEqual(
            registry.renamed,
            [
                (
                    "button.geosil_geosil_cangmunsenseo_refresh",
                    "button.geosil_cangmunsenseo_refresh",
                )
            ],
        )

    def test_bounded_retry_rechecks_dynamic_entity_without_registry_feedback(self) -> None:
        """Retry discovery without subscribing to our own registry mutations."""
        registry = FakeRegistry([])
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_window",
                    identifiers={(DOMAIN, "dev_window")},
                    area_id="geosil",
                    config_entries={"entry_001"},
                ),
            ]
        )
        scheduled: list[Callable[[], None]] = []
        delayed: list[tuple[float, Callable[[], None]]] = []
        hass = SimpleNamespace(
            loop=SimpleNamespace(
                call_soon=lambda callback: scheduled.append(callback),
                call_later=lambda delay, callback: (
                    delayed.append((delay, callback))
                    or SimpleNamespace(cancel=lambda: None)
                ),
            ),
        )
        runtime_callbacks: list[object] = []
        runtime = SimpleNamespace(
            inventory=BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.110",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_g": ("loc_001", "Geosil")},
                devices={
                    "dev_window": self._bridge_device(
                        "dev_window", "거실 창문센서", room="room_g"
                    )
                },
            ),
            subscribe=lambda callback: (
                runtime_callbacks.append(callback) or (lambda: None)
            ),
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
            runtime_data=runtime,
            async_on_unload=lambda callback: None,
        )

        _subscribe_entity_registry_migration(hass, entry)
        self.assertEqual(
            [delay for delay, _callback in delayed],
            [0.5, 2.0, 10.0, 30.0],
        )
        scheduled.pop(0)()
        self.assertEqual(registry.renamed, [])

        registry.entries.append(
            self._registry_entry(
                "button.geosil_geosil_cangmunsenseo_refresh",
                "uuid_window",
                domain="button",
                unique_id="dev_window_button_advanced:refresh:identifier_main:identifier_refresh",
            )
        )
        delayed.pop(0)[1]()
        scheduled.pop(0)()

        self.assertEqual(
            registry.renamed,
            [
                (
                    "button.geosil_geosil_cangmunsenseo_refresh",
                    "button.geosil_cangmunsenseo_refresh",
                )
            ],
        )

    def test_detaches_only_unreferenced_stale_bridge_device_card(self) -> None:
        """Retire an old alias card without touching current or active devices."""
        updates: list[tuple[str, str]] = []
        device_registry = SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_active",
                    identifiers={(DOMAIN, "dev_active")},
                    config_entries={"entry_001"},
                ),
                SimpleNamespace(
                    id="uuid_current_empty",
                    identifiers={(DOMAIN, "dev_current_empty")},
                    config_entries={"entry_001"},
                ),
                SimpleNamespace(
                    id="uuid_orphan",
                    identifiers={(DOMAIN, "dev_old_alias")},
                    config_entries={"entry_001"},
                ),
                SimpleNamespace(
                    id="uuid_other_entry",
                    identifiers={(DOMAIN, "dev_old_other")},
                    config_entries={"entry_999"},
                ),
            ],
            async_update_device=lambda device_id, *, remove_config_entry: updates.append(
                (device_id, remove_config_entry)
            ),
        )
        integration.dr.async_get = lambda _hass: device_registry
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.120",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={
                "dev_active": self._bridge_device("dev_active", "Active"),
                "dev_current_empty": self._bridge_device(
                    "dev_current_empty", "Current Empty"
                ),
            },
        )
        registry_entries = [
            SimpleNamespace(entity_id="switch.active", device_id="uuid_active")
        ]

        integration._remove_orphan_bridge_device_cards(
            object(),
            entry,
            inventory,
            registry_entries,
            set(),
        )

        self.assertEqual(updates, [("uuid_orphan", "entry_001")])

    @staticmethod
    def _registry_entry(
        entity_id: str,
        device_id: str,
        *,
        domain: str = "switch",
        unique_id: str | None = None,
        name: str | None = None,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            entity_id=entity_id,
            domain=domain,
            platform=DOMAIN,
            unique_id=unique_id or f"{device_id}_identifier",
            device_id=device_id,
            name=name,
            disabled_by=None,
            original_name=None,
        )

    @staticmethod
    def _fake_device_registry() -> object:
        return SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_status",
                    identifiers={(DOMAIN, "dev_status", "subentry_1")},
                    area_id="deiteorum",
                ),
                SimpleNamespace(
                    id="uuid_double",
                    identifiers={(DOMAIN, "dev_double")},
                    area_id="geosil",
                ),
                SimpleNamespace(
                    id="uuid_unmapped",
                    identifiers={(DOMAIN, "dev_plain", "subentry_2")},
                    area_id=None,
                ),
            ]
        )

    @staticmethod
    def _bridge_device(
        device_id: str,
        name: str,
        *,
        location_id: str = "loc_001",
        room: str | None = "room_d",
    ) -> BridgeDevice:
        state = BridgeState("main", "switch", "switch", "on", None, "2026-08-27T00:00:00Z")
        return BridgeDevice(
            device_id=device_id,
            location_id=location_id,
            room_id=room,
            name=name,
            device_type="Switch",
            online=True,
            states={state.key: state},
        )

    def patch_registry(
        self,
        registry: FakeRegistry,
        config_entries: list[SimpleNamespace] | None = None,
    ) -> None:
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_config_entry = (
            lambda _registry, _entry_id: registry.entries
            if config_entries is None
            else config_entries
        )


class ControlPlaneTests(unittest.IsolatedAsyncioTestCase):
    """Regression tests for control mode and login repair helpers."""

    def test_existing_entries_without_option_remain_safe_control(self) -> None:
        entry = SimpleNamespace(data={}, options={})

        self.assertEqual(_control_mode(entry), CONTROL_MODE_SAFE_CONTROL)

    def test_entry_option_can_force_read_only(self) -> None:
        entry = SimpleNamespace(data={}, options={CONF_CONTROL_MODE: CONTROL_MODE_READ_ONLY})

        self.assertEqual(_control_mode(entry), CONTROL_MODE_READ_ONLY)

    async def test_health_auth_state_creates_samsung_login_repair(self) -> None:
        calls: list[tuple[str, str, str]] = []
        integration.ir.async_create_issue = lambda _hass, domain, issue_id, **_kwargs: calls.append(("create", domain, issue_id))
        integration.ir.async_delete_issue = lambda _hass, domain, issue_id: calls.append(("delete", domain, issue_id))
        client = FakeHealthClient(
            {"details": {"urlCategory": "samsung_login", "state": "LOGIN_REQUIRED"}}
        )

        await _async_update_repairs(
            object(),
            SimpleNamespace(entry_id="entry_001"),
            client,
        )

        self.assertEqual(calls, [("create", DOMAIN, "entry_001_samsung_login_required")])

    async def test_healthy_state_dismisses_samsung_login_repair(self) -> None:
        calls: list[tuple[str, str, str]] = []
        integration.ir.async_create_issue = lambda _hass, domain, issue_id, **_kwargs: calls.append(("create", domain, issue_id))
        integration.ir.async_delete_issue = lambda _hass, domain, issue_id: calls.append(("delete", domain, issue_id))
        client = FakeHealthClient(
            {"details": {"urlCategory": "smartthings_location", "state": "CONNECTED"}}
        )

        await _async_update_repairs(
            object(),
            SimpleNamespace(entry_id="entry_001"),
            client,
        )

        self.assertEqual(calls, [("delete", DOMAIN, "entry_001_samsung_login_required")])

    async def test_repair_loop_refreshes_health_repairs(self) -> None:
        calls: list[tuple[str, str, str]] = []
        sleeps = 0
        original_sleep = integration.asyncio.sleep
        integration.ir.async_create_issue = lambda _hass, domain, issue_id, **_kwargs: calls.append(("create", domain, issue_id))
        integration.ir.async_delete_issue = lambda _hass, domain, issue_id: calls.append(("delete", domain, issue_id))

        async def fake_sleep(_seconds: int) -> None:
            nonlocal sleeps
            sleeps += 1
            if sleeps > 1:
                raise integration.asyncio.CancelledError

        integration.asyncio.sleep = fake_sleep
        try:
            with self.assertRaises(integration.asyncio.CancelledError):
                await _repair_loop(
                    object(),
                    SimpleNamespace(entry_id="entry_001"),
                    FakeHealthClient(
                        {
                            "details": {
                                "urlCategory": "samsung_login",
                                "state": "LOGIN_REQUIRED",
                            }
                        }
                    ),
                )
        finally:
            integration.asyncio.sleep = original_sleep

        self.assertEqual(calls, [("create", DOMAIN, "entry_001_samsung_login_required")])

    async def test_event_loop_resyncs_and_recovers_after_stream_auth_failure(self) -> None:
        runtime = FakeEventRuntime()
        original_sleep = integration.asyncio.sleep

        async def fake_sleep(_seconds: int) -> None:
            return None

        integration.asyncio.sleep = fake_sleep
        try:
            with self.assertRaises(integration.asyncio.CancelledError):
                await _event_loop(SimpleNamespace(runtime_data=runtime))
        finally:
            integration.asyncio.sleep = original_sleep

        self.assertEqual(runtime.client.inventory_calls, 2)
        self.assertEqual(runtime.client.event_calls, 2)
        self.assertEqual(runtime.reconnect_sequences, [2, 3])
        self.assertEqual(runtime.applied_sequences, [])
        self.assertEqual(runtime.handled_events, [{"type": "state", "sequence": 4}])

    async def test_event_loop_applies_reconnect_snapshot_as_new_epoch_after_sequence_reset(self) -> None:
        runtime = FakeRestartEpochRuntime()
        original_sleep = integration.asyncio.sleep

        async def fake_sleep(_seconds: int) -> None:
            return None

        integration.asyncio.sleep = fake_sleep
        try:
            with self.assertRaises(integration.asyncio.CancelledError):
                await _event_loop(SimpleNamespace(runtime_data=runtime))
        finally:
            integration.asyncio.sleep = original_sleep

        self.assertEqual(runtime.reconnect_sequences, [50, 1])
        self.assertEqual(runtime.applied_sequences, [])

    async def test_event_loop_retries_transient_bridge_failures_immediately_with_a_cap(self) -> None:
        runtime = FakeReconnectRuntime()
        original_sleep = integration.asyncio.sleep
        delays: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            delays.append(seconds)

        integration.asyncio.sleep = fake_sleep
        try:
            with self.assertRaises(integration.asyncio.CancelledError):
                await _event_loop(SimpleNamespace(runtime_data=runtime))
        finally:
            integration.asyncio.sleep = original_sleep

        self.assertEqual(delays, [0.05, 0.1, 0.2])
        self.assertEqual(runtime.client.inventory_calls, 4)


class FakeHealthClient:
    """Minimal async health client."""

    def __init__(self, health: dict[str, object]) -> None:
        self.health = health

    async def async_get_health(self) -> dict[str, object]:
        return self.health


class FakeEventClient:
    """Event client that simulates one transient stream-auth failure."""

    def __init__(self) -> None:
        self.inventory_calls = 0
        self.event_calls = 0

    async def async_get_inventory(self) -> SimpleNamespace:
        self.inventory_calls += 1
        return SimpleNamespace(sequence=self.inventory_calls + 1)

    async def async_events(self):
        self.event_calls += 1
        if self.event_calls == 1:
            raise BridgeAuthError("bridge_auth_failed")
        yield {"type": "state", "sequence": 4}
        raise integration.asyncio.CancelledError


class FakeEventRuntime:
    """Minimal runtime proving reconnect snapshot and event application order."""

    def __init__(self) -> None:
        self.client = FakeEventClient()
        self.reconnect_sequences: list[int] = []
        self.applied_sequences: list[int] = []
        self.handled_events: list[dict[str, object]] = []

    def apply_reconnect_inventory(self, inventory: SimpleNamespace) -> bool:
        self.reconnect_sequences.append(inventory.sequence)
        return True

    def apply_inventory(self, inventory: SimpleNamespace) -> bool:
        self.applied_sequences.append(inventory.sequence)
        return True

    async def handle_event(self, event: dict[str, object]) -> bool:
        self.handled_events.append(event)
        return True


class FakeRestartEpochClient:
    """Event client that simulates a Bridge restart sequence reset."""

    def __init__(self) -> None:
        self.inventory_calls = 0
        self.event_calls = 0

    async def async_get_inventory(self) -> SimpleNamespace:
        self.inventory_calls += 1
        return SimpleNamespace(sequence=50 if self.inventory_calls == 1 else 1)

    async def async_events(self):
        self.event_calls += 1
        if self.event_calls == 1:
            raise BridgeAuthError("bridge_auth_failed")
        raise integration.asyncio.CancelledError
        yield


class FakeRestartEpochRuntime:
    """Minimal runtime proving lower reconnect snapshots start a new epoch."""

    def __init__(self) -> None:
        self.client = FakeRestartEpochClient()
        self.reconnect_sequences: list[int] = []
        self.applied_sequences: list[int] = []

    def apply_reconnect_inventory(self, inventory: SimpleNamespace) -> bool:
        self.reconnect_sequences.append(inventory.sequence)
        return True

    def apply_inventory(self, inventory: SimpleNamespace) -> bool:
        self.applied_sequences.append(inventory.sequence)
        return True


class FakeReconnectClient:
    """Inventory client that exposes the bounded transient reconnect schedule."""

    def __init__(self) -> None:
        self.inventory_calls = 0

    async def async_get_inventory(self) -> SimpleNamespace:
        self.inventory_calls += 1
        if self.inventory_calls <= 3:
            raise BridgeClientError("bridge_request_failed")
        raise integration.asyncio.CancelledError


class FakeReconnectRuntime:
    """Minimal runtime for event-loop reconnect timing."""

    def __init__(self) -> None:
        self.client = FakeReconnectClient()

    def apply_inventory(self, _inventory: SimpleNamespace) -> bool:
        return True

    def apply_reconnect_inventory(self, _inventory: SimpleNamespace) -> bool:
        return True


def entity(
    entity_id: str,
    domain: str,
    unique_id: str,
    *,
    platform: str = DOMAIN,
) -> SimpleNamespace:
    return SimpleNamespace(
        entity_id=entity_id,
        domain=domain,
        platform=platform,
        unique_id=unique_id,
    )


def level_only_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    state = BridgeState("main", "switchLevel", "level", 40, "%", "2026-08-25T00:00:00Z")
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="Light",
        online=True,
        states={state.key: state},
    )


def fan_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    state = BridgeState("main", "fanMode", "fanMode", "auto", None, "2026-08-25T00:00:00Z")
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="Air Purifier",
        online=True,
        states={state.key: state},
    )


def audio_accessory_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    volume = BridgeState("main", "audioVolume", "volume", 5, None, "2026-08-25T00:00:00Z")
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="accessory",
        online=True,
        states={volume.key: volume},
    )


def media_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    playback = BridgeState(
        "main",
        "mediaPlayback",
        "playbackStatus",
        "paused",
        None,
        "2026-08-25T00:00:00Z",
    )
    volume = BridgeState("main", "audioVolume", "volume", 20, "%", "2026-08-25T00:00:00Z")
    mute = BridgeState("main", "audioMute", "mute", "unmuted", None, "2026-08-25T00:00:00Z")
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="speaker",
        online=True,
        states={playback.key: playback, volume.key: volume, mute.key: mute},
    )


def window_sensor_with_image_artifacts(
    device_id: str, location_id: str, name: str
) -> BridgeDevice:
    contact = BridgeState("main", "contactSensor", "contact", "closed", None, "2026-08-25T02:11:34Z")
    battery = BridgeState("main", "battery", "battery", 91, "%", "2026-04-01T17:21:43Z")
    signal = BridgeState(
        "main",
        "legendabsolute60149.signalMetrics",
        "signalMetrics",
        "KST-9: 2026/04/01 11:28 LQI: 184  RSSI: -95dbm",
        None,
        "2026-04-01T11:28:55Z",
    )
    image = BridgeState("main", "imageCapture", "image", "stale", None, "2026-04-01T11:28:55Z")
    progress = BridgeState(
        "main", "imageCapture", "imageTransferProgress", 100, "%", "2026-04-01T11:28:55Z"
    )
    states = {state.key: state for state in (contact, battery, signal, image, progress)}
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="custom_window_h",
        online=True,
        states=states,
        controls={
            "identifier_refresh": BridgeControl(
                "identifier_refresh",
                "button",
                "Refresh",
                capability="refresh",
                attribute="refresh",
                commands=("refresh",),
            )
        },
    )


def camera_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    image = BridgeState("main", "imageCapture", "image", "metadata", None, "2026-08-25T03:16:00Z")
    progress = BridgeState(
        "main", "imageCapture", "imageTransferProgress", 100, "%", "2026-08-25T03:16:00Z"
    )
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="camera_security",
        online=True,
        states={image.key: image, progress.key: progress},
    )


def slider_number_device(device_id: str, location_id: str, name: str) -> BridgeDevice:
    state = BridgeState(
        "main",
        "motion",
        "detectionFrequency",
        60,
        "s",
        "2026-08-25T00:00:00Z",
    )
    return BridgeDevice(
        device_id=device_id,
        location_id=location_id,
        room_id=None,
        name=name,
        device_type="Motion Sensor",
        online=True,
        states={state.key: state},
        controls={
            "detection_slider": BridgeControl(
                "detection_slider",
                "slider",
                "Detection frequency",
                component="main",
                capability="motion",
                attribute="detectionFrequency",
                minimum=0,
                maximum=3600,
                step=1,
            )
        },
    )


if __name__ == "__main__":
    unittest.main()
