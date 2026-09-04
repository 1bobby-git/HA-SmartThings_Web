"""Regression tests for SmartThings Web setup migrations."""

from __future__ import annotations

import asyncio
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

    const.ATTR_RESTORED = "restored"  # type: ignore[attr-defined]
    const.STATE_UNAVAILABLE = "unavailable"  # type: ignore[attr-defined]
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
    entity_registry.async_entries_for_device = (  # type: ignore[attr-defined]
        lambda _registry, _device_id, include_disabled_entities=False: []
    )
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
    _async_recover_empty_location_inventory,
    _async_update_repairs,
    _control_mode,
    _event_loop,
    _migrate_entity_registry,
    _persist_canonical_bridge_url,
    _repair_loop,
    _subscribe_entity_registry_migration,
)
from smartthings_web.bridge_client import BridgeAuthError, BridgeClientError  # noqa: E402
from smartthings_web.const import (  # noqa: E402
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
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
        self.get_or_create_calls = 0

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
        self.get_or_create_calls += 1
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
        original_name: str | None = None,
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
        if original_name is not None:
            entry.original_name = original_name


class BridgeUrlMigrationTests(unittest.TestCase):
    """Persist only the hostname that answered a validated Bridge request."""

    def test_persists_resolved_repository_hostname_after_fallback(self) -> None:
        updates: list[dict[str, object]] = []
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_update_entry=lambda _entry, **kwargs: updates.append(kwargs)
            )
        )
        entry = SimpleNamespace(
            data={
                CONF_BRIDGE_URL: "http://local-smartthings-web-bridge:8100",
                CONF_BRIDGE_TOKEN: "x" * 32,
                CONF_LOCATION_ID: "loc_001",
            }
        )

        integration._persist_canonical_bridge_url(
            hass,
            entry,
            "http://d55cafb9-smartthings-web-bridge:8100",
        )

        self.assertEqual(
            updates,
            [
                {
                    "data": {
                        CONF_BRIDGE_URL: "http://d55cafb9-smartthings-web-bridge:8100",
                        CONF_BRIDGE_TOKEN: "x" * 32,
                        CONF_LOCATION_ID: "loc_001",
                    }
                }
            ],
        )

    def test_keeps_already_selected_repository_hostname(self) -> None:
        updates: list[dict[str, object]] = []
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_update_entry=lambda _entry, **kwargs: updates.append(kwargs)
            )
        )
        entry = SimpleNamespace(
            data={CONF_BRIDGE_URL: "http://d55cafb9-smartthings-web-bridge:8100/"}
        )

        integration._persist_canonical_bridge_url(
            hass,
            entry,
            "http://d55cafb9-smartthings-web-bridge:8100",
        )

        self.assertEqual(updates, [])


