"""Regression tests for SmartThings Web runtime event ordering."""

from __future__ import annotations

import asyncio
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import models as models_module  # noqa: E402

from models import (  # noqa: E402
    BridgeControl,
    BridgeDevice,
    BridgeDevicePresentation,
    BridgeInventory,
    BridgeLocation,
    BridgeScene,
    BridgeState,
    SmartThingsWebRuntime,
    climate_controls,
    control_kind,
    control_supports_command,
    cover_controls,
    device_model,
    entity_unique_id,
    is_climate_device,
    is_cover_device,
    is_fan_device,
    is_image_device,
    is_media_device,
    is_refreshable_device,
    parse_device_presentation,
    refresh_controls,
    _safe_device_asset_url,
    location_arm_state,
    location_name,
    number_controls,
    numeric_range_for,
    option_values,
    parse_command_result,
    primary_state_attributes,
    safe_generic_toggle_control,
    select_controls,
    sensor_extra_attributes,
    sensor_native_value,
    sensor_state_allowed,
    sensor_state_owned_by_primary_domain,
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

    def test_matching_inventory_marker_does_not_refetch_the_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        client = FakeClient()
        runtime = SmartThingsWebRuntime(client, "loc_001", current)

        changed = asyncio.run(
            runtime.handle_event({"type": "inventory", "sequence": 10})
        )

        self.assertFalse(changed)
        self.assertEqual(client.calls, 0)
        self.assertEqual(runtime.inventory.sequence, 10)

    def test_inventory_merge_updates_device_presentation_atomically(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        current.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/off",
        )
        latest.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/on",
            animation_url="https://app-asset.samsungiotcloud.com/assets/icons/published/contact_sensor/contact_sensor.json",
        )
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertEqual(
            runtime.inventory.devices["dev_001"].presentation,
            latest.devices["dev_001"].presentation,
        )

    def test_inventory_merge_clears_presentation_removed_by_latest_snapshot(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:00:00Z")
        latest = inventory(11, 21, "2026-08-24T21:01:00Z")
        current.devices["dev_001"].presentation = BridgeDevicePresentation(
            asset_type="contact_sensor",
            icon_url="https://client.smartthings.com/icons/oneui/contact/on",
        )
        self.assertIsNone(latest.devices["dev_001"].presentation)
        runtime = SmartThingsWebRuntime(FakeClient(latest), "loc_001", current)

        changed = asyncio.run(runtime.handle_event({"type": "inventory", "sequence": 11}))

        self.assertTrue(changed)
        self.assertIsNone(runtime.inventory.devices["dev_001"].presentation)

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

    def test_ready_inventory_atomically_removes_items_absent_from_latest_snapshot(self) -> None:
        current = inventory(50, 20, "2026-08-24T21:00:00Z")
        stale = BridgeDevice(
            "dev_002",
            "loc_001",
            "room_stale",
            "Removed sensor",
            "sensor",
            True,
        )
        current.devices[stale.device_id] = stale
        current.rooms["room_stale"] = ("loc_001", "Removed room")
        current.scenes["scene_stale"] = BridgeScene(
            "scene_stale",
            "loc_001",
            "Removed scene",
            "2026-08-24T21:00:00Z",
        )
        latest = inventory(51, 21, "2026-08-24T21:01:00Z")
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)

        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertEqual(runtime.inventory.devices, latest.devices)
        self.assertEqual(runtime.inventory.rooms, latest.rooms)
        self.assertEqual(runtime.inventory.scenes, latest.scenes)

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

    def test_repeated_button_events_with_the_same_timestamp_keep_each_sequence(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        button = BridgeState(
            "main",
            "button",
            "button",
            "pushed",
            None,
            "2026-08-24T21:11:00Z",
        )
        current.devices["dev_001"].states[button.key] = button
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        calls: list[int] = []
        runtime.subscribe_state(
            "dev_001",
            button.key,
            lambda: calls.append(runtime.inventory.sequence),
        )

        for sequence in (11, 12):
            changed = asyncio.run(
                runtime.handle_event(
                    {
                        "type": "state",
                        "sequence": sequence,
                        "deviceId": "dev_001",
                        "state": {
                            "component": "main",
                            "capability": "button",
                            "attribute": "button",
                            "value": "pushed",
                            "updatedAt": "2026-08-24T21:11:00Z",
                        },
                    }
                )
            )
            self.assertTrue(changed)

        self.assertEqual(calls, [11, 12])

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

    def test_one_failing_entity_listener_does_not_block_other_push_updates(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        observations: list[int] = []

        def failing_listener() -> None:
            raise RuntimeError("entity write failed")

        state = next(iter(runtime.inventory.devices["dev_001"].states.values()))
        runtime.subscribe_state("dev_001", state.key, failing_listener)
        runtime.subscribe_state(
            "dev_001", state.key, lambda: observations.append(sensor_value(runtime))
        )

        with self.assertLogs(level="ERROR") as captured:
            changed = asyncio.run(
                runtime.handle_event(state_event(11, 21, "2026-08-24T21:11:00Z"))
            )

        self.assertTrue(changed)
        self.assertEqual(observations, [21])
        self.assertEqual(len(captured.output), 1)
        self.assertEqual(captured.records[0].getMessage(), "runtime_listener_failed")
        self.assertIsNotNone(captured.records[0].exc_info)

    def test_state_push_notifies_only_matching_state_and_device_listeners(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        humidity = next(iter(runtime.inventory.devices["dev_001"].states.values()))
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        runtime.inventory.devices["dev_001"].states[battery.key] = battery
        runtime.inventory.devices["dev_002"] = BridgeDevice(
            "dev_002",
            "loc_001",
            None,
            "Other sensor",
            "sensor",
            True,
            states={battery.key: battery},
        )
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("global"))
        runtime.subscribe_state("dev_001", humidity.key, lambda: calls.append("humidity"))
        runtime.subscribe_state("dev_001", battery.key, lambda: calls.append("battery"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device_1"))
        runtime.subscribe_device("dev_002", lambda: calls.append("device_2"))

        changed = runtime.apply_state(state_event(11, 21, "2026-08-24T21:11:00Z"))

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["humidity", "device_1"])

    def test_new_state_key_runs_discovery_and_its_device_listener_once(self) -> None:
        runtime = SmartThingsWebRuntime(
            FakeClient(),
            "loc_001",
            inventory(10, 20, "2026-08-24T21:10:00Z"),
        )
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("discovery"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device"))

        changed = runtime.apply_state(
            {
                "type": "state",
                "sequence": 11,
                "deviceId": "dev_001",
                "state": {
                    "component": "main",
                    "capability": "battery",
                    "attribute": "battery",
                    "value": 80,
                    "unit": "%",
                    "updatedAt": "2026-08-24T21:11:00Z",
                },
            }
        )

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["discovery", "device"])

    def test_inventory_merge_notifies_only_changed_device_subscribers(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        unchanged_state = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        current.devices["dev_002"] = BridgeDevice(
            "dev_002",
            "loc_001",
            None,
            "Other sensor",
            "sensor",
            True,
            states={unchanged_state.key: unchanged_state},
        )
        runtime = SmartThingsWebRuntime(FakeClient(), "loc_001", current)
        changed_state = next(iter(current.devices["dev_001"].states.values()))
        calls: list[str] = []
        runtime.subscribe(lambda: calls.append("global"))
        runtime.subscribe_state("dev_001", changed_state.key, lambda: calls.append("state_1"))
        runtime.subscribe_device("dev_001", lambda: calls.append("device_1"))
        runtime.subscribe_state(
            "dev_002", unchanged_state.key, lambda: calls.append("state_2")
        )
        runtime.subscribe_device("dev_002", lambda: calls.append("device_2"))

        latest = inventory(11, 21, "2026-08-24T21:11:00Z")
        latest.devices["dev_002"] = deepcopy(current.devices["dev_002"])
        changed = runtime.apply_inventory(latest)

        self.assertTrue(changed)
        self.assertCountEqual(calls, ["global", "state_1", "device_1"])

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

    def test_refresh_controls_only_use_button_controls_with_refresh_mention(self) -> None:
        battery_state = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={
                "refresh": BridgeControl(
                    "refresh",
                    "button",
                    "Refresh",
                    commands=("refresh",),
                ),
                "not_refresh": BridgeControl(
                    "not_refresh",
                    "button",
                    "Refresh",
                    commands=(),
                ),
                "slider": BridgeControl(
                    "level",
                    "slider",
                    "Level",
                    minimum=0,
                    maximum=100,
                ),
            },
            states={battery_state.key: battery_state},
        )

        controls = [control.control_id for control in refresh_controls(device)]
        self.assertEqual(controls, ["refresh"])

    def test_is_refreshable_device_depends_on_observed_refresh_control(self) -> None:
        image_state = BridgeState(
            "main",
            "camera",
            "image",
            "data",
            None,
            "2026-08-24T21:10:00Z",
        )
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Camera",
            "camera",
            True,
            controls={
                "battery_only": BridgeControl(
                    "battery_only",
                    "value",
                    "Battery",
                )
            },
            states={image_state.key: image_state},
        )

        self.assertFalse(is_refreshable_device(device))

    def test_refresh_control_with_unsafe_fields_is_rejected_by_url_guard(self) -> None:
        self.assertIsNone(
            _safe_device_asset_url("https://example.com/icons/oneui/contact/on", animation=False)
        )
        parsed = parse_device_presentation(
            {
                "assetType": "oneui",
                "iconUrl": "https://client.smartthings.com/icons/oneui/contact/on",
                "inactiveIconUrl": "https://example.com/icons/oneui/contact/off",
            }
        )
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(
            parsed.icon_url, "https://client.smartthings.com/icons/oneui/contact/on"
        )
        self.assertIsNone(parsed.inactive_icon_url)
        self.assertEqual(parsed.inactive_icon_url, None)

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

        self.assertEqual(numeric_range_for(device, frequency), (10.0, 120.0, 5.0))
        self.assertEqual(option_values({"values": [{"value": "auto"}, {"name": "sleep"}]}), ["auto", "sleep"])

    def test_richer_domains_do_not_create_duplicate_number_entities(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        playback = BridgeState(
            "main",
            "mediaPlayback",
            "playbackStatus",
            "paused",
            None,
            "2026-08-24T21:10:00Z",
        )
        volume = BridgeState(
            "main",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {playback.key: playback, volume.key: volume}
        device.controls = {
            "volume": BridgeControl(
                "volume",
                "slider",
                "Volume",
                component="main",
                capability="audioVolume",
                attribute="volume",
                minimum=0,
                maximum=100,
                step=1,
            )
        }

        self.assertEqual(number_controls(device), [])

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

    def test_observed_select_owns_its_mirrored_state_instead_of_a_duplicate_sensor(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        state = BridgeState(
            "main",
            "motionSensitivity",
            "sensitivityAdjustment",
            "high",
            None,
            "2026-08-24T21:10:00Z",
        )
        device.states = {state.key: state}
        device.controls = {
            "sensitivity": BridgeControl(
                "sensitivity",
                "enumerated",
                "Sensitivity adjustment",
                component="main",
                capability="motionSensitivity",
                attribute="sensitivityAdjustment",
                options=("low", "medium", "high"),
            )
        }

        self.assertTrue(sensor_state_owned_by_primary_domain(device, state))

    def test_primary_attributes_preserve_duplicate_components_without_overwrite(self) -> None:
        current = inventory(10, 20, "2026-08-24T21:10:00Z")
        device = current.devices["dev_001"]
        first = BridgeState(
            "main",
            "audioVolume",
            "volume",
            10,
            "%",
            "2026-08-24T21:10:00Z",
        )
        second = BridgeState(
            "zone2",
            "audioVolume",
            "volume",
            20,
            "%",
            "2026-08-24T21:10:00Z",
        )
        device.states = {first.key: first, second.key: second}

        attributes = primary_state_attributes(device, {"volume"})

        self.assertEqual(len(attributes), 2)
        self.assertEqual(set(attributes.values()), {10, 20})
        self.assertNotIn("volume", attributes)

    def test_generic_toggle_rejects_compound_and_localized_dangerous_controls(self) -> None:
        for attribute, label in (
            ("doorLock", "Power"),
            ("lockState", "Power"),
            ("garageDoor", "Power"),
            ("valveState", "Power"),
            ("safeToggle", "문 열기"),
            ("safeToggle", "밸브 제어"),
            ("safeToggle", "현관문"),
            ("safeToggle", "대문"),
        ):
            with self.subTest(attribute=attribute, label=label):
                control = BridgeControl(
                    "toggle",
                    "toggle",
                    label,
                    attribute=attribute,
                    commands=("switchOn", "switchOff"),
                )
                self.assertFalse(safe_generic_toggle_control(control))

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

    def test_device_models_use_korean_names_for_observed_smartthings_types(self) -> None:
        expected = {
            "accessory": "액세서리",
            "ai_speaker_lux_one": "AI 스피커",
            "air_purifier": "공기청정기",
            "air_quality_sensor": "공기질 센서",
            "bleD2D": "블루투스 기기",
            "button_1": "버튼",
            "camera_security": "보안 카메라",
            "charger_hub": "충전 허브",
            "coffee_machine": "커피 머신",
            "contact_sensor": "문열림 센서",
            "custom_door": "도어",
            "custom_floor_ac_rac": "에어컨",
            "custom_light_mood": "무드등",
            "custom_light_pendant": "펜던트 조명",
            "custom_light_strip": "스트립 조명",
            "custom_light_tube": "튜브 조명",
            "custom_window_h": "창문",
            "dishwasher": "식기세척기",
            "dryer": "건조기",
            "elevator": "엘리베이터",
            "energy_monitoring": "에너지 모니터",
            "fan": "선풍기",
            "floor_ac": "에어컨",
            "garage_door": "차고문",
            "general_display": "디스플레이",
            "home_theater": "홈시어터",
            "hub": "허브",
            "humidifier": "가습기",
            "illuminance_sensor": "조도 센서",
            "light_bulb": "전구",
            "light_ceiling": "천장등",
            "moisture_sensor_1": "누수 센서",
            "motion_sensor_1": "모션 센서",
            "multipurpose_sensor_1": "다목적 센서",
            "outlet_1": "콘센트",
            "presence_sensor": "재실 센서",
            "qooker": "쿠커",
            "range_extender": "신호 확장기",
            "refrigerator": "냉장고",
            "remote": "리모컨",
            "shade": "블라인드",
            "smoke_sensor": "연기 감지기",
            "soundbar": "사운드바",
            "speaker": "스피커",
            "switch": "스위치",
            "temp_humidity_sensor": "온습도 센서",
            "thermostat": "온도조절기",
            "unknown": "스마트 기기",
            "washer": "세탁기",
            "wifi_hub_1": "Wi-Fi 허브",
        }

        for device_type, model in expected.items():
            with self.subTest(device_type=device_type):
                device = BridgeDevice(
                    "dev_001", "loc_001", None, "Device", device_type, True
                )
                self.assertEqual(device_model(device), model)

    def test_unknown_device_model_removes_only_trailing_numeric_suffix(self) -> None:
        device = BridgeDevice(
            "dev_001", "loc_001", None, "Device", "future_sensor_1", True
        )

        self.assertEqual(device_model(device), "Future Sensor")

    def test_duplicate_state_names_get_stable_human_readable_qualifiers(self) -> None:
        first = BridgeState(
            "identifier_component",
            "identifier_capability_a",
            "referenceTable",
            {},
            None,
            "2026-08-27T00:00:00Z",
        )
        second = BridgeState(
            "identifier_component",
            "identifier_capability_b",
            "referenceTable",
            {},
            None,
            "2026-08-27T00:00:00Z",
        )
        indoor = BridgeState(
            "indoor",
            "temperatureMeasurement",
            "temperature",
            24,
            "C",
            "2026-08-27T00:00:00Z",
        )
        outdoor = BridgeState(
            "outdoor",
            "temperatureMeasurement",
            "temperature",
            31,
            "C",
            "2026-08-27T00:00:00Z",
        )
        battery = BridgeState(
            "main",
            "battery",
            "battery",
            80,
            "%",
            "2026-08-27T00:00:00Z",
        )

        names = models_module.disambiguated_state_names(
            [
                (second, "Reference Table"),
                (first, "Reference Table"),
                (outdoor, "Temperature"),
                (indoor, "Temperature"),
                (battery, "Battery"),
            ]
        )

        self.assertEqual(names[first.key], "Reference Table (1)")
        self.assertEqual(names[second.key], "Reference Table (2)")
        self.assertEqual(names[indoor.key], "Temperature (Indoor)")
        self.assertEqual(names[outdoor.key], "Temperature (Outdoor)")
        self.assertNotIn(battery.key, names)


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
