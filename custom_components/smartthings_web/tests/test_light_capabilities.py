"""Light regressions using real integration entities in an isolated HA stand-in."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import unittest


class LightIsolationTest(unittest.TestCase):
    def test_light_capabilities_in_isolated_runtime(self):
        result = subprocess.run([sys.executable, __file__, "--isolated"],
                                capture_output=True, text=True, timeout=40, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


def isolated_suite():
    from copy import deepcopy
    from dataclasses import replace
    from enum import Enum
    from types import ModuleType, SimpleNamespace as NS
    from unittest.mock import AsyncMock

    root = Path(__file__).resolve().parents[1]
    package = ModuleType("smartthings_web")
    package.__path__ = [str(root)]
    package.SmartThingsWebConfigEntry = object
    sys.modules["smartthings_web"] = package
    for name in ("homeassistant", "homeassistant.components", "homeassistant.helpers"):
        module = ModuleType(name); module.__path__ = []; sys.modules[name] = module

    class Entity:
        def async_on_remove(self, remove):
            self.remove_callback = remove
        def async_write_ha_state(self):
            self.writes = getattr(self, "writes", 0) + 1

    class ColorMode(str, Enum):
        ONOFF = "onoff"
        BRIGHTNESS = "brightness"
        COLOR_TEMP = "color_temp"
        HS = "hs"

    for name, values in {
        "homeassistant.components.light": {"ColorMode": ColorMode, "LightEntity": type("LightEntity", (), {}),
            "ATTR_BRIGHTNESS": "brightness", "ATTR_COLOR_TEMP_KELVIN": "color_temp_kelvin", "ATTR_HS_COLOR": "hs_color"},
        "homeassistant.core": {"HomeAssistant": object},
        "homeassistant.exceptions": {"HomeAssistantError": type("HomeAssistantError", (Exception,), {})},
        "homeassistant.helpers.entity_platform": {"AddConfigEntryEntitiesCallback": object},
        "homeassistant.helpers.entity": {"Entity": Entity},
        "homeassistant.helpers.device_registry": {"DeviceInfo": dict},
        "homeassistant.helpers.entity_registry": {"async_get": lambda _: NS(async_get_entity_id=lambda *args: None)},
        "homeassistant.util": {"slugify": lambda value: value.lower().replace(" ", "_")},
    }.items():
        module = ModuleType(name); module.__dict__.update(values); sys.modules[name] = module

    from smartthings_web.light import SmartThingsWebLight, async_setup_entry
    from smartthings_web.models import (
        BridgeState, BridgeDevice, BridgeInventory, SmartThingsWebRuntime,
        BridgeControl, BridgeCommandDescriptor, BridgeCommandArgument, BridgeCommandOmission,
        entity_unique_id, light_scalar_control, control_kind, number_controls,
        sensor_state_owned_by_primary_domain,
    )
    from smartthings_web.bridge_client import BridgeClientError, ReadOnlyBridgeClient
    from homeassistant.exceptions import HomeAssistantError

    C = "identifier_main"
    capabilities = {"switch": "identifier_power", "level": "identifier_level",
                    "colorTemperature": "identifier_temperature", "hue": "identifier_color", "saturation": "identifier_color"}
    setters = {"level": "setLevel", "colorTemperature": "setColorTemperature", "hue": "setHue", "saturation": "setSaturation"}
    def state(attr, value, component=C, capability=None, at="2026-09-07T00:00:00Z"):
        return BridgeState(component, capability or capabilities.get(attr, "identifier_meta"), attr,
                           value, "K" if attr == "colorTemperature" else None, at, component_role="main")
    def descriptor(attr, component=C, capability=None, integer=False):
        return BridgeCommandDescriptor(component, capability or capabilities[attr], 1, setters[attr],
            (BridgeCommandArgument("value", True, False, {"type": "integer" if integer or attr in {"level", "colorTemperature"} else "number",
                "minimum": 2000 if attr == "colorTemperature" else 0, "maximum": 6500 if attr == "colorTemperature" else 100}),),
            "advanced", "state", setters[attr], "capability")
    def slider(attr, component=C, id=None):
        return BridgeControl(id or "slider_"+attr, "slider", attr, component, capabilities[attr], attr,
                             commands=(setters[attr],), minimum=2000 if attr == "colorTemperature" else 0,
                             maximum=6500 if attr == "colorTemperature" else 100, step=1)

    class Cases(unittest.IsolatedAsyncioTestCase):
        def setUp(self):
            self.states = [state("switch", "off"), state("level", 60), state("colorTemperature", 2732),
                           state("hue", 25), state("saturation", 80)]
            power = BridgeControl("power", "toggle", "Power", C, capabilities["switch"], "switch", commands=("on", "off"))
            self.device = BridgeDevice("dev_001", "loc_001", None, "Fixture bulb", "light", True,
                states={s.key: s for s in self.states}, controls={power.control_id: power},
                commands=tuple(descriptor(a) for a in setters))
            self.client = NS(async_execute_command=AsyncMock())
            self.runtime = SmartThingsWebRuntime(self.client, "loc_001", BridgeInventory(1, True, "1.8.17", "5",
                {"loc_001": "Home"}, {}, {self.device.device_id: self.device}))
            self.client.async_get_inventory = AsyncMock(side_effect=lambda: deepcopy(self.runtime.inventory))
            self.entity = SmartThingsWebLight(self.runtime, self.device, self.states[0])

        def enable_joint_catalog(self):
            import json
            from smartthings_web.bridge_client import parse_command_catalog
            shared = json.loads((root / "tests/fixtures/light-plan.json").read_text())
            catalog = parse_command_catalog(shared["expectedCatalog"], self.device.device_id)
            self.assertEqual(len(catalog.commands), len(shared["expectedCatalog"]["commands"]))
            self.runtime.inventory.light_plan_supported = True
            self.device.commands = catalog.commands
            self.assertEqual(catalog.omissions, {})
            self.device.command_omissions = ()
            return shared

        def enable_latest_catalog(self):
            self.enable_joint_catalog()
            self.runtime.inventory.light_latest_wins_supported = True
            self.client.async_execute_command.return_value = NS(status="confirmed", sequence=1)

        async def test_latest_flag_routes_power_color_and_white_to_verified_advanced(self):
            self.enable_latest_catalog()
            await self.entity.async_turn_on(brightness=128, hs_color=(180, 75))
            first = self.client.async_execute_command.await_args.kwargs
            self.assertEqual(first["command"], "applyLight")
            self.assertTrue(first["replace_pending"])
            self.assertEqual([c["command"] for c in first["arguments"]], ["on", "setLevel", "setColor"])
            self.assertEqual(first["arguments"][2]["arguments"], [{"hue": 50, "saturation": 75}])
            await self.entity.async_turn_on(color_temp_kelvin=3000)
            self.assertEqual([c["command"] for c in self.client.async_execute_command.await_args.kwargs["arguments"]],
                             ["on", "setColorTemperature"])
            await self.entity.async_turn_off()
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["arguments"],
                             [{"attribute": "switch", "capability": capabilities["switch"], "command": "off", "arguments": []}])
            # Returning a receipt never changes requested values into observed state.
            self.assertEqual(self.entity.brightness, 153)
            self.assertEqual(self.entity.hs_color, (90, 80))
            self.assertFalse(self.entity.is_on)

        async def test_slider_burst_merges_pending_brightness_with_latest_color_without_error_flood(self):
            import asyncio
            self.enable_latest_catalog()
            started = asyncio.Event()
            first_response = asyncio.get_running_loop().create_future()
            async def execute(**kwargs):
                if self.client.async_execute_command.await_count == 1:
                    started.set()
                    return await first_response
                first_response.set_exception(BridgeClientError("command_superseded"))
                return NS(status="confirmed", sequence=1)
            self.client.async_execute_command.side_effect = execute
            first = asyncio.create_task(self.entity.async_turn_on(brightness=128))
            await started.wait()
            tasks = [asyncio.create_task(self.entity.async_turn_on(hs_color=(n * 10, 80))) for n in range(1, 19)]
            await asyncio.gather(first, *tasks)
            self.assertEqual(self.client.async_execute_command.await_count, 2)
            payload = self.client.async_execute_command.await_args.kwargs["arguments"]
            self.assertEqual([c["command"] for c in payload], ["on", "setLevel", "setColor"])
            self.assertEqual(payload[1]["arguments"], [50])
            self.assertEqual(payload[2]["arguments"], [{"hue": 50, "saturation": 80}])
            self.assertFalse(self.entity._intent_pending)
            self.assertEqual(self.entity._pending_light_values, {})
            self.assertEqual(self.client.async_get_inventory.await_count, 1)

        async def test_off_replaces_pending_color_and_does_not_send_obsolete_channels(self):
            import asyncio
            self.enable_latest_catalog()
            started = asyncio.Event()
            first_response = asyncio.get_running_loop().create_future()
            async def execute(**kwargs):
                if self.client.async_execute_command.await_count == 1:
                    started.set(); return await first_response
                first_response.set_exception(BridgeClientError("command_superseded"))
                return NS(status="confirmed", sequence=1)
            self.client.async_execute_command.side_effect = execute
            first = asyncio.create_task(self.entity.async_turn_on(hs_color=(180, 70)))
            await started.wait()
            await asyncio.gather(first, self.entity.async_turn_off())
            payload = self.client.async_execute_command.await_args.kwargs["arguments"]
            self.assertEqual([c["command"] for c in payload], ["off"])
            self.assertIsNone(self.entity._confirmed_color_mode)

        async def test_white_replaces_pending_color_mode_instead_of_merging_incompatible_modes(self):
            import asyncio
            self.enable_latest_catalog()
            self.entity._intent_pending = True
            self.entity._pending_light_values = {"hue": 50, "saturation": 70, "level": 40}
            await self.entity.async_turn_on(color_temp_kelvin=3000)
            payload = self.client.async_execute_command.await_args.kwargs["arguments"]
            self.assertEqual([c["command"] for c in payload], ["on", "setLevel", "setColorTemperature"])
            self.assertEqual(payload[1]["arguments"], [40])

        async def test_invalid_new_color_does_not_cancel_existing_intent(self):
            self.enable_latest_catalog()
            self.entity._intent_pending = True
            self.entity._pending_light_values = {"level": 40}
            before = self.entity._intent_generation
            with self.assertRaises(HomeAssistantError):
                await self.entity.async_turn_on(hs_color=(999, 100))
            self.assertEqual(self.entity._intent_generation, before)
            self.assertEqual(self.entity._pending_light_values, {"level": 40})
            self.client.async_execute_command.assert_not_awaited()

        async def test_newest_real_failure_is_not_hidden_or_retried(self):
            self.enable_latest_catalog()
            self.client.async_execute_command.side_effect = BridgeClientError("command_confirmation_timeout")
            with self.assertRaisesRegex(HomeAssistantError, "command_confirmation_timeout"):
                await self.entity.async_turn_on(brightness=200)
            self.assertEqual(self.client.async_execute_command.await_count, 1)
            self.assertFalse(self.entity._intent_pending)
            self.assertEqual(self.entity.brightness, 153)

        async def test_receipt_only_cannot_confirm_new_light_intent(self):
            self.enable_latest_catalog()
            self.client.async_execute_command.return_value = NS(status="accepted_unconfirmed", sequence=1)
            with self.assertRaisesRegex(HomeAssistantError, "bridge_command_unconfirmed"):
                await self.entity.async_turn_on(color_temp_kelvin=3000)
            self.assertIsNone(self.entity._confirmed_color_mode)
            self.assertFalse(self.entity._intent_pending)

        async def test_cancelled_trailing_intent_does_not_leave_stale_pending_values(self):
            import asyncio
            self.enable_latest_catalog()
            self.entity._intent_pending = True
            self.entity._pending_light_values = {"level": 40}
            task = asyncio.create_task(self.entity.async_turn_on(hs_color=(180, 70)))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertFalse(self.entity._intent_pending)
            self.assertEqual(self.entity._pending_light_values, {})
            self.client.async_execute_command.assert_not_awaited()

        async def test_old_bridge_never_receives_new_replacement_flag(self):
            self.enable_joint_catalog()
            await self.entity.async_turn_on(brightness=128)
            self.assertNotIn("replace_pending", self.client.async_execute_command.await_args.kwargs)

        def test_verified_equal_timestamp_inventory_updates_actual_light_only(self):
            self.enable_latest_catalog()
            latest = deepcopy(self.runtime.inventory)
            latest.sequence += 1
            level = latest.devices[self.device.device_id].states[self.states[1].key]
            level.value = 40; level.command_read_verified = True
            self.runtime.apply_inventory(latest)
            self.assertEqual(self.entity.brightness, 102)
            self.assertEqual(self.entity._state("level").updated_at, self.states[1].updated_at)

        def test_equal_timestamp_without_proof_or_feature_or_sequence_cannot_rollback(self):
            for kind in ("no_proof", "no_flag", "equal_sequence", "old_time"):
                with self.subTest(kind=kind):
                    latest = deepcopy(self.runtime.inventory)
                    latest.sequence += int(kind != "equal_sequence")
                    latest.light_latest_wins_supported = kind != "no_flag"
                    level = latest.devices[self.device.device_id].states[self.states[1].key]
                    level.value = 40; level.command_read_verified = kind != "no_proof"
                    if kind == "old_time": level.updated_at = "2020-01-01T00:00:00Z"
                    self.runtime.apply_inventory(latest)
                    self.assertEqual(self.entity.brightness, 153)

        def test_only_strict_read_proof_is_parsed(self):
            from smartthings_web.models import parse_state
            for fields, expected in (({}, False), ({"commandReadVerified": True}, False),
                    ({"commandReadVerified": "true", "source": "COMMAND_STATUS_RECHECK"}, False),
                    ({"commandReadVerified": True, "source": "LOCATION_EVENT"}, False),
                    ({"commandReadVerified": True, "source": "COMMAND_STATUS_RECHECK"}, True)):
                candidate = parse_state({"component": C, "capability": capabilities["level"],
                                         "attribute": "level", "value": 40, "updatedAt": self.states[1].updated_at, **fields})
                self.assertEqual(candidate.command_read_verified, expected)

        async def test_caught_up_confirmed_power_releases_queue_without_full_inventory_read(self):
            async def execute(**payload):
                latest = deepcopy(self.runtime.inventory); latest.sequence += 1
                new = state("switch", payload["command"], at=f"2026-09-07T00:00:{latest.sequence:02d}Z")
                latest.devices["dev_001"].states[new.key] = new
                self.runtime.apply_inventory(latest)
                return NS(status="confirmed", sequence=latest.sequence)
            self.client.async_execute_command.side_effect = execute
            await self.entity.async_turn_on()
            await self.entity.async_turn_off()
            self.client.async_get_inventory.assert_not_awaited()
            self.assertFalse(self.entity._command_lock.locked())
            self.assertEqual(self.client.async_execute_command.await_count, 2)
            self.assertFalse(self.entity.is_on)

        async def test_caught_up_joint_color_uses_actual_rounded_states_without_extra_get(self):
            self.enable_joint_catalog()
            async def execute(**payload):
                latest = deepcopy(self.runtime.inventory); latest.sequence += 1
                for attribute, value in {"switch": "on", "level": 49.8, "hue": 99.9, "saturation": 99.8}.items():
                    new = state(attribute, value, at="2026-09-07T00:00:01Z")
                    latest.devices["dev_001"].states[new.key] = new
                self.runtime.apply_inventory(latest)
                return NS(status="confirmed", sequence=latest.sequence)
            self.client.async_execute_command.side_effect = execute
            await self.entity.async_turn_on(brightness=128, hs_color=(0, 100))
            self.client.async_get_inventory.assert_not_awaited()
            self.assertEqual(self.entity.brightness, 127)
            self.assertEqual(self.entity.hs_color, (359.64, 99.8))

        async def test_a_newer_sequence_with_mismatched_light_still_catches_up(self):
            self.runtime.inventory.sequence = 10
            self.client.async_execute_command.return_value = NS(status="confirmed", sequence=9)
            await self.entity.async_turn_on()
            self.client.async_get_inventory.assert_awaited_once()
            self.assertFalse(self.entity.is_on, "requested power must not become state")

        async def test_missing_sse_sequence_still_reads_after_confirmed_power(self):
            self.client.async_execute_command.return_value = NS(status="confirmed", sequence=9)
            await self.entity.async_turn_off()
            self.client.async_get_inventory.assert_awaited_once()

        async def test_joint_catalog_uses_one_power_level_setcolor_request(self):
            shared = self.enable_joint_catalog()
            original = (self.entity.entity_id, self.entity._attr_unique_id)
            await self.entity.async_turn_on(brightness=128, hs_color=(0, 100))
            self.client.async_execute_command.assert_awaited_once()
            sent = self.client.async_execute_command.await_args.kwargs
            self.assertEqual(sent["command"], "applyLight")
            self.assertEqual(sent["arguments"], shared["request"]["arguments"])
            self.assertTrue(sent["require_advanced"])
            self.assertTrue(sent["confirm"])
            self.assertEqual((sent["component"], sent["capability"]), (C, capabilities["switch"]))
            # The request receipt is not a report: input does not overwrite state.
            self.assertFalse(self.entity.is_on)
            self.assertEqual(self.entity.brightness, 153)
            self.assertEqual(self.entity.hs_color, (90, 80))
            self.assertEqual((self.entity.entity_id, self.entity._attr_unique_id), original)

        async def test_joint_catalog_color_only_does_not_wait_between_hue_and_saturation(self):
            self.enable_joint_catalog()
            await self.entity.async_turn_on(hs_color=(180, 70))
            sent = self.client.async_execute_command.await_args.kwargs
            self.assertEqual([item["command"] for item in sent["arguments"]], ["on", "setColor"])
            self.assertEqual(sent["arguments"][1]["arguments"], [{"hue": 50, "saturation": 70}])
            self.client.async_execute_command.assert_awaited_once()

        async def test_joint_catalog_supports_setcolor_without_scalar_color_handlers(self):
            self.enable_joint_catalog()
            self.device.commands = tuple(c for c in self.device.commands if c.command not in {"setHue", "setSaturation"})
            self.assertIn(ColorMode.HS, self.entity.supported_color_modes)
            await self.entity.async_turn_on(hs_color=(90, 60))
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["command"], "applyLight")

        async def test_joint_catalog_temperature_and_level_share_one_request(self):
            self.enable_joint_catalog()
            await self.entity.async_turn_on(brightness=128, color_temp_kelvin=3000)
            sent = self.client.async_execute_command.await_args.kwargs
            self.assertEqual([item["command"] for item in sent["arguments"]], ["on", "setLevel", "setColorTemperature"])
            self.client.async_execute_command.assert_awaited_once()

        async def test_joint_catalog_old_bridge_keeps_legacy_command_shape(self):
            self.enable_joint_catalog()
            self.runtime.inventory.light_plan_supported = False
            await self.entity.async_turn_on(brightness=128, hs_color=(180, 70))
            self.assertEqual([call.kwargs["command"] for call in self.client.async_execute_command.await_args_list],
                             ["on", "setLevel", "setHue", "setSaturation"])

        async def test_joint_catalog_missing_power_contract_does_not_guess(self):
            self.enable_joint_catalog()
            self.device.commands = tuple(c for c in self.device.commands if c.command != "on")
            await self.entity.async_turn_on(brightness=128)
            self.assertEqual([call.kwargs["command"] for call in self.client.async_execute_command.await_args_list], ["on", "setLevel"])

        async def test_joint_catalog_changed_ranges_are_checked_before_power(self):
            self.enable_joint_catalog()
            commands = []
            for command in self.device.commands:
                if command.command == "setColor":
                    schema = deepcopy(command.arguments[0].schema)
                    schema["properties"]["hue"]["maximum"] = 40
                    command = replace(command, arguments=(replace(command.arguments[0], schema=schema),))
                commands.append(command)
            self.device.commands = tuple(commands)
            with self.assertRaisesRegex(HomeAssistantError, "outside"):
                await self.entity.async_turn_on(hs_color=(180, 70))
            self.client.async_execute_command.assert_not_awaited()

        async def test_joint_catalog_failure_is_not_retried_on_other_transport(self):
            self.enable_joint_catalog()
            self.client.async_execute_command.side_effect = BridgeClientError("command_confirmation_timeout")
            with self.assertRaisesRegex(HomeAssistantError, "light plan command failed: command_confirmation_timeout"):
                await self.entity.async_turn_on(hs_color=(180, 70))
            self.client.async_execute_command.assert_awaited_once()
            self.assertIsNone(self.entity._confirmed_color_mode)
            self.assertEqual(self.entity.hs_color, (90, 80))

        async def test_joint_catalog_state_refresh_uses_real_quantized_report(self):
            self.enable_joint_catalog()
            latest = deepcopy(self.runtime.inventory); latest.sequence += 1
            for attribute, value in (("switch", "on"), ("level", 49.8), ("hue", 99.9), ("saturation", 99.8)):
                updated = state(attribute, value, at="2026-09-07T00:00:03Z")
                latest.devices["dev_001"].states[updated.key] = updated
            self.client.async_get_inventory.side_effect = None
            self.client.async_get_inventory.return_value = latest
            await self.entity.async_turn_on(brightness=128, hs_color=(0, 100))
            self.assertTrue(self.entity.is_on)
            self.assertEqual(self.entity.brightness, 127)
            self.assertEqual(self.entity.hs_color, (359.64, 99.8))
            self.client.async_execute_command.assert_awaited_once()
            self.client.async_get_inventory.assert_awaited_once()

        async def test_joint_catalog_feature_flag_survives_parser_and_runtime(self):
            from smartthings_web.bridge_client import parse_inventory
            for value, expected in ((True, True), (False, False), ("true", False)):
                raw = {"schemaVersion": 1, "sequence": self.runtime.inventory.sequence + 1,
                       "ready": True, "bridgeVersion": "1.8.20", "protocolVersion": "5",
                       "locations": [], "rooms": [], "devices": [], "lightPlanSupported": value}
                parsed = parse_inventory(raw)
                self.runtime.apply_inventory(parsed)
                self.assertIs(self.runtime.inventory.light_plan_supported, expected)

        async def test_joint_catalog_readonly_still_blocks_every_member(self):
            self.enable_joint_catalog()
            self.runtime.client = ReadOnlyBridgeClient(self.client)
            with self.assertRaises(Exception):
                await self.entity.async_turn_on(brightness=128, hs_color=(180, 70))
            self.client.async_execute_command.assert_not_awaited()

        async def test_raw_schema_catalog_contract_restores_brightness_and_color(self):
            # The Node test produces exactly this catalog from title-bearing raw schemas.
            import json
            from smartthings_web.bridge_client import parse_command_catalog
            fixture = json.loads((root / "tests/fixtures/light-schema-annotations.json").read_text())
            catalog = parse_command_catalog(fixture["expectedCatalog"], self.device.device_id)
            self.device.commands = tuple(d for d in catalog.commands if d.command == "setColorTemperature")
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})
            original = (self.entity.entity_id, self.entity._attr_unique_id)
            await self.entity.async_added_to_hass()
            latest = deepcopy(self.runtime.inventory)
            latest.sequence += 1
            latest.devices[self.device.device_id].commands = catalog.commands
            latest.devices[self.device.device_id].command_omissions = (
                BridgeCommandOmission(C, capabilities["hue"], "setColor", "schema_invalid"),
            )
            self.runtime.apply_inventory(latest)
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.HS, ColorMode.COLOR_TEMP})
            self.assertEqual((self.entity.entity_id, self.entity._attr_unique_id), original)
            self.assertEqual(self.entity.writes, 1)
            self.assertEqual(self.entity.brightness, 153)
            self.assertEqual(self.entity.hs_color, (90, 80))
            await self.entity.async_turn_on(brightness=128, hs_color=(180, 70))
            calls = [call.kwargs for call in self.client.async_execute_command.await_args_list]
            self.assertEqual([call["command"] for call in calls], ["on", "setLevel", "setHue", "setSaturation"])
            self.assertEqual([call["arguments"] for call in calls], [[], [50], [50], [70]])
            self.assertTrue(all(call["require_advanced"] and call["confirm"] for call in calls[1:]))
            self.client.async_execute_command.reset_mock()
            await self.entity.async_turn_on(color_temp_kelvin=3000)
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["command"], "setColorTemperature")
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["arguments"], [3000])
            self.assertEqual(self.entity.hs_color, (90, 80))


        async def test_optional_colormap_catalog_selects_combined_color_for_reported_values(self):
            import json
            from smartthings_web.bridge_client import parse_command_catalog
            fixture = json.loads((root / "tests/fixtures/light-schema-annotations.json").read_text())
            catalog = parse_command_catalog(fixture["expectedCatalog"], self.device.device_id)
            self.runtime.inventory.light_plan_supported = True
            self.runtime.inventory.light_latest_wins_supported = True
            self.device.commands = catalog.commands
            self.device.command_omissions = ()
            self.client.async_execute_command.return_value = NS(status="confirmed", sequence=1)
            for hue, saturation in ((99, 92), (34, 96)):
                await self.entity.async_turn_on(hs_color=(hue * 3.6, saturation))
                request = self.client.async_execute_command.await_args.kwargs
                self.assertTrue(request["replace_pending"])
                self.assertEqual(request["command"], "applyLight")
                self.assertEqual([x["command"] for x in request["arguments"]], ["on", "setColor"])
                self.assertEqual(request["arguments"][1]["arguments"], [{"hue": hue, "saturation": saturation}])
            self.assertEqual(self.entity.hs_color, (90, 80))  # No requested-value state fabrication.

        async def test_post_command_read_updates_real_states_when_sse_is_delayed(self):
            latest = deepcopy(self.runtime.inventory); latest.sequence += 1
            for attr, value in (("switch", "on"), ("level", 50)):
                new = state(attr, value, at="2026-09-07T00:00:01Z")
                latest.devices["dev_001"].states[new.key] = new
            self.client.async_get_inventory.side_effect = None
            self.client.async_get_inventory.return_value = latest
            await self.entity.async_added_to_hass()
            await self.entity.async_turn_on(brightness=128)
            self.assertTrue(self.entity.is_on)
            self.assertEqual(self.entity.brightness, 128)
            self.assertEqual(self.entity.writes, 1)
            self.client.async_get_inventory.assert_awaited_once()
            self.assertEqual(self.client.async_execute_command.await_count, 2)

        async def test_failed_later_step_catches_up_actual_state_but_keeps_error(self):
            latest = deepcopy(self.runtime.inventory); latest.sequence += 1
            new = state("switch", "on", at="2026-09-07T00:00:01Z")
            latest.devices["dev_001"].states[new.key] = new
            self.client.async_get_inventory.side_effect = None
            self.client.async_get_inventory.return_value = latest
            self.client.async_execute_command.side_effect = [None, BridgeClientError("command_confirmation_timeout")]
            with self.assertRaisesRegex(HomeAssistantError, "light level command failed: command_confirmation_timeout"):
                await self.entity.async_turn_on(brightness=128)
            self.assertTrue(self.entity.is_on)
            self.assertEqual(self.entity.brightness, 153)
            self.assertIsNone(self.entity._confirmed_color_mode)
            self.client.async_get_inventory.assert_awaited_once()
            self.assertEqual(self.client.async_execute_command.await_count, 2)

        async def test_catchup_failure_does_not_mask_original_error_or_retry(self):
            self.client.async_execute_command.side_effect = BridgeClientError("command_confirmation_timeout")
            self.client.async_get_inventory.side_effect = BridgeClientError("bridge_request_failed")
            with self.assertRaisesRegex(HomeAssistantError, "light on command failed: command_confirmation_timeout"):
                await self.entity.async_turn_on()
            self.assertFalse(self.entity.is_on)
            self.client.async_execute_command.assert_awaited_once()

        async def test_hanging_catchup_is_bounded_and_does_not_change_state(self):
            import asyncio
            from unittest.mock import patch
            async def stalled(): await asyncio.Future()
            self.client.async_get_inventory.side_effect = stalled
            with patch("smartthings_web.light._STATE_CATCHUP_TIMEOUT", 0.01):
                await asyncio.wait_for(self.entity.async_turn_off(), timeout=1)
            self.assertFalse(self.entity.is_on)
            self.assertFalse(self.entity._command_lock.locked())

        async def test_expired_ui_request_never_dispatches_after_the_lock_is_released(self):
            from unittest.mock import patch
            await self.entity._command_lock.acquire()
            try:
                with patch("smartthings_web.light._COMMAND_QUEUE_TIMEOUT", 0.01):
                    with self.assertRaisesRegex(HomeAssistantError, "command_queue_timeout"):
                        await self.entity.async_turn_on(brightness=128)
                self.assertTrue(self.entity._command_lock.locked())
            finally:
                self.entity._command_lock.release()
            self.client.async_execute_command.assert_not_awaited()
            self.client.async_get_inventory.assert_not_awaited()

        async def test_cancelled_waiter_does_not_release_running_command_lock(self):
            import asyncio
            await self.entity._command_lock.acquire()
            task = asyncio.create_task(self.entity.async_turn_off())
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError): await task
            self.assertTrue(self.entity._command_lock.locked())
            self.entity._command_lock.release()
            self.client.async_execute_command.assert_not_awaited()

        async def test_older_catchup_snapshot_does_not_rollback_live_state(self):
            older = deepcopy(self.runtime.inventory)
            latest = deepcopy(older); latest.sequence += 2
            new = state("level", 70, at="2026-09-07T00:00:02Z")
            latest.devices["dev_001"].states[new.key] = new
            self.runtime.apply_inventory(latest)
            self.client.async_get_inventory.side_effect = None
            self.client.async_get_inventory.return_value = older
            await self.entity.async_turn_on(brightness=128)
            self.assertEqual(self.entity.brightness, 178)
            self.assertEqual(self.runtime.inventory.sequence, latest.sequence)

        def test_hue_supports_color_temperature_and_color_without_web_sliders(self):
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.HS, ColorMode.COLOR_TEMP})
            self.assertEqual(self.entity.brightness, 153)
            self.assertEqual(self.entity.color_temp_kelvin, 2732)
            self.assertEqual(self.entity.hs_color, (90, 80))
            self.assertFalse(self.entity.is_on)

        async def test_ikea_three_identical_bulbs_with_different_detail_discovery(self):
            self.device.states = {s.key: s for s in self.states[:3]}
            self.device.commands = tuple(descriptor(a) for a in ("level", "colorTemperature"))
            bulbs = []
            for i in range(3):
                bulb = deepcopy(self.device); bulb.device_id = f"dev_00{i+1}"
                firmware = state("currentVersion", "same-firmware")
                bulb.states[firmware.key] = firmware
                for attr in ("level", "colorTemperature")[:i]:
                    ctl = slider(attr); bulb.controls[ctl.control_id] = ctl
                self.runtime.inventory.devices[bulb.device_id] = bulb
                bulbs.append(SmartThingsWebLight(self.runtime, bulb, self.states[0]))
            for bulb in bulbs:
                self.assertEqual(bulb.supported_color_modes, {ColorMode.COLOR_TEMP})
                await bulb.async_turn_on(brightness=128, color_temp_kelvin=3000)
            self.assertEqual(self.client.async_execute_command.await_count, 9)

        async def test_catalog_arrives_late_existing_light_gains_controls_and_keeps_ids(self):
            self.device.commands = ()
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})
            original = (self.entity.entity_id, self.entity._attr_unique_id)
            await self.entity.async_added_to_hass()
            latest = deepcopy(self.runtime.inventory); latest.sequence += 1
            latest.devices["dev_001"].commands = tuple(descriptor(a) for a in setters)
            self.runtime.apply_inventory(latest)
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.HS, ColorMode.COLOR_TEMP})
            self.assertEqual((self.entity.entity_id, self.entity._attr_unique_id), original)
            self.assertEqual(original[1], entity_unique_id("dev_001", self.states[0]))
            self.assertEqual(self.entity.writes, 1)

        async def test_late_web_slider_updates_without_entity_recreation(self):
            self.device.commands = ()
            self.device.controls["level"] = slider("level")
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.BRIGHTNESS})
            self.device.controls["temperature"] = slider("colorTemperature")
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.COLOR_TEMP})

        async def test_color_commands_use_exact_aliases_and_scale_without_optimistic_values(self):
            before = deepcopy(self.device.states)
            await self.entity.async_turn_on(brightness=128, hs_color=(180, 70))
            calls = [call.kwargs for call in self.client.async_execute_command.await_args_list]
            self.assertEqual([call["command"] for call in calls], ["on", "setLevel", "setHue", "setSaturation"])
            self.assertEqual([call["arguments"] for call in calls], [[], [50], [50], [70]])
            for call in calls[1:]:
                self.assertEqual(call["component"], C)
                self.assertEqual(call["capability"], capabilities[call["attribute"]])
                self.assertTrue(call["require_advanced"])
                self.assertTrue(call["confirm"])
            self.assertEqual(self.device.states, before)
            self.assertEqual(self.entity.hs_color, (90, 80))
            self.assertFalse(self.entity.is_on)

        async def test_native_web_slider_wins_over_catalog(self):
            ctl = slider("level", id="action:level")
            self.device.controls[ctl.control_id] = ctl
            self.device.controls["duplicate"] = slider("level", id="detail_level")
            await self.entity.async_turn_on(brightness=128)
            call = self.client.async_execute_command.await_args.kwargs
            self.assertEqual(call["command"], "setNumber")
            self.assertEqual(call["control_id"], "action:level")
            self.assertNotIn("require_advanced", call)

        async def test_component_state_and_command_isolation(self):
            for s in self.states[1:]:
                sibling = replace(s, component="identifier_other", value=99)
                self.device.states[sibling.key] = sibling
            self.device.commands += tuple(descriptor(a, component="identifier_other") for a in setters)
            self.assertEqual(self.entity.hs_color, (90, 80))
            self.assertEqual(self.entity.brightness, 153)
            await self.entity.async_turn_on(hs_color=(180, 25))
            self.assertTrue(all(call.kwargs["component"] == C for call in self.client.async_execute_command.await_args_list))

        def test_sibling_sliders_cannot_enable_this_component(self):
            self.device.commands = ()
            for attr in setters:
                ctl = slider(attr, component="identifier_other")
                self.device.controls[ctl.control_id] = ctl
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})

        def test_duplicate_sources_are_not_selected_arbitrarily(self):
            duplicate = state("level", 40, capability="identifier_other_level")
            self.device.states[duplicate.key] = duplicate
            self.device.commands += (descriptor("level", capability=duplicate.capability),)
            self.assertIsNone(light_scalar_control(self.device, C, "level"))
            self.assertIsNone(self.entity.brightness)
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})

        def test_duplicate_descriptors_or_omissions_do_not_advertise_color(self):
            hue = descriptor("hue")
            self.device.commands += (hue,)
            self.assertNotIn(ColorMode.HS, self.entity.supported_color_modes)
            self.device.commands = tuple(descriptor(a) for a in setters)
            self.device.command_omissions = (BridgeCommandOmission(C, capabilities["hue"], "setHue", "schema_invalid"),)
            self.assertNotIn(ColorMode.HS, self.entity.supported_color_modes)

        def test_nullable_off_state_still_exposes_supported_features(self):
            for s in self.states[1:]:
                s.value = None
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.HS, ColorMode.COLOR_TEMP})
            self.assertIsNone(self.entity.hs_color)
            self.assertIsNone(self.entity.brightness)

        def test_invalid_numbers_remain_unknown(self):
            for value in (None, True, "60", float("nan"), float("inf"), -1, 101):
                self.states[1].value = value; self.states[3].value = value
                self.assertIsNone(self.entity.brightness)
                self.assertIsNone(self.entity.hs_color)

        async def test_invalid_values_rejected_before_power_command(self):
            for kwargs in ({"brightness": 256}, {"brightness": True}, {"brightness": float("nan")},
                           {"color_temp_kelvin": 1500}, {"hs_color": (361, 50)}, {"hs_color": (30, -1)},
                           {"hs_color": (0,)}, {"hs_color": (0, 100), "color_temp_kelvin": 3000}):
                with self.assertRaises(HomeAssistantError):
                    await self.entity.async_turn_on(**kwargs)
            self.client.async_execute_command.assert_not_awaited()

        async def test_zero_brightness_turns_off_and_minimum_nonzero_does_not(self):
            await self.entity.async_turn_on(brightness=0)
            self.assertEqual(self.client.async_execute_command.await_count, 1)
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["command"], "off")
            await self.entity.async_turn_on(brightness=1)
            self.assertEqual(self.client.async_execute_command.await_args.kwargs["arguments"], [1])

        def test_ct_range_uses_exact_capability_metadata(self):
            limits = state("colorTemperatureRange", {"minimum": 2200, "maximum": 6000}, capability=capabilities["colorTemperature"])
            self.device.states[limits.key] = limits
            wrong = state("colorTemperatureRange", {"minimum": 2500, "maximum": 2800}, capability="identifier_wrong")
            self.device.states[wrong.key] = wrong
            self.assertEqual((self.entity.min_color_temp_kelvin, self.entity.max_color_temp_kelvin), (2200, 6000))

        def test_color_mode_follows_reported_mode_or_latest_attribute(self):
            self.states[3].updated_at = "2026-09-07T00:01:00Z"
            self.assertEqual(self.entity.color_mode, ColorMode.HS)
            self.states[2].updated_at = "2026-09-07T00:02:00Z"
            self.assertEqual(self.entity.color_mode, ColorMode.COLOR_TEMP)
            explicit = state("colorMode", "color")
            self.device.states[explicit.key] = explicit
            self.assertEqual(self.entity.color_mode, ColorMode.HS)

        async def test_level_and_color_events_update_light_without_power_event(self):
            await self.entity.async_added_to_hass()
            for seq, attr, value in ((2, "level", 10), (3, "hue", 50), (4, "colorTemperature", 5000)):
                self.runtime.apply_state({"type": "state", "deviceId": "dev_001", "sequence": seq,
                    "state": {"component": C, "capability": capabilities[attr], "attribute": attr,
                              "value": value, "unit": None, "updatedAt": "2026-09-07T01:00:00Z"}})
            self.assertEqual(self.entity.writes, 3)
            self.assertEqual(self.entity.brightness, 26)
            self.assertEqual(self.entity.hs_color, (180, 80))
            self.assertEqual(self.entity.color_temp_kelvin, 5000)
            self.entity.remove_callback()
            self.assertEqual(self.runtime.device_listeners, {})
            self.assertEqual(self.runtime.state_listeners, {})

        async def test_discovery_does_not_duplicate_existing_lights(self):
            added = []
            await async_setup_entry(None, NS(runtime_data=self.runtime, async_on_unload=lambda cb: None), added.extend)
            self.assertEqual(len(added), 1)
            self.runtime._notify_listeners()
            self.assertEqual(len(added), 1)

        async def test_offline_removed_and_moved_devices_cannot_be_controlled(self):
            self.device.online = False
            with self.assertRaises(HomeAssistantError):
                await self.entity.async_turn_on(brightness=50)
            self.device.online = True; self.device.location_id = "loc_002"
            with self.assertRaises(HomeAssistantError):
                await self.entity.async_turn_on(hs_color=(30, 40))
            self.runtime.inventory.devices.clear()
            self.assertFalse(self.entity.available)
            self.client.async_execute_command.assert_not_awaited()

        async def test_failed_command_does_not_fake_color_or_retry(self):
            self.client.async_execute_command.side_effect = BridgeClientError("command_confirmation_timeout")
            with self.assertRaises(HomeAssistantError):
                await self.entity.async_turn_on(hs_color=(20, 10))
            self.assertIsNone(self.entity._confirmed_color_mode)
            self.assertEqual(self.client.async_execute_command.await_count, 1)
            self.assertEqual(self.entity.hs_color, (90, 80))

        def test_optional_transition_allowed_required_extra_and_sensitive_rejected(self):
            level = descriptor("level")
            rate = BridgeCommandArgument("rate", False, False, {"type": "integer", "minimum": 0, "maximum": 100})
            self.device.commands = (replace(level, arguments=level.arguments+(rate,)),)
            self.assertIsNotNone(light_scalar_control(self.device, C, "level"))
            for invalid in (replace(rate, required=True), replace(rate, sensitive=True)):
                self.device.commands = (replace(level, arguments=level.arguments+(invalid,)),)
                self.assertIsNone(light_scalar_control(self.device, C, "level"))

        async def test_read_only_entry_blocks_light_writes(self):
            self.runtime.client = ReadOnlyBridgeClient(self.client)
            with self.assertRaises(HomeAssistantError):
                await self.entity.async_turn_on(hs_color=(180, 20))
            self.client.async_execute_command.assert_not_awaited()

        async def test_fractional_color_uses_native_percentage_resolution(self):
            await self.entity.async_turn_on(hs_color=(200, 73.7))
            calls = self.client.async_execute_command.await_args_list
            self.assertEqual(calls[-2].kwargs["arguments"], [56])
            self.assertEqual(calls[-1].kwargs["arguments"], [74])

        def test_plain_switch_is_not_given_light_features(self):
            self.device.states = {self.states[0].key: self.states[0]}
            self.device.commands = ()
            self.assertEqual(control_kind(self.device, self.states[0]), "switch")
            self.assertEqual(self.entity.supported_color_modes, {ColorMode.ONOFF})

        def test_other_component_number_and_sensor_are_not_hidden(self):
            s = state("level", 10, component="identifier_other")
            self.device.states[s.key] = s
            ctl = slider("level", component=s.component)
            self.device.controls[ctl.control_id] = ctl
            self.assertIn(ctl, number_controls(self.device))
            # A read-only sibling state without its own slider must also stay visible.
            self.device.controls.pop(ctl.control_id)
            self.assertFalse(sensor_state_owned_by_primary_domain(self.device, s))

    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Cases))
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    isolated_suite() if "--isolated" in sys.argv else unittest.main()
