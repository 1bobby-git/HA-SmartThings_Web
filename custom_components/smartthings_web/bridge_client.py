"""Local SmartThings Web Bridge client."""

from __future__ import annotations

from collections.abc import AsyncIterator
import json
from typing import Any
from uuid import uuid4

from aiohttp import ClientError, ClientSession, ClientTimeout
from yarl import URL

from .models import (
    BridgeCommandResult,
    BridgeDevice,
    BridgeInventory,
    parse_command_result,
    parse_state,
)


class BridgeClientError(Exception):
    """Bridge communication failed."""


class BridgeAuthError(BridgeClientError):
    """Bridge authentication failed."""


class SmartThingsWebBridgeClient:
    """Client for the local Bridge HTTP/SSE API."""

    def __init__(self, session: ClientSession, base_url: str, token: str | None = None) -> None:
        url = URL(base_url)
        if url.scheme not in {"http", "https"} or not url.host or url.user or url.query_string:
            raise BridgeClientError("invalid_bridge_url")
        self._session = session
        self._base_url = str(url.with_path("").with_query(None)).rstrip("/")
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

    async def async_execute_switch(
        self,
        device_id: str,
        component: str,
        capability: str,
        command: str,
    ) -> BridgeCommandResult:
        """Execute one safe switch command and require authoritative confirmation."""
        client_request_id = f"ha_{uuid4().hex}"
        raw = await self._request_json(
            "POST",
            "/api/v1/commands",
            auth=True,
            json_body={
                "deviceId": device_id,
                "component": component,
                "capability": capability,
                "command": command,
                "arguments": [],
                "clientRequestId": client_request_id,
            },
        )
        result = parse_command_result(raw, client_request_id)
        if result is None:
            raise BridgeClientError("bridge_command_unconfirmed")
        return result

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
                timeout=ClientTimeout(total=20),
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


def parse_inventory(raw: dict[str, Any]) -> BridgeInventory:
    """Validate the Bridge inventory response."""
    if raw.get("schemaVersion") != 1 or not isinstance(raw.get("devices"), list):
        raise BridgeClientError("bridge_response_invalid")
    locations = {
        item["id"]: item["name"]
        for item in raw.get("locations", [])
        if isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and isinstance(item.get("name"), str)
    }
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
        )
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
    )
