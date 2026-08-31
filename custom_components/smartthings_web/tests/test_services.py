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
sys.modules["homeassistant.core"] = core
exceptions = ModuleType("homeassistant.exceptions")
exceptions.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions

from smartthings_web.services import (  # noqa: E402
    EXECUTE_COMMAND_SCHEMA,
    async_handle_execute_command,
    async_handle_reconnect_realtime,
    async_handle_reload_inventory,
    async_handle_refresh_device,
    async_setup_services,
)


class SmartThingsWebServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_setup_registers_each_missing_service_independently(self) -> None:
        registered: list[str] = []
        services = SimpleNamespace(
            has_service=lambda _domain, service: service == "execute_command",
            async_register=lambda _domain, service, _handler, schema: registered.append(
                service
            ),
        )

        await async_setup_services(SimpleNamespace(services=services))

        self.assertEqual(
            registered,
            ["reload_inventory", "refresh_device", "reconnect_realtime"],
        )

    async def test_execute_command_routes_to_the_entry_that_owns_the_device(self) -> None:
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
            confirm=False,
            timeout=25,
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

    def test_execute_command_schema_rejects_unknown_fields_and_invalid_tokens(self) -> None:
        for payload in (
            {
                "device_id": "dev_001",
                "component": "main",
                "capability": "switch",
                "command": "on",
                "cookie": "secret",
            },
            {
                "device_id": "raw-device-id",
                "component": "main",
                "capability": "switch",
                "command": "on",
            },
        ):
            with self.subTest(payload=payload), self.assertRaises(vol.Invalid):
                EXECUTE_COMMAND_SCHEMA(payload)

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


if __name__ == "__main__":
    unittest.main()
