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
        FAN = "fan"
        IMAGE = "image"
        LIGHT = "light"
        MEDIA_PLAYER = "media_player"
        NUMBER = "number"
        SCENE = "scene"
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

    aiohttp_client = ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda _hass: None  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client


_install_homeassistant_stubs()

from smartthings_web.__init__ import _migrate_entity_registry  # noqa: E402
from smartthings_web.const import CONF_LOCATION_ID, DOMAIN  # noqa: E402
from smartthings_web.models import BridgeDevice, BridgeInventory, BridgeState  # noqa: E402
import smartthings_web.__init__ as integration  # noqa: E402


class FakeRegistry:
    """Minimal entity registry surface used by setup migration."""

    def __init__(self, entries: list[SimpleNamespace]) -> None:
        self.entries = entries
        self.removed: list[str] = []
        self.updated: list[tuple[str, str]] = []

    def async_remove(self, entity_id: str) -> None:
        self.removed.append(entity_id)

    def async_get_entity_id(self, _domain: str, _platform: str, _unique_id: str) -> str | None:
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

    def patch_registry(self, registry: FakeRegistry) -> None:
        integration.er.async_get = lambda _hass: registry
        integration.er.async_entries_for_config_entry = lambda _registry, _entry_id: registry.entries


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


if __name__ == "__main__":
    unittest.main()
