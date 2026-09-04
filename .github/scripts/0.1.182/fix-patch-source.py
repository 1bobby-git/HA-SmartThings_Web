from pathlib import Path

path = Path("/tmp/apply-0.1.182.py")
text = path.read_text(encoding="utf-8")

replacements = (
    (
        '''        """    image_listeners: set[Callable[[], None]] = field(default_factory=set)
    latest_images: dict[str, BridgeImageUpdate] = field(default_factory=dict)
""",
        """    image_listeners: set[Callable[[], None]] = field(default_factory=set)
    latest_images: dict[str, BridgeImageUpdate] = field(default_factory=dict)
    listener_coalesce_ms: int = 0
''',
        '''        """    image_updates: dict[str, BridgeImageUpdate] = field(default_factory=dict)
""",
        """    image_updates: dict[str, BridgeImageUpdate] = field(default_factory=dict)
    listener_coalesce_ms: int = 0
''',
        "runtime field marker",
    ),
    (
        '''        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to inventory changes.\\\"\\\"\\\"
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)
""",
        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to inventory changes.\\\"\\\"\\\"
''',
        '''        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to state changes.\\\"\\\"\\\"
        self.listeners.add(listener)
        return lambda: self.listeners.discard(listener)
""",
        """    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        \\\"\\\"\\\"Subscribe to state changes.\\\"\\\"\\\"
''',
        "subscribe marker",
    ),
    (
        '''        """    main_power_states = [
        candidate
        for candidate in safe_switch_states
        if _main_power_switch_state(device, candidate)
    ]
    return len(main_power_states) == 1 and main_power_states[0].key == state.key
""",
        """    main_power_states = [
        candidate
        for candidate in safe_switch_states
        if _main_power_switch_state(device, candidate)
    ]
''',
        '''        """    main_power_states = [
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
''',
        "primary switch marker",
    ),
)

for old_head, new_head, old_tail, new_tail, label in replacements:
    if text.count(old_head) != 1 or text.count(old_tail) != 1:
        raise SystemExit(f"{label}: source patch marker mismatch")
    text = text.replace(old_head, new_head, 1).replace(old_tail, new_tail, 1)

path.write_text(text, encoding="utf-8")
