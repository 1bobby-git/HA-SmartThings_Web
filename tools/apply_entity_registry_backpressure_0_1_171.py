from __future__ import annotations

from pathlib import Path
from textwrap import dedent


def block(value: str) -> str:
    lines = dedent(value).strip("\n").splitlines()
    if any(not line.startswith("|") for line in lines):
        raise SystemExit("invalid block margin")
    return "\n".join(line[1:] for line in lines)


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


init_path = "custom_components/smartthings_web/__init__.py"

replace_once(
    init_path,
    block("""
    |    SmartThingsWebRuntime,
    |    button_controls,
    """),
    block("""
    |    SmartThingsWebRuntime,
    |    STATE_ROLE_DISPLAY_NAMES,
    |    button_controls,
    """),
)

replace_once(
    init_path,
    block("""
    |        delayed_handles.clear()
    |        schedule_migration()
    |        call_later = getattr(hass.loop, "call_later", None)
    |        if callable(call_later):
    |            for delay in (0.5, 2.0, 10.0, 30.0):
    |                handle = call_later(delay, schedule_migration)
    |                if handle is not None:
    |                    delayed_handles.append(handle)
    """),
    block("""
    |        delayed_handles.clear()
    |        # Run once after current platform-discovery callbacks and keep
    |        # one settled retry for restored-state reservations. Older
    |        # builds ran five passes per topology change and amplified
    |        # entity_registry_updated WebSocket traffic.
    |        schedule_migration()
    |        call_later = getattr(hass.loop, "call_later", None)
    |        if callable(call_later):
    |            handle = call_later(15.0, schedule_migration)
    |            if handle is not None:
    |                delayed_handles.append(handle)
    """),
)

replace_once(
    init_path,
    block("""
    |    if canonical_suggested_object_id is None:
    |        return
    |    get_or_create = getattr(registry, "async_get_or_create", None)
    """),
    block("""
    |    if canonical_suggested_object_id is None:
    |        return
    |    if (
    |        getattr(entity_entry, "object_id_base", None)
    |        == canonical_object_id_base
    |        and getattr(entity_entry, "suggested_object_id", None)
    |        == canonical_suggested_object_id
    |        and getattr(entity_entry, "has_entity_name", True) is True
    |    ):
    |        return
    |    get_or_create = getattr(registry, "async_get_or_create", None)
    """),
)

replace_once(
    init_path,
    block("""
    |    domain = getattr(entity_entry, "domain", "")
    |    domain_value = getattr(domain, "value", domain)
    |    name = (
    |        switch_name_overrides(device).get(getattr(state, "key", ()))
    |        if domain_value == "switch" and getattr(state, "attribute", None) == "switch"
    |        else None
    |    )
    |    if name is None:
    |        name = _generated_registry_state_name(entity_entry, device, state, inventory)
    |    if not name or getattr(entity_entry, "original_name", None) == name:
    |        return
    """),
    block("""
    |    domain = getattr(entity_entry, "domain", "")
    |    domain_value = getattr(domain, "value", domain)
    |    # Sensor and binary-sensor platform discovery owns translated
    |    # display names. Recomputing those labels from slug-oriented
    |    # restore metadata here caused both paths to alternate names and
    |    # flood Home Assistant clients with entity_registry_updated events.
    |    # Keep this repair only for Web-labelled switch channels, where
    |    # both paths share switch_name_overrides as their source of truth.
    |    if domain_value != "switch" or getattr(state, "attribute", None) != "switch":
    |        return
    |    name = switch_name_overrides(device).get(getattr(state, "key", ()))
    |    if not name or getattr(entity_entry, "original_name", None) == name:
    |        return
    """),
)

replace_once(
    init_path,
    block("""
    |    for candidate in (
    |        getattr(entity_entry, "object_id_base", None),
    |        getattr(entity_entry, "original_name", None),
    |    ):
    """),
    block("""
    |    for candidate in (
    |        # original_name is the entity-local display label. The
    |        # object_id_base may already contain a generated qualifier
    |        # left by an older migration pass.
    |        getattr(entity_entry, "original_name", None),
    |        getattr(entity_entry, "object_id_base", None),
    |    ):
    """),
)

replace_once(
    init_path,
    block("""
    |    base = _strip_generated_device_slug_prefix(base.strip(), device, inventory)
    |    base = _normalized_registry_state_name_base(
    |        base,
    |        state,
    |        len(siblings),
    |        additional_qualifiers=(
    |            (main_presence_name,)
    |            if main_presence_name is not None
    |            and str(getattr(state, "component_role", "")).strip().lower()
    |            == "main"
    |            else ()
    |        ),
    |    )
    """),
    block("""
    |    base = _strip_generated_device_slug_prefix(base.strip(), device, inventory)
    |    generated_qualifiers = _current_registry_state_qualifier_names(
    |        device,
    |        state,
    |        siblings,
    |        main_presence_name=main_presence_name,
    |    )
    |    base = _normalized_registry_state_name_base(
    |        base,
    |        state,
    |        len(siblings),
    |        additional_qualifiers=(
    |            *generated_qualifiers,
    |            *(
    |                (main_presence_name,)
    |                if main_presence_name is not None
    |                and str(getattr(state, "component_role", "")).strip().lower()
    |                == "main"
    |                else ()
    |            ),
    |        ),
    |    )
    """),
)

