"""Exact fan power regression tests, isolated from the legacy HA module stubs."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import unittest


class FanPowerBindingProcessTests(unittest.TestCase):
    def test_fan_power_regressions(self) -> None:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--isolated"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


def isolated_tests() -> None:
    import asyncio
    from copy import deepcopy
    from dataclasses import replace
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    import test_fan as legacy

    class ExactFanPowerTests(unittest.TestCase):
        def setUp(self) -> None:
            self.state = legacy.BridgeState(
                "identifier_primary", "identifier_power", "switch", "on", None,
                "2026-09-07T00:00:00Z", component_role="main",
            )
            self.control = legacy.BridgeControl(
                "action:power", "toggle", "Power", component=self.state.component,
                capability=self.state.capability, attribute="switch", commands=("on", "off"),
            )
            self.device = legacy.BridgeDevice(
                "dev_001", "loc_001", None, "Purifier", "air_purifier", True,
                states={self.state.key: self.state},
                controls={self.control.control_id: self.control},
            )
            self.client = SimpleNamespace(async_execute_command=AsyncMock())
            self.fan = legacy.SmartThingsWebFan(object(), self.device)
            # The legacy base-entity stub does not store these runtime fields.
            self.fan.runtime = SimpleNamespace(client=self.client)
            self.fan.device_id = self.device.device_id

        def add_control(self, control) -> None:
            self.device.controls[control.control_id] = control

        def send_off(self) -> dict:
            asyncio.run(self.fan.async_turn_off())
            self.client.async_execute_command.assert_awaited_once()
            return self.client.async_execute_command.await_args.kwargs

        def test_duplicate_action_and_detail_swatch_use_exact_action(self) -> None:
            self.add_control(replace(self.control, control_id="detail:power"))
            self.assertTrue(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)
            sent = self.send_off()
            self.assertEqual(sent["control_id"], "action:power")
            self.assertEqual(sent["capability"], self.state.capability)
            self.assertEqual(sent["command"], "off")

        def test_readonly_value_row_does_not_ambiguate_power(self) -> None:
            self.add_control(replace(self.control, control_id="value:power", kind="value"))
            self.assertEqual(self.send_off()["control_id"], "action:power")

        def test_unrelated_button_does_not_ambiguate_power(self) -> None:
            self.add_control(replace(self.control, control_id="button:refresh", kind="button"))
            self.assertEqual(self.send_off()["control_id"], "action:power")

        def test_primary_state_does_not_depend_on_insertion_order(self) -> None:
            sibling = replace(self.state, component="identifier_aux", component_role="auxiliary", value="off")
            self.device.states = {sibling.key: sibling, self.state.key: self.state}
            self.add_control(replace(self.control, control_id="action:aux", component=sibling.component))
            self.assertTrue(self.fan.is_on)
            self.assertEqual(self.send_off()["component"], self.state.component)

        def test_distinct_capability_is_not_selected_by_attribute_only(self) -> None:
            other = replace(self.control, control_id="detail:other", capability="identifier_other")
            self.add_control(other)
            self.assertEqual(self.send_off()["capability"], self.state.capability)

        def test_unknown_single_component_is_supported_without_renaming(self) -> None:
            state = replace(self.state, component_role=None)
            self.device.states = {state.key: state}
            self.assertEqual(self.send_off()["component"], "identifier_primary")

        def test_ambiguous_detail_swatches_do_not_advertise_power(self) -> None:
            self.device.controls = {key: replace(self.control, control_id=key)
                                    for key in ("detail:one", "detail:two")}
            self.assertFalse(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)
            with self.assertRaisesRegex(Exception, "no observed off control"):
                asyncio.run(self.fan.async_turn_off())
            self.client.async_execute_command.assert_not_awaited()

        def test_multiple_actions_remain_ambiguous(self) -> None:
            self.add_control(replace(self.control, control_id="action:other"))
            self.assertFalse(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)

        def test_unbound_primary_does_not_switch_sibling_instead(self) -> None:
            sibling = replace(self.state, component="identifier_aux", component_role="auxiliary")
            self.device.states[sibling.key] = sibling
            self.device.controls = {"aux": replace(self.control, control_id="action:aux", component=sibling.component)}
            self.assertFalse(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)
            with self.assertRaisesRegex(Exception, "no observed off control"):
                asyncio.run(self.fan.async_turn_off())
            self.client.async_execute_command.assert_not_awaited()

        def test_command_does_not_optimistically_mutate_states(self) -> None:
            before = deepcopy(self.device)
            self.send_off()
            self.assertEqual(self.device, before)
            self.assertTrue(self.fan.is_on)

        def test_control_removal_is_rechecked_at_dispatch(self) -> None:
            self.assertTrue(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)
            self.device.controls.clear()
            with self.assertRaisesRegex(Exception, "no observed off control"):
                asyncio.run(self.fan.async_turn_off())
            self.client.async_execute_command.assert_not_awaited()

        def test_unknown_switch_value_is_not_off(self) -> None:
            self.state.value = "unavailable"
            self.assertIsNone(self.fan.is_on)

        def test_dangerous_control_is_not_promoted(self) -> None:
            self.device.controls = {"unsafe": replace(self.control, control_id="action:door", label="Door lock")}
            self.assertFalse(self.fan.supported_features & legacy.FanEntityFeature.TURN_OFF)

    suite = unittest.TestLoader().loadTestsFromTestCase(ExactFanPowerTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    if "--isolated" in sys.argv:
        isolated_tests()
    else:
        unittest.main()
