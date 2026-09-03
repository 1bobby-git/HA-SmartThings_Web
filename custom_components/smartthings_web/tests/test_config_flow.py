"""Tests for SmartThings Web config/options flows."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from typing import Any
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

    class ConfigFlow:
        def __init_subclass__(cls, **kwargs: object) -> None:
            super().__init_subclass__()

        def __init__(self) -> None:
            self.hass = object()

        def async_show_form(self, **kwargs: object) -> dict[str, object]:
            return {"type": "form", **kwargs}

        def async_abort(self, **kwargs: object) -> dict[str, object]:
            return {"type": "abort", **kwargs}

        def async_create_entry(self, **kwargs: object) -> dict[str, object]:
            return {"type": "create_entry", **kwargs}

        async def async_set_unique_id(self, unique_id: str) -> None:
            self.unique_id = unique_id

        def _abort_if_unique_id_configured(self) -> None:
            return None

        def _get_reauth_entry(self) -> object:
            return SimpleNamespace(entry_id="entry_001")

        def async_update_reload_and_abort(
            self, entry: object, *, data_updates: dict[str, Any]
        ) -> dict[str, object]:
            return {
                "type": "abort",
                "reason": "reauth_successful",
                "entry": entry,
                "data_updates": data_updates,
            }

    class OptionsFlowWithReload:
        automatic_reload = True

        def async_show_form(self, **kwargs: object) -> dict[str, object]:
            return {"type": "form", **kwargs}

        def async_create_entry(self, **kwargs: object) -> dict[str, object]:
            return {"type": "create_entry", **kwargs}

    config_entries.ConfigEntry = ConfigEntry  # type: ignore[attr-defined]
    config_entries.ConfigFlow = ConfigFlow  # type: ignore[attr-defined]
    config_entries.OptionsFlow = OptionsFlowWithReload  # type: ignore[attr-defined]
    config_entries.OptionsFlowWithReload = OptionsFlowWithReload  # type: ignore[attr-defined]
    sys.modules["homeassistant.config_entries"] = config_entries

    helpers = ModuleType("homeassistant.helpers")
    sys.modules["homeassistant.helpers"] = helpers
    aiohttp_client = ModuleType("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda _hass: object()  # type: ignore[attr-defined]
    sys.modules["homeassistant.helpers.aiohttp_client"] = aiohttp_client


_install_homeassistant_stubs()

from smartthings_web.config_flow import (  # noqa: E402
    SmartThingsWebConfigFlow,
    SmartThingsWebOptionsFlow,
)
from smartthings_web.const import (  # noqa: E402
    CONF_BRIDGE_TOKEN,
    CONF_BRIDGE_URL,
    CONF_COMMAND_CONFIRMATION_TIMEOUT,
    CONF_CONTROL_MODE,
    CONF_DEBUG_PROTOCOL_LOGGING,
    CONF_DOM_FALLBACK_ENABLED,
    CONF_INVENTORY_RECONCILIATION_INTERVAL,
    CONF_STATUS_RECHECK_ENABLED,
    CONTROL_MODE_READ_ONLY,
    CONTROL_MODE_SAFE_CONTROL,
)
from smartthings_web.models import BridgeInventory  # noqa: E402
import smartthings_web.config_flow as config_flow  # noqa: E402


class ConfigFlowTests(unittest.IsolatedAsyncioTestCase):
    """Cover user-facing setup, options and reauth behavior."""

    async def test_options_flow_factory_accepts_home_assistant_config_entry(self) -> None:
        flow = SmartThingsWebConfigFlow.async_get_options_flow(SimpleNamespace())

        self.assertIsInstance(flow, SmartThingsWebOptionsFlow)

    async def test_new_pairing_stores_local_hostname_for_legacy_repository_url(self) -> None:
        original_client = config_flow.SmartThingsWebBridgeClient
        config_flow.SmartThingsWebBridgeClient = FakeLegacyPairingClient  # type: ignore[assignment]
        try:
            flow = SmartThingsWebConfigFlow()
            result = await flow.async_step_user(
                {
                    CONF_BRIDGE_URL: "http://d55cafb9-smartthings-web-bridge:8100",
                    "pairing_code": "12345678",
                }
            )
        finally:
            config_flow.SmartThingsWebBridgeClient = original_client  # type: ignore[assignment]

        self.assertEqual(result["type"], "form")
        self.assertEqual(result["step_id"], "location")
        self.assertIsNotNone(flow._pending_pairing)
        self.assertEqual(
            flow._pending_pairing[0],
            "http://local-smartthings-web-bridge:8100",
        )

    async def test_new_entries_default_to_safe_control_options(self) -> None:
        flow = SmartThingsWebConfigFlow()
        flow._pending_pairing = (
            "http://bridge.local",
            "x" * 32,
            BridgeInventory(
                sequence=1,
                ready=True,
                bridge_version="0.1.38",
                protocol_version="2",
                locations={"loc_001": "Home"},
                rooms={},
                devices={},
            ),
        )

        result = await flow.async_step_location({"location_id": "loc_001"})

        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(
            result["options"],
            {
                CONF_CONTROL_MODE: CONTROL_MODE_SAFE_CONTROL,
                CONF_COMMAND_CONFIRMATION_TIMEOUT: 30,
                CONF_STATUS_RECHECK_ENABLED: True,
                CONF_INVENTORY_RECONCILIATION_INTERVAL: 21600,
                CONF_DOM_FALLBACK_ENABLED: True,
                CONF_DEBUG_PROTOCOL_LOGGING: False,
            },
        )

    async def test_options_flow_updates_control_mode(self) -> None:
        entry = SimpleNamespace(options={CONF_CONTROL_MODE: CONTROL_MODE_READ_ONLY})
        flow = SmartThingsWebOptionsFlow()
        flow.config_entry = entry

        result = await flow.async_step_init(
            {
                CONF_CONTROL_MODE: CONTROL_MODE_SAFE_CONTROL,
                CONF_COMMAND_CONFIRMATION_TIMEOUT: 45,
                CONF_STATUS_RECHECK_ENABLED: False,
                CONF_INVENTORY_RECONCILIATION_INTERVAL: 7200,
                CONF_DOM_FALLBACK_ENABLED: False,
                CONF_DEBUG_PROTOCOL_LOGGING: True,
            }
        )

        self.assertEqual(result["type"], "create_entry")
        self.assertEqual(
            result["data"],
            {
                CONF_CONTROL_MODE: CONTROL_MODE_SAFE_CONTROL,
                CONF_COMMAND_CONFIRMATION_TIMEOUT: 45,
                CONF_STATUS_RECHECK_ENABLED: False,
                CONF_INVENTORY_RECONCILIATION_INTERVAL: 7200,
                CONF_DOM_FALLBACK_ENABLED: False,
                CONF_DEBUG_PROTOCOL_LOGGING: True,
            },
        )
        self.assertTrue(flow.automatic_reload)

    async def test_reauth_asks_only_for_pairing_code_and_updates_token(self) -> None:
        original_client = config_flow.SmartThingsWebBridgeClient
        config_flow.SmartThingsWebBridgeClient = FakePairingClient  # type: ignore[assignment]
        try:
            flow = SmartThingsWebConfigFlow()
            form = await flow.async_step_reauth({"bridge_url": "http://bridge.local"})
            result = await flow.async_step_reauth_confirm({"pairing_code": "123456"})
        finally:
            config_flow.SmartThingsWebBridgeClient = original_client  # type: ignore[assignment]

        self.assertEqual(form["type"], "form")
        self.assertEqual(list(form["data_schema"].schema), ["pairing_code"])
        self.assertEqual(result["type"], "abort")
        self.assertEqual(result["reason"], "reauth_successful")
        self.assertEqual(
            result["data_updates"],
            {
                CONF_BRIDGE_TOKEN: "y" * 32,
                CONF_BRIDGE_URL: "http://bridge.local",
            },
        )


class FakeLegacyPairingClient:
    """Pair a legacy repository hostname but expose the canonical local URL."""

    def __init__(self, _session: object, _bridge_url: str) -> None:
        self.base_url = "http://local-smartthings-web-bridge:8100"

    async def async_pair(self, code: str) -> str:
        if code != "12345678":
            raise AssertionError(code)
        return "x" * 32

    async def async_get_inventory(self) -> BridgeInventory:
        return BridgeInventory(
            sequence=1,
            ready=True,
            bridge_version="0.1.168",
            protocol_version="5",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )


class FakePairingClient:
    """Minimal pairing client used by reauth tests."""

    def __init__(self, _session: object, bridge_url: str) -> None:
        self.base_url = bridge_url.rstrip("/")

    async def async_pair(self, code: str) -> str:
        if code != "123456":
            raise AssertionError(code)
        return "y" * 32


if __name__ == "__main__":
    unittest.main()
