"""Tests for the local Bridge HTTP client."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType
from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)

from smartthings_web.bridge_client import (  # noqa: E402
    BridgeClientError,
    BridgeReadOnlyError,
    ReadOnlyBridgeClient,
    SmartThingsWebBridgeClient,
    parse_inventory,
)


class BridgeCommandTimeoutTests(IsolatedAsyncioTestCase):
    """Keep HA's request open through browser actuation and push confirmation."""

    def test_accepts_only_local_bridge_addresses(self) -> None:
        accepted = (
            "http://local-smartthings-web-bridge:8100",
            "http://localhost:8099",
            "http://127.0.0.1:8099",
            "http://192.168.1.25:8099",
            "http://[fd00::25]:8099",
            "https://bridge.local",
            "https://bridge.home.arpa",
        )

        for base_url in accepted:
            with self.subTest(base_url=base_url):
                client = SmartThingsWebBridgeClient(object(), base_url)  # type: ignore[arg-type]
                self.assertTrue(client._base_url.startswith(("http://", "https://")))

    def test_rejects_public_or_ambiguous_bridge_addresses(self) -> None:
        rejected = (
            "https://example.com",
            "http://8.8.8.8:8099",
            "http://user:password@bridge.local",
            "http://bridge.local/api",
            "http://bridge.local?token=secret",
            "http://bridge.local/#fragment",
            "ftp://bridge.local",
            "not a url",
        )

        for base_url in rejected:
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(BridgeClientError, "invalid_bridge_url"):
                    SmartThingsWebBridgeClient(object(), base_url)  # type: ignore[arg-type]

    async def test_read_only_client_blocks_write_commands(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        readonly = ReadOnlyBridgeClient(client)

        with self.assertRaises(BridgeReadOnlyError):
            await readonly.async_execute_switch("dev_001", "main", "switch", "on")

        with self.assertRaises(BridgeReadOnlyError):
            await readonly.async_execute_command(
                target_type="device",
                target_id="dev_001",
                command="refresh",
            )

    async def test_read_only_client_keeps_read_methods_available(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        request = AsyncMock(
            return_value={
                "schemaVersion": 1,
                "ready": True,
                "bridgeVersion": "0.1.38",
                "protocolVersion": "2",
                "locations": [],
                "rooms": [],
                "scenes": [],
                "devices": [],
            }
        )
        client._request_json = request  # type: ignore[method-assign]
        readonly = ReadOnlyBridgeClient(client)

        inventory = await readonly.async_get_inventory()

        self.assertTrue(inventory.ready)
        request.assert_awaited_once()

    async def test_switch_command_uses_extended_request_timeout(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        async def confirmed(_method: str, _path: str, **kwargs: Any) -> dict[str, Any]:
            request_id = kwargs["json_body"]["clientRequestId"]
            return {
                "schemaVersion": 1,
                "status": "confirmed",
                "clientRequestId": request_id,
                "sequence": 42,
                "transport": "smartthings_web_ui",
                "confirmation": "device_event",
            }

        request = AsyncMock(side_effect=confirmed)
        client._request_json = request  # type: ignore[method-assign]

        await client.async_execute_switch("dev_001", "main", "switch", "on")

        self.assertEqual(request.await_args.kwargs["timeout_seconds"], 90)

    async def test_generic_command_sends_target_and_control_metadata(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        async def confirmed(_method: str, _path: str, **kwargs: Any) -> dict[str, Any]:
            request_id = kwargs["json_body"]["clientRequestId"]
            return {
                "schemaVersion": 1,
                "status": "confirmed",
                "clientRequestId": request_id,
                "sequence": 43,
                "transport": "smartthings_web_ui",
                "confirmation": "security_arm_state_event",
            }

        request = AsyncMock(side_effect=confirmed)
        client._request_json = request  # type: ignore[method-assign]

        await client.async_execute_command(
            target_type="location",
            target_id="loc_001",
            control_id="armState",
            control_label="Home Monitor",
            command="armAway",
            arguments=[],
        )

        body = request.await_args.kwargs["json_body"]
        self.assertEqual(body["targetType"], "location")
        self.assertEqual(body["targetId"], "loc_001")
        self.assertEqual(body["controlId"], "armState")
        self.assertEqual(body["controlLabel"], "Home Monitor")
        self.assertEqual(request.await_args.kwargs["timeout_seconds"], 90)

    def test_inventory_parses_locations_scenes_and_non_value_controls(self) -> None:
        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "sequence": 5,
                "ready": True,
                "bridgeVersion": "0.1.30",
                "protocolVersion": "1",
                "locations": [
                    {
                        "id": "loc_001",
                        "name": "Home",
                        "armState": "disarmed",
                        "updatedAt": "2026-08-24T21:10:00Z",
                    }
                ],
                "rooms": [],
                "scenes": [
                    {
                        "id": "scene_001",
                        "locationId": "loc_001",
                        "name": "Movie",
                        "updatedAt": "2026-08-24T21:10:00Z",
                    }
                ],
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "name": "Speaker",
                        "online": True,
                        "states": [],
                        "controls": [
                            {
                                "id": "volume_slider",
                                "kind": "slider",
                                "label": "Volume",
                                "attribute": "volume",
                                "commands": ["volume"],
                                "min": 0,
                                "max": 100,
                                "step": 1,
                            },
                            {"id": "now_playing", "kind": "value", "label": "Now Playing"},
                        ],
                    }
                ],
            }
        )

        self.assertEqual(parsed.sequence, 5)
        self.assertEqual(parsed.scenes["scene_001"].name, "Movie")
        self.assertEqual(parsed.devices["dev_001"].controls["volume_slider"].maximum, 100.0)
        self.assertNotIn("now_playing", parsed.devices["dev_001"].controls)
