"""Tests for SmartThings Web domain services."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock

import voluptuous as vol


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)

homeassistant = ModuleType("homeassistant")
sys.modules.setdefault("homeassistant", homeassistant)
core = ModuleType("homeassistant.core")
core.HomeAssistant = object  # type: ignore[attr-defined]
core.ServiceCall = object  # type: ignore[attr-defined]
core.SupportsResponse = SimpleNamespace(ONLY="only", NONE="none")  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core
exceptions = ModuleType("homeassistant.exceptions")
exceptions.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions
helpers = ModuleType("homeassistant.helpers")
sys.modules["homeassistant.helpers"] = helpers
device_registry = ModuleType("homeassistant.helpers.device_registry")
device_registry.async_get = lambda _hass: SimpleNamespace(async_get=lambda _id: None)  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.device_registry"] = device_registry

from smartthings_web.services import (  # noqa: E402
    EXECUTE_COMMAND_SCHEMA,
    LIST_COMMANDS_SCHEMA,
    SPEAK_SCHEMA,
    async_handle_execute_command,
    async_handle_list_commands,
    async_handle_reconnect_realtime,
    async_handle_reload_inventory,
    async_handle_refresh_device,
    async_handle_speak,
    async_setup_services,
)

from smartthings_web.models import BridgeCommandArgument, BridgeCommandDescriptor  # noqa: E402


def _catalog(*commands: BridgeCommandDescriptor, omissions: dict[str, int] | None = None) -> object:
    return SimpleNamespace(
        device_id="dev_001",
        commands=tuple(commands),
        omissions=omissions or {},
    )


def _descriptor(
    *,
    component: str = "main",
    capability: str = "switch",
    capability_role: str | None = None,
    command: str = "on",
    arguments: tuple[BridgeCommandArgument, ...] = (),
) -> BridgeCommandDescriptor:
    return BridgeCommandDescriptor(
        component=component,
        component_role="main",
        capability=capability,
        capability_role=capability_role,
        capability_version=1,
        command=command,
        arguments=arguments,
        transport="advanced",
        confirmation="accepted_receipt",
        label=command,
        label_source="capability",
    )


def _phrase_argument() -> BridgeCommandArgument:
    return BridgeCommandArgument(
        name="phrase",
        required=True,
        sensitive=False,
        schema={"type": "string"},
    )


class _FakeDeviceRegistry:
    def __init__(self, *devices: object) -> None:
        self._devices = {getattr(device, "id"): device for device in devices}

    def async_get(self, device_id: str) -> object | None:
        return self._devices.get(device_id)


def _set_device_registry(registry: _FakeDeviceRegistry) -> None:
    sys.modules["homeassistant.helpers.device_registry"].async_get = lambda _hass: registry  # type: ignore[attr-defined]


class SmartThingsWebServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_registers_each_missing_service_independently(self) -> None:
        registered: list[str] = []
        services = SimpleNamespace(
            has_service=lambda _domain, service: service == "execute_command",
            async_register=lambda _domain, service, _handler, schema, **_kwargs: registered.append(
                service
            ),
        )

        await async_setup_services(SimpleNamespace(services=services))

        self.assertEqual(
            registered,
            [
                "list_commands",
                "speak",
                "reload_inventory",
                "refresh_device",
                "reconnect_realtime",
            ],
        )

    async def test_list_commands_registers_response_support(self) -> None:
        registrations: dict[str, dict[str, object]] = {}
        services = SimpleNamespace(
            has_service=lambda _domain, _service: False,
            async_register=lambda _domain, service, _handler, schema, **kwargs: registrations.__setitem__(
                service, {"schema": schema, **kwargs}
            ),
        )

        await async_setup_services(SimpleNamespace(services=services))

        self.assertEqual(registrations["list_commands"]["supports_response"], "only")

    async def test_execute_command_routes_direct_alias_as_advanced_command(self) -> None:
        client = SimpleNamespace(async_execute_command=AsyncMock())
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        entry = SimpleNamespace(runtime_data=runtime)
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(async_entries=lambda _domain: [entry])
        )
        data = EXECUTE_COMMAND_SCHEMA(
            {
                "device_id": "dev_001",
                "component": "main",
                "capability": "switch",
                "command": "on",
                "arguments": [],
                "confirm": False,
                "timeout": 25,
            }
        )

        await async_handle_execute_command(hass, SimpleNamespace(data=data))

        client.async_execute_command.assert_awaited_once_with(
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

    async def test_execute_command_resolves_ha_device_registry_id(self) -> None:
        client = SimpleNamespace(async_execute_command=AsyncMock())
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        entry = SimpleNamespace(runtime_data=runtime)
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(async_entries=lambda _domain: [entry])
        )
        _set_device_registry(_FakeDeviceRegistry(
            SimpleNamespace(
                id="registry-device-id",
                identifiers={("smartthings_web", "dev_001")},
            )
        ))

        await async_handle_execute_command(
            hass,
            SimpleNamespace(
                data=EXECUTE_COMMAND_SCHEMA(
                    {
                        "device_id": "registry-device-id",
                        "component": "main",
                        "capability": "switch",
                        "command": "on",
                    }
                )
            ),
        )

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_001",
            component="main",
            capability="switch",
            command="on",
            arguments=[],
            require_advanced=True,
            confirm=True,
            timeout=30,
        )

    async def test_execute_command_rejects_unknown_device_without_broadcasting(self) -> None:
        client = SimpleNamespace(async_execute_command=AsyncMock())
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [
                    SimpleNamespace(
                        runtime_data=SimpleNamespace(
                            client=client,
                            inventory=SimpleNamespace(devices={}),
                        )
                    )
                ]
            )
        )

        with self.assertRaisesRegex(Exception, "device_not_found"):
            await async_handle_execute_command(
                hass,
                SimpleNamespace(
                    data=EXECUTE_COMMAND_SCHEMA(
                        {
                            "device_id": "dev_999",
                            "component": "main",
                            "capability": "switch",
                            "command": "on",
                        }
                    )
                ),
            )
        client.async_execute_command.assert_not_awaited()

    async def test_device_registry_resolution_rejects_foreign_and_ambiguous_targets(self) -> None:
        runtime = SimpleNamespace(
            client=SimpleNamespace(async_execute_command=AsyncMock()),
            inventory=SimpleNamespace(devices={"dev_001": object(), "dev_002": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        for registry_device, error in (
            (
                SimpleNamespace(
                    id="foreign-device",
                    identifiers={("other", "dev_001")},
                ),
                "device_not_found",
            ),
            (
                SimpleNamespace(
                    id="ambiguous-device",
                    identifiers={
                        ("smartthings_web", "dev_001"),
                        ("smartthings_web", "dev_002"),
                    },
                ),
                "device_ambiguous",
            ),
        ):
            with self.subTest(error=error):
                _set_device_registry(_FakeDeviceRegistry(registry_device))
                with self.assertRaisesRegex(Exception, error):
                    await async_handle_execute_command(
                        hass,
                        SimpleNamespace(
                            data=EXECUTE_COMMAND_SCHEMA(
                                {
                                    "device_id": registry_device.id,
                                    "component": "main",
                                    "capability": "switch",
                                    "command": "on",
                                }
                            )
                        ),
                    )

    def test_service_schemas_reject_unknown_fields_and_invalid_values(self) -> None:
        for payload in (
            {
                "device_id": "dev_001",
                "component": "main",
                "capability": "switch",
                "command": "on",
                "cookie": "secret",
            },
            {
                "device_id": "../raw-device-id",
                "component": "main",
                "capability": "switch",
                "command": "on",
            },
        ):
            with self.subTest(payload=payload), self.assertRaises(vol.Invalid):
                EXECUTE_COMMAND_SCHEMA(payload)
        with self.assertRaises(vol.Invalid):
            LIST_COMMANDS_SCHEMA({"device_id": "dev_001", "extra": True})
        with self.assertRaises(vol.Invalid):
            LIST_COMMANDS_SCHEMA({"device_id": "dev_001", "component": "../raw"})
        with self.assertRaises(vol.Invalid):
            SPEAK_SCHEMA({"device_id": "dev_001", "phrase": "bad\u0000text"})
        with self.assertRaises(vol.Invalid):
            SPEAK_SCHEMA({"device_id": "dev_001", "phrase": ""})
        with self.assertRaises(vol.Invalid):
            EXECUTE_COMMAND_SCHEMA(
                {
                    "device_id": "dev_001",
                    "component": "main",
                    "capability": "switch",
                    "command": "on",
                    "arguments": ["x" * 9000],
                }
            )
        deep: object = "leaf"
        for _ in range(18):
            deep = [deep]
        with self.assertRaises(vol.Invalid):
            EXECUTE_COMMAND_SCHEMA(
                {
                    "device_id": "dev_001",
                    "component": "main",
                    "capability": "switch",
                    "command": "on",
                    "arguments": [deep],
                }
            )

    async def test_maintenance_services_use_the_local_client_only(self) -> None:
        client = SimpleNamespace(
            async_reload_inventory=AsyncMock(),
            async_reconnect_realtime=AsyncMock(),
            async_execute_command=AsyncMock(),
        )
        entry = SimpleNamespace(
            runtime_data=SimpleNamespace(
                client=client,
                inventory=SimpleNamespace(
                    devices={
                        "dev_001": SimpleNamespace(
                            controls={
                                "identifier_refresh_control": SimpleNamespace(
                                    control_id="identifier_refresh_control",
                                    component="identifier_main",
                                    capability="identifier_refresh",
                                    command="refresh",
                                    commands=("refresh",),
                                    label="Refresh",
                                )
                            }
                        )
                    }
                ),
            )
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(async_entries=lambda _domain: [entry])
        )

        await async_handle_reload_inventory(hass, SimpleNamespace(data={}))
        await async_handle_reconnect_realtime(hass, SimpleNamespace(data={}))
        await async_handle_refresh_device(
            hass, SimpleNamespace(data={"device_id": "dev_001"})
        )

        client.async_reload_inventory.assert_awaited_once()
        client.async_reconnect_realtime.assert_awaited_once()
        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_001",
            component="identifier_main",
            capability="identifier_refresh",
            command="refresh",
            arguments=[],
            control_id="identifier_refresh_control",
            control_label="Refresh",
            confirm=False,
            timeout=30,
        )

    async def test_list_commands_returns_sanitized_catalog_for_read_only_clients(self) -> None:
        descriptor = _descriptor(arguments=(_phrase_argument(),))
        client = SimpleNamespace(async_list_commands=AsyncMock(return_value=_catalog(descriptor, omissions={"schema_invalid": 1})))
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        result = await async_handle_list_commands(
            hass, SimpleNamespace(data=LIST_COMMANDS_SCHEMA({"device_id": "dev_001"}))
        )

        self.assertEqual(result["device_id"], "dev_001")
        self.assertEqual(result["omissions"], {"schema_invalid": 1})
        self.assertEqual(result["commands"][0]["arguments"][0]["name"], "phrase")
        client.async_list_commands.assert_awaited_once_with("dev_001")

    async def test_list_commands_filters_descriptors_and_keeps_aggregate_omissions(self) -> None:
        switch = _descriptor(component="main", capability="switch", command="on")
        audio = _descriptor(
            component="main",
            capability="speechSynthesis",
            command="speak",
            arguments=(_phrase_argument(),),
        )
        secondary = _descriptor(
            component="switch2",
            capability="switch",
            command="off",
        )
        client = SimpleNamespace(
            async_list_commands=AsyncMock(
                return_value=_catalog(
                    switch,
                    audio,
                    secondary,
                    omissions={"dangerous_command": 2},
                )
            )
        )
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        result = await async_handle_list_commands(
            hass,
            SimpleNamespace(
                data=LIST_COMMANDS_SCHEMA(
                    {"device_id": "dev_001", "component": "main", "capability": "switch"}
                )
            ),
        )

        self.assertEqual(
            [(item["component"], item["capability"], item["command"]) for item in result["commands"]],
            [("main", "switch", "on")],
        )
        self.assertEqual(result["omissions"], {"dangerous_command": 2})

    async def test_list_commands_filter_returns_empty_commands_for_no_matches(self) -> None:
        client = SimpleNamespace(
            async_list_commands=AsyncMock(
                return_value=_catalog(
                    _descriptor(component="main", capability="switch", command="on"),
                    omissions={"schema_invalid": 1},
                )
            )
        )
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        result = await async_handle_list_commands(
            hass,
            SimpleNamespace(
                data=LIST_COMMANDS_SCHEMA(
                    {"device_id": "dev_001", "capability": "speechSynthesis"}
                )
            ),
        )

        self.assertEqual(result["commands"], [])
        self.assertEqual(result["omissions"], {"schema_invalid": 1})

    async def test_list_commands_resolves_ha_registry_device_id(self) -> None:
        client = SimpleNamespace(
            async_list_commands=AsyncMock(
                return_value=_catalog(_descriptor(component="main", capability="switch"))
            )
        )
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )
        _set_device_registry(
            _FakeDeviceRegistry(
                SimpleNamespace(
                    id="registry-device-id",
                    identifiers={("smartthings_web", "dev_001")},
                )
            )
        )

        result = await async_handle_list_commands(
            hass,
            SimpleNamespace(
                data=LIST_COMMANDS_SCHEMA({"device_id": "registry-device-id"})
            ),
        )

        self.assertEqual(result["device_id"], "dev_001")
        client.async_list_commands.assert_awaited_once_with("dev_001")

    async def test_speak_routes_unique_speech_synthesis_descriptor_without_confirmation(self) -> None:
        speech = _descriptor(
            capability="speechSynthesis",
            command="speak",
            arguments=(_phrase_argument(),),
        )
        client = SimpleNamespace(
            async_list_commands=AsyncMock(return_value=_catalog(speech)),
            async_execute_command=AsyncMock(),
        )
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        await async_handle_speak(
            hass,
            SimpleNamespace(
                data=SPEAK_SCHEMA({"device_id": "dev_001", "phrase": "안녕하세요"})
            ),
        )

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_001",
            component="main",
            capability="speechSynthesis",
            command="speak",
            arguments=["안녕하세요"],
            require_advanced=True,
            confirm=False,
            timeout=30,
        )

    async def test_speak_routes_aliased_speech_synthesis_descriptor_by_safe_role(self) -> None:
        speech = _descriptor(
            component="identifier_component_main",
            capability="identifier_74292182f118",
            capability_role="speechsynthesis",
            command="speak",
            arguments=(_phrase_argument(),),
        )
        client = SimpleNamespace(
            async_list_commands=AsyncMock(return_value=_catalog(speech)),
            async_execute_command=AsyncMock(),
        )
        runtime = SimpleNamespace(
            client=client,
            inventory=SimpleNamespace(devices={"dev_001": object()}),
        )
        hass = SimpleNamespace(
            config_entries=SimpleNamespace(
                async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
            )
        )

        await async_handle_speak(
            hass,
            SimpleNamespace(data=SPEAK_SCHEMA({"device_id": "dev_001", "phrase": "hello"})),
        )

        client.async_execute_command.assert_awaited_once_with(
            target_type="device",
            target_id="dev_001",
            component="identifier_component_main",
            capability="identifier_74292182f118",
            command="speak",
            arguments=["hello"],
            require_advanced=True,
            confirm=False,
            timeout=30,
        )

    async def test_speak_rejects_missing_or_ambiguous_speech_descriptors(self) -> None:
        valid_speech = _descriptor(
            capability="speechSynthesis",
            command="speak",
            arguments=(_phrase_argument(),),
        )
        for commands, error in (
            ((), "command_control_not_found"),
            ((valid_speech, valid_speech), "command_control_ambiguous"),
            (
                (
                    _descriptor(
                        capability="speechSynthesis",
                        command="speak",
                        arguments=(),
                    ),
                ),
                "invalid_arguments",
            ),
        ):
            with self.subTest(error=error):
                client = SimpleNamespace(
                    async_list_commands=AsyncMock(return_value=_catalog(*commands)),
                    async_execute_command=AsyncMock(),
                )
                runtime = SimpleNamespace(
                    client=client,
                    inventory=SimpleNamespace(devices={"dev_001": object()}),
                )
                hass = SimpleNamespace(
                    config_entries=SimpleNamespace(
                        async_entries=lambda _domain: [SimpleNamespace(runtime_data=runtime)]
                    )
                )
                with self.assertRaisesRegex(Exception, error):
                    await async_handle_speak(
                        hass,
                        SimpleNamespace(
                            data=SPEAK_SCHEMA(
                                {"device_id": "dev_001", "phrase": "hello"}
                            )
                        ),
                    )
                client.async_execute_command.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
