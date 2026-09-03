"""Local SmartThings Web Bridge client."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from ipaddress import ip_address
import json
from math import isfinite
import re
from typing import Any
from uuid import uuid4

from aiohttp import ClientError, ClientSession, ClientTimeout
from yarl import URL

from .const import normalize_bridge_url
from .device_identity import canonicalize_duplicate_devices
from .models import (
    BridgeAdvancedDeviceMetadata,
    BridgeCommandArgument,
    BridgeCommandDescriptor,
    BridgeCommandOmission,
    BridgeCommandResult,
    BridgeDevice,
    BridgeInventory,
    parse_control,
    parse_device_presentation,
    parse_location,
    parse_command_result,
    parse_scene,
    parse_state,
)


_LOCAL_DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_LOCAL_DNS_SUFFIXES = (".local", ".home.arpa")
_DEVICE_ALIAS = re.compile(r"^dev_[A-Za-z0-9]{3,64}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_RAW_OR_SECRET = re.compile(
    r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|raw|uuid|secret|token)",
    re.IGNORECASE,
)
_MAX_COMMANDS = 256
_MAX_ARGUMENTS = 16
_MAX_ENUM_VALUES = 128
_MAX_OMISSION_COUNT = 512
_MAX_SCHEMA_DEPTH = 32
_MAX_SCHEMA_NODES = 512
_MAX_SCHEMA_BYTES = 8192
_MAX_ENUM_STRING_LENGTH = 1024
_MAX_STRING_LENGTH = 2048
_CATALOG_KEYS = {"schemaVersion", "deviceId", "commands", "omissions"}
_COMMAND_DESCRIPTOR_KEYS = {
    "component",
    "componentRole",
    "capability",
    "capabilityRole",
    "capabilityVersion",
    "command",
    "arguments",
    "transport",
    "confirmation",
    "label",
    "labelSource",
}
_COMMAND_ARGUMENT_KEYS = {"name", "required", "sensitive", "unit", "schema"}
_COMMAND_OMISSION_KEYS = {"component", "capability", "command", "reason"}
_COMMAND_SCHEMA_KEYS = {"type", "enum", "minimum", "maximum", "minLength", "maxLength"}
_COMMAND_OMISSION_REASONS = {
    "definition_unavailable",
    "dangerous_command",
    "sensitive_argument",
    "schema_invalid",
}
_SAFE_COMMAND_CAPABILITY_ROLES = {"speechsynthesis"}
_SAFE_BRIDGE_ERROR_CODES = {
    "bridge_api_unavailable",
    "bridge_auth_failed",
    "bridge_command_unconfirmed",
    "bridge_event_stream_failed",
    "bridge_not_connected",
    "bridge_request_failed",
    "bridge_response_invalid",
    "camera_image_not_found",
    "camera_image_unavailable",
    "capability_not_found",
    "client_request_conflict",
    "command_api_unavailable",
    "command_browser_unavailable",
    "command_confirmation_timeout",
    "command_control_ambiguous",
    "command_control_not_found",
    "component_command_partial_failure",
    "component_command_rollback_failed",
    "command_execution_failed",
    "command_location_change_failed",
    "command_location_mismatch",
    "command_location_picker_not_found",
    "command_location_target_not_found",
    "command_location_unknown",
    "command_login_required",
    "command_room_not_found",
    "command_search_ambiguous",
    "command_search_not_found",
    "command_target_ambiguous",
    "command_target_not_found",
    "content_type_unsupported",
    "device_not_found",
    "device_offline",
    "ingress_required",
    "internal_error",
    "invalid_arguments",
    "invalid_body",
    "invalid_capability",
    "invalid_client_request_id",
    "invalid_component",
    "invalid_control_id",
    "invalid_control_label",
    "invalid_device_id",
    "invalid_pairing_code",
    "method_not_allowed",
    "not_found",
    "unauthorized",
    "unknown_key",
    "unsupported_command",
}


class BridgeClientError(Exception):
    """Bridge communication failed."""


class BridgeAuthError(BridgeClientError):
    """Bridge authentication failed."""


class BridgeReadOnlyError(BridgeClientError):
    """Write command blocked by the HA integration control mode."""


@dataclass(frozen=True)
class BridgeCommandCatalog:
    """Validated safe command catalog for one Bridge device alias."""

    device_id: str
    commands: tuple[BridgeCommandDescriptor, ...]
    omissions: dict[str, int]


def bridge_error_message(action: str, error: BridgeClientError) -> str:
    """Return an actionable command error without exposing arbitrary details."""
    raw_code = str(error)
    code = (
        raw_code
        if raw_code in _SAFE_BRIDGE_ERROR_CODES or raw_code == "smartthings_web_read_only"
        else "bridge_request_failed"
    )
    return f"SmartThings Web {action} failed: {code}"


class SmartThingsWebBridgeClient:
    """Client for the local Bridge HTTP/SSE API."""

    def __init__(self, session: ClientSession, base_url: str, token: str | None = None) -> None:
        try:
            url = URL(normalize_bridge_url(base_url))
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

    @property
    def base_url(self) -> str:
        """Return the validated canonical Bridge base URL."""
        return self._base_url

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

    async def async_list_commands(self, device_id: str) -> BridgeCommandCatalog:
        """Fetch the safe Advanced command catalog for one device alias."""
        if not _DEVICE_ALIAS.fullmatch(device_id):
            raise BridgeClientError("invalid_device_id")
        return parse_command_catalog(
            await self._request_json(
                "GET", f"/api/v1/commands/catalog?deviceId={device_id}", auth=True
            ),
            device_id,
        )

    async def async_get_health(self) -> dict[str, Any]:
        """Fetch non-secret Bridge health metadata for repairs/diagnostics."""
        return await self._request_json("GET", "/health/details")

    async def async_reload_inventory(self) -> None:
        """Request one coalesced Advanced inventory reconciliation."""
        await self._async_maintenance("/api/v1/maintenance/reload-inventory")

    async def async_reconnect_realtime(self) -> None:
        """Request a bounded Location realtime reconnect."""
        await self._async_maintenance("/api/v1/maintenance/reconnect-realtime")

    async def _async_maintenance(self, path: str) -> None:
        raw = await self._request_json("POST", path, auth=True, timeout_seconds=30)
        if raw.get("accepted") is not True:
            raise BridgeClientError("bridge_response_invalid")

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
        require_advanced: bool | None = None,
        confirm: bool | None = None,
        timeout: int | None = None,
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
        if require_advanced is not None:
            body["requireAdvanced"] = require_advanced
        if confirm is not None:
            body["confirm"] = confirm
        if timeout is not None:
            if isinstance(timeout, bool) or timeout < 1 or timeout > 120:
                raise BridgeClientError("invalid_arguments")
            body["timeout"] = timeout
        raw = await self._request_json(
            "POST",
            "/api/v1/commands",
            auth=True,
            json_body=body,
            timeout_seconds=90 if timeout is None else timeout + 10,
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
                    raise BridgeClientError(await _safe_bridge_error_code(response))
                value = await response.json(content_type="application/json")
                if not isinstance(value, dict):
                    raise BridgeClientError("bridge_response_invalid")
                return value
        except BridgeClientError:
            raise
        except (ClientError, TimeoutError, ValueError) as err:
            raise BridgeClientError("bridge_request_failed") from err


async def _safe_bridge_error_code(response: Any) -> str:
    """Return only fixed Bridge error tokens from non-2xx JSON bodies."""
    try:
        value = await response.json(content_type="application/json")
    except (ClientError, TimeoutError, ValueError, TypeError):
        return "bridge_request_failed"
    if not isinstance(value, dict):
        return "bridge_request_failed"
    error = value.get("error")
    if isinstance(error, str) and error in _SAFE_BRIDGE_ERROR_CODES:
        return error
    return "bridge_request_failed"


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

    async def async_list_commands(self, device_id: str) -> BridgeCommandCatalog:
        """Allow read-only config entries to inspect the safe command catalog."""
        return await self._client.async_list_commands(device_id)

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
        require_advanced: bool | None = None,
        confirm: bool | None = None,
        timeout: int | None = None,
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
        presentation = parse_device_presentation(item.get("presentation"))
        advanced = _parse_advanced_metadata(item.get("advanced"))
        health_updated_at = item.get("healthUpdatedAt")
        commands = _parse_command_descriptors(item.get("advancedCommands"), strict=False)
        command_omissions = _parse_command_omission_records(
            item.get("commandOmissions"), strict=False
        )
        devices[device_id] = BridgeDevice(
            device_id=device_id,
            location_id=location_id,
            room_id=room_id if isinstance(room_id, str) else None,
            name=name,
            device_type=device_type if isinstance(device_type, str) else None,
            online=item.get("online") is True,
            presentation=presentation,
            states=states,
            controls=controls,
            commands=commands,
            command_omissions=command_omissions,
            advanced=advanced,
            health_updated_at=(
                health_updated_at
                if isinstance(health_updated_at, str)
                and 0 < len(health_updated_at) <= 64
                else None
            ),
        )
    canonical = canonicalize_duplicate_devices(devices)
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
        devices=canonical.devices,
        scenes=scenes,
        device_aliases=canonical.aliases,
    )


def parse_command_catalog(raw: dict[str, Any], device_id: str) -> BridgeCommandCatalog:
    """Validate a bounded safe command catalog response for one alias device."""
    if not _DEVICE_ALIAS.fullmatch(device_id):
        raise BridgeClientError("invalid_device_id")
    if (
        set(raw) != _CATALOG_KEYS
        or raw.get("schemaVersion") != 1
        or raw.get("deviceId") != device_id
        or not isinstance(raw.get("commands"), list)
        or len(raw["commands"]) > _MAX_COMMANDS
    ):
        raise BridgeClientError("bridge_response_invalid")
    omissions = _parse_command_omissions(raw.get("omissions"), strict=True)
    if omissions is None:
        raise BridgeClientError("bridge_response_invalid")
    return BridgeCommandCatalog(
        device_id=device_id,
        commands=_parse_command_descriptors(raw["commands"], strict=True),
        omissions=omissions,
    )


def _parse_command_descriptors(
    raw: Any, *, strict: bool
) -> tuple[BridgeCommandDescriptor, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > _MAX_COMMANDS:
        if strict:
            raise BridgeClientError("bridge_response_invalid")
        return ()
    descriptors: list[BridgeCommandDescriptor] = []
    seen: set[tuple[str, str, str, str]] = set()
    for item in raw:
        descriptor = _parse_command_descriptor(item)
        if descriptor is None:
            if strict:
                raise BridgeClientError("bridge_response_invalid")
            continue
        key = (
            descriptor.component,
            descriptor.capability,
            descriptor.command,
            json.dumps(
                [argument.schema for argument in descriptor.arguments],
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        if key in seen:
            if strict:
                raise BridgeClientError("bridge_response_invalid")
            continue
        seen.add(key)
        descriptors.append(descriptor)
    return tuple(
        sorted(
            descriptors,
            key=lambda item: (item.component, item.capability, item.command, item.label),
        )
    )


def _parse_command_descriptor(raw: Any) -> BridgeCommandDescriptor | None:
    if not isinstance(raw, dict):
        return None
    if not set(raw).issubset(_COMMAND_DESCRIPTOR_KEYS):
        return None
    component = _safe_command_token(raw.get("component"), allow_public=True)
    component_role = _safe_command_role(raw.get("componentRole"))
    capability = _safe_command_token(raw.get("capability"), allow_public=True)
    capability_role = _safe_command_capability_role(raw.get("capabilityRole"))
    capability_version = raw.get("capabilityVersion")
    command = _safe_command_token(raw.get("command"), allow_public=True)
    label = _safe_display(raw.get("label"))
    label_source = raw.get("labelSource")
    if (
        component is None
        or (raw.get("componentRole") is not None and component_role is None)
        or capability is None
        or (raw.get("capabilityRole") is not None and capability_role is None)
        or command is None
        or isinstance(capability_version, bool)
        or not isinstance(capability_version, int)
        or capability_version < 0
        or capability_version > 10_000
        or raw.get("transport") != "advanced"
        or raw.get("confirmation") not in {"accepted_receipt", "state"}
        or label is None
        or label_source not in {"visible_web", "capability", "role", "fallback"}
    ):
        return None
    arguments = _parse_command_arguments(raw.get("arguments"))
    if arguments is None:
        return None
    return BridgeCommandDescriptor(
        component=component,
        component_role=component_role,
        capability=capability,
        capability_role=capability_role,
        capability_version=capability_version,
        command=command,
        arguments=arguments,
        transport="advanced",
        confirmation=raw["confirmation"],
        label=label,
        label_source=label_source,
    )


def _parse_command_arguments(raw: Any) -> tuple[BridgeCommandArgument, ...] | None:
    if not isinstance(raw, list) or len(raw) > _MAX_ARGUMENTS:
        return None
    arguments: list[BridgeCommandArgument] = []
    names: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            return None
        if not set(item).issubset(_COMMAND_ARGUMENT_KEYS):
            return None
        name = _safe_command_token(item.get("name"), allow_public=True)
        schema = _safe_command_schema(item.get("schema"))
        unit = item.get("unit")
        if (
            name is None
            or name in names
            or not isinstance(item.get("required"), bool)
            or not isinstance(item.get("sensitive"), bool)
            or item["sensitive"] is True
            or schema is None
            or (unit is not None and (not isinstance(unit, str) or len(unit) > 64))
        ):
            return None
        names.add(name)
        arguments.append(
            BridgeCommandArgument(
                name=name,
                required=item["required"],
                sensitive=False,
                unit=unit if isinstance(unit, str) and unit else None,
                schema=schema,
            )
        )
    return tuple(arguments)


def _safe_command_schema(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    try:
        if len(json.dumps(raw, sort_keys=True, separators=(",", ":"))) > _MAX_SCHEMA_BYTES:
            return None
    except (TypeError, ValueError):
        return None
    schema = _clone_schema(raw, depth=0, nodes=[0])
    if schema is None:
        return None
    schema_type = schema.get("type")
    if schema_type is not None and schema_type not in {
        "array",
        "boolean",
        "integer",
        "number",
        "object",
        "string",
    }:
        return None
    minimum = schema.get("minimum")
    maximum = schema.get("maximum")
    min_length = schema.get("minLength")
    max_length = schema.get("maxLength")
    if (
        (minimum is not None and (not isinstance(minimum, (int, float)) or isinstance(minimum, bool)))
        or (maximum is not None and (not isinstance(maximum, (int, float)) or isinstance(maximum, bool)))
        or (min_length is not None and not _safe_string_length_bound(min_length))
        or (max_length is not None and not _safe_string_length_bound(max_length))
        or (
            isinstance(minimum, (int, float))
            and not isinstance(minimum, bool)
            and isinstance(maximum, (int, float))
            and not isinstance(maximum, bool)
            and minimum > maximum
        )
        or (
            isinstance(min_length, int)
            and not isinstance(min_length, bool)
            and isinstance(max_length, int)
            and not isinstance(max_length, bool)
            and min_length > max_length
        )
    ):
        return None
    if "enum" in schema:
        enum_values = _safe_enum_values(schema.get("enum"))
        if enum_values is None:
            return None
        schema["enum"] = enum_values
    return schema


def _safe_string_length_bound(raw: Any) -> bool:
    return isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw <= _MAX_STRING_LENGTH


def _safe_enum_values(raw: Any) -> list[Any] | None:
    if not isinstance(raw, list) or len(raw) > _MAX_ENUM_VALUES:
        return None
    values: list[Any] = []
    for item in raw:
        if item is None or isinstance(item, bool):
            values.append(item)
        elif isinstance(item, (int, float)) and not isinstance(item, bool) and isfinite(item):
            values.append(item)
        elif (
            isinstance(item, str)
            and len(item) <= _MAX_ENUM_STRING_LENGTH
            and not re.search(r"[\u0000-\u001f\u007f]", item)
        ):
            values.append(item)
        else:
            return None
    return values


def _parse_command_omissions(raw: Any, *, strict: bool) -> dict[str, int] | None:
    if raw is None:
        return {}
    if strict and not isinstance(raw, dict):
        return None
    if isinstance(raw, dict):
        counts: dict[str, int] = {}
        for reason, count in raw.items():
            if (
                reason not in _COMMAND_OMISSION_REASONS
                or isinstance(count, bool)
                or not isinstance(count, int)
                or count < 0
                or count > _MAX_OMISSION_COUNT
            ):
                return None
            if count:
                counts[reason] = count
        return counts
    if not isinstance(raw, list) or len(raw) > _MAX_OMISSION_COUNT:
        return None if strict else {}
    counts: dict[str, int] = {}
    seen: set[tuple[str, str, str | None, str]] = set()
    for item in raw:
        parsed = _parse_command_omission(item)
        if parsed is None:
            if strict:
                return None
            continue
        key = (
            parsed["component"],
            parsed["capability"],
            parsed.get("command"),
            parsed["reason"],
        )
        if key in seen:
            if strict:
                return None
            continue
        seen.add(key)
        reason = parsed["reason"]
        counts[reason] = counts.get(reason, 0) + 1
        if counts[reason] > _MAX_OMISSION_COUNT:
            return None
    return counts


def _parse_command_omission_records(
    raw: Any, *, strict: bool
) -> tuple[BridgeCommandOmission, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or len(raw) > _MAX_OMISSION_COUNT:
        return ()
    omissions: list[BridgeCommandOmission] = []
    seen: set[tuple[str, str, str | None, str]] = set()
    for item in raw:
        parsed = _parse_command_omission(item)
        if parsed is None:
            if strict:
                return ()
            continue
        key = (
            parsed["component"],
            parsed["capability"],
            parsed.get("command"),
            parsed["reason"],
        )
        if key in seen:
            if strict:
                return ()
            continue
        seen.add(key)
        omissions.append(
            BridgeCommandOmission(
                component=parsed["component"],
                capability=parsed["capability"],
                command=parsed.get("command"),
                reason=parsed["reason"],
            )
        )
    return tuple(
        sorted(
            omissions,
            key=lambda item: (
                item.component,
                item.capability,
                item.command or "",
                item.reason,
            ),
        )
    )


def _parse_command_omission(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    if not set(raw).issubset(_COMMAND_OMISSION_KEYS):
        return None
    component = _safe_command_token(raw.get("component"), allow_public=True)
    capability = _safe_command_token(raw.get("capability"), allow_public=True)
    command = (
        _safe_command_token(raw.get("command"), allow_public=True)
        if raw.get("command") is not None
        else None
    )
    reason = raw.get("reason")
    if (
        component is None
        or capability is None
        or (raw.get("command") is not None and command is None)
        or reason not in _COMMAND_OMISSION_REASONS
    ):
        return None
    return {
        "component": component,
        "capability": capability,
        **({"command": command} if command is not None else {}),
        "reason": reason,
    }


def _safe_command_token(raw: Any, *, allow_public: bool) -> str | None:
    if not isinstance(raw, str) or not _TOKEN.fullmatch(raw) or _RAW_OR_SECRET.search(raw):
        return None
    if raw.startswith("identifier_") or allow_public:
        return raw
    return None


def _safe_command_role(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if (
        not text
        or len(text) > 80
        or text.startswith("identifier_")
        or _RAW_OR_SECRET.search(text)
        or not re.fullmatch(r"[A-Za-z0-9가-힣 ._-]+", text)
    ):
        return None
    return text


def _safe_command_capability_role(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        return None
    text = raw.strip().lower()
    return text if text in _SAFE_COMMAND_CAPABILITY_ROLES else None


def _safe_display(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if (
        not text
        or len(text) > 255
        or "[REDACTED]" in text
        or re.search(r"[\u0000-\u001f\u007f]", text)
        or re.search(r"\b(?:https?|wss?)://", text, re.IGNORECASE)
    ):
        return None
    return text


def _clone_schema(raw: Any, *, depth: int, nodes: list[int]) -> Any:
    nodes[0] += 1
    if depth > _MAX_SCHEMA_DEPTH or nodes[0] > _MAX_SCHEMA_NODES:
        return None
    if raw is None or isinstance(raw, str):
        return raw
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return raw if not isinstance(raw, bool) and isfinite(raw) else None
    if isinstance(raw, list):
        if len(raw) > _MAX_ENUM_VALUES:
            return None
        items = []
        for item in raw:
            cloned = _clone_schema(item, depth=depth + 1, nodes=nodes)
            if cloned is None and item is not None:
                return None
            items.append(cloned)
        return items
    if isinstance(raw, dict):
        if not set(raw).issubset(_COMMAND_SCHEMA_KEYS):
            return None
        result: dict[str, Any] = {}
        for key, value in raw.items():
            cloned = _clone_schema(value, depth=depth + 1, nodes=nodes)
            if cloned is None and value is not None:
                return None
            result[key] = cloned
        return result
    return None


def _parse_advanced_metadata(raw: Any) -> BridgeAdvancedDeviceMetadata | None:
    """Parse only the redacted identity fields needed for safe canonicalization."""
    if not isinstance(raw, dict):
        return None
    owner_id = _safe_alias(raw.get("ownerId"), "identifier_")
    parent_device_id = _safe_alias(raw.get("parentDeviceId"), "dev_")
    execution_context = raw.get("executionContext")
    if execution_context not in {"CLOUD", "LOCAL"}:
        execution_context = None
    if owner_id is None and parent_device_id is None and execution_context is None:
        return None
    return BridgeAdvancedDeviceMetadata(
        owner_id=owner_id,
        parent_device_id=parent_device_id,
        execution_context=execution_context,
    )


def _safe_alias(value: Any, prefix: str) -> str | None:
    if (
        isinstance(value, str)
        and value.startswith(prefix)
        and 1 <= len(value) <= 256
        and re.fullmatch(r"[A-Za-z0-9_.:-]+", value)
    ):
        return value
    return None
