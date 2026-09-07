"""Bounded, flat numeric color schemas; never accept arbitrary object constraints."""
from __future__ import annotations

from math import isfinite
from typing import Any


def parse_color_schema(raw: Any) -> dict[str, Any] | None:
    """Validate the public two-number setColor schema, including every constraint."""
    if (not isinstance(raw, dict) or raw.get("type") != "object"
            or not set(raw).issubset({"type", "properties", "required", "additionalProperties"})
            or raw.get("additionalProperties") is not False
            or not isinstance(raw.get("required"), list)
            or len(raw["required"]) != 2
            or any(not isinstance(key, str) for key in raw["required"])
            or set(raw["required"]) != {"hue", "saturation"}):
        return None
    properties = raw.get("properties")
    if not isinstance(properties, dict) or set(properties) != {"hue", "saturation"}:
        return None
    result = {}
    for name, schema in properties.items():
        if (not isinstance(schema, dict) or set(schema) != {"type", "minimum", "maximum"}
                or schema["type"] not in {"integer", "number"}):
            return None
        low, high = schema["minimum"], schema["maximum"]
        if (type(low) not in (int, float) or type(high) not in (int, float)
                or not isfinite(low) or not isfinite(high) or not 0 <= low < high <= 100):
            return None
        result[name] = dict(schema)
    return {"type": "object", "properties": result,
            "required": ["hue", "saturation"], "additionalProperties": False}
