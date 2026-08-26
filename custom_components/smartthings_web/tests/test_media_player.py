"""Regression tests for SmartThings speaker feature discovery."""

from __future__ import annotations

import asyncio
from enum import IntFlag
from pathlib import Path
import sys
from types import ModuleType
import unittest


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = sys.modules.setdefault("smartthings_web", ModuleType("smartthings_web"))
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
package.SmartThingsWebConfigEntry = object  # type: ignore[attr-defined]

sys.modules.setdefault("homeassistant", ModuleType("homeassistant"))
sys.modules.setdefault("homeassistant.components", ModuleType("homeassistant.components"))
media_module = ModuleType("homeassistant.components.media_player")


class MediaPlayerEntity:
    """Minimal HA media-player entity stub."""


class MediaPlayerEntityFeature(IntFlag):
    """Minimal distinct feature flags used by the integration."""

    TURN_ON = 1
    TURN_OFF = 2
    PLAY = 4
    PAUSE = 8
    STOP = 16
    NEXT_TRACK = 32
    PREVIOUS_TRACK = 64
    VOLUME_SET = 128
    VOLUME_MUTE = 256
    PLAY_MEDIA = 512


media_module.MediaPlayerEntity = MediaPlayerEntity  # type: ignore[attr-defined]
media_module.MediaPlayerEntityFeature = MediaPlayerEntityFeature  # type: ignore[attr-defined]
sys.modules["homeassistant.components.media_player"] = media_module

const_module = ModuleType("homeassistant.const")
const_module.STATE_IDLE = "idle"  # type: ignore[attr-defined]
const_module.STATE_OFF = "off"  # type: ignore[attr-defined]
const_module.STATE_PAUSED = "paused"  # type: ignore[attr-defined]
const_module.STATE_PLAYING = "playing"  # type: ignore[attr-defined]
sys.modules["homeassistant.const"] = const_module

core_module = ModuleType("homeassistant.core")
core_module.HomeAssistant = object  # type: ignore[attr-defined]
sys.modules["homeassistant.core"] = core_module

exceptions_module = ModuleType("homeassistant.exceptions")
exceptions_module.HomeAssistantError = type("HomeAssistantError", (Exception,), {})
sys.modules["homeassistant.exceptions"] = exceptions_module

sys.modules.setdefault("homeassistant.helpers", ModuleType("homeassistant.helpers"))
entity_platform = ModuleType("homeassistant.helpers.entity_platform")
entity_platform.AddConfigEntryEntitiesCallback = object  # type: ignore[attr-defined]
sys.modules["homeassistant.helpers.entity_platform"] = entity_platform

entity_module = ModuleType("smartthings_web.entity")


class SmartThingsWebDeviceEntity:
    """Minimal integration entity base stub."""

    def __init__(self, _runtime: object, device: object, *_args: object) -> None:
        self.runtime = _runtime
        self.bridge_device = device
        self.device_id = device.device_id  # type: ignore[attr-defined]


entity_module.SmartThingsWebDeviceEntity = SmartThingsWebDeviceEntity  # type: ignore[attr-defined]
sys.modules["smartthings_web.entity"] = entity_module

from smartthings_web.media_player import (  # noqa: E402
    SmartThingsWebMediaPlayer,
    _preferred_command,
)
from smartthings_web.models import BridgeControl, BridgeDevice, BridgeState  # noqa: E402


