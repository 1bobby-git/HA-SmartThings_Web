"""Regression tests for SmartThings Web setup migrations."""

from __future__ import annotations

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
        FAN = "fan"
        IMAGE = "image"
        LIGHT = "light"
        MEDIA_PLAYER = "media_player"
        NUMBER = "number"
        SCENE = "scene"
        SELECT = "select"
        SENSOR = "sensor"
        SWITCH = "switch"

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
    device_registry.async_get = lambda _hass: None  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.device_registry"] = device_registry

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


_install_homeassistant_stubs()

from smartthings_web.__init__ import (  # noqa: E402
    _async_update_repairs,
    _control_mode,
    _migrate_entity_registry,
    _repair_loop,
)
from smartthings_web.const import (  # noqa: E402
    CONF_CONTROL_MODE,
    CONF_LOCATION_ID,
    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
    DOMAIN,
)
from smartthings_web.models import BridgeControl, BridgeDevice, BridgeInventory, BridgeState  # noqa: E402
import smartthings_web.__init__ as integration  # noqa: E402


class FakeRegistry:
    """Minimal entity registry surface used by setup migration."""

    def __init__(self, entries: list[SimpleNamespace]) -> None:
        self.entries = entries
        self.removed: list[str] = []
        self.updated: list[tuple[str, str]] = []

    def async_remove(self, entity_id: str) -> None:
        self.removed.append(entity_id)

    def async_get_entity_id(self, domain: str, platform: str, unique_id: str) -> str | None:
        for entry in self.entries:
            if entry.domain == domain and entry.platform == platform and entry.unique_id == unique_id:
                return entry.entity_id
        return None

    def async_update_entity(self, entity_id: str, *, new_unique_id: str) -> None:
        self.updated.append((entity_id, new_unique_id))


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

    def test_removes_registry_duplicate_when_initial_inventory_has_no_control(self) -> None:
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

        self.assertEqual(registry.removed, ["number.motion_detection_frequency_2"])
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

    def patch_registry(self, registry: FakeRegistry) -> None:
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_config_entry = lambda _registry, _entry_id: registry.entries


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


class FakeHealthClient:
    """Minimal async health client."""

    def __init__(self, health: dict[str, object]) -> None:
        self.health = health

    async def async_get_health(self) -> dict[str, object]:
        return self.health


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
