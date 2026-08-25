"""Regression tests for SmartThings Web runtime event ordering."""

from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from models import (  # noqa: E402
    BridgeControl,
    BridgeDevice,
    BridgeInventory,
    BridgeLocation,
    BridgeScene,
    BridgeState,
    SmartThingsWebRuntime,
    climate_controls,
    control_kind,
    control_supports_command,
    cover_controls,
    entity_unique_id,
    is_climate_device,
    is_cover_device,
    is_fan_device,
    is_image_device,
    is_media_device,
    is_refreshable_device,
    location_arm_state,
    location_name,
    number_controls,
    number_state_allowed,
    numeric_range_for,
    option_values,
    parse_command_result,
    select_controls,
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
    token_values,
)


class FakeClient:
    """Return queued full inventories without network access."""

    def __init__(self, *inventories: BridgeInventory) -> None:
        self.inventories = list(inventories)
        self.calls = 0

    async def async_get_inventory(self) -> BridgeInventory:
        self.calls += 1
        return self.inventories.pop(0)


class SmartThingsWebRuntimeTests(unittest.TestCase):
    """Cover reconnect, gap, and stale-event behavior."""

    def test_inventory_marker_fetches_and_atomically_merges_latest_inventory(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)
        observations: list[int] = []
        runtime.subscribe(lambda: observations.append(sensor_value(runtime)))

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(sensor_value(runtime), 21)
        self.assertEqual(observations, [21])

    def test_inventory_merge_does_not_lose_devices_from_an_incomplete_restart_snapshot(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        partial = BridgeInventory(
            sequence=1,
            ready=False,
            bridge_version="0.1.27",
            protocol_version="1",
            locations={"loc_001": "Home"},
            rooms={},
            devices={},
        )
        runtime = SmartThingsWebRuntime(FakeClient(partial), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 1}))

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.sequence, 1)
        self.assertIn("dev_001", runtime.inventory.devices)
        self.assertEqual(sensor_value(runtime), 20)

    def test_sequence_gap_immediately_resynchronizes_from_a_full_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(12, 22, "2026-08-24T21:02:00Z")
        client = FakeClient(latest)
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(
            runtime.handle_event(
                state_event(12, 99, "2026-08-24T21:01:00Z")
            )
        )

        self.assertTrue(changed)
        self.assertEqual(client.calls, 1)
        self.assertEqual(runtime.inventory.sequence, 12)
        self.assertEqual(sensor_value(runtime), 22)

    def test_stale_sequence_and_timestamp_cannot_overwrite_current_state(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )

        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(10, 10, "2026-08-24T21:11:00Z")))
        )
        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(11, 10, "2026-08-24T21:09:00Z")))
        )
        self.assertEqual(runtime.inventory.sequence, 11)
        self.assertEqual(sensor_value(runtime), 20)

    def test_timestamp_without_timezone_is_rejected_and_left_for_gap_resync(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )

        self.assertFalse(
            asyncio.run(runtime.handle_event(state_event(11, 99, "2026-08-24T21:11:00")))
        )
        self.assertEqual(runtime.inventory.sequence, 10)
        self.assertEqual(sensor_value(runtime), 20)

    def test_control_kind_keeps_plain_switches_out_of_binary_sensor_and_light(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="identifier_component_main",
            capability="identifier_capability_switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch}

        self.assertEqual(control_kind(device, switch), "switch")

    def test_control_kind_avoids_duplicate_power_for_media_and_fan_devices(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="identifier_component_main",
            capability="identifier_capability_switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        playback = BridgeState(
            component="main",
            capability="media",
            attribute="playbackStatus",
            value="paused",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch, playback.key: playback}

        self.assertIsNone(control_kind(device, switch))

    def test_control_kind_requires_light_specific_state_evidence(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        switch = BridgeState(
            component="identifier_component_main",
            capability="identifier_capability_switch",
            attribute="switch",
            value="off",
            unit=None,
            updated_at="2026-08-24T21:10:00Z",
        )
        color_range = BridgeState(
            component=switch.component,
            capability="identifier_capability_color_temperature",
            attribute="colorTemperatureRange",
            value={"minimum": 2200, "maximum": 6500},
            unit="K",
            updated_at="2026-08-24T21:10:00Z",
        )
        device.states = {switch.key: switch, color_range.key: color_range}

        self.assertEqual(control_kind(device, switch), "light")

    def test_unique_id_contains_attribute_once(self) -> None:
        state = next(iter(inventory(10, 20, "2026-08-24T21:10:00Z").devices["dev_001"].states.values()))

        unique_id = entity_unique_id("dev_001", state)

        self.assertEqual(
            unique_id,
            "dev_001_identifier_component_main_identifier_capability_temperature_temperature",
        )

    def test_generic_sensor_keeps_signal_metrics_and_structured_values(self) -> None:
        self.assertTrue(sensor_state_allowed("signalMetrics"))
        self.assertTrue(sensor_state_allowed("value"))
        self.assertFalse(sensor_state_allowed("contact"))
        self.assertFalse(sensor_state_allowed("switch"))
        self.assertEqual(sensor_native_value("rssi: -61, lqi: 99"), "rssi: -61, lqi: 99")
        structured = {"rssi": -61, "lqi": 99}
        self.assertEqual(sensor_native_value(structured), "data")
        self.assertEqual(sensor_extra_attributes(structured), {"value": structured})

    def test_play_track_control_label_does_not_match_plain_play(self) -> None:
        play = BridgeControl("play", "button", "Play", commands=("play",))
        play_track = BridgeControl(
            "track", "button", "Play track and resume", commands=()
        )

        self.assertFalse(control_supports_command(play, "playTrackAndResume"))
        self.assertTrue(control_supports_command(play_track, "playTrackAndResume"))

    def test_locations_and_scenes_merge_without_stale_metadata_overwrite(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        current.locations["loc_001"] = BridgeLocation(
            "loc_001", "Home", "armedAway", "2026-08-24T21:10:00Z"
        )
        current.scenes["scene_001"] = BridgeScene(
            "scene_001", "loc_001", "Movie", "2026-08-24T21:10:00Z"
        )
        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest.locations["loc_001"] = BridgeLocation(
            "loc_001", "Home", "disarmed", "2026-08-24T21:09:00Z"
        )
        latest.scenes["scene_001"] = BridgeScene(
            "scene_001", "loc_001", "Old Movie", "2026-08-24T21:09:00Z"
        )
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        self.assertTrue(asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11})))

        self.assertEqual(location_name(runtime.inventory, "loc_001"), "Home")
        self.assertEqual(location_arm_state(runtime.inventory, "loc_001"), "armedAway")
        self.assertEqual(runtime.inventory.scenes["scene_001"].name, "Movie")

    def test_capability_helpers_identify_added_platform_surfaces(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        states = [
            BridgeState("main", "signal", "signalMetrics", {"rssi": -61}, None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "media", "playbackStatus", "playing", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "media", "volume", 20, "%", "2026-08-24T21:10:00Z"),
            BridgeState("main", "fan", "fanMode", "auto", None, "2026-08-24T21:10:00Z"),
            BridgeState("main", "fan", "level", 50, "%", "2026-08-24T21:10:00Z"),
            BridgeState("main", "camera", "image", "data", None, "2026-08-24T21:10:00Z"),
        ]
        device.states = {state.key: state for state in states}
        device.controls = {
            "refresh_button": BridgeControl(
                "refresh_button", "button", "Refresh", commands=("refresh",)
            )
        }

        self.assertTrue(is_refreshable_device(device))
        self.assertTrue(is_media_device(device))
        self.assertTrue(is_fan_device(device))
        self.assertTrue(is_image_device(device))
        self.assertFalse(number_state_allowed(device, device.states[("main", "media", "volume")]))
        self.assertTrue(number_state_allowed(device, device.states[("main", "fan", "level")]))

    def test_number_range_and_options_parse_normalized_metadata(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        frequency = BridgeState(
            "main",
            "motion",
            "detectionFrequency",
            30,
            "s",
            "2026-08-24T21:10:00Z",
        )
        range_state = BridgeState(
            "main",
            "motion",
            "detectionFrequencyRange",
            {"minimum": 10, "maximum": 120, "step": 5},
            "s",
            "2026-08-24T21:10:00Z",
        )
        device.states = {frequency.key: frequency, range_state.key: range_state}

        self.assertTrue(number_state_allowed(device, frequency))
        self.assertEqual(numeric_range_for(device, frequency), (10.0, 120.0, 5.0))
        self.assertEqual(option_values({"values": [{"value": "auto"}, {"name": "sleep"}]}), ["auto", "sleep"])

    def test_level_only_devices_are_not_fans_without_fan_identity(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            60,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room Mood Light"
        device.device_type = "Light"
        device.states = {level.key: level}
        device.controls = {
            "level_slider": BridgeControl(
                "level_slider",
                "slider",
                "Brightness",
                component="main",
                capability="switchLevel",
                attribute="level",
                minimum=0.0,
                maximum=100.0,
            )
        }

        self.assertFalse(is_fan_device(device))
        self.assertTrue(number_state_allowed(device, level))
        self.assertEqual([control.control_id for control in number_controls(device)], ["level_slider"])

    def test_fan_identity_allows_level_based_fan_speed(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        level = BridgeState(
            "main",
            "switchLevel",
            "level",
            60,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room Fan"
        device.device_type = "Fan"
        device.states = {level.key: level}

        self.assertTrue(is_fan_device(device))
        self.assertTrue(number_state_allowed(device, level))

    def test_fan_semantic_controls_identify_fans_without_level_fallback(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.name = "Kitchen Air Purifier"
        device.device_type = None
        device.states = {}
        device.controls = {
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Fan Mode",
                component="main",
                capability="fanMode",
                attribute="fanMode",
                options=("auto", "sleep"),
            )
        }

        self.assertTrue(is_fan_device(device))

    def test_fan_speed_state_identifies_fan_even_with_room_name(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        fan_speed = BridgeState(
            "main",
            "fanSpeed",
            "fanSpeed",
            40,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Living Room"
        device.device_type = None
        device.states = {fan_speed.key: fan_speed}

        self.assertTrue(is_fan_device(device))
        self.assertTrue(number_state_allowed(device, fan_speed))

    def test_air_purifier_percent_and_space_delimited_modes_are_actionable(self) -> None:
        """Match the pushed shape used by the live Air Purifier devices."""
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        fan_mode = BridgeState(
            "main",
            "fanMode",
            "fanMode",
            "off",
            None,
            "2026-08-24T21:10:00Z",
        )
        percent = BridgeState(
            "main",
            "fanSpeedPercent",
            "percent",
            0,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.name = "Air Purifier"
        device.states = {fan_mode.key: fan_mode, percent.key: percent}

        self.assertTrue(is_fan_device(device))
        self.assertTrue(number_state_allowed(device, percent))
        self.assertEqual(numeric_range_for(device, percent), (0.0, 100.0, 1.0))
        self.assertEqual(option_values("Quiet Mode"), ["Quiet Mode"])
        self.assertEqual(
            token_values("off low medium high auto"),
            ["off", "low", "medium", "high", "auto"],
        )

    def test_cover_helpers_require_cover_state_or_controls(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        shade = BridgeState(
            "main",
            "windowShade",
            "windowShade",
            "partially open",
            None,
            "2026-08-24T21:10:00Z",
        )
        level = BridgeState(
            "main",
            "windowShadeLevel",
            "shadeLevel",
            40,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {shade.key: shade, level.key: level}
        device.controls = {
            "open": BridgeControl("open", "button", "Open", attribute="windowShade", commands=("open",)),
            "level": BridgeControl(
                "level",
                "slider",
                "Shade level",
                attribute="shadeLevel",
                minimum=0.0,
                maximum=100.0,
            ),
        }

        self.assertTrue(is_cover_device(device))
        self.assertEqual([control.control_id for control in cover_controls(device)], ["open", "level"])

    def test_climate_helpers_require_thermostat_state_or_controls(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        mode = BridgeState(
            "main",
            "thermostatMode",
            "thermostatMode",
            "cool",
            None,
            "2026-08-24T21:10:00Z",
        )
        temperature = BridgeState(
            "main",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-24T21:10:00Z",
        )
        device.states = {mode.key: mode, temperature.key: temperature}
        device.controls = {
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Thermostat mode",
                attribute="thermostatMode",
                options=("off", "cool", "heat"),
            ),
            "setpoint": BridgeControl(
                "setpoint",
                "slider",
                "Target temperature",
                attribute="targetTemperature",
                minimum=16.0,
                maximum=30.0,
            ),
        }

        self.assertTrue(is_climate_device(device))
        self.assertEqual([control.control_id for control in climate_controls(device)], ["mode", "setpoint"])

    def test_select_helpers_only_return_observed_non_primary_enumerated_options(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        device.controls = {
            "sound": BridgeControl(
                "sound",
                "enumerated",
                "Sound mode",
                attribute="soundMode",
                options=("standard", "night"),
            ),
            "mode": BridgeControl(
                "mode",
                "enumerated",
                "Thermostat mode",
                attribute="thermostatMode",
                options=("off", "cool"),
            ),
            "value": BridgeControl(
                "value",
                "value",
                "Read only",
                attribute="displayMode",
                options=("a", "b"),
            ),
        }

        self.assertEqual([control.control_id for control in select_controls(device)], ["sound"])

    def test_command_result_accepts_only_push_confirmed_response(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_12345678",
                "status": "confirmed",
                "sequence": 42,
                "transport": "smartthings_web_ui",
                "confirmation": "device_event",
            },
            "request_12345678",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.sequence, 42)
        self.assertEqual(result.confirmation, "device_event")

    def test_command_result_accepts_authoritative_inventory_resync_confirmation(self) -> None:
        result = parse_command_result(
            {
                "schemaVersion": 1,
                "clientRequestId": "request_12345678",
                "status": "confirmed",
                "sequence": 43,
                "transport": "smartthings_web_ui",
                "confirmation": "inventory_snapshot",
            },
            "request_12345678",
            "device",
        )

        self.assertIsNotNone(result)
        self.assertEqual(result.sequence, 43)
        self.assertEqual(result.confirmation, "inventory_snapshot")

    def test_command_result_rejects_wrong_request_or_unverified_confirmation(self) -> None:
        base = {
            "schemaVersion": 1,
            "clientRequestId": "request_12345678",
            "status": "confirmed",
            "sequence": 42,
            "transport": "smartthings_web_ui",
            "confirmation": "device_event",
        }

        self.assertIsNone(parse_command_result({**base, "clientRequestId": "other_12345678"}, "request_12345678"))
        self.assertIsNone(parse_command_result({**base, "confirmation": "button_click"}, "request_12345678"))

    def test_security_arm_confirmation_is_location_only(self) -> None:
        raw = {
            "schemaVersion": 1,
            "clientRequestId": "request_12345678",
            "status": "confirmed",
            "sequence": 42,
            "transport": "smartthings_web_ui",
            "confirmation": "security_arm_state_event",
        }

        self.assertIsNone(parse_command_result(raw, "request_12345678", "device"))
        result = parse_command_result(raw, "request_12345678", "location")
        self.assertIsNotNone(result)
        self.assertEqual(result.confirmation, "security_arm_state_event")


def inventory(sequence: int, value: int, updated_at: str) -> BridgeInventory:
    state = BridgeState(
        component="identifier_component_main",
        capability="identifier_capability_temperature",
        attribute="temperature",
        value=value,
        unit="C",
        updated_at=updated_at,
    )
    device = BridgeDevice(
        device_id="dev_001",
        location_id="loc_001",
        room_id=None,
        name="Sensor",
        device_type=None,
        online=True,
        states={state.key: state},
    )
    return BridgeInventory(
        sequence=sequence,
        ready=True,
        bridge_version="0.1.27",
        protocol_version="1",
        locations={"loc_001": "Home"},
        rooms={},
        devices={"dev_001": device},
    )


def state_event(sequence: int, value: int, updated_at: str) -> dict[str, object]:
    return {
        "type": "state",
        "sequence": sequence,
        "deviceId": "dev_001",
        "state": {
            "component": "identifier_component_main",
            "capability": "identifier_capability_temperature",
            "attribute": "temperature",
            "value": value,
            "unit": "C",
            "updatedAt": updated_at,
        },
    }


def sensor_value(runtime: SmartThingsWebRuntime) -> int:
    device = runtime.inventory.devices["dev_001"]
    return next(iter(device.states.values())).value


if __name__ == "__main__":
    unittest.main()