class SmartThingsWebMediaPlayerTests(unittest.TestCase):
    """Expose the command strings pushed by the live speaker devices."""

    def test_space_delimited_supported_commands_enable_all_speaker_controls(self) -> None:
        values = {
            "switch": "on",
            "playbackStatus": "stopped",
            "supportedPlaybackCommands": "play pause stop",
            "supportedTrackControlCommands": "nextTrack previousTrack",
            "volume": 10,
            "mute": "unmuted",
            "audioTrackData": {"title": "Track"},
        }
        states = [
            BridgeState(
                "main",
                attribute,
                attribute,
                value,
                None,
                "2026-08-25T00:00:00Z",
            )
            for attribute, value in values.items()
        ]
        device = BridgeDevice(
            "dev_001",
            "loc_001",
            None,
            "Living room speaker",
            None,
            True,
            states={state.key: state for state in states},
            controls=_media_controls(),
        )

        features = SmartThingsWebMediaPlayer(object(), device).supported_features

        for feature in (
            MediaPlayerEntityFeature.TURN_ON,
            MediaPlayerEntityFeature.TURN_OFF,
            MediaPlayerEntityFeature.PLAY,
            MediaPlayerEntityFeature.PAUSE,
            MediaPlayerEntityFeature.STOP,
            MediaPlayerEntityFeature.NEXT_TRACK,
            MediaPlayerEntityFeature.PREVIOUS_TRACK,
            MediaPlayerEntityFeature.VOLUME_SET,
            MediaPlayerEntityFeature.VOLUME_MUTE,
            MediaPlayerEntityFeature.PLAY_MEDIA,
        ):
            with self.subTest(feature=feature):
                self.assertTrue(features & feature)

    def test_track_data_alone_does_not_invent_a_play_track_control(self) -> None:
        track = BridgeState(
            "main",
            "audioTrackData",
            "audioTrackData",
            {"title": "Track"},
            None,
            "2026-08-25T00:00:00Z",
        )
        device = BridgeDevice(
            "dev_002",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            states={track.key: track},
            controls={},
        )

        features = SmartThingsWebMediaPlayer(object(), device).supported_features

        self.assertFalse(features & MediaPlayerEntityFeature.PLAY_MEDIA)

    def test_track_command_uses_only_observed_actions(self) -> None:
        primary = BridgeControl(
            "next",
            "button",
            "Next track",
            attribute="audioTrackData",
            commands=("nextTrack",),
        )
        fallback = BridgeControl(
            "playback",
            "enumerated",
            "Playback",
            attribute="playbackStatus",
            options=("fast forwarding",),
            option_commands={"fast forwarding": "fastForward"},
        )
        primary_device = BridgeDevice(
            "dev_primary",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            controls={primary.control_id: primary},
        )
        fallback_device = BridgeDevice(
            "dev_fallback",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            controls={fallback.control_id: fallback},
        )
        ambiguous_primary_device = BridgeDevice(
            "dev_ambiguous",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            controls={
                "next_1": primary,
                "next_2": BridgeControl(
                    "next_2",
                    "button",
                    "Next track 2",
                    attribute="audioTrackData",
                    commands=("nextTrack",),
                ),
                fallback.control_id: fallback,
            },
        )
        unavailable_device = BridgeDevice(
            "dev_none",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
        )

        self.assertEqual(
            _preferred_command(primary_device, "nextTrack", "fastForward"),
            "nextTrack",
        )
        self.assertEqual(
            _preferred_command(fallback_device, "nextTrack", "fastForward"),
            "fastForward",
        )
        self.assertEqual(
            _preferred_command(
                ambiguous_primary_device,
                "nextTrack",
                "fastForward",
            ),
            "fastForward",
        )
        with self.assertRaises(exceptions_module.HomeAssistantError):
            _preferred_command(unavailable_device, "nextTrack", "fastForward")

    def test_unsafe_control_cannot_advertise_or_supply_media_fallback(self) -> None:
        unsafe = BridgeControl(
            "garageDoorControl",
            "button",
            "Garage door",
            attribute="playbackStatus",
            commands=("fastForward", "playTrackAndResume"),
        )
        device = BridgeDevice(
            "dev_unsafe",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            controls={unsafe.control_id: unsafe},
        )

        features = SmartThingsWebMediaPlayer(object(), device).supported_features

        self.assertFalse(features & MediaPlayerEntityFeature.NEXT_TRACK)
        self.assertFalse(features & MediaPlayerEntityFeature.PLAY_MEDIA)
        with self.assertRaises(exceptions_module.HomeAssistantError):
            _preferred_command(device, "nextTrack", "fastForward")

    def test_all_media_services_forward_exact_bridge_commands_without_state_mutation(self) -> None:
        values = {
            "switch": "off",
            "playbackStatus": "stopped",
            "supportedPlaybackCommands": "play pause stop",
            "supportedTrackControlCommands": "nextTrack previousTrack",
            "volume": 10,
            "mute": "unmuted",
            "audioTrackData": {"title": "Before"},
        }
        states = [
            BridgeState(
                "main",
                attribute,
                attribute,
                value,
                None,
                "2026-08-25T00:00:00Z",
            )
            for attribute, value in values.items()
        ]
        device = BridgeDevice(
            "dev_003",
            "loc_001",
            None,
            "Speaker",
            None,
            True,
            states={state.key: state for state in states},
            controls=_media_controls(),
        )

        class Client:
            def __init__(self) -> None:
                self.calls: list[dict[str, object]] = []

            async def async_execute_command(self, **kwargs: object) -> None:
                self.calls.append(kwargs)

        client = Client()
        runtime = type("Runtime", (), {"client": client})()
        player = SmartThingsWebMediaPlayer(runtime, device)
        before = {key: state.value for key, state in device.states.items()}

        async def exercise() -> None:
            await player.async_turn_on()
            await player.async_turn_off()
            await player.async_media_play()
            await player.async_media_pause()
            await player.async_media_stop()
            await player.async_media_next_track()
            await player.async_media_previous_track()
            await player.async_set_volume_level(0.25)
            await player.async_mute_volume(True)
            await player.async_mute_volume(False)
            await player.async_play_media("music", "track-123")

        asyncio.run(exercise())

        self.assertEqual(
            [call["command"] for call in client.calls],
            [
                "on",
                "off",
                "play",
                "pause",
                "stop",
                "nextTrack",
                "previousTrack",
                "setVolume",
                "mute",
                "unmute",
                "playTrackAndResume",
            ],
        )
        self.assertEqual(client.calls[7]["arguments"], [25])
        self.assertEqual(client.calls[10]["arguments"], ["track-123"])
        self.assertEqual(
            {key: state.value for key, state in device.states.items()},
            before,
        )


