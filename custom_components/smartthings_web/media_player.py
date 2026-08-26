"""Media player entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.media_player import MediaPlayerEntity, MediaPlayerEntityFeature
from homeassistant.const import STATE_IDLE, STATE_OFF, STATE_PAUSED, STATE_PLAYING
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError, bridge_error_message
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    control_supports_command,
    is_media_device,
    primary_state_attributes,
    safe_observed_control,
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SmartThingsWebConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create media players for speaker-like devices."""
    runtime = entry.runtime_data
    known: set[str] = set()

    def discover() -> None:
        entities = []
        for device in runtime.inventory.devices.values():
            if device.location_id != runtime.location_id or not is_media_device(device):
                continue
            if device.device_id in known:
                continue
            known.add(device.device_id)
            entities.append(SmartThingsWebMediaPlayer(runtime, device))
        if entities:
            async_add_entities(entities)

    discover()
    entry.async_on_unload(runtime.subscribe(discover))


class SmartThingsWebMediaPlayer(SmartThingsWebDeviceEntity, MediaPlayerEntity):
    """One SmartThings speaker/media device."""

    def __init__(self, runtime: SmartThingsWebRuntime, device: BridgeDevice) -> None:
        super().__init__(runtime, device, "media_player", None)

    @property
    def state(self) -> str | None:
        """Return current playback state."""
        playback = _string_state(self.bridge_device, "playbackStatus")
        switch = _string_state(self.bridge_device, "switch")
        if switch == "off":
            return STATE_OFF
        return {
            "playing": STATE_PLAYING,
            "fast forwarding": STATE_PLAYING,
            "rewinding": STATE_PLAYING,
            "paused": STATE_PAUSED,
            "stopped": STATE_IDLE,
            "idle": STATE_IDLE,
        }.get((playback or "").lower(), STATE_IDLE if playback is not None else None)

    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        """Expose only controls observed for this media device."""
        device = self.bridge_device
        features = MediaPlayerEntityFeature(0)
        if _control_for(device, "on") is not None and _control_for(device, "off") is not None:
            features |= MediaPlayerEntityFeature.TURN_ON | MediaPlayerEntityFeature.TURN_OFF
        if _control_for(device, "play") is not None:
            features |= MediaPlayerEntityFeature.PLAY
        if _control_for(device, "pause") is not None:
            features |= MediaPlayerEntityFeature.PAUSE
        if _control_for(device, "stop") is not None:
            features |= MediaPlayerEntityFeature.STOP
        if _has_preferred_command(device, "nextTrack", "fastForward"):
            features |= MediaPlayerEntityFeature.NEXT_TRACK
        if _has_preferred_command(device, "previousTrack", "rewind"):
            features |= MediaPlayerEntityFeature.PREVIOUS_TRACK
        if _control_for(device, "setVolume") is not None:
            features |= MediaPlayerEntityFeature.VOLUME_SET
        if _control_for(device, "mute") is not None and _control_for(device, "unmute") is not None:
            features |= MediaPlayerEntityFeature.VOLUME_MUTE
        if _control_for(device, "playTrackAndResume") is not None:
            features |= MediaPlayerEntityFeature.PLAY_MEDIA
        return features

    @property
    def volume_level(self) -> float | None:
        """Return current volume as 0..1."""
        value = _numeric_state(self.bridge_device, "volume")
        return None if value is None else max(0.0, min(1.0, value / 100.0))

    @property
    def is_volume_muted(self) -> bool | None:
        """Return current mute state."""
        value = _string_state(self.bridge_device, "mute")
        if value is None:
            return None
        return value.lower() in {"muted", "mute", "on", "true"}

    @property
    def media_title(self) -> str | None:
        """Return current track title when exposed by SmartThings."""
        data = _raw_state(self.bridge_device, "audioTrackData")
        if isinstance(data, dict):
            for key in ("title", "name", "trackTitle"):
                value = data.get(key)
                if isinstance(value, str):
                    return value
        return data if isinstance(data, str) else None

    @property
    def media_artist(self) -> str | None:
        """Return the current artist when SmartThings supplies it."""
        data = _raw_state(self.bridge_device, "audioTrackData")
        if not isinstance(data, dict):
            return None
        for key in ("artist", "artistName", "subtitle"):
            value = data.get(key)
            if isinstance(value, str):
                return value
        return None

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Keep all pushed media content on the primary media entity."""
        device = self.bridge_device
        if device is None:
            return {}
        return primary_state_attributes(
            device,
            {
                "audioTrackData",
                "mute",
                "playbackStatus",
                "switch",
                "supportedPlaybackCommands",
                "supportedTrackControlCommands",
                "volume",
            },
        )

    async def async_turn_on(self) -> None:
        await self._async_command("on", [])

    async def async_turn_off(self) -> None:
        await self._async_command("off", [])

    async def async_media_play(self) -> None:
        await self._async_command("play", [])

    async def async_media_pause(self) -> None:
        await self._async_command("pause", [])

    async def async_media_stop(self) -> None:
        await self._async_command("stop", [])

    async def async_media_next_track(self) -> None:
        await self._async_command(
            _preferred_command(self.bridge_device, "nextTrack", "fastForward"), []
        )

    async def async_media_previous_track(self) -> None:
        await self._async_command(
            _preferred_command(self.bridge_device, "previousTrack", "rewind"), []
        )

    async def async_set_volume_level(self, volume: float) -> None:
        await self._async_command("setVolume", [round(max(0.0, min(1.0, volume)) * 100)])

    async def async_mute_volume(self, mute: bool) -> None:
        await self._async_command("mute" if mute else "unmute", [])

    async def async_play_media(self, media_type: str, media_id: str, **kwargs: object) -> None:
        """Play a track and resume playback."""
        await self._async_command("playTrackAndResume", [media_id])

    async def _async_command(self, command: str, arguments: list[object]) -> None:
        control = _control_for(self.bridge_device, command)
        if control is None:
            raise HomeAssistantError(
                f"SmartThings Web media device has no observed {command} control"
            )
        state = _state_for_command(self.bridge_device, command)
        try:
            await self.runtime.client.async_execute_command(
                target_type="device",
                target_id=self.device_id,
                component=control.component if control else state.component if state else None,
                capability=control.capability if control else state.capability if state else None,
                attribute=control.attribute if control else state.attribute if state else None,
                control_id=control.control_id if control else None,
                control_label=control.label if control else None,
                command=command,
                arguments=arguments,
            )
        except BridgeClientError as err:
            raise HomeAssistantError(bridge_error_message("media command", err)) from err


def _raw_state(device: BridgeDevice | None, attribute: str) -> object | None:
    if device is None:
        return None
    for state in device.states.values():
        if state.attribute == attribute:
            return state.value
    return None


def _string_state(device: BridgeDevice | None, attribute: str) -> str | None:
    value = _raw_state(device, attribute)
    return value if isinstance(value, str) else None


def _numeric_state(device: BridgeDevice | None, attribute: str) -> float | None:
    value = _raw_state(device, attribute)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _state_for_command(device: BridgeDevice | None, command: str):
    attributes = {
        "on": ("switch",),
        "off": ("switch",),
        "play": ("playbackStatus",),
        "pause": ("playbackStatus",),
        "stop": ("playbackStatus",),
        "setVolume": ("volume",),
        "mute": ("mute",),
        "unmute": ("mute",),
        "nextTrack": ("audioTrackData", "supportedTrackControlCommands"),
        "previousTrack": ("audioTrackData", "supportedTrackControlCommands"),
        "fastForward": ("playbackStatus", "supportedPlaybackCommands"),
        "rewind": ("playbackStatus", "supportedPlaybackCommands"),
        "playTrackAndResume": ("audioTrackData", "playbackStatus"),
    }.get(command, ())
    if device is None:
        return None
    return next(
        (state for attribute in attributes for state in device.states.values() if state.attribute == attribute),
        None,
    )


def _control_for(device: BridgeDevice | None, command: str) -> BridgeControl | None:
    if device is None:
        return None
    matches = []
    for control in device.controls.values():
        if control.kind == "value" or not safe_observed_control(control):
            continue
        if command in {"on", "off"}:
            matched = control.kind == "toggle" and control.attribute == "switch"
        elif command in {"mute", "unmute"}:
            matched = control.kind == "toggle" and control.attribute == "mute"
        elif command == "setVolume":
            matched = control.kind == "slider" and control.attribute == "volume"
        elif command == "playTrackAndResume":
            matched = control.kind == "button" and control_supports_command(
                control, command
            )
        elif command in {
            "fastForward",
            "nextTrack",
            "pause",
            "play",
            "previousTrack",
            "rewind",
            "stop",
        }:
            matched = (
                control.kind in {"button", "enumerated"}
                and control_supports_command(control, command)
            )
        else:
            matched = False
        if matched:
            matches.append(control)
    return matches[0] if len(matches) == 1 else None


def _preferred_command(
    device: BridgeDevice | None, primary: str, official_fallback: str
) -> str:
    if _control_for(device, primary) is not None:
        return primary
    if _control_for(device, official_fallback) is not None:
        return official_fallback
    raise HomeAssistantError(
        f"SmartThings Web media device has no observed {primary} or {official_fallback} control"
    )


def _has_preferred_command(
    device: BridgeDevice | None, primary: str, official_fallback: str
) -> bool:
    return (
        _control_for(device, primary) is not None
        or _control_for(device, official_fallback) is not None
    )
