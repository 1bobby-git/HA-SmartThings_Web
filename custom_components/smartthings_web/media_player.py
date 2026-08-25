"""Media player entities for SmartThings Web."""

from __future__ import annotations

from homeassistant.components.media_player import MediaPlayerEntity, MediaPlayerEntityFeature
from homeassistant.const import STATE_IDLE, STATE_OFF, STATE_PAUSED, STATE_PLAYING
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import SmartThingsWebConfigEntry
from .bridge_client import BridgeClientError
from .entity import SmartThingsWebDeviceEntity
from .models import (
    BridgeControl,
    BridgeDevice,
    SmartThingsWebRuntime,
    control_supports_command,
    is_media_device,
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
            "paused": STATE_PAUSED,
            "stopped": STATE_IDLE,
            "idle": STATE_IDLE,
        }.get((playback or "").lower(), STATE_IDLE if playback is not None else None)

    @property
    def supported_features(self) -> MediaPlayerEntityFeature:
        """Expose only controls observed for this media device."""
        device = self.bridge_device
        features = MediaPlayerEntityFeature(0)
        if _raw_state(device, "switch") is not None:
            features |= MediaPlayerEntityFeature.TURN_ON | MediaPlayerEntityFeature.TURN_OFF
        playback = _string_options(_raw_state(device, "supportedPlaybackCommands"))
        if "play" in playback:
            features |= MediaPlayerEntityFeature.PLAY
        if "pause" in playback:
            features |= MediaPlayerEntityFeature.PAUSE
        if "stop" in playback:
            features |= MediaPlayerEntityFeature.STOP
        tracks = _string_options(_raw_state(device, "supportedTrackControlCommands"))
        if "nextTrack" in tracks:
            features |= MediaPlayerEntityFeature.NEXT_TRACK
        if "previousTrack" in tracks:
            features |= MediaPlayerEntityFeature.PREVIOUS_TRACK
        if _raw_state(device, "volume") is not None:
            features |= MediaPlayerEntityFeature.VOLUME_SET
        if _raw_state(device, "mute") is not None:
            features |= MediaPlayerEntityFeature.VOLUME_MUTE
        if device and any(
            control_supports_command(control, "playTrackAndResume")
            for control in device.controls.values()
        ):
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
        await self._async_command("nextTrack", [])

    async def async_media_previous_track(self) -> None:
        await self._async_command("previousTrack", [])

    async def async_set_volume_level(self, volume: float) -> None:
        await self._async_command("setVolume", [round(max(0.0, min(1.0, volume)) * 100)])

    async def async_mute_volume(self, mute: bool) -> None:
        await self._async_command("mute" if mute else "unmute", [])

    async def async_play_media(self, media_type: str, media_id: str, **kwargs: object) -> None:
        """Play a track and resume playback."""
        await self._async_command("playTrackAndResume", [media_id])

    async def _async_command(self, command: str, arguments: list[object]) -> None:
        control = _control_for(self.bridge_device, command)
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
            raise HomeAssistantError("SmartThings Web did not confirm media state") from err


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


def _string_options(value: object | None) -> set[str]:
    return {item for item in value if isinstance(item, str)} if isinstance(value, list) else set()


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
    for control in device.controls.values():
        if control.kind == "value":
            continue
        if control_supports_command(control, command):
            return control
    return None