helper_anchor = block("""
|def _strip_generated_device_slug_prefix(
|    base: str,
|    device: object,
|    inventory: BridgeInventory,
|) -> str:
""")
helper = block('''
|def _current_registry_state_qualifier_names(
|    device: object,
|    state: object,
|    siblings: Sequence[object],
|    *,
|    main_presence_name: str | None,
|) -> tuple[str, ...]:
|    """Return the exact qualifier current discovery assigns to this state."""
|    marker = "__smartthings_web_state__"
|    names = disambiguated_state_names(
|        [(item, marker) for item in siblings],
|        all_states=getattr(device, "states", {}).values(),
|        main_presence_name=main_presence_name,
|    )
|    generated = names.get(getattr(state, "key", ()))
|    prefix = f"{marker} ("
|    if not isinstance(generated, str) or not generated.startswith(prefix):
|        return ()
|    if not generated.endswith(")"):
|        return ()
|    qualifier = generated[len(prefix) : -1].strip()
|    return (qualifier,) if qualifier else ()
|
|
''')
replace_once(init_path, helper_anchor, helper + helper_anchor)

replace_once(
    init_path,
    block("""
    |        if field_name in {"component_role", "component"} and normalized.lower() == "main":
    |            continue
    |        normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", normalized)
    """),
    block("""
    |        if field_name in {"component_role", "component"} and normalized.lower() == "main":
    |            continue
    |        localized = STATE_ROLE_DISPLAY_NAMES.get(normalized.lower())
    |        if localized is not None and localized not in names:
    |            names.append(localized)
    |        normalized = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", normalized)
    """),
)

for path, domain in (
    ("custom_components/smartthings_web/binary_sensor.py", "binary_sensor"),
    ("custom_components/smartthings_web/sensor.py", "sensor"),
):
    replace_once(
        path,
        block("""
        |    runtime = entry.runtime_data
        |    known: set[str] = set()
        """),
        block("""
        |    runtime = entry.runtime_data
        |    known: set[str] = set()
        |    migrated_names: dict[str, str] = {}
        """),
    )
    replace_once(
        path,
        block(f"""
        |                migrate_entity_original_name(
        |                    hass,
        |                    "{domain}",
        |                    unique_id,
        |                    name_override,
        |                )
        """),
        block(f"""
        |                if (
        |                    name_override is not None
        |                    and migrated_names.get(unique_id) != name_override
        |                ):
        |                    migrate_entity_original_name(
        |                        hass,
        |                        "{domain}",
        |                        unique_id,
        |                        name_override,
        |                    )
        |                    migrated_names[unique_id] = name_override
        """),
    )

test_init = "custom_components/smartthings_web/tests/test_init.py"
replace_once(
    test_init,
    block("""
    |        self.updated: list[tuple[str, str]] = []
    |        self.renamed: list[tuple[str, str]] = []
    """),
    block("""
    |        self.updated: list[tuple[str, str]] = []
    |        self.renamed: list[tuple[str, str]] = []
    |        self.get_or_create_calls = 0
    """),
)
replace_once(
    test_init,
    block("""
    |    ) -> SimpleNamespace:
    |        entity_id = self.async_get_entity_id(domain, platform, unique_id)
    """),
    block("""
    |    ) -> SimpleNamespace:
    |        self.get_or_create_calls += 1
    |        entity_id = self.async_get_entity_id(domain, platform, unique_id)
    """),
)
replace_once(
    test_init,
    block("""
    |        self.assertEqual(
    |            [delay for delay, _callback in delayed],
    |            [0.5, 2.0, 10.0, 30.0],
    |        )
    """),
    block("""
    |        self.assertEqual(
    |            [delay for delay, _callback in delayed],
    |            [15.0],
    |        )
    """),
)

