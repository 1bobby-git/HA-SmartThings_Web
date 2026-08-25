"""Local SmartThings Web Bridge client."""

from __future__ import annotations

from collections.abc import AsyncIterator
from ipaddress import ip_address
import json
import re
from typing import Any
from uuid import uuid4

from aiohttp import ClientError, ClientSession, ClientTimeout
from yarl import URL

from .models import (
    BridgeCommandResult,
    BridgeDevice,
    BridgeInventory,
    parse_control,
    parse_location,
    parse_command_result,
    parse_scene,
    parse_state,
)


_LOCAL_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_LOCAL_DNS_SUFFIXES = (".local", ".home.arpa")


class BridgeClientError(Exception):
    """Bridge communication failed."""


class BridgeAuthError(BridgeClientError):
    """Bridge authentication failed."""


class BridgeReadOnlyError(BridgeClientError):
    """Write command blocked by the HA integration control mode."""


class SmartThingsWebBridgeClient:
    """Client for the local Bridge HTTP/SSE API."""

    def __init__(self, session: ClientSession, base_url: str, token: str | None = None) -> None:
        try:
            url = URL(base_url)
        except (TypeError, ValueError) as err:
            raise BridgeClientError("invalid_bridge_url") from err
        if (
            url.scheme not in {"http", "https"}
            or not url.host
            or url.user
            or url.password
            or url.query_string
            or url.fragment
            or url.path not in {"", "/"}
            or not _is_local_bridge_host(url.host)
        ):
            raise BridgeClientError("invalid_bridge_url")
        self._session = session
        self._base_url = str(url.with_path("").with_query(None).with_fragment(None)).rstrip("/")
        self._token = token

    async def async_pair(self, code: str) -> str:
        """Exchange an Ingress pairing code for the local Bridge token."""
        data = await self._request_json("POST", "/api/v1/pair", json_body={"code": code})
        token = data.get("token")
        if not isinstance(token, str) or len(token) < 32:
            raise BridgeAuthError("invalid_pairing_code")
        self._token = token
        return token

    async def async_get_inventory(self) -> BridgeInventory:
        """Fetch the current full inventory."""
        return parse_inventory(await self._request_json("GET", "/api/v1/inventory", auth=True))

    async def async_get_health(self) -> dict[str, Any]:
        """Fetch non-secret Bridge health metadata for repairs/diagnostics."""
        return await self._request_json("GET", "/health/details")

    async def async_execute_switch(
        self,
        device_id: str,
        component: str,
        capability: str,
        command: str,
    ) -> BridgeCommandResult:
        """Execute one safe switch command and require authoritative confirmation."""
        return await self.async_execute_command(
            target_type="device",
            target_id=device_id,
            component=component,
            capability=capability,
            command=command,
            arguments=[],
        )

    async def async_execute_command(
        self,
        *,
        target_type: str,
        target_id: str,
        command: str,
        component: str | None = None,
        capability: str | None = None,
        attribute: str | None = None,
        control_id: str | None = None,
        control_label: str | None = None,
        arguments: list[Any] | None = None,
    ) -> BridgeCommandResult:
        """Execute one generic command and require authoritative Bridge confirmation."""
        client_request_id = f"ha_{uuid4().hex}"
        body: dict[str, Any] = {
            "targetType": target_type,
            "targetId": target_id,
            "command": command,
            "arguments": arguments or [],
            "clientRequestId": client_request_id,
        }
        if component is not None:
            body["component"] = component
        if capability is not None:
            body["capability"] = capability
        if attribute is not None:
            body["attribute"] = attribute
        if control_id is not None:
            body["controlId"] = control_id
        if control_label is not None:
            body["controlLabel"] = control_label
        raw = await self._request_json(
            "POST",
            "/api/v1/commands",
            auth=True,
            json_body=body,
            timeout_seconds=90,
        )
        result = parse_command_result(raw, client_request_id, target_type)
        if result is None:
            raise BridgeClientError("bridge_command_unconfirmed")
        return result

    async def async_get_image(self, device_id: str) -> tuple[bytes, str | None]:
        """Fetch one authenticated camera still through the local Bridge."""
        if self._token is None:
            raise BridgeAuthError("missing_bridge_token")
        try:
            async with self._session.get(
                f"{self._base_url}/api/v1/images/{device_id}",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=ClientTimeout(total=30),
            ) as response:
                if response.status in {401, 403}:
                    raise BridgeAuthError("bridge_auth_failed")
                if response.status >= 400:
                    raise BridgeClientError("bridge_request_failed")
                return await response.read(), response.headers.get("Content-Type")
        except BridgeClientError:
            raise
        except (ClientError, TimeoutError) as err:
            raise BridgeClientError("bridge_request_failed") from err

    async def async_events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield local push events without polling SmartThings."""
        if self._token is None:
            raise BridgeAuthError("missing_bridge_token")
        try:
            async with self._session.get(
                f"{self._base_url}/api/v1/events",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=ClientTimeout(total=None, connect=15, sock_read=90),
            ) as response:
                if response.status in {401, 403}:
                    raise BridgeAuthError("bridge_auth_failed")
                if response.status != 200:
                    raise BridgeClientError("bridge_event_stream_failed")
                async for raw_line in response.content:
                    line = raw_line.decode("utf-8", errors="strict").strip()
                    if not line.startswith("data: "):
                        continue
                    value = json.loads(line[6:])
                    if isinstance(value, dict):
                        yield value
        except (ClientError, TimeoutError, UnicodeError, json.JSONDecodeError) as err:
            raise BridgeClientError("bridge_event_stream_failed") from err

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        auth: bool = False,
        json_body: dict[str, Any] | None = None,
        timeout_seconds: int = 20,
    ) -> dict[str, Any]:
        headers: dict[str, str] = {}
        if auth:
            if self._token is None:
                raise BridgeAuthError("missing_bridge_token")
            headers["Authorization"] = f"Bearer {self._token}"
        try:
            async with self._session.request(
                method,
                f"{self._base_url}{path}",
                headers=headers,
                json=json_body,
                timeout=ClientTimeout(total=timeout_seconds),
            ) as response:
                if response.status in {401, 403}:
                    raise BridgeAuthError("bridge_auth_failed")
                if response.status >= 400:
                    raise BridgeClientError("bridge_request_failed")
                value = await response.json(content_type="application/json")
                if not isinstance(value, dict):
                    raise BridgeClientError("bridge_response_invalid")
                return value
        except BridgeClientError:
            raise
        except (ClientError, TimeoutError, ValueError) as err:
            raise BridgeClientError("bridge_request_failed") from err


def _is_local_bridge_host(host: str) -> bool:
    """Allow only loopback/private addresses and local DNS names."""
    normalized = host.rstrip(".").lower()
    if not normalized:
        return False
    try:
        address = ip_address(normalized)
    except ValueError:
        labels = normalized.split(".")
        if not all(_LOCAL_DNS_LABEL.fullmatch(label) for label in labels):
            return False
        return (
            len(labels) == 1
            or normalized == "localhost"
            or normalized.endswith(_LOCAL_DNS_SUFFIXES)
        )
    return (
        not address.is_unspecified
        and not address.is_multicast
        and (address.is_loopback or address.is_private or address.is_link_local)
    )


class ReadOnlyBridgeClient:
    """Proxy the Bridge client while blocking every write-capable command."""

    def __init__(self, client: SmartThingsWebBridgeClient) -> None:
        self._client = client

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    async def async_execute_switch(
        self,
        device_id: str,
        component: str,
        capability: str,
        command: str,
    ) -> BridgeCommandResult:
        """Block switch commands when the entry is read-only."""
        raise BridgeReadOnlyError("smartthings_web_read_only")

    async def async_execute_command(
        self,
        *,
        target_type: str,
        target_id: str,
        command: str,
        component: str | None = None,
        capability: str | None = None,
        attribute: str | None = None,
        control_id: str | None = None,
        control_label: str | None = None,
        arguments: list[Any] | None = None,
    ) -> BridgeCommandResult:
        """Block generic commands when the entry is read-only."""
        raise BridgeReadOnlyError("smartthings_web_read_only")


def parse_inventory(raw: dict[str, Any]) -> BridgeInventory:
    """Validate the Bridge inventory response."""
    if raw.get("schemaVersion") != 1 or not isinstance(raw.get("devices"), list):
        raise BridgeClientError("bridge_response_invalid")
    locations = {}
    for item in raw.get("locations", []):
        parsed = parse_location(item)
        if parsed is not None:
            locations[parsed.location_id] = parsed
    rooms = {
        item["id"]: (item["locationId"], item["name"])
        for item in raw.get("rooms", [])
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and isinstance(item.get("locationId"), str)
        and isinstance(item.get("name"), str)
    }
    devices: dict[str, BridgeDevice] = {}
    for item in raw["devices"]:
        if not isinstance(item, dict):
            continue
        device_id = item.get("id")
        location_id = item.get("locationId")
        name = item.get("name")
        if not all(isinstance(value, str) and value for value in (device_id, location_id, name)):
            continue
        states = {}
        for state_raw in item.get("states", []):
            if isinstance(state_raw, dict) and (state := parse_state(state_raw)) is not None:
                states[state.key] = state
        controls = {}
        for control_raw in item.get("controls", []):
            control = parse_control(control_raw)
            if control is not None and control.kind != "value":
                controls[control.control_id] = control
        room_id = item.get("roomId")
        device_type = item.get("type")
        devices[device_id] = BridgeDevice(
            device_id=device_id,
            location_id=location_id,
            room_id=room_id if isinstance(room_id, str) else None,
            name=name,
            device_type=device_type if isinstance(device_type, str) else None,
            online=item.get("online") is True,
            states=states,
            controls=controls,
        )
    scenes = {}
    for item in raw.get("scenes", []):
        parsed_scene = parse_scene(item)
        if parsed_scene is not None:
            scenes[parsed_scene.scene_id] = parsed_scene
    sequence = raw.get("sequence")
    bridge_version = raw.get("bridgeVersion")
    protocol_version = raw.get("protocolVersion")
    return BridgeInventory(
        sequence=sequence if isinstance(sequence, int) else 0,
        ready=raw.get("ready") is True,
        bridge_version=bridge_version if isinstance(bridge_version, str) else "unknown",
        protocol_version=protocol_version if isinstance(protocol_version, str) else "unknown",
        locations=locations,
        rooms=rooms,
        devices=devices,
        scenes=scenes,
    )
