"""Isolated HA-stub regression for observed Advanced command-only entities."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import unittest


class CatalogCommandIsolationTest(unittest.TestCase):
    def test_catalog_entities_in_isolated_runtime(self) -> None:
        result = subprocess.run(
            [sys.executable, __file__, "--isolated"],
            capture_output=True, text=True, timeout=40, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


def isolated_suite() -> None:
    import asyncio
    from dataclasses import replace
    from enum import Enum
    from types import ModuleType, SimpleNamespace
    from unittest.mock import AsyncMock

    root = Path(__file__).resolve().parents[1]
    package = ModuleType("smartthings_web")
    package.__path__ = [str(root)]
    package.SmartThingsWebConfigEntry = object
    sys.modules["smartthings_web"] = package
    for name in ("homeassistant", "homeassistant.components", "homeassistant.helpers"):
        module = ModuleType(name)
        module.__path__ = []
        sys.modules[name] = module
    for name, values in {
        "homeassistant.core": {"HomeAssistant": object},
        "homeassistant.exceptions": {"HomeAssistantError": type("HomeAssistantError", (Exception,), {})},
        "homeassistant.helpers.entity_platform": {"AddConfigEntryEntitiesCallback": object},
        "homeassistant.const": {"EntityCategory": SimpleNamespace(CONFIG="config")},
    }.items():
        module = ModuleType(name)
        module.__dict__.update(values)
        sys.modules[name] = module
    class NumberMode(str, Enum):
        SLIDER = "slider"
        BOX = "box"
    for platform in ("number", "select", "button"):
        name = f"homeassistant.components.{platform}"
        module = ModuleType(name)
        setattr(module, f"{platform.title()}Entity", type(f"{platform.title()}Entity", (), {}))
        if platform == "number":
            module.NumberMode = NumberMode
        sys.modules[name] = module
    class DeviceEntity:
        def __init__(self, runtime, device, suffix, name):
            self.runtime, self.device_id = runtime, device.device_id
            self._attr_unique_id = f"{device.device_id}_{suffix}"
        @property
        def bridge_device(self):
            return self.runtime.inventory.devices.get(self.device_id)
        @property
        def available(self):
            return self.bridge_device is not None and self.bridge_device.online
    entity = ModuleType("smartthings_web.entity")
    entity.SmartThingsWebDeviceEntity = DeviceEntity
    entity.suggested_entity_object_id = lambda *_args: "test_refresh"
    sys.modules[entity.__name__] = entity

    from smartthings_web.models import (
        BridgeCommandArgument, BridgeCommandDescriptor, BridgeCommandOmission,
        BridgeControl, BridgeDevice, BridgeState,
    )
    from smartthings_web.command_controls import catalog_commands, command_suffix
    from smartthings_web.number import SmartThingsWebCommandNumber, async_setup_entry as setup_number
    from smartthings_web.select import SmartThingsWebCommandSelect, async_setup_entry as setup_select
    from smartthings_web.button import SmartThingsWebCommandButton, async_setup_entry as setup_button
    from smartthings_web.bridge_client import BridgeClientError
    from homeassistant.exceptions import HomeAssistantError

    component = "identifier_c9246e0ac435"
    def descriptor(command, capability, schema=None):
        args = () if schema is None else (BridgeCommandArgument("value", True, False, schema),)
        return BridgeCommandDescriptor(component, capability, 1, command, args, "advanced",
            "accepted_receipt" if not args else "state", command, "capability", "main")
    commands = (
        descriptor("setUpdown", "identifier_07455895e52f", {"type": "string", "enum": ["minus_2", "minus_1", "plus_1", "plus_2"]}),
        descriptor("setFreeze", "identifier_0f4a0e165316", {"type": "string", "enum": ["on", "off"]}),
        descriptor("setPeopleCounter", "identifier_24b23b825273", {"type": "integer", "minimum": 0, "maximum": 65535}),
        descriptor("refresh", "identifier_d52609f71115"),
        descriptor("push", "identifier_df9ead01127d"),
    )

    class Cases(unittest.TestCase):
        def setUp(self):
            self.device = BridgeDevice("dev_344", "loc_test", None, "Counter", None, True, commands=commands)
            self.runtime = SimpleNamespace(location_id="loc_test",
                inventory=SimpleNamespace(devices={"dev_344": self.device}),
                client=SimpleNamespace(async_execute_command=AsyncMock()))
            self.number = SmartThingsWebCommandNumber(self.runtime, self.device, commands[2])
            self.select = SmartThingsWebCommandSelect(self.runtime, self.device, commands[0])
            self.button = SmartThingsWebCommandButton(self.runtime, self.device, commands[4])
        def test_five_exact_commands_without_role_hints(self):
            self.assertEqual(len(catalog_commands(self.device, "select")), 2)
            self.assertEqual(len(catalog_commands(self.device, "number")), 1)
            self.assertEqual(len(catalog_commands(self.device, "button")), 2)
        def test_exact_options_not_guessed_toggle(self):
            self.assertEqual(self.select.options, ["minus_2", "minus_1", "plus_1", "plus_2"])
            freeze = SmartThingsWebCommandSelect(self.runtime, self.device, commands[1])
            self.assertEqual(freeze.options, ["on", "off"])
        def test_integer_boundaries_and_exact_alias_dispatch(self):
            self.assertEqual((self.number.native_min_value, self.number.native_max_value), (0, 65535))
            for value in (0, 65535, 3.0):
                asyncio.run(self.number.async_set_native_value(value))
                self.runtime.client.async_execute_command.assert_awaited_with(
                    target_type="device", target_id="dev_344", component=component,
                    capability="identifier_24b23b825273", command="setPeopleCounter",
                    arguments=[int(value)], require_advanced=True, confirm=False)
                self.assertIs(type(self.runtime.client.async_execute_command.call_args.kwargs["arguments"][0]), int)
        def test_invalid_integers_never_dispatch(self):
            for value in (-1, 65536, 1.5, True, "3", float("nan"), float("inf"), 10**400):
                with self.subTest(value=str(value)):
                    with self.assertRaises(HomeAssistantError):
                        asyncio.run(self.number.async_set_native_value(value))
            self.runtime.client.async_execute_command.assert_not_awaited()
        def test_select_dispatch_and_invalid_option(self):
            asyncio.run(self.select.async_select_option("plus_1"))
            self.assertEqual(self.runtime.client.async_execute_command.call_args.kwargs["arguments"], ["plus_1"])
            self.runtime.client.async_execute_command.reset_mock()
            with self.assertRaises(HomeAssistantError):
                asyncio.run(self.select.async_select_option("plus_3"))
            self.runtime.client.async_execute_command.assert_not_awaited()
        def test_push_dispatches_once_without_arguments(self):
            asyncio.run(self.button.async_press())
            self.runtime.client.async_execute_command.assert_awaited_once()
            self.assertEqual(self.runtime.client.async_execute_command.call_args.kwargs["command"], "push")
            self.assertEqual(self.runtime.client.async_execute_command.call_args.kwargs["arguments"], [])
        def test_no_fabricated_current_state_even_with_same_capability_state(self):
            state = BridgeState(component, commands[2].capability, "peopleCounter", 7, None, None)
            self.device.states[state.key] = state
            asyncio.run(self.number.async_set_native_value(5))
            asyncio.run(self.select.async_select_option("plus_1"))
            self.assertIsNone(self.number.native_value)
            self.assertIsNone(self.select.current_option)
            self.assertEqual(state.value, 7)
        def test_removed_catalog_command_becomes_unavailable(self):
            self.device.commands = ()
            self.assertFalse(self.number.available)
            with self.assertRaises(HomeAssistantError):
                asyncio.run(self.number.async_set_native_value(0))
            self.runtime.client.async_execute_command.assert_not_awaited()
        def test_duplicate_or_omitted_descriptor_is_not_exposed(self):
            self.device.commands += (commands[2],)
            self.assertEqual(catalog_commands(self.device, "number"), [])
            self.device.commands = commands
            self.device.command_omissions = (BridgeCommandOmission(component, commands[2].capability, None, "schema_invalid"),)
            self.assertFalse(self.number.available)
        def test_existing_web_controls_take_priority_without_migration(self):
            control = BridgeControl("old_slider_id", "slider", "Counter", component=component,
                capability=commands[2].capability, attribute="peopleCounter", minimum=0, maximum=65535)
            self.device.controls[control.control_id] = control
            self.assertEqual(catalog_commands(self.device, "number"), [])
            self.assertIs(self.device.controls[control.control_id], control)
        def test_existing_refresh_is_not_duplicated(self):
            control = BridgeControl("old_refresh", "button", "Refresh", component=component,
                capability=commands[3].capability, commands=("refresh",))
            self.device.controls[control.control_id] = control
            self.assertEqual([d.command for d in catalog_commands(self.device, "button")], ["push"])
        def test_sensitive_and_unsupported_schemas_are_not_exposed(self):
            for schema in ({"type": "integer"}, {"type": "integer", "minimum": 0, "maximum": float("inf")},
                           {"type": "string", "enum": ["on", "on"]}, {"type": "object"}):
                self.device.commands = (descriptor("setValue", "identifier_custom", schema),)
                self.assertFalse(catalog_commands(self.device, "number") + catalog_commands(self.device, "select"))
            self.device.commands = (replace(commands[2], arguments=(replace(commands[2].arguments[0], sensitive=True),)),)
            self.assertFalse(catalog_commands(self.device, "number"))
        def test_schema_changes_revalidate_inputs(self):
            self.device.commands = (replace(commands[2], arguments=(replace(commands[2].arguments[0],
                schema={"type": "integer", "minimum": 1, "maximum": 2}),)),)
            self.assertEqual((self.number.native_min_value, self.number.native_max_value), (1, 2))
            with self.assertRaises(HomeAssistantError):
                asyncio.run(self.number.async_set_native_value(3))
        def test_location_and_online_guards(self):
            self.device.location_id = "loc_other"
            self.assertFalse(self.button.available)
            self.device.location_id = "loc_test"
            self.device.online = False
            with self.assertRaises(HomeAssistantError):
                asyncio.run(self.button.async_press())
            self.runtime.client.async_execute_command.assert_not_awaited()
        def test_new_identity_stable_across_order_and_label_changes(self):
            changed = replace(commands[2], label="Another label", capability_version=2)
            self.assertEqual(command_suffix("number", commands[2]), command_suffix("number", changed))
            self.assertNotEqual(command_suffix("number", commands[2]), command_suffix("number", replace(commands[2], component="other")))
        def test_transport_failure_is_not_retried(self):
            self.runtime.client.async_execute_command.side_effect = BridgeClientError("command_execution_failed")
            with self.assertRaises(HomeAssistantError):
                asyncio.run(self.button.async_press())
            self.runtime.client.async_execute_command.assert_awaited_once()
        def test_late_inventory_discovery_and_no_duplicates(self):
            listeners, added = [], []
            self.runtime.subscribe = lambda callback: (listeners.append(callback) or (lambda: None))
            entry = SimpleNamespace(runtime_data=self.runtime, async_on_unload=lambda callback: None)
            self.device.commands = ()
            for setup in (setup_number, setup_select, setup_button):
                asyncio.run(setup(None, entry, added.extend))
            self.assertEqual(added, [])
            self.device.commands = commands
            for listener in listeners:
                listener()
                listener()
            self.assertEqual(len(added), 5)
            self.assertEqual(len({item._attr_unique_id for item in added}), 5)
        def test_native_commands_remain_owned_by_existing_platforms(self):
            self.device.commands = (descriptor("setVolume", "identifier_volume", {"type": "integer", "minimum": 0, "maximum": 100}),)
            self.assertFalse(catalog_commands(self.device, "number"))

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    if "--isolated" in sys.argv:
        isolated_suite()
    else:
        unittest.main()