test_anchor = block("""
|    def test_primary_switch_name_collision_uses_device_name_numbered_ids(self) -> None:
""")
regression = block('''
|    def test_localized_role_suffix_metadata_converges_without_websocket_churn(self) -> None:
|        """Collapse the live ``단일 도어`` restore-metadata feedback loop once."""
|        states: list[BridgeState] = []
|        for role in ("onedoor", "freezer"):
|            component = f"identifier_component_{role}"
|            states.extend(
|                [
|                    BridgeState(
|                        component,
|                        "contactSensor",
|                        "contact",
|                        "closed",
|                        None,
|                        "2026-09-03T00:00:00Z",
|                        component_role="main",
|                    ),
|                    BridgeState(
|                        component,
|                        "temperatureMeasurement",
|                        "temperature",
|                        3,
|                        "C",
|                        "2026-09-03T00:00:00Z",
|                        component_role=role,
|                    ),
|                ]
|            )
|        device = BridgeDevice(
|            "dev_fridge",
|            "loc_001",
|            None,
|            "Naengjanggo",
|            "refrigerator",
|            True,
|            states={state.key: state for state in states},
|        )
|        repeated = "contact_" + "_".join(("danil_doeo",) * 14)
|        registry_entry = SimpleNamespace(
|            entity_id="binary_sensor.naengjanggo_contact_danil_doeo",
|            domain="binary_sensor",
|            platform=DOMAIN,
|            unique_id=(
|                "dev_fridge_identifier_component_onedoor_contactSensor_contact"
|            ),
|            device_id="uuid_fridge",
|            name=None,
|            disabled_by=None,
|            original_name="Contact (단일 도어)",
|            object_id_base=repeated,
|            suggested_object_id=f"naengjanggo_{repeated}",
|            has_entity_name=True,
|        )
|        registry = FakeRegistry([registry_entry])
|        self.patch_registry(registry)
|        inventory = BridgeInventory(
|            sequence=1,
|            ready=True,
|            bridge_version="0.1.171",
|            protocol_version="5",
|            locations={"loc_001": "Home"},
|            rooms={},
|            devices={device.device_id: device},
|        )
|        entry = SimpleNamespace(
|            entry_id="entry_001",
|            data={CONF_LOCATION_ID: "loc_001"},
|        )
|
|        _migrate_entity_registry(object(), entry, inventory)
|        _migrate_entity_registry(object(), entry, inventory)
|        _migrate_entity_registry(object(), entry, inventory)
|
|        expected_base = integration.slugify("Contact (단일 도어)")
|        self.assertEqual(registry_entry.object_id_base, expected_base)
|        self.assertEqual(
|            registry_entry.suggested_object_id,
|            f"naengjanggo_{expected_base}",
|        )
|        self.assertEqual(registry_entry.original_name, "Contact (단일 도어)")
|        self.assertEqual(registry.get_or_create_calls, 1)
|
''')
replace_once(test_init, test_anchor, regression + test_anchor)

binary_test = "custom_components/smartthings_web/tests/test_binary_sensor.py"
replace_once(
    binary_test,
    block("""
    |        try:
    |            await async_setup_entry(object(), entry, added.extend)
    |        finally:
    """),
    block("""
    |        try:
    |            await async_setup_entry(object(), entry, added.extend)
    |            for listener in tuple(runtime.listeners):
    |                listener()
    |                listener()
    |        finally:
    """),
)
replace_once(
    binary_test,
    block("""
    |        self.assertEqual(
    |            {unique_id: name for _, _, unique_id, name in migrations},
    """),
    block("""
    |        self.assertEqual(len(migrations), len(role_labels))
    |        self.assertEqual(
    |            {unique_id: name for _, _, unique_id, name in migrations},
    """),
)

replace_once(
    "bridge/src/runtime.ts",
    'const bridgeVersion = "0.1.170";',
    'const bridgeVersion = "0.1.171";',
)
replace_once(
    "custom_components/smartthings_web/manifest.json",
    '"version": "0.1.170"',
    '"version": "0.1.171"',
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    "version: 0.1.170",
    "version: 0.1.171",
)
replace_once(
    "package.json",
    '"version": "0.1.170"',
    '"version": "0.1.171"',
)

for name in (
    "package-lock.json",
    "protocol/version.json",
    "tests/addon-config.test.ts",
    "tests/protocol-version-contract.test.ts",
):
    path = Path(name)
    text = path.read_text(encoding="utf-8")
    count = text.count("0.1.170")
    if count < 1:
        raise SystemExit(f"{name}: no 0.1.170 release contract found")
    updated = text.replace("0.1.170", "0.1.171")
    if "0.1.170" in updated:
        raise SystemExit(f"{name}: old release contract remains")
    path.write_text(updated, encoding="utf-8")

changelog_path = Path("addon/smartthings_web_bridge/CHANGELOG.md")
changelog = changelog_path.read_text(encoding="utf-8")
if not changelog.startswith("## 0.1.170\n"):
    raise SystemExit("CHANGELOG.md: unexpected release head")
notes = (
    "## 0.1.171\n\n"
    "- `단일 도어` 같은 현지화된 상태 역할이 기존 `object_id_base`와 `suggested_object_id` 뒤에 반복해서 누적되던 엔티티 레지스트리 피드백 루프를 한 번에 정규화합니다.\n"
    "- 센서·이진 센서 이름은 각 플랫폼의 번역 및 Web 역할 이름만 관리하도록 분리해 레지스트리 마이그레이션과 이름 갱신이 서로 되돌리는 현상을 차단합니다.\n"
    "- 이미 올바른 복원 메타데이터는 다시 기록하지 않고, 토폴로지 변경당 레지스트리 정리 횟수를 5회에서 최대 2회로 줄여 Home Assistant WebSocket 메시지 폭주를 완화합니다.\n"
    "- 센서 발견 콜백에서 동일한 `original_name` 갱신을 반복하지 않도록 캐시하며, 0.1.170의 Home Monitor 및 임시 Socket.IO 종료 안정화는 그대로 유지합니다.\n\n"
)
changelog_path.write_text(notes + changelog, encoding="utf-8")