class EmptyLocationInventoryRecoveryTests(unittest.TestCase):
    "Recover a location omitted by one otherwise ready inventory epoch."

    def test_reloads_once_and_uses_recovered_location_devices(self) -> None:
        initial = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.166",
            protocol_version="5",
            locations={"loc_home": "Home", "loc_office": "ExampleOffice"},
            rooms={},
            devices={
                "dev_home": BridgeDevice(
                    "dev_home",
                    "loc_home",
                    None,
                    "Home switch",
                    "switch",
                    True,
                )
            },
        )
        recovered = BridgeInventory(
            sequence=2,
            ready=True,
            bridge_version="0.1.167",
            protocol_version="5",
            locations={"loc_home": "Home", "loc_office": "ExampleOffice"},
            rooms={},
            devices={
                **initial.devices,
                "dev_office": BridgeDevice(
                    "dev_office",
                    "loc_office",
                    None,
                    "ExampleOffice switch",
                    "switch",
                    True,
                ),
            },
        )

        class RecoveringClient:
            def __init__(self) -> None:
                self.reload_calls = 0
                self.inventory_calls = 0

            async def async_reload_inventory(self) -> None:
                self.reload_calls += 1

            async def async_get_inventory(self) -> BridgeInventory:
                self.inventory_calls += 1
                return recovered

        client = RecoveringClient()
        result = asyncio.run(
            _async_recover_empty_location_inventory(
                client,  # type: ignore[arg-type]
                initial,
                "loc_office",
            )
        )

        self.assertIs(result, recovered)
        self.assertEqual(client.reload_calls, 1)
        self.assertEqual(client.inventory_calls, 1)
        self.assertIn("dev_office", result.devices)

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

    def test_replaces_numbered_presence_ids_with_current_advanced_roles(self) -> None:
        """Role metadata must repair old Presence (1)..(4) registry rows."""
        state_specs = [
            ("identifier_7091628e9151", "부모님댁", "presence", "1"),
            ("identifier_bf4c9146a548", "친정집", "presence_2", "2"),
            ("identifier_cd4f3cfbf2aa", "main", "presence_3", "3"),
            ("identifier_d5fc226da81d", "회사", "presence_4", "4"),
        ]
        states = [
            BridgeState(
                component,
                "identifier_149a650ca9d",
                "presence",
                "present"
                if component == "identifier_cd4f3cfbf2aa"
                else "not present",
                None,
                "2026-08-31T06:00:00Z",
                component_role=role,
            )
            for component, role, _base, _number in state_specs
        ]
        device = BridgeDevice(
            "dev_332",
            "loc_001",
            None,
            "Jaebunyi Jump3",
            "mobile",
            True,
            states={state.key: state for state in states},
        )
        registry_entries = [
            SimpleNamespace(
                entity_id=(
                    "binary_sensor.jaebunyi_jump3_presence"
                    if number == "1"
                    else f"binary_sensor.jaebunyi_jump3_presence_{number}_{number}"
                ),
                domain="binary_sensor",
                platform=DOMAIN,
                unique_id=f"dev_332_{component}_identifier_149a650ca9d_presence",
                device_id="uuid_jump3",
                config_entry_id="entry_001",
                name=None,
                disabled_by=None,
                original_name=f"Presence ({number})",
                object_id_base=base,
                suggested_object_id=(
                    "jaebunyi_jump3_presence"
                    if number == "1"
                    else f"jaebunyi_jump3_presence_{number}"
                ),
            )
            for component, _role, base, number in state_specs
        ]
        registry = FakeRegistry(registry_entries)
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.142",
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
        _migrate_entity_registry(object(), entry, inventory)

        self.assertCountEqual(
            [new for _old, new in registry.renamed],
            [
                "binary_sensor.jaebunyi_jump3_presence_부모님댁",
                "binary_sensor.jaebunyi_jump3_presence_친정집",
                "binary_sensor.jaebunyi_jump3_presence_home",
                "binary_sensor.jaebunyi_jump3_presence_회사",
            ],
        )
        self.assertCountEqual(
            [entry.object_id_base for entry in registry.entries],
            [
                "presence_부모님댁",
                "presence_친정집",
                "presence_home",
                "presence_회사",
            ],
        )

    def test_primary_controls_share_room_free_base_across_switch_and_fan(self) -> None:
        """Representation changes must not add a room or ``_switch`` suffix."""
        aquarium_switch = BridgeState(
            "identifier_component_switch",
            "identifier_capability_switch",
            "switch",
            "off",
            None,
            "2026-08-31T06:00:00Z",
            component_role="Switch",
        )
        custom_switch = BridgeState(
            "identifier_component_switch",
            "identifier_capability_switch",
            "switch",
            "off",
            None,
            "2026-08-31T06:00:00Z",
            component_role="Switch",
        )
        fan_switch = BridgeState(
            "main", "switch", "switch", "off", None, "2026-08-31T06:00:00Z"
        )
        fan_mode = BridgeState(
            "main", "fanMode", "fanMode", "auto", None, "2026-08-31T06:00:00Z"
        )
        aquarium = BridgeDevice(
            "dev_167",
            "loc_001",
            None,
            "Eohang",
            "air_purifier",
            True,
            states={aquarium_switch.key: aquarium_switch},
            controls={
                "action:main:switch": BridgeControl(
                    "action:main:switch",
                    "toggle",
                    "Power",
                    component=aquarium_switch.component,
                    capability=aquarium_switch.capability,
                    attribute="switch",
                    commands=("on", "off"),
                )
            },
        )
        custom_named_switch = BridgeDevice(
            "dev_168",
            "loc_001",
            None,
            "Synthetic",
            "switch",
            True,
            states={custom_switch.key: custom_switch},
            controls={
                "action:switch:switch": BridgeControl(
                    "action:switch:switch",
                    "toggle",
                    "Power",
                    component=custom_switch.component,
                    capability=custom_switch.capability,
                    attribute="switch",
                    commands=("on", "off"),
                )
            },
        )
        bathroom_fan = BridgeDevice(
            "dev_145",
            "loc_001",
            "room_bathroom",
            "Hwajangsil Hwanpunggi",
            "fan",
            True,
            states={fan_switch.key: fan_switch, fan_mode.key: fan_mode},
        )
        switch_entry = SimpleNamespace(
            entity_id="switch.eohang_switch",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_167_identifier_component_switch_identifier_capability_switch_switch",
            device_id="uuid_aquarium",
            config_entry_id="entry_001",
            name=None,
            disabled_by=None,
            original_name=None,
            object_id_base="switch",
            suggested_object_id="eohang_switch",
        )
        custom_switch_entry = SimpleNamespace(
            entity_id="switch.user_kept_synthetic_switch",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_168_identifier_component_switch_identifier_capability_switch_switch",
            device_id="uuid_custom_switch",
            config_entry_id="entry_001",
            name="User kept switch",
            disabled_by=None,
            original_name="Synthetic Switch",
            object_id_base="switch",
            suggested_object_id="synthetic_switch",
        )
        old_fan_switch_entry = SimpleNamespace(
            entity_id="switch.hwanpunggi",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_145_main_switch_switch",
            device_id="uuid_fan",
            config_entry_id="entry_001",
            name=None,
            disabled_by=None,
            original_name=None,
            object_id_base="switch",
            suggested_object_id="hwanpunggi_switch",
        )
        fan_entry = SimpleNamespace(
            entity_id="fan.hwajangsil_hwanpunggi",
            domain="fan",
            platform=DOMAIN,
            unique_id="dev_145_fan",
            device_id="uuid_fan",
            config_entry_id="entry_001",
            name=None,
            disabled_by=None,
            original_name=None,
            object_id_base="hwajangsil_hwanpunggi",
            suggested_object_id="hwajangsil_hwanpunggi",
        )
        registry = FakeRegistry(
            [switch_entry, custom_switch_entry, old_fan_switch_entry, fan_entry]
        )
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.142",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
            devices={
                aquarium.device_id: aquarium,
                custom_named_switch.device_id: custom_named_switch,
                bathroom_fan.device_id: bathroom_fan,
            },
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )

        _migrate_entity_registry(object(), entry, inventory)

        self.assertIn("switch.hwanpunggi", registry.removed)
        self.assertIn(
            ("switch.eohang_switch", "switch.eohang"),
            registry.renamed,
        )
        self.assertIn(
            ("fan.hwajangsil_hwanpunggi", "fan.hwanpunggi"),
            registry.renamed,
        )
        self.assertEqual(switch_entry.suggested_object_id, "eohang")
        self.assertIsNone(switch_entry.object_id_base)
        self.assertEqual(custom_switch_entry.entity_id, "switch.user_kept_synthetic_switch")
        self.assertEqual(custom_switch_entry.suggested_object_id, "synthetic_switch")
        self.assertEqual(fan_entry.suggested_object_id, "hwanpunggi")
        self.assertIsNone(fan_entry.object_id_base)

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
                (
                    "binary_sensor.smartthings_device_dev_426_presence_custom",
                    "binary_sensor.gyeongsugyi_s22_presence_custom",
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
            "binary_sensor.gyeongsugyi_s22_presence_custom",
        )
        self.assertEqual(
            custom_named_entry.object_id_base,
            "presence_custom",
        )
        self.assertEqual(
            custom_named_entry.suggested_object_id,
            "gyeongsugyi_s22_presence_custom",
        )

    def test_rebases_secondary_switch_components_to_distinct_generated_ids(self) -> None:
        """Move generated multi-switch rows away from duplicate device-name IDs."""
        states = [
            BridgeState(
                component,
                f"identifier_capability_{component}",
                "switch",
                "off",
                None,
                "2026-08-29T00:00:00Z",
                component_role=role,
            )
            for component, role in (
                ("main", "main"),
                ("identifier_component_switch2", "switch2"),
                ("identifier_component_switch3", "switch3"),
            )
        ]
        device = BridgeDevice(
            "dev_lamp",
            "loc_001",
            "room_living",
            "Geosil Ganjeobdeung",
            "switch",
            True,
            states={state.key: state for state in states},
            controls={
                f"action:{state.component}:{state.capability}:switch": BridgeControl(
                    f"action:{state.component}:{state.capability}:switch",
                    "toggle",
                    "Power",
                    component=state.component,
                    capability=state.capability,
                    attribute=state.attribute,
                    commands=("on", "off"),
                )
                for state in states
            },
        )
        registry_entries = [
            SimpleNamespace(
                entity_id="switch.geosil_ganjeobdeung",
                domain="switch",
                platform=DOMAIN,
                unique_id="dev_lamp_main_identifier_capability_main_switch",
                device_id="uuid_lamp",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_ganjeobdeung",
            ),
            SimpleNamespace(
                entity_id="switch.geosil_geosil_ganjeobdeung",
                domain="switch",
                platform=DOMAIN,
                unique_id=(
                    "dev_lamp_identifier_component_switch2_"
                    "identifier_capability_identifier_component_switch2_switch"
                ),
                device_id="uuid_lamp",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_geosil_ganjeobdeung",
            ),
            SimpleNamespace(
                entity_id="switch.geosil_ganjeobdeung_2",
                domain="switch",
                platform=DOMAIN,
                unique_id=(
                    "dev_lamp_identifier_component_switch3_"
                    "identifier_capability_identifier_component_switch3_switch"
                ),
                device_id="uuid_lamp",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_ganjeobdeung_2",
            ),
        ]
        registry = FakeRegistry(registry_entries)
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.130",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_living": ("loc_001", "Geosil")},
            devices={device.device_id: device},
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            inventory,
        )

        self.assertCountEqual(
            registry.renamed,
            [
                (
                    "switch.geosil_geosil_ganjeobdeung",
                    "switch.geosil_ganjeobdeung_스위치_2",
                ),
                (
                    "switch.geosil_ganjeobdeung_2",
                    "switch.geosil_ganjeobdeung_스위치_3",
                ),
            ],
        )
        self.assertEqual(registry_entries[0].entity_id, "switch.geosil_ganjeobdeung")
        self.assertEqual(
            registry_entries[1].suggested_object_id,
            "geosil_ganjeobdeung_스위치_2",
        )
        self.assertEqual(
            registry_entries[2].suggested_object_id,
            "geosil_ganjeobdeung_스위치_3",
        )

    def test_registry_migration_updates_switch_original_name_without_user_name_or_entity_id(self) -> None:
        """Refresh generated Web-label metadata without taking over user names."""
        state = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        control = BridgeControl(
            "power",
            "toggle",
            "Power",
            component=state.component,
            capability=state.capability,
            attribute=state.attribute,
            commands=("on", "off"),
        )
        device = BridgeDevice(
            "dev_outlet",
            "loc_001",
            None,
            "멀티탭",
            "outlet_1",
            True,
            states={state.key: state},
            controls={control.control_id: control},
        )
        before = SimpleNamespace(
            entity_id="switch.meoltitaeb",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_outlet_main_switch_switch",
            device_id="ha_device_outlet",
            name="내 전원",
            original_name=None,
            disabled_by=None,
            object_id_base=None,
            suggested_object_id=None,
        )
        registry = FakeRegistry([before])
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.154",
                protocol_version="5:test",
                locations={"loc_001": "Home"},
                rooms={},
                devices={device.device_id: device},
            ),
        )

        after = registry.async_get("switch.meoltitaeb")
        self.assertIs(after, before)
        self.assertEqual(after.name, "내 전원")
        self.assertEqual(after.original_name, "전원")

    def test_registry_migration_preserves_multi_channel_switch_entity_ids(self) -> None:
        """Web label repair must not rename existing switch rows."""
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        status = BridgeState(
            "main",
            "yjswitchstatus",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_outlet",
            "loc_001",
            None,
            "멀티탭",
            "outlet_1",
            True,
            states={power.key: power, status.key: status},
            controls={
                "power": BridgeControl(
                    "power",
                    "toggle",
                    "Power",
                    component=power.component,
                    capability=power.capability,
                    attribute=power.attribute,
                    commands=("on", "off"),
                ),
                "status": BridgeControl(
                    "status",
                    "toggle",
                    "yjswitchstatus",
                    component=status.component,
                    capability=status.capability,
                    attribute=status.attribute,
                    commands=("on", "off"),
                ),
            },
        )
        power_entry = SimpleNamespace(
            entity_id="switch.meoltitaeb",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_outlet_main_switch_switch",
            device_id="ha_device_outlet",
            name="내 멀티탭 전원",
            original_name=None,
            disabled_by=None,
            object_id_base=None,
            suggested_object_id=None,
        )
        status_entry = SimpleNamespace(
            entity_id="switch.meoltitaeb_2",
            domain="switch",
            platform=DOMAIN,
            unique_id="dev_outlet_main_yjswitchstatus_switch",
            device_id="ha_device_outlet",
            name=None,
            original_name=None,
            disabled_by=None,
            object_id_base=None,
            suggested_object_id=None,
        )
        registry = FakeRegistry([power_entry, status_entry])
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.154",
                protocol_version="5:test",
                locations={"loc_001": "Home"},
                rooms={},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(power_entry.entity_id, "switch.meoltitaeb")
        self.assertEqual(status_entry.entity_id, "switch.meoltitaeb_2")
        self.assertEqual(power_entry.name, "내 멀티탭 전원")
        self.assertIsNone(status_entry.name)
        self.assertEqual(power_entry.original_name, "전원")
        self.assertEqual(status_entry.original_name, "장치 상태")

    def test_rebases_identifier_only_secondary_switch_components_by_order(self) -> None:
        """Keep registry repair aligned with generated unreadable switch names."""
        states = [
            BridgeState(
                component,
                f"identifier_capability_{component}",
                "switch",
                "off",
                None,
                "2026-08-29T00:00:00Z",
                component_role=role,
            )
            for component, role in (
                ("main", "main"),
                ("identifier_component_b", "identifier_role_b"),
                ("identifier_component_a", "identifier_role_a"),
            )
        ]
        device = BridgeDevice(
            "dev_lamp_identifier",
            "loc_001",
            "room_living",
            "Geosil Ganjeobdeung",
            "switch",
            True,
            states={state.key: state for state in states},
            controls={
                f"action:{state.component}:{state.capability}:switch": BridgeControl(
                    f"action:{state.component}:{state.capability}:switch",
                    "toggle",
                    "Power",
                    component=state.component,
                    capability=state.capability,
                    attribute=state.attribute,
                    commands=("on", "off"),
                )
                for state in states
            },
        )
        registry_entries = [
            SimpleNamespace(
                entity_id="switch.geosil_ganjeobdeung",
                domain="switch",
                platform=DOMAIN,
                unique_id=(
                    "dev_lamp_identifier_main_"
                    "identifier_capability_main_switch"
                ),
                device_id="uuid_lamp_identifier",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_ganjeobdeung",
            ),
            SimpleNamespace(
                entity_id="switch.geosil_geosil_ganjeobdeung",
                domain="switch",
                platform=DOMAIN,
                unique_id=(
                    "dev_lamp_identifier_identifier_component_a_"
                    "identifier_capability_identifier_component_a_switch"
                ),
                device_id="uuid_lamp_identifier",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_geosil_ganjeobdeung",
            ),
            SimpleNamespace(
                entity_id="switch.geosil_ganjeobdeung_2",
                domain="switch",
                platform=DOMAIN,
                unique_id=(
                    "dev_lamp_identifier_identifier_component_b_"
                    "identifier_capability_identifier_component_b_switch"
                ),
                device_id="uuid_lamp_identifier",
                name=None,
                disabled_by=None,
                original_name=None,
                object_id_base=None,
                suggested_object_id="geosil_ganjeobdeung_2",
            ),
        ]
        registry = FakeRegistry(registry_entries)
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.132",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={"room_living": ("loc_001", "Geosil")},
            devices={device.device_id: device},
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            inventory,
        )

        self.assertCountEqual(
            registry.renamed,
            [
                (
                    "switch.geosil_geosil_ganjeobdeung",
                    "switch.geosil_ganjeobdeung_스위치_2",
                ),
                (
                    "switch.geosil_ganjeobdeung_2",
                    "switch.geosil_ganjeobdeung_스위치_3",
                ),
            ],
        )
        self.assertEqual(
            registry_entries[1].suggested_object_id,
            "geosil_ganjeobdeung_스위치_2",
        )
        self.assertEqual(
            registry_entries[2].suggested_object_id,
            "geosil_ganjeobdeung_스위치_3",
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

    def test_localized_single_presence_id_migrates_back_to_presence(self) -> None:
        state = BridgeState("main", "presenceSensor", "presence", "present", None, "2026-09-05T00:00:00Z")
        device = BridgeDevice(
            "dev_iphone", "loc_001", None, "iPhone", "mobile", True,
            states={state.key: state},
        )
        row = SimpleNamespace(
            entity_id="binary_sensor.iphone_jaesil", domain="binary_sensor",
            platform=DOMAIN, unique_id="dev_iphone_main_presenceSensor_presence",
            device_id="uuid_iphone", name=None, disabled_by=None,
            original_name="재실", object_id_base="jaesil",
            suggested_object_id="iphone_jaesil",
        )
        registry = FakeRegistry([row])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            1, True, "0.1.182", "5", {"loc_001": "Home"}, {}, {device.device_id: device}
        )
        _migrate_entity_registry(
            object(), SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}), inventory
        )
        self.assertEqual(row.entity_id, "binary_sensor.iphone_presence")
        self.assertEqual(row.object_id_base, "presence")
        self.assertEqual(row.suggested_object_id, "iphone_presence")

    def test_generated_advanced_on_suffix_migrates_to_device_name(self) -> None:
        state = BridgeState("opaque_main", "opaque_switch", "switch", "off", None, "2026-09-05T00:00:00Z")
        control_id = "advanced:opaque_main:opaque_switch:switch"
        device = BridgeDevice(
            "dev_ha_switch", "loc_001", None, "Home Assistant integration switch",
            "signage", True, states={state.key: state},
            controls={control_id: BridgeControl(
                control_id, "toggle", "on", component=state.component,
                capability=state.capability, attribute=state.attribute,
                commands=("on", "off"), transport="advanced",
            )},
        )
        row = SimpleNamespace(
            entity_id="switch.home_assistant_integration_switch_on", domain="switch",
            platform=DOMAIN, unique_id="dev_ha_switch_opaque_main_opaque_switch_switch",
            device_id="uuid_switch", name=None, disabled_by=None,
            original_name="On", object_id_base="on",
            suggested_object_id="home_assistant_integration_switch_on",
        )
        registry = FakeRegistry([row])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            1, True, "0.1.182", "5", {"loc_001": "Home"}, {}, {device.device_id: device}
        )
        _migrate_entity_registry(
            object(), SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}), inventory
        )
        self.assertEqual(row.entity_id, "switch.home_assistant_integration_switch")

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

    def test_same_name_fallback_repair_preserves_user_name_while_rebasing_id(self) -> None:
        """Preserve explicit display names while removing stale fallback IDs."""
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

        self.assertEqual(
            registry.renamed,
            [
                (
                    "binary_sensor.smartthings_device_dev_401_presence",
                    "binary_sensor.iphone_presence_2",
                )
            ],
        )
        self.assertEqual(
            stale_entry.entity_id,
            "binary_sensor.iphone_presence_2",
        )
        self.assertEqual(stale_entry.name, "My iPhone presence")
        self.assertEqual(stale_entry.object_id_base, "presence")
        self.assertEqual(stale_entry.suggested_object_id, "iphone_presence_2")

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

        class ActiveStates:
            def __init__(self) -> None:
                self.removed: list[str] = []

            def get(self, entity_id: str) -> object | None:
                if entity_id != "binary_sensor.hwajangsil_doeosenseo_contact":
                    return None
                return SimpleNamespace(
                    state="on",
                    attributes={"restored": True},
                )

            def async_remove(self, entity_id: str) -> None:
                self.removed.append(entity_id)

        active_states = ActiveStates()

        _migrate_entity_registry(
            SimpleNamespace(states=active_states),
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
        self.assertEqual(active_states.removed, [])

    def test_reclaims_numbered_id_after_restored_state_reservation(self) -> None:
        """Remove only a stale restored state before reclaiming the canonical ID."""
        canonical_entity_id = "binary_sensor.hwajangsil_doeosenseo_contact"
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
            entity_id=f"{canonical_entity_id}_4",
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

        class FakeStates:
            def __init__(self) -> None:
                self.values = {
                    canonical_entity_id: SimpleNamespace(
                        state="unavailable",
                        attributes={"restored": True},
                    )
                }
                self.removed: list[str] = []

            def get(self, entity_id: str) -> object | None:
                return self.values.get(entity_id)

            def async_remove(self, entity_id: str) -> None:
                self.removed.append(entity_id)
                self.values.pop(entity_id, None)

        fake_states = FakeStates()

        class RestoredStateRegistry(FakeRegistry):
            def async_update_entity(
                self,
                entity_id: str,
                *,
                new_unique_id: str | None = None,
                new_entity_id: str | None = None,
            ) -> None:
                if (
                    new_entity_id == canonical_entity_id
                    and fake_states.get(canonical_entity_id) is not None
                ):
                    raise ValueError("entity id is already reserved")
                super().async_update_entity(
                    entity_id,
                    new_unique_id=new_unique_id,
                    new_entity_id=new_entity_id,
                )

        registry = RestoredStateRegistry([registry_entry])
        self.patch_registry(registry)

        _migrate_entity_registry(
            SimpleNamespace(states=fake_states),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_001"},
            ),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.134",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_bathroom": ("loc_001", "Hwajangsil")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(fake_states.removed, [canonical_entity_id])
        self.assertEqual(registry_entry.entity_id, canonical_entity_id)
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

    def test_repeated_device_slug_state_id_repairs_once_and_stays_stable(self) -> None:
        """Collapse generated IDs that fed a prior canonical object ID back in."""
        state = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            3,
            "C",
            "2026-09-01T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_fridge",
            "loc_001",
            None,
            "Fridge",
            "refrigerator",
            True,
            states={state.key: state},
        )
        registry_entry = SimpleNamespace(
            entity_id="sensor.fridge_fridge_temperature",
            domain="sensor",
            platform=DOMAIN,
            unique_id="dev_fridge_main_temperatureMeasurement_temperature",
            device_id="uuid_fridge",
            name=None,
            disabled_by=None,
            original_name="fridge_fridge_temperature",
            object_id_base="fridge_fridge_temperature",
            suggested_object_id="fridge_fridge_temperature",
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)

        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.157",
            protocol_version="5",
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
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    "sensor.fridge_fridge_temperature",
                    "sensor.fridge_temperature",
                )
            ],
        )
        self.assertEqual(registry_entry.entity_id, "sensor.fridge_temperature")
        self.assertEqual(registry_entry.object_id_base, "temperature")
        self.assertEqual(
            registry_entry.suggested_object_id,
            "fridge_temperature",
        )

    def test_heavily_corrupted_generated_state_id_repairs_in_one_pass(self) -> None:
        """Bound a many-pass generated metadata feedback loop immediately."""
        state = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            3,
            "C",
            "2026-09-01T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_fridge",
            "loc_001",
            None,
            "Fridge",
            "refrigerator",
            True,
            states={state.key: state},
        )
        corrupted_object_id = "_".join(("fridge",) * 10000 + ("temperature",))
        registry_entry = SimpleNamespace(
            entity_id=f"sensor.{corrupted_object_id}",
            domain="sensor",
            platform=DOMAIN,
            unique_id="dev_fridge_main_temperatureMeasurement_temperature",
            device_id="uuid_fridge",
            name=None,
            disabled_by=None,
            original_name=corrupted_object_id,
            object_id_base=corrupted_object_id,
            suggested_object_id=corrupted_object_id,
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"}),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.157",
                protocol_version="5",
                locations={"loc_001": "Home"},
                rooms={},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(registry_entry.entity_id, "sensor.fridge_temperature")
        self.assertEqual(registry_entry.object_id_base, "temperature")
        self.assertEqual(registry_entry.suggested_object_id, "fridge_temperature")
        self.assertLess(len(registry_entry.entity_id), 80)

    def test_tail_repeated_device_slug_state_id_repairs_once_and_stays_stable(self) -> None:
        """Collapse live-shaped ``attr_device_device`` metadata feedback loops."""
        state = BridgeState(
            "main",
            "fridgeMode",
            "supportedFullFridgeModes",
            ["rapidCool", "powerCool"],
            None,
            "2026-09-01T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_fridge",
            "loc_001",
            None,
            "Naengjanggo",
            "refrigerator",
            True,
            states={state.key: state},
        )
        corrupted_object_id = "_".join(
            ("naengjanggo", "supported", "full", "fridge", "modes")
            + ("naengjanggo",) * 700
        )
        registry_entry = SimpleNamespace(
            entity_id=f"sensor.{corrupted_object_id}",
            domain="sensor",
            platform=DOMAIN,
            unique_id="dev_fridge_main_fridgeMode_supportedFullFridgeModes",
            device_id="uuid_fridge",
            name=None,
            disabled_by=None,
            original_name=corrupted_object_id,
            object_id_base=corrupted_object_id,
            suggested_object_id=corrupted_object_id,
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.157",
            protocol_version="5",
            locations={"loc_001": "Home"},
            rooms={},
            devices={device.device_id: device},
        )
        entry = SimpleNamespace(entry_id="entry_001", data={CONF_LOCATION_ID: "loc_001"})

        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)
        _migrate_entity_registry(object(), entry, inventory)

        self.assertEqual(
            registry.renamed,
            [
                (
                    f"sensor.{corrupted_object_id}",
                    "sensor.naengjanggo_supported_full_fridge_modes",
                )
            ],
        )
        self.assertEqual(
            registry_entry.entity_id,
            "sensor.naengjanggo_supported_full_fridge_modes",
        )
        self.assertEqual(
            registry_entry.object_id_base,
            "supported_full_fridge_modes",
        )
        self.assertEqual(
            registry_entry.suggested_object_id,
            "naengjanggo_supported_full_fridge_modes",
        )
        self.assertLess(len(registry_entry.entity_id), 80)

    def test_localized_role_suffix_metadata_converges_without_websocket_churn(self) -> None:
        """Collapse the live ``단일 도어`` restore-metadata feedback loop once."""
        states: list[BridgeState] = []
        for role in ("onedoor", "freezer"):
            component = f"identifier_component_{role}"
            states.extend(
                [
                    BridgeState(
                        component,
                        "contactSensor",
                        "contact",
                        "closed",
                        None,
                        "2026-09-03T00:00:00Z",
                        component_role="main",
                    ),
                    BridgeState(
                        component,
                        "temperatureMeasurement",
                        "temperature",
                        3,
                        "C",
                        "2026-09-03T00:00:00Z",
                        component_role=role,
                    ),
                ]
            )
        device = BridgeDevice(
            "dev_fridge",
            "loc_001",
            None,
            "Naengjanggo",
            "refrigerator",
            True,
            states={state.key: state for state in states},
        )
        repeated = "contact_" + "_".join(("danil_doeo",) * 14)
        registry_entry = SimpleNamespace(
            entity_id="binary_sensor.naengjanggo_contact_danil_doeo",
            domain="binary_sensor",
            platform=DOMAIN,
            unique_id=(
                "dev_fridge_identifier_component_onedoor_contactSensor_contact"
            ),
            device_id="uuid_fridge",
            name=None,
            disabled_by=None,
            original_name="Contact (단일 도어)",
            object_id_base=repeated,
            suggested_object_id=f"naengjanggo_{repeated}",
            has_entity_name=True,
        )
        registry = FakeRegistry([registry_entry])
        self.patch_registry(registry)
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.171",
            protocol_version="5",
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
        _migrate_entity_registry(object(), entry, inventory)

        expected_base = integration.slugify("Contact (단일 도어)")
        self.assertEqual(registry_entry.object_id_base, expected_base)
        self.assertEqual(
            registry_entry.suggested_object_id,
            f"naengjanggo_{expected_base}",
        )
        self.assertEqual(registry_entry.original_name, "Contact (단일 도어)")
        self.assertEqual(registry.get_or_create_calls, 1)
    def test_primary_switch_name_collision_uses_device_name_numbered_ids(self) -> None:
        """Use only the device name and a numeric suffix across config entries."""
        registry, devices = self._primary_switch_collision_registry()
        home_entry = registry.async_get("switch.meoltitaeb_switch")
        spark_entry = registry.async_get("switch.meoltitaeb")
        assert home_entry is not None
        assert spark_entry is not None

        self.patch_registry(registry, config_entries=[home_entry])
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_home_multitap",
                    identifiers={(DOMAIN, "dev_191")},
                    area_id="anbang",
                    config_entries={"entry_home"},
                ),
                SimpleNamespace(
                    id="uuid_spark_multitap",
                    identifiers={(DOMAIN, "dev_567")},
                    area_id="samuseol",
                    config_entries={"entry_spark"},
                ),
            ]
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(entry_id="entry_home", data={CONF_LOCATION_ID: "loc_home"}),
            self._primary_switch_collision_inventory(devices),
        )

        self.assertEqual(home_entry.entity_id, "switch.meoltitaeb_2")
        self.assertEqual(home_entry.object_id_base, None)
        self.assertEqual(home_entry.suggested_object_id, "meoltitaeb_2")
        self.assertEqual(spark_entry.entity_id, "switch.meoltitaeb")

    def test_primary_switch_name_collision_converges_independent_of_entry_order(self) -> None:
        """Both load orders converge on device-name-only IDs with numeric suffixes."""
        results: list[set[str]] = []
        for first_location, second_location in (
            ("loc_home", "loc_office"),
            ("loc_office", "loc_home"),
        ):
            registry, devices = self._primary_switch_collision_registry()
            entries_by_location = {
                "loc_home": registry.async_get("switch.meoltitaeb_switch"),
                "loc_office": registry.async_get("switch.meoltitaeb"),
            }
            assert entries_by_location["loc_home"] is not None
            assert entries_by_location["loc_office"] is not None
            inventory = self._primary_switch_collision_inventory(devices)
            integration.dr.async_get = lambda _hass: SimpleNamespace(devices=[])

            for location_id in (first_location, second_location):
                self.patch_registry(
                    registry,
                    config_entries=[entries_by_location[location_id]],
                )
                _migrate_entity_registry(
                    object(),
                    SimpleNamespace(
                        entry_id=f"entry_{location_id}",
                        data={CONF_LOCATION_ID: location_id},
                    ),
                    inventory,
                )

            results.append({entry.entity_id for entry in registry.entries})

        expected = {
            "switch.meoltitaeb",
            "switch.meoltitaeb_2",
        }
        self.assertEqual(results, [expected, expected])

    def test_primary_switch_collision_preserves_arbitrary_custom_entity_id(self) -> None:
        """Do not rewrite a user-chosen ID just because the row has no name."""
        for custom_entity_id in (
            "switch.my_custom_multitap",
            "switch.my_meoltitaeb_meoltitaeb_custom",
            "switch.meoltitaeb_meoltitaeb_custom",
        ):
            registry, devices = self._primary_switch_collision_registry(
                home_entity_id=custom_entity_id,
            )
            home_entry = registry.async_get(custom_entity_id)
            spark_entry = registry.async_get("switch.meoltitaeb")
            assert home_entry is not None
            assert spark_entry is not None
            self.patch_registry(registry, config_entries=[home_entry])

            _migrate_entity_registry(
                object(),
                SimpleNamespace(
                    entry_id="entry_home",
                    data={CONF_LOCATION_ID: "loc_home"},
                ),
                self._primary_switch_collision_inventory(devices),
            )

            custom_object_id = custom_entity_id.partition(".")[2]
            self.assertEqual(registry.renamed, [], custom_entity_id)
            self.assertEqual(home_entry.entity_id, custom_entity_id)
            self.assertEqual(home_entry.suggested_object_id, custom_object_id)
            self.assertEqual(spark_entry.entity_id, "switch.meoltitaeb")

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

    def test_migration_removes_non_executable_switches_and_duplicate_refresh(self) -> None:
        """Keep one exact main control and remove Advanced-only UI artifacts."""
        components = ("main", "switch2", "switch3", "switch4")
        states = {
            state.key: state
            for component in components
            for state in (
                BridgeState(
                    component,
                    "identifier_switch",
                    "switch",
                    "off",
                    None,
                    "2026-08-31T14:00:00Z",
                    component_role=component,
                ),
            )
        }
        controls = {
            "action:main:identifier_switch:switch": BridgeControl(
                "action:main:identifier_switch:switch",
                "toggle",
                "Power",
                component="main",
                capability="identifier_switch",
                attribute="switch",
                commands=("on", "off"),
            ),
            **{
                f"advanced:refresh:{component}:identifier_refresh": BridgeControl(
                    f"advanced:refresh:{component}:identifier_refresh",
                    "button",
                    "Refresh",
                    component=component,
                    capability="identifier_refresh",
                    attribute="refresh",
                    commands=("refresh",),
                )
                for component in components
            },
        }
        device = BridgeDevice(
            "dev_151",
            "loc_001",
            "room_g",
            "거실 간접등",
            "switch",
            True,
            states=states,
            controls=controls,
        )
        switch_entity_ids = {
            "main": "switch.ganjeobdeung",
            "switch2": "switch.geosil_ganjeobdeung_seuwici_2",
            "switch3": "switch.geosil_ganjeobdeung_seuwici_3",
            "switch4": "switch.geosil_ganjeobdeung_seuwici_4",
        }
        refresh_entity_ids = {
            "main": "button.ganjeobdeung_refresh",
            "switch2": "button.geosil_ganjeobdeung_refresh_2",
            "switch3": "button.geosil_ganjeobdeung_refresh_3",
            "switch4": "button.geosil_ganjeobdeung_refresh_4",
        }
        registry = FakeRegistry(
            [
                self._registry_entry(
                    entity_id,
                    "uuid_indirect_light",
                    unique_id=(
                        f"dev_151_{component}_identifier_switch_switch"
                    ),
                )
                for component, entity_id in switch_entity_ids.items()
            ]
            + [
                self._registry_entry(
                    entity_id,
                    "uuid_indirect_light",
                    domain="button",
                    unique_id=(
                        "dev_151_button_"
                        f"advanced:refresh:{component}:identifier_refresh"
                    ),
                )
                for component, entity_id in refresh_entity_ids.items()
            ]
        )
        self.patch_registry(registry)
        integration.dr.async_get = lambda _hass: SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_indirect_light",
                    identifiers={(DOMAIN, "dev_151")},
                    area_id="geosil",
                    config_entries={"entry_001"},
                )
            ]
        )

        _migrate_entity_registry(
            object(),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_001"},
            ),
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.147",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={"room_g": ("loc_001", "Geosil")},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(
            set(registry.removed),
            {
                switch_entity_ids["switch2"],
                switch_entity_ids["switch3"],
                switch_entity_ids["switch4"],
                refresh_entity_ids["switch2"],
                refresh_entity_ids["switch3"],
                refresh_entity_ids["switch4"],
            },
        )
        self.assertIsNotNone(registry.async_get(switch_entity_ids["main"]))
        self.assertIsNotNone(registry.async_get(refresh_entity_ids["main"]))

    def test_non_ready_cached_inventory_never_removes_control_rows(self) -> None:
        """Defer destructive cleanup until the Bridge has a complete inventory."""
        switch = BridgeState(
            "main",
            "identifier_switch",
            "switch",
            "off",
            None,
            "2026-08-31T14:00:00Z",
            component_role="main",
        )
        device = BridgeDevice(
            "dev_cached",
            "loc_001",
            None,
            "Cached Light",
            "switch",
            True,
            states={switch.key: switch},
            controls={
                component: BridgeControl(
                    component,
                    "button",
                    "Refresh",
                    component=component,
                    capability="identifier_refresh",
                    attribute="refresh",
                    commands=("refresh",),
                )
                for component in ("main", "secondary")
            },
        )
        registry = FakeRegistry(
            [
                self._registry_entry(
                    "switch.cached_light",
                    "uuid_cached_light",
                    unique_id="dev_cached_main_identifier_switch_switch",
                ),
                self._registry_entry(
                    "button.cached_light_refresh_2",
                    "uuid_cached_light",
                    domain="button",
                    unique_id="dev_cached_button_secondary",
                ),
            ]
        )
        self.patch_registry(registry)

        _migrate_entity_registry(
            object(),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_001"},
            ),
            BridgeInventory(
                sequence=1,
                ready=False,
                bridge_version="0.1.147",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={device.device_id: device},
            ),
        )

        self.assertEqual(registry.removed, [])

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
            [15.0],
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

    def test_removes_stale_bridge_entities_and_card_but_preserves_locations(self) -> None:
        """Deleted dev_N aliases disappear; loc_N location cards stay intact."""
        updates: list[tuple[str, str]] = []
        removed_devices: list[str] = []
        registry = FakeRegistry(
            [
                SimpleNamespace(
                    entity_id="sensor.deleted_battery",
                    domain="sensor",
                    platform=DOMAIN,
                    unique_id="dev_999_main_battery_battery",
                    device_id="uuid_orphan",
                    config_entry_id="entry_001",
                    name=None,
                    disabled_by=None,
                    original_name="Battery",
                    object_id_base="battery",
                    suggested_object_id="deleted_battery",
                ),
                SimpleNamespace(
                    entity_id="sensor.location_status",
                    domain="sensor",
                    platform=DOMAIN,
                    unique_id="loc_009_status",
                    device_id="uuid_location",
                    config_entry_id="entry_001",
                    name=None,
                    disabled_by=None,
                    original_name="Status",
                    object_id_base="status",
                    suggested_object_id="location_status",
                ),
            ]
        )
        device_registry = SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_active",
                    identifiers={(DOMAIN, "dev_001")},
                    config_entries={"entry_001"},
                ),
                SimpleNamespace(
                    id="uuid_location",
                    identifiers={(DOMAIN, "loc_009")},
                    config_entries={"entry_001"},
                ),
                SimpleNamespace(
                    id="uuid_orphan",
                    identifiers={(DOMAIN, "dev_999")},
                    config_entries={"entry_001"},
                ),
            ],
            async_update_device=lambda device_id, *, remove_config_entry: updates.append(
                (device_id, remove_config_entry)
            ),
            async_remove_device=lambda device_id: removed_devices.append(device_id),
        )
        integration.dr.async_get = lambda _hass: device_registry
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_device = (
            lambda current_registry, device_id, include_disabled_entities=False: [
                row
                for row in current_registry.entries
                if getattr(row, "device_id", None) == device_id
            ]
        )
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
                "dev_001": self._bridge_device("dev_001", "Active"),
            },
        )

        integration._remove_orphan_bridge_device_cards(
            object(),
            entry,
            inventory,
            list(registry.entries),
            set(),
        )

        self.assertEqual(registry.removed, ["sensor.deleted_battery"])
        self.assertEqual(removed_devices, ["uuid_orphan"])
        self.assertEqual(updates, [])
        self.assertIsNotNone(registry.async_get("sensor.location_status"))

    def test_deleted_bridge_card_keeps_foreign_references(self) -> None:
        """Remove only this entry's entity when another integration shares a card."""
        updates: list[tuple[str, str]] = []
        removed_devices: list[str] = []
        own = SimpleNamespace(
            entity_id="sensor.deleted_signal",
            domain="sensor",
            platform=DOMAIN,
            unique_id="dev_998_main_signal_signal",
            device_id="uuid_shared",
            config_entry_id="entry_001",
            name=None,
            disabled_by=None,
            original_name="Signal",
            object_id_base="signal",
            suggested_object_id="deleted_signal",
        )
        foreign = SimpleNamespace(
            entity_id="sensor.foreign",
            domain="sensor",
            platform="other_integration",
            unique_id="foreign_signal",
            device_id="uuid_shared",
            config_entry_id="entry_foreign",
            name=None,
            disabled_by=None,
            original_name="Foreign",
            object_id_base="foreign",
            suggested_object_id="foreign",
        )
        registry = FakeRegistry([own, foreign])
        device_registry = SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_shared",
                    identifiers={(DOMAIN, "dev_998")},
                    config_entries={"entry_001", "entry_foreign"},
                )
            ],
            async_update_device=lambda device_id, *, remove_config_entry: updates.append(
                (device_id, remove_config_entry)
            ),
            async_remove_device=lambda device_id: removed_devices.append(device_id),
        )
        integration.dr.async_get = lambda _hass: device_registry
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_device = (
            lambda current_registry, device_id, include_disabled_entities=False: [
                row
                for row in current_registry.entries
                if getattr(row, "device_id", None) == device_id
            ]
        )
        entry = SimpleNamespace(
            entry_id="entry_001",
            data={CONF_LOCATION_ID: "loc_001"},
        )
        inventory = BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.142",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )

        integration._remove_orphan_bridge_device_cards(
            object(), entry, inventory, list(registry.entries), set()
        )

        self.assertEqual(registry.removed, ["sensor.deleted_signal"])
        self.assertEqual(updates, [("uuid_shared", "entry_001")])
        self.assertEqual(removed_devices, [])
        self.assertIsNotNone(registry.async_get("sensor.foreign"))

    def test_cached_inventory_never_removes_device_cards(self) -> None:
        """Deletion waits for a current authoritative inventory."""
        removed_devices: list[str] = []
        device_registry = SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_cached",
                    identifiers={(DOMAIN, "dev_997")},
                    config_entries={"entry_001"},
                )
            ],
            async_remove_device=lambda device_id: removed_devices.append(device_id),
        )
        integration.dr.async_get = lambda _hass: device_registry
        integration.er.async_get = lambda _hass: FakeRegistry([])

        integration._remove_orphan_bridge_device_cards(
            object(),
            SimpleNamespace(
                entry_id="entry_001",
                data={CONF_LOCATION_ID: "loc_001"},
            ),
            BridgeInventory(
                sequence=1,
                ready=False,
                bridge_version="0.1.142",
                protocol_version="4",
                locations={"loc_001": "Home"},
                rooms={},
                devices={},
            ),
            [],
            set(),
        )

        self.assertEqual(removed_devices, [])

    def test_inventory_readiness_changes_registry_migration_fingerprint(self) -> None:
        """A fresh authoritative view must retry deferred device deletion."""
        cached = BridgeInventory(
            sequence=1,
            ready=False,
            bridge_version="0.1.142",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )
        current = BridgeInventory(
            sequence=2,
            ready=True,
            bridge_version="0.1.142",
            protocol_version="4",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )

        self.assertNotEqual(
            integration._entity_registry_topology_fingerprint(cached, "loc_001"),
            integration._entity_registry_topology_fingerprint(current, "loc_001"),
        )

    def test_shared_card_detach_failure_is_visible(self) -> None:
        """An unsupported registry signature must not fail silently."""
        registry = FakeRegistry([])

        def reject_update(_device_id: str, *, remove_config_entry: str) -> None:
            raise TypeError(remove_config_entry)

        device_registry = SimpleNamespace(
            devices=[
                SimpleNamespace(
                    id="uuid_shared_failure",
                    identifiers={(DOMAIN, "dev_996")},
                    config_entries={"entry_001", "entry_foreign"},
                )
            ],
            async_update_device=reject_update,
        )
        integration.dr.async_get = lambda _hass: device_registry
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_device = (
            lambda _registry, _device_id, include_disabled_entities=False: []
        )

        with self.assertLogs("smartthings_web.__init__", level="WARNING") as logs:
            integration._remove_orphan_bridge_device_cards(
                object(),
                SimpleNamespace(
                    entry_id="entry_001",
                    data={CONF_LOCATION_ID: "loc_001"},
                ),
                BridgeInventory(
                    sequence=1,
                    ready=True,
                    bridge_version="0.1.142",
                    protocol_version="4",
                    locations={"loc_001": "Home"},
                    rooms={},
                    devices={},
                ),
                [],
                set(),
            )

        self.assertIn("could not detach a stale shared device card", logs.output[0])

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
            controls={
                "action:main:switch": BridgeControl(
                    "action:main:switch",
                    "toggle",
                    "Power",
                    component="main",
                    capability="switch",
                    attribute="switch",
                    commands=("on", "off"),
                )
            },
        )

    @staticmethod
    def _primary_switch_collision_device(
        device_id: str,
        location_id: str,
        room_id: str,
    ) -> BridgeDevice:
        power = BridgeState(
            "main",
            "switch",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        status = BridgeState(
            "main",
            "yjswitchstatus",
            "switch",
            "off",
            None,
            "2026-09-01T00:00:00Z",
        )
        return BridgeDevice(
            device_id=device_id,
            location_id=location_id,
            room_id=room_id,
            name="Meoltitaeb",
            device_type="outlet",
            online=True,
            states={power.key: power, status.key: status},
            controls={
                f"{device_id}:power": BridgeControl(
                    f"{device_id}:power",
                    "toggle",
                    "Power",
                    component=power.component,
                    capability=power.capability,
                    attribute=power.attribute,
                    commands=("on", "off"),
                ),
                f"{device_id}:status": BridgeControl(
                    f"{device_id}:status",
                    "toggle",
                    "yjswitchstatus",
                    component=status.component,
                    capability=status.capability,
                    attribute=status.attribute,
                    commands=("on", "off"),
                ),
            },
        )

    @classmethod
    def _primary_switch_collision_registry(
        cls,
        *,
        home_entity_id: str = "switch.meoltitaeb_switch",
    ) -> tuple[FakeRegistry, dict[str, BridgeDevice]]:
        devices = {
            "dev_191": cls._primary_switch_collision_device(
                "dev_191",
                "loc_home",
                "room_anbang",
            ),
            "dev_567": cls._primary_switch_collision_device(
                "dev_567",
                "loc_office",
                "room_samuseol",
            ),
        }
        entries = [
            SimpleNamespace(
                entity_id=home_entity_id,
                domain="switch",
                platform=DOMAIN,
                unique_id="dev_191_main_switch_switch",
                device_id="uuid_home_multitap",
                name=None,
                disabled_by=None,
                original_name="전원",
                object_id_base=None,
                suggested_object_id="meoltitaeb_switch",
            ),
            SimpleNamespace(
                entity_id="switch.meoltitaeb",
                domain="switch",
                platform=DOMAIN,
                unique_id="dev_567_main_switch_switch",
                device_id="uuid_spark_multitap",
                name=None,
                disabled_by=None,
                original_name="전원",
                object_id_base=None,
                suggested_object_id="meoltitaeb",
            ),
        ]
        return FakeRegistry(entries), devices

    @staticmethod
    def _primary_switch_collision_inventory(
        devices: dict[str, BridgeDevice],
    ) -> BridgeInventory:
        return BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.157",
            protocol_version="5",
            locations={
                "loc_home": "Home",
                "loc_office": "ExampleOffice",
            },
            rooms={
                "room_anbang": ("loc_home", "Anbang"),
                "room_samuseol": ("loc_office", "Samuseol"),
            },
            devices=devices,
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

        self.assertEqual(delays, [1.0, 2.0, 4.0])
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
