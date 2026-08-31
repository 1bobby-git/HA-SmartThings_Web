"""Tests for redacted SmartThings Web diagnostics."""

from __future__ import annotations

from pathlib import Path
import json
import sys
from types import ModuleType, SimpleNamespace
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)


def _install_homeassistant_stubs() -> None:
    homeassistant = ModuleType("homeassistant")
    sys.modules.setdefault("homeassistant", homeassistant)
    core = ModuleType("homeassistant.core")
    core.HomeAssistant = object  # type: ignore[attr-defined]
    sys.modules["homeassistant.core"] = core
    config_entries = ModuleType("homeassistant.config_entries")

    class ConfigEntry:
        @classmethod
        def __class_getitem__(cls, _item: object) -> type["ConfigEntry"]:
            return cls

    config_entries.ConfigEntry = ConfigEntry  # type: ignore[attr-defined]
    sys.modules["homeassistant.config_entries"] = config_entries


_install_homeassistant_stubs()

from smartthings_web.const import CONF_CONTROL_MODE, CONTROL_MODE_READ_ONLY  # noqa: E402
from smartthings_web.diagnostics import async_get_config_entry_diagnostics  # noqa: E402
from smartthings_web.models import BridgeDevice, BridgeInventory, BridgeState  # noqa: E402


class DiagnosticsTests(unittest.IsolatedAsyncioTestCase):
    """Keep diagnostics useful without leaking raw SmartThings data."""

    async def test_diagnostics_are_redacted_aggregates(self) -> None:
        state = BridgeState(
            "main",
            "battery",
            "battery",
            "raw-secret-token",
            "%",
            "2026-08-25T00:00:00Z",
        )
        inventory = BridgeInventory(
            sequence=42,
            ready=True,
            bridge_version="0.1.38",
            protocol_version="2",
            locations={"raw-location-id": "Private Home"},
            rooms={"raw-room-id": ("raw-location-id", "Bedroom")},
            devices={
                "raw-device-id": BridgeDevice(
                    device_id="raw-device-id",
                    location_id="raw-location-id",
                    room_id="raw-room-id",
                    name="Private Sensor",
                    device_type="Sensor",
                    online=True,
                    states={state.key: state},
                )
            },
        )
        entry = SimpleNamespace(
            data={
                "bridge_url": "https://example.invalid/raw-ingress",
                "bridge_token": "raw-secret-token",
                "location_id": "raw-location-id",
            },
            options={CONF_CONTROL_MODE: CONTROL_MODE_READ_ONLY},
            runtime_data=SimpleNamespace(
                inventory=inventory,
                client=FakeHealthClient(
                    {
                        "live": True,
                        "ready": True,
                        "url": "https://example.invalid/raw-ingress",
                        "details": {
                            "state": "CONNECTED",
                            "urlCategory": "smartthings_location",
                            "bridgeVersion": "0.1.38",
                            "protocolVersion": "2:abc",
                            "observedDeviceCount": 1,
                            "protocolInvalidFrameCount": 0,
                            "protocolChangeCount": 0,
                            "restartCount": 0,
                            "detailDiscoveryFailureCount": 0,
                            "architectureVersion": "advanced-primary-v1",
                            "advancedInventoryDeviceCount": 235,
                            "advancedInventoryLocationCount": 2,
                            "advancedInventoryPageCount": 2,
                            "pendingCommandCount": 0,
                            "domFallbackCount": 0,
                            "reconnectCount": 3,
                            "lastReconnectAtMs": 123456,
                            "lastCommandTransport": "advanced",
                            "lastCommandConfirmation": "CONFIRMED_BY_EVENT",
                            "deviceId": "raw-device-id",
                        },
                    }
                ),
            ),
        )

        diagnostics = await async_get_config_entry_diagnostics(object(), entry)
        serialized = json.dumps(diagnostics, sort_keys=True)

        self.assertEqual(diagnostics["entry"]["control_mode"], CONTROL_MODE_READ_ONLY)
        self.assertEqual(diagnostics["inventory"]["device_count"], 1)
        self.assertEqual(diagnostics["inventory"]["state_count"], 1)
        self.assertEqual(diagnostics["health"]["live"], True)
        self.assertEqual(diagnostics["health"]["details"]["state"], "CONNECTED")
        self.assertEqual(diagnostics["health"]["details"]["observedDeviceCount"], 1)
        self.assertEqual(
            diagnostics["health"]["details"]["architectureVersion"],
            "advanced-primary-v1",
        )
        self.assertEqual(
            diagnostics["health"]["details"]["advancedInventoryDeviceCount"], 235
        )
        self.assertEqual(
            diagnostics["health"]["details"]["lastCommandTransport"], "advanced"
        )
        self.assertNotRegex(
            serialized,
            "raw-secret-token|raw-location-id|raw-room-id|raw-device-id|Private|example.invalid",
        )


class FakeHealthClient:
    """Minimal diagnostics health client."""

    def __init__(self, health: dict[str, object]) -> None:
        self.health = health

    async def async_get_health(self) -> dict[str, object]:
        return self.health


if __name__ == "__main__":
    unittest.main()
