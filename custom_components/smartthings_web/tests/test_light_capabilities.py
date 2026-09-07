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
            self.entity = SmartThingsWebLight(self.runtime, self.device, self.states[0])

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