def _media_controls() -> dict[str, BridgeControl]:
    controls = [
        BridgeControl(
            "power",
            "toggle",
            "Power",
            component="main",
            capability="switch",
            attribute="switch",
            commands=("on", "off"),
        ),
        BridgeControl(
            "playback",
            "enumerated",
            "Playback",
            component="main",
            capability="mediaPlayback",
            attribute="playbackStatus",
            options=("playing", "paused", "stopped"),
            option_commands={
                "playing": "play",
                "paused": "pause",
                "stopped": "stop",
            },
        ),
        BridgeControl(
            "next",
            "button",
            "Next track",
            component="main",
            capability="mediaTrackControl",
            attribute="audioTrackData",
            commands=("nextTrack",),
        ),
        BridgeControl(
            "previous",
            "button",
            "Previous track",
            component="main",
            capability="mediaTrackControl",
            attribute="audioTrackData",
            commands=("previousTrack",),
        ),
        BridgeControl(
            "volume",
            "slider",
            "Volume",
            component="main",
            capability="audioVolume",
            attribute="volume",
            minimum=0,
            maximum=100,
            step=1,
        ),
        BridgeControl(
            "mute",
            "toggle",
            "Mute",
            component="main",
            capability="audioMute",
            attribute="mute",
            commands=("mute", "unmute"),
        ),
        BridgeControl(
            "play_track",
            "button",
            "Play track and resume",
            component="main",
            capability="audioTrackData",
            attribute="audioTrackData",
            commands=("playTrackAndResume",),
        ),
    ]
    return {control.control_id: control for control in controls}


if __name__ == "__main__":
    unittest.main()
