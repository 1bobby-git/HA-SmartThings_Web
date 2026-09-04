from pathlib import Path

path = Path("/tmp/apply-0.1.182.py")
text = path.read_text(encoding="utf-8")

start = text.index(
    '    text = replace_once(\n        text,\n        """    image_listeners:'
)
end = text.index(
    '    text = replace_once(\n        text,\n        """    def subscribe(',
    start,
)
field_call = '''    text = replace_once(
        text,
        """    image_updates: dict[str, BridgeImageUpdate] = field(default_factory=dict)
""",
        """    image_updates: dict[str, BridgeImageUpdate] = field(default_factory=dict)
    listener_coalesce_ms: int = 0
    _pending_listeners: set[Callable[[], None]] = field(
        default_factory=set, init=False, repr=False
    )
    _listener_flush_handle: Any = field(default=None, init=False, repr=False)
""",
        "listener coalescing fields",
    )
'''
text = text[:start] + field_call + text[end:]

start = text.index(
    '    text = replace_once(\n        text,\n        """    def subscribe('
)
end = text.index(
    '    text = replace_once(\n        text,\n        """        self._notify_listeners(',
    start,
)
subscribe_call = '''    text = replace_once(
        text,
        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to state changes.\\\"\\\"\\\"
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)
""",
        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to state changes.\\\"\\\"\\\"
        self.listeners.add(listener)

        def unsubscribe() -> None:
            self.listeners.discard(listener)
            self._pending_listeners.discard(listener)

        return unsubscribe
""",
        "global unsubscribe",
    )
'''
text = text[:start] + subscribe_call + text[end:]

start = text.index(
    '    text = replace_once(\n        text,\n        """    main_power_states = ['
)
end = text.index("    write(path, text)", start)
primary_call = '''    text = replace_once(
        text,
        """    main_power_states = [
        item
        for item in safe_switch_states
        if _main_power_switch_state(device, item, allow_identifier_component=True)
    ]
    return len(main_power_states) == 1 and main_power_states[0].key == state.key
""",
        """    main_power_states = [
        item
        for item in safe_switch_states
        if _main_power_switch_state(device, item, allow_identifier_component=True)
    ]
    if len(main_power_states) == 1:
        return main_power_states[0].key == state.key
    return len(safe_switch_states) == 1 and safe_switch_states[0].key == state.key
""",
        "single safe switch primary",
    )
'''
text = text[:start] + primary_call + text[end:]

old = '''        '    expect(changelog).toContain("## 0.1.181");',
        '    expect(changelog).toContain("## 0.1.182");\\n    expect(changelog).toContain("## 0.1.181");',
'''
new = '''        '    expect(changelog).toContain("## 0.1.182");',
        '    expect(changelog).toContain("## 0.1.182");\\n    expect(changelog).toContain("## 0.1.181");',
'''
if text.count(old) != 1:
    raise SystemExit(
        f"changelog assertion source marker: expected one, found {text.count(old)}"
    )
text = text.replace(old, new, 1)

path.write_text(text, encoding="utf-8")
