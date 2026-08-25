"""Tests for the local Bridge HTTP client."""

from __future__ import annotations

from pathlib import Path
import sys
from types import ModuleType
from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
package = ModuleType("smartthings_web")
package.__path__ = [str(PACKAGE_ROOT)]  # type: ignore[attr-defined]
sys.modules.setdefault("smartthings_web", package)

from smartthings_web.bridge_client import SmartThingsWebBridgeClient  # noqa: E402


class BridgeCommandTimeoutTests(IsolatedAsyncioTestCase):
    """Keep HA's request open through browser actuation and push confirmation."""

    async def test_switch_command_uses_extended_request_timeout(self) -> None:
        client = SmartThingsWebBridgeClient(object(), "http://bridge.local", "x" * 32)  # type: ignore[arg-type]

        async def confirmed(_method: str, _path: str, **kwargs: Any) -> dict[str, Any]:
            request_id = kwargs["json_body"]["clientRequestId"]
            return {
                "schemaVersion": 1,
                "status": "confirmed",
                "clientRequestId": request_id,
                "sequence": 42,
                "transport": "smartthings_web_ui",
                "confirmation": "device_event",
            }

        request = AsyncMock(side_effect=confirmed)
        client._request_json = request  # type: ignore[method-assign]

        await client.async_execute_switch("dev_001", "main", "switch", "on")

        self.assertEqual(request.await_args.kwargs["timeout_seconds"], 90)
