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
    BridgeAuthError,
    BridgeClientError,
    BridgeReadOnlyError,
    ReadOnlyBridgeClient,
    SmartThingsWebBridgeClient,
    bridge_error_message,
    parse_command_catalog,
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

    def test_command_error_message_preserves_only_safe_actionable_codes(self) -> None:
        self.assertEqual(
            bridge_error_message("fan command", BridgeClientError("command_login_required")),
            "SmartThings Web fan command failed: command_login_required",
        )
        self.assertEqual(
            bridge_error_message("switch command", BridgeClientError("private raw detail")),
            "SmartThings Web switch command failed: bridge_request_failed",
        )
        for code in (
            "component_command_partial_failure",
            "component_command_rollback_failed",
        ):
            with self.subTest(code=code):
                self.assertEqual(
                    bridge_error_message("switch command", BridgeClientError(code)),
                    f"SmartThings Web switch command failed: {code}",
                )

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

    async def test_read_only_client_allows_command_catalog_reads(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        request = AsyncMock(
            return_value={
                "schemaVersion": 1,
                "deviceId": "dev_001",
                "commands": [],
                "omissions": {},
            }
        )
        client._request_json = request  # type: ignore[method-assign]
        readonly = ReadOnlyBridgeClient(client)

        catalog = await readonly.async_list_commands("dev_001")

        self.assertEqual(catalog.device_id, "dev_001")
        request.assert_awaited_once_with(
            "GET", "/api/v1/commands/catalog?deviceId=dev_001", auth=True
        )

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

    async def test_request_json_preserves_safe_bridge_error_code(self) -> None:
        client = SmartThingsWebBridgeClient(_FakeSession(504, {"error": "command_confirmation_timeout"}), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        with self.assertRaisesRegex(BridgeClientError, "command_confirmation_timeout"):
            await client._request_json("POST", "/api/v1/commands", auth=True)  # type: ignore[attr-defined]

    async def test_request_json_preserves_component_transaction_error_codes(self) -> None:
        for code in (
            "component_command_partial_failure",
            "component_command_rollback_failed",
        ):
            with self.subTest(code=code):
                client = SmartThingsWebBridgeClient(
                    _FakeSession(502, {"error": code}),
                    "http://bridge.local",
                    "x" * 32,
                )  # type: ignore[arg-type]
                with self.assertRaisesRegex(BridgeClientError, code):
                    await client._request_json(  # type: ignore[attr-defined]
                        "POST", "/api/v1/commands", auth=True
                    )

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

    async def test_generic_command_forwards_confirmation_and_timeout_policy(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        async def accepted(_method: str, _path: str, **kwargs: Any) -> dict[str, Any]:
            request_id = kwargs["json_body"]["clientRequestId"]
            return {
                "schemaVersion": 1,
                "status": "accepted_unconfirmed",
                "clientRequestId": request_id,
                "sequence": 44,
                "transport": "advanced",
                "confirmation": "accepted_receipt",
                "lifecycle": "ACCEPTED_UNCONFIRMED",
            }

        request = AsyncMock(side_effect=accepted)
        client._request_json = request  # type: ignore[method-assign]

        result = await client.async_execute_command(
            target_type="device",
            target_id="dev_001",
            component="main",
            capability="switch",
            command="on",
            arguments=[],
            require_advanced=True,
            confirm=False,
            timeout=25,
        )

        body = request.await_args.kwargs["json_body"]
        self.assertEqual(body["requireAdvanced"], True)
        self.assertEqual(body["confirm"], False)
        self.assertEqual(body["timeout"], 25)
        self.assertEqual(request.await_args.kwargs["timeout_seconds"], 35)
        self.assertEqual(result.status, "accepted_unconfirmed")

    async def test_maintenance_methods_call_authenticated_local_routes(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        request = AsyncMock(return_value={"accepted": True})
        client._request_json = request  # type: ignore[method-assign]

        await client.async_reload_inventory()
        await client.async_reconnect_realtime()

        self.assertEqual(
            [call.args[:2] for call in request.await_args_list],
            [
                ("POST", "/api/v1/maintenance/reload-inventory"),
                ("POST", "/api/v1/maintenance/reconnect-realtime"),
            ],
        )
        self.assertTrue(all(call.kwargs["auth"] for call in request.await_args_list))

    async def test_list_commands_uses_exact_authenticated_catalog_route(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        request = AsyncMock(
            return_value={
                "schemaVersion": 1,
                "deviceId": "dev_001",
                "commands": [
                    {
                        "component": "main",
                        "componentRole": "main",
                        "capability": "switch",
                        "capabilityVersion": 1,
                        "command": "on",
                        "arguments": [],
                        "transport": "advanced",
                        "confirmation": "state",
                        "label": "Power",
                        "labelSource": "capability",
                    }
                ],
                "omissions": {"sensitive_argument": 1},
            }
        )
        client._request_json = request  # type: ignore[method-assign]

        catalog = await client.async_list_commands("dev_001")

        self.assertEqual(catalog.commands[0].component_role, "main")
        self.assertEqual(catalog.omissions, {"sensitive_argument": 1})
        request.assert_awaited_once_with(
            "GET", "/api/v1/commands/catalog?deviceId=dev_001", auth=True
        )

    async def test_list_commands_returns_fresh_deep_copied_catalogs(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        payload = {
            "schemaVersion": 1,
            "deviceId": "dev_001",
            "commands": [
                {
                    "component": "main",
                    "capability": "speechSynthesis",
                    "capabilityVersion": 1,
                    "command": "speak",
                    "arguments": [
                        {
                            "name": "phrase",
                            "required": True,
                            "sensitive": False,
                            "schema": {"type": "string", "enum": ["Hello"]},
                        }
                    ],
                    "transport": "advanced",
                    "confirmation": "accepted_receipt",
                    "label": "Speak",
                    "labelSource": "capability",
                }
            ],
            "omissions": {},
        }
        request = AsyncMock(return_value=payload)
        client._request_json = request  # type: ignore[method-assign]

        first = await client.async_list_commands("dev_001")
        first.commands[0].arguments[0].schema["enum"].append("mutated")
        second = await client.async_list_commands("dev_001")

        self.assertIsNot(first, second)
        self.assertEqual(second.commands[0].arguments[0].schema["enum"], ["Hello"])

    async def test_list_commands_rejects_raw_device_ids_before_url_construction(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]
        request = AsyncMock()
        client._request_json = request  # type: ignore[method-assign]

        with self.assertRaisesRegex(BridgeClientError, "invalid_device_id"):
            await client.async_list_commands("550e8400-e29b-41d4-a716-446655440000")

        request.assert_not_called()

    def test_parse_command_catalog_rejects_top_level_mismatch_and_bounds(self) -> None:
        valid = {
            "schemaVersion": 1,
            "deviceId": "dev_001",
            "commands": [],
            "omissions": {"schema_invalid": 1},
        }
        self.assertEqual(parse_command_catalog(valid, "dev_001").device_id, "dev_001")
        for raw in (
            {**valid, "schemaVersion": 2},
            {**valid, "deviceId": "dev_002"},
            {**valid, "commands": [{} for _ in range(257)]},
            {**valid, "omissions": {"schema_invalid": 513}},
            {
                **valid,
                "omissions": [
                    {
                        "component": "main",
                        "capability": "switch",
                        "command": "on",
                        "reason": "schema_invalid",
                    }
                ],
            },
            {**valid, "token": "secret-token"},
            {**valid, "rawDeviceId": "550e8400-e29b-41d4-a716-446655440000"},
        ):
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(BridgeClientError, "bridge_response_invalid"):
                    parse_command_catalog(raw, "dev_001")

    def test_parse_command_catalog_rejects_unknown_descriptor_and_argument_fields(self) -> None:
        descriptor = {
            "component": "main",
            "capability": "speechSynthesis",
            "capabilityVersion": 1,
            "command": "speak",
            "arguments": [
                {
                    "name": "phrase",
                    "required": True,
                    "sensitive": False,
                    "schema": {"type": "string"},
                }
            ],
            "transport": "advanced",
            "confirmation": "accepted_receipt",
            "label": "Speak",
            "labelSource": "visible_web",
        }
        valid = {
            "schemaVersion": 1,
            "deviceId": "dev_001",
            "commands": [descriptor],
            "omissions": {},
        }
        self.assertEqual(parse_command_catalog(valid, "dev_001").commands[0].command, "speak")
        role_catalog = parse_command_catalog(
            {
                **valid,
                "commands": [
                    {
                        **descriptor,
                        "capability": "identifier_74292182f118",
                        "capabilityRole": "speechsynthesis",
                    }
                ],
            },
            "dev_001",
        )
        self.assertEqual(role_catalog.commands[0].capability_role, "speechsynthesis")
        for command in (
            {**descriptor, "rawCapability": "550e8400-e29b-41d4-a716-446655440000"},
            {**descriptor, "token": "secret-token"},
            {**descriptor, "capabilityRole": "identifier_74292182f118"},
            {**descriptor, "capabilityRole": "smartthings.speechSynthesis"},
            {
                **descriptor,
                "arguments": [
                    {
                        "name": "phrase",
                        "required": True,
                        "sensitive": False,
                        "schema": {"type": "string"},
                        "raw": "secret",
                    }
                ],
            },
        ):
            with self.subTest(command=command):
                with self.assertRaisesRegex(BridgeClientError, "bridge_response_invalid"):
                    parse_command_catalog({**valid, "commands": [command]}, "dev_001")

    def test_parse_command_catalog_enforces_schema_key_and_nested_bounds(self) -> None:
        schema: dict[str, object] = {"type": "string", "enum": ["Hello", "Goodnight"]}
        descriptor = {
            "component": "main",
            "capability": "speechSynthesis",
            "capabilityVersion": 1,
            "command": "speak",
            "arguments": [
                {
                    "name": "phrase",
                    "required": True,
                    "sensitive": False,
                    "schema": schema,
                }
            ],
            "transport": "advanced",
            "confirmation": "accepted_receipt",
            "label": "Speak",
            "labelSource": "visible_web",
        }
        valid = {
            "schemaVersion": 1,
            "deviceId": "dev_001",
            "commands": [descriptor],
            "omissions": {},
        }
        catalog = parse_command_catalog(valid, "dev_001")
        self.assertEqual(catalog.commands[0].arguments[0].schema["enum"], ["Hello", "Goodnight"])
        schema["enum"].append("mutated")  # type: ignore[union-attr]
        self.assertEqual(catalog.commands[0].arguments[0].schema["enum"], ["Hello", "Goodnight"])

        deep: dict[str, object] = {"type": "object"}
        cursor = deep
        for _ in range(80):
            nested: dict[str, object] = {"type": "object"}
            cursor["enum"] = [nested]
            cursor = nested
        oversize_nested_enum = {"type": "array", "enum": [{"type": "string"} for _ in range(129)]}
        raw_object_enum = {
            "type": "string",
            "enum": [{"rawDeviceId": "550e8400-e29b-41d4-a716-446655440000"}],
        }
        nested_object_enum = {"type": "string", "enum": [{"items": {"type": "string"}}]}
        array_enum = {"type": "string", "enum": [["nested"]]}
        control_string_enum = {"type": "string", "enum": ["safe", "bad\u0001value"]}
        long_string_enum = {"type": "string", "enum": ["x" * 1025]}
        for bad_schema in (
            {"type": "string", "pattern": ".*"},
            deep,
            oversize_nested_enum,
            raw_object_enum,
            nested_object_enum,
            array_enum,
            control_string_enum,
            long_string_enum,
        ):
            with self.subTest(schema=bad_schema):
                bad_descriptor = {
                    **descriptor,
                    "arguments": [
                        {
                            "name": "phrase",
                            "required": True,
                            "sensitive": False,
                            "schema": bad_schema,
                        }
                    ],
                }
                with self.assertRaisesRegex(BridgeClientError, "bridge_response_invalid"):
                    parse_command_catalog({**valid, "commands": [bad_descriptor]}, "dev_001")

    def test_parse_command_catalog_accepts_device_store_shaped_public_schema(self) -> None:
        enum_values = ["Hello", 12, 3.5, True, False, None]
        catalog = parse_command_catalog(
            {
                "schemaVersion": 1,
                "deviceId": "dev_001",
                "commands": [
                    {
                        "component": "main",
                        "capability": "speechSynthesis",
                        "capabilityVersion": 1,
                        "command": "speak",
                        "arguments": [
                            {
                                "name": "phrase",
                                "required": True,
                                "sensitive": False,
                                "schema": {
                                    "type": "string",
                                    "enum": enum_values,
                                    "minimum": 1,
                                    "maximum": 32,
                                },
                            }
                        ],
                        "transport": "advanced",
                        "confirmation": "accepted_receipt",
                        "label": "Speak",
                        "labelSource": "capability",
                    }
                ],
                "omissions": {"schema_invalid": 1},
            },
            "dev_001",
        )

        self.assertEqual(catalog.commands[0].arguments[0].schema["type"], "string")
        self.assertEqual(catalog.commands[0].arguments[0].schema["enum"], enum_values)
        enum_values.append("mutated")
        self.assertEqual(catalog.commands[0].arguments[0].schema["enum"], ["Hello", 12, 3.5, True, False, None])
        self.assertEqual(catalog.omissions, {"schema_invalid": 1})

    async def test_event_stream_yields_data_events_and_ignores_keepalives(self) -> None:
        session = _FakeEventSession(
            200,
            [
                b": keepalive\n",
                b"\n",
                b'data: {"schemaVersion":1,"sequence":41,"type":"inventory"}\n',
                b"\n",
                b'data: {"schemaVersion":1,"sequence":42,"type":"state","deviceId":"dev_001"}\n',
                b"\n",
            ],
        )
        client = SmartThingsWebBridgeClient(session, "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        events = [event async for event in client.async_events()]

        self.assertEqual(
            events,
            [
                {"schemaVersion": 1, "sequence": 41, "type": "inventory"},
                {
                    "schemaVersion": 1,
                    "sequence": 42,
                    "type": "state",
                    "deviceId": "dev_001",
                },
            ],
        )
        self.assertEqual(session.request_headers, {"Authorization": f"Bearer {'x' * 32}"})

    async def test_event_stream_maps_auth_and_invalid_json_failures(self) -> None:
        unauthorized = SmartThingsWebBridgeClient(
            _FakeEventSession(401, []),
            "http://bridge.local",
            "x" * 32,
        )  # type: ignore[arg-type]
        malformed = SmartThingsWebBridgeClient(
            _FakeEventSession(200, [b"data: {\n"]),
            "http://bridge.local",
            "x" * 32,
        )  # type: ignore[arg-type]

        with self.assertRaisesRegex(BridgeAuthError, "bridge_auth_failed"):
            _ = [event async for event in unauthorized.async_events()]
        with self.assertRaisesRegex(BridgeClientError, "bridge_event_stream_failed"):
            _ = [event async for event in malformed.async_events()]

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
                        "type": "ai_speaker_lux_one",
                        "online": True,
                        "presentation": {
                            "assetType": "ai_speaker_lux_one",
                            "iconUrl": "https://client.smartthings.com/icons/preload/lux-one/on",
                            "inactiveIconUrl": "https://client.smartthings.com/icons/preload/lux-one/off",
                            "animationUrl": "https://app-asset.samsungiotcloud.com/assets/icons/published/ai_speaker_lux_one/ai_speaker_lux_one.json",
                        },
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
        self.assertEqual(parsed.devices["dev_001"].presentation.asset_type, "ai_speaker_lux_one")
        self.assertEqual(
            parsed.devices["dev_001"].presentation.animation_url,
            "https://app-asset.samsungiotcloud.com/assets/icons/published/ai_speaker_lux_one/ai_speaker_lux_one.json",
        )

    def test_inventory_parses_safe_command_descriptors_and_control_transport(self) -> None:
        enum_schema = {"type": "string", "enum": ["Hello", "Goodnight"]}
        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "sequence": 7,
                "ready": True,
                "bridgeVersion": "0.1.154",
                "protocolVersion": "4:test",
                "locations": [],
                "rooms": [],
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "name": "Speaker",
                        "online": True,
                        "controls": [
                            {
                                "id": "advanced:main:speechSynthesis:speak",
                                "kind": "button",
                                "label": "Speak",
                                "component": "main",
                                "capability": "speechSynthesis",
                                "attribute": "phrase",
                                "commands": ["speak"],
                                "transport": "advanced",
                            }
                        ],
                        "advancedCommands": [
                            {
                                "component": "main",
                                "componentRole": "main",
                                "capability": "speechSynthesis",
                                "capabilityVersion": 1,
                                "command": "speak",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "unit": "text",
                                        "schema": enum_schema,
                                    }
                                ],
                                "transport": "advanced",
                                "confirmation": "accepted_receipt",
                                "label": "Speak",
                                "labelSource": "visible_web",
                            }
                        ],
                        "commandOmissions": [
                            {
                                "component": "main",
                                "capability": "lock",
                                "command": "unlock",
                                "reason": "dangerous_command",
                            }
                        ],
                    }
                ],
            }
        )

        device = parsed.devices["dev_001"]
        descriptor = device.commands[0]
        self.assertEqual(device.controls["advanced:main:speechSynthesis:speak"].transport, "advanced")
        self.assertEqual(descriptor.component_role, "main")
        self.assertEqual(descriptor.arguments[0].name, "phrase")
        self.assertEqual(descriptor.arguments[0].schema, enum_schema)
        self.assertEqual(len(device.command_omissions), 1)
        self.assertEqual(device.command_omissions[0].component, "main")
        self.assertEqual(device.command_omissions[0].capability, "lock")
        self.assertEqual(device.command_omissions[0].command, "unlock")
        self.assertEqual(device.command_omissions[0].reason, "dangerous_command")
        enum_schema["enum"].append("mutated")
        self.assertEqual(descriptor.arguments[0].schema["enum"], ["Hello", "Goodnight"])
        descriptor.arguments[0].schema["enum"].append("local")
        reparsed = parse_inventory(
            {
                "schemaVersion": 1,
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "name": "Speaker",
                        "advancedCommands": [
                            {
                                "component": "main",
                                "capability": "speechSynthesis",
                                "capabilityVersion": 1,
                                "command": "speak",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {"type": "string", "enum": ["Hello"]},
                                    }
                                ],
                                "transport": "advanced",
                                "confirmation": "accepted_receipt",
                                "label": "Speak",
                                "labelSource": "visible_web",
                            }
                        ],
                    }
                ],
            }
        )
        self.assertEqual(reparsed.devices["dev_001"].commands[0].arguments[0].schema["enum"], ["Hello"])

    def test_inventory_drops_malformed_sensitive_and_oversize_command_descriptors(self) -> None:
        valid = {
            "component": "main",
            "capability": "switch",
            "capabilityVersion": 1,
            "command": "on",
            "arguments": [],
            "transport": "advanced",
            "confirmation": "state",
            "label": "Power",
            "labelSource": "capability",
        }
        raw_devices = [
            {
                "id": "dev_001",
                "locationId": "loc_001",
                "name": "Lamp",
                "advancedCommands": [
                    valid,
                    {**valid, "command": "off", "capability": "550e8400-e29b-41d4-a716-446655440000"},
                    {**valid, "command": "setPin", "arguments": [{"name": "pin", "required": True, "sensitive": True, "schema": {"type": "string"}}]},
                    {**valid, "command": "setMode", "arguments": [{"name": "mode", "required": True, "sensitive": False, "schema": {"type": "string", "enum": [str(i) for i in range(129)]}}]},
                ],
                "commandOmissions": [
                    {"component": "main", "capability": "switch", "reason": "schema_invalid"},
                    {"component": "main", "capability": "raw-capability-uuid", "reason": "schema_invalid"},
                ],
            }
        ]

        parsed = parse_inventory({"schemaVersion": 1, "devices": raw_devices})

        device = parsed.devices["dev_001"]
        self.assertEqual([descriptor.command for descriptor in device.commands], ["on"])
        self.assertEqual(
            [(omission.capability, omission.reason) for omission in device.command_omissions],
            [("switch", "schema_invalid")],
        )

    def test_inventory_drops_descriptors_with_unknown_fields_but_retains_device_state(self) -> None:
        valid = {
            "component": "main",
            "capability": "switch",
            "capabilityVersion": 1,
            "command": "on",
            "arguments": [],
            "transport": "advanced",
            "confirmation": "state",
            "label": "Power",
            "labelSource": "capability",
        }
        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "name": "Lamp",
                        "states": [
                            {
                                "component": "main",
                                "capability": "switch",
                                "attribute": "switch",
                                "value": "on",
                            }
                        ],
                        "advancedCommands": [
                            valid,
                            {**valid, "command": "off", "rawCapability": "secret-token"},
                            {
                                **valid,
                                "command": "setLevel",
                                "arguments": [
                                    {
                                        "name": "level",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {"type": "integer"},
                                        "raw": "secret",
                                    }
                                ],
                            },
                        ],
                    }
                ],
            }
        )

        device = parsed.devices["dev_001"]
        self.assertEqual([descriptor.command for descriptor in device.commands], ["on"])
        self.assertEqual(device.states[("main", "switch", "switch")].value, "on")

    def test_inventory_drops_descriptors_with_structured_enum_members(self) -> None:
        valid = {
            "component": "main",
            "capability": "speechSynthesis",
            "capabilityVersion": 1,
            "command": "speak",
            "arguments": [
                {
                    "name": "phrase",
                    "required": True,
                    "sensitive": False,
                    "schema": {"type": "string", "enum": ["Hello", 1, True, None]},
                }
            ],
            "transport": "advanced",
            "confirmation": "accepted_receipt",
            "label": "Speak",
            "labelSource": "capability",
        }
        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "name": "Speaker",
                        "advancedCommands": [
                            valid,
                            {
                                **valid,
                                "command": "speakRaw",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {
                                            "type": "string",
                                            "enum": [
                                                {
                                                    "rawDeviceId": "550e8400-e29b-41d4-a716-446655440000"
                                                }
                                            ],
                                        },
                                    }
                                ],
                            },
                            {
                                **valid,
                                "command": "speakNested",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {"type": "string", "enum": [["nested"]]},
                                    }
                                ],
                            },
                            {
                                **valid,
                                "command": "speakControl",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {"type": "string", "enum": ["safe", "bad\u0001value"]},
                                    }
                                ],
                            },
                            {
                                **valid,
                                "command": "speakLong",
                                "arguments": [
                                    {
                                        "name": "phrase",
                                        "required": True,
                                        "sensitive": False,
                                        "schema": {"type": "string", "enum": ["x" * 1025]},
                                    }
                                ],
                            },
                        ],
                    }
                ],
            }
        )

        device = parsed.devices["dev_001"]
        self.assertEqual([descriptor.command for descriptor in device.commands], ["speak"])
        self.assertNotIn("550e8400-e29b-41d4-a716-446655440000", str(device.commands))

    def test_inventory_keeps_device_names_pristine_for_room_free_display(self) -> None:
        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "sequence": 6,
                "ready": True,
                "bridgeVersion": "0.1.38",
                "protocolVersion": "1",
                "locations": [],
                "rooms": [
                    {
                        "id": "room_001",
                        "locationId": "loc_001",
                        "name": "디티오룸",
                    }
                ],
                "devices": [
                    {
                        "id": "dev_001",
                        "locationId": "loc_001",
                        "roomId": "room_001",
                        "name": "디티오룸 Status",
                    },
                    {
                        "id": "dev_002",
                        "locationId": "loc_001",
                        "roomId": None,
                        "name": "거실 2",
                    },
                ],
            }
        )

        self.assertEqual(parsed.rooms["room_001"][1], "디티오룸")
        self.assertEqual(parsed.devices["dev_001"].name, "디티오룸 Status")
        self.assertEqual(parsed.devices["dev_002"].name, "거실 2")

    def test_inventory_parses_and_canonicalizes_strong_cloud_local_pair(self) -> None:
        def raw_device(
            device_id: str,
            execution_context: str,
            parent_device_id: str | None,
            color_temperature: int,
            updated_at: str,
        ) -> dict[str, Any]:
            advanced = {
                "ownerId": "identifier_owner",
                "executionContext": execution_context,
            }
            if parent_device_id is not None:
                advanced["parentDeviceId"] = parent_device_id
            states = [
                {
                    "component": "identifier_main",
                    "componentRole": "main",
                    "capability": capability,
                    "attribute": attribute,
                    "value": value,
                    "updatedAt": updated_at,
                }
                for capability, attribute, value in (
                    ("identifier_switch", "switch", "off"),
                    ("identifier_level", "level", 1),
                    ("identifier_color", "hue", 10),
                    ("identifier_color", "saturation", 81),
                    (
                        "identifier_color_temperature",
                        "colorTemperature",
                        color_temperature,
                    ),
                )
            ]
            return {
                "id": device_id,
                "locationId": "loc_009",
                "roomId": "identifier_living_room",
                "name": "벽난로",
                "type": "light_bulb",
                "online": True,
                "healthUpdatedAt": updated_at,
                "advanced": advanced,
                "states": states,
                "controls": [
                    {
                        "id": "advanced:refresh:identifier_main:identifier_refresh",
                        "kind": "button",
                        "label": "Refresh",
                        "component": "identifier_main",
                        "capability": "identifier_refresh",
                        "attribute": "refresh",
                        "commands": ["refresh"],
                    }
                ],
            }

        parsed = parse_inventory(
            {
                "schemaVersion": 1,
                "sequence": 10,
                "ready": True,
                "bridgeVersion": "0.1.147",
                "protocolVersion": "4:test",
                "locations": [],
                "rooms": [],
                "devices": [
                    raw_device(
                        "dev_185",
                        "CLOUD",
                        None,
                        2732,
                        "2026-07-05T01:27:46Z",
                    ),
                    raw_device(
                        "dev_602",
                        "LOCAL",
                        "dev_407",
                        4000,
                        "2026-08-31T13:39:35Z",
                    ),
                ],
            }
        )

        self.assertEqual(set(parsed.devices), {"dev_185"})
        self.assertEqual(parsed.device_aliases, {"dev_602": "dev_185"})
        merged = parsed.devices["dev_185"]
        self.assertEqual(merged.advanced.linked_device_ids, ("dev_602",))
        self.assertEqual(merged.health_updated_at, "2026-08-31T13:39:35Z")


class _FakeResponse:
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        self.status = status
        self._payload = payload

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None

    async def json(self, *, content_type: str | None = None) -> dict[str, Any]:
        return self._payload


class _FakeSession:
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        self._response = _FakeResponse(status, payload)

    def request(self, *_args: object, **_kwargs: object) -> _FakeResponse:
        return self._response


class _FakeEventContent:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = iter(lines)

    def __aiter__(self) -> "_FakeEventContent":
        return self

    async def __anext__(self) -> bytes:
        try:
            return next(self._lines)
        except StopIteration as err:
            raise StopAsyncIteration from err


class _FakeEventResponse:
    def __init__(self, status: int, lines: list[bytes]) -> None:
        self.status = status
        self.content = _FakeEventContent(lines)

    async def __aenter__(self) -> "_FakeEventResponse":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None


class _FakeEventSession:
    def __init__(self, status: int, lines: list[bytes]) -> None:
        self._response = _FakeEventResponse(status, lines)
        self.request_headers: dict[str, str] | None = None

    def get(self, _url: str, **kwargs: Any) -> _FakeEventResponse:
        self.request_headers = kwargs.get("headers")
        return self._response
