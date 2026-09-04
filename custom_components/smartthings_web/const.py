"""Constants for SmartThings Web."""

DOMAIN = "smartthings_web"
CONF_BRIDGE_URL = "bridge_url"
CONF_BRIDGE_TOKEN = "bridge_token"
CONF_CONTROL_MODE = "control_mode"
CONF_COMMAND_CONFIRMATION_TIMEOUT = "command_confirmation_timeout"
CONF_STATUS_RECHECK_ENABLED = "status_recheck_enabled"
CONF_INVENTORY_RECONCILIATION_INTERVAL = "inventory_reconciliation_interval"
CONF_DOM_FALLBACK_ENABLED = "dom_fallback_enabled"
CONF_DEBUG_PROTOCOL_LOGGING = "debug_protocol_logging"
CONF_LOCATION_ID = "location_id"
CONTROL_MODE_READ_ONLY = "read_only"
CONTROL_MODE_SAFE_CONTROL = "safe_control"
BRIDGE_ADDON_SLUG = "smartthings_web_bridge"
BRIDGE_INTERNAL_PORT = 8100
REPOSITORY_BRIDGE_URL = "http://8a97f131-smartthings-web-bridge:8100"
LOCAL_BRIDGE_URL = "http://local-smartthings-web-bridge:8100"
LEGACY_REPOSITORY_BRIDGE_URL = "http://d55cafb9-smartthings-web-bridge:8100"
KNOWN_BRIDGE_URLS = (
    REPOSITORY_BRIDGE_URL,
    LOCAL_BRIDGE_URL,
    LEGACY_REPOSITORY_BRIDGE_URL,
)
DEFAULT_BRIDGE_URL = REPOSITORY_BRIDGE_URL


def normalize_bridge_url(value: str) -> str:
    """Normalize a configured local Bridge URL without changing its hostname."""
    if not isinstance(value, str):
        raise ValueError("invalid_bridge_url")
    normalized = value.strip().rstrip("/")
    if not normalized:
        raise ValueError("invalid_bridge_url")
    known = {candidate.lower(): candidate for candidate in KNOWN_BRIDGE_URLS}
    return known.get(normalized.lower(), normalized)


def bridge_url_candidates(value: str) -> tuple[str, ...]:
    """Return current, local, and legacy Supervisor app URL candidates."""
    normalized = normalize_bridge_url(value)
    if normalized not in KNOWN_BRIDGE_URLS:
        return (normalized,)
    return (normalized,) + tuple(
        candidate for candidate in KNOWN_BRIDGE_URLS if candidate != normalized
    )


DEFAULT_COMMAND_CONFIRMATION_TIMEOUT = 30
DEFAULT_INVENTORY_RECONCILIATION_INTERVAL = 21600
REPAIR_SAMSUNG_LOGIN_REQUIRED = "samsung_login_required"
SERVICE_EXECUTE_COMMAND = "execute_command"
SERVICE_LIST_COMMANDS = "list_commands"
SERVICE_RELOAD_INVENTORY = "reload_inventory"
SERVICE_REFRESH_DEVICE = "refresh_device"
SERVICE_RECONNECT_REALTIME = "reconnect_realtime"
SERVICE_SPEAK = "speak"
