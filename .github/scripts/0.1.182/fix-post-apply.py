from __future__ import annotations

from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one marker, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


# The Home Monitor scan now accepts a bounded caller-supplied timeout while
# retaining 15 seconds as its public default. Keep the source-contract test
# aligned with that safer parameterized implementation.
replace_once(
    Path("bridge/tests/browser/home-monitor-dom.test.ts"),
    '    expect(source).toContain("Date.now() + 15_000");\n',
    '    expect(source).toContain("Date.now() + Math.max(1, timeoutMs)");\n',
    "Home Monitor timeout assertion",
)


# Preserve the exact valid SmartThings timestamp spelling that entered the
# store. Timestamp-only repeats advance the internal sequence but do not need
# to fabricate millisecond digits.
device_store_test = Path("bridge/tests/state/device-store.test.ts")
text = device_store_test.read_text(encoding="utf-8")
start = text.index(
    '  test("stores timestamp-only repeats without publishing another state event"'
)
end = text.index('\n  test("', start + 10)
block = text[start:end]
old_timestamp = '"2026-09-04T00:00:02.000Z"'
if block.count(old_timestamp) != 1:
    raise SystemExit(
        "timestamp-only repeat expectation: expected one marker, "
        f"found {block.count(old_timestamp)}"
    )
block = block.replace(old_timestamp, '"2026-09-04T00:00:02Z"', 1)
device_store_test.write_text(text[:start] + block + text[end:], encoding="utf-8")


# Separate command-confirmation evidence from the public SSE stream. A
# timestamp-only same-value push must not wake every Home Assistant entity, but
# it can still be authoritative evidence for a just-executed Scene. Normal
# published events are delivered to both listener groups; semantic duplicates
# are delivered only to confirmation listeners.
device_store = Path("bridge/src/state/device-store.ts")
replace_once(
    device_store,
    "  readonly #listeners = new Set<Listener>();\n",
    "  readonly #listeners = new Set<Listener>();\n"
    "  readonly #confirmationListeners = new Set<Listener>();\n",
    "DeviceStore confirmation listener field",
)
replace_once(
    device_store,
    "  subscribe(listener: Listener): () => void {\n"
    "    this.#listeners.add(listener);\n"
    "    return () => this.#listeners.delete(listener);\n"
    "  }\n",
    "  subscribe(listener: Listener): () => void {\n"
    "    this.#listeners.add(listener);\n"
    "    return () => this.#listeners.delete(listener);\n"
    "  }\n\n"
    "  subscribeConfirmation(listener: Listener): () => void {\n"
    "    this.#confirmationListeners.add(listener);\n"
    "    return () => this.#confirmationListeners.delete(listener);\n"
    "  }\n",
    "DeviceStore confirmation subscription",
)

text = device_store.read_text(encoding="utf-8")
apply_start = text.index("  #applyDeviceEvent(input: unknown): void {")
apply_end = text.index("\n  #applyDeviceHealthEvent", apply_start)
apply_block = text[apply_start:apply_end]
state_marker = (
    "    const stateChanged = this.#setState(device, state);\n"
    "    if (!stateChanged) {\n"
    "      return;\n"
    "    }\n"
)
if apply_block.count(state_marker) != 1:
    raise SystemExit(
        "DeviceStore state-change marker: expected one, "
        f"found {apply_block.count(state_marker)}"
    )
confirmation_branch = state_marker + (
    "    const confirmationEventId = safeEventMetadata(\n"
    "      event.event_id ?? event.eventId ?? data.event_id ?? data.eventId\n"
    "    );\n"
    "    const confirmationCommandId = safeEventMetadata(\n"
    "      event.command_id ?? event.commandId ?? data.command_id ?? data.commandId\n"
    "    );\n"
    "    if (!durableStateChanged && !confirmationCommandId) {\n"
    "      const wasOnline = device.online;\n"
    "      this.#setDeviceHealth(device, true, state.updatedAt);\n"
    "      if (!wasOnline) {\n"
    "        const onlineSequence = this.#nextSequence();\n"
    "        this.#publish({ schemaVersion: 1, sequence: onlineSequence, type: \"inventory\" });\n"
    "      }\n"
    "      const sequence = this.#nextSequence();\n"
    "      this.#publishConfirmation({\n"
    "        schemaVersion: 1,\n"
    "        sequence,\n"
    "        type: \"state\",\n"
    "        deviceId,\n"
    "        state: cloneState(state),\n"
    "        ...(confirmationEventId ? { eventId: confirmationEventId } : {}),\n"
    "        ...(state.updatedAt ? { eventTime: state.updatedAt } : {})\n"
    "      });\n"
    "      if (!wasOnline) this.#schedulePersist();\n"
    "      return;\n"
    "    }\n"
)
apply_block = apply_block.replace(state_marker, confirmation_branch, 1)
text = text[:apply_start] + apply_block + text[apply_end:]
device_store.write_text(text, encoding="utf-8")

replace_once(
    device_store,
    "  #publish(event: BridgeDeviceStoreEvent): void {\n"
    "    for (const listener of this.#listeners) {\n"
    "      try {\n"
    "        listener(event);\n"
    "      } catch {\n"
    "        // One failed local client must not interrupt browser capture.\n"
    "      }\n"
    "    }\n"
    "  }\n",
    "  #publish(event: BridgeDeviceStoreEvent): void {\n"
    "    const listeners = new Set([\n"
    "      ...this.#listeners,\n"
    "      ...this.#confirmationListeners\n"
    "    ]);\n"
    "    this.#notifyListeners(listeners, event);\n"
    "  }\n\n"
    "  #publishConfirmation(event: BridgeDeviceStoreEvent): void {\n"
    "    this.#notifyListeners(this.#confirmationListeners, event);\n"
    "  }\n\n"
    "  #notifyListeners(\n"
    "    listeners: ReadonlySet<Listener>,\n"
    "    event: BridgeDeviceStoreEvent\n"
    "  ): void {\n"
    "    for (const listener of listeners) {\n"
    "      try {\n"
    "        listener(event);\n"
    "      } catch {\n"
    "        // One failed local client must not interrupt browser capture.\n"
    "      }\n"
    "    }\n"
    "  }\n",
    "DeviceStore split publish channels",
)

replace_once(
    Path("bridge/src/command/command-service.ts"),
    "    unsubscribe = options.devices.subscribe((event) => {\n",
    "    unsubscribe = options.devices.subscribeConfirmation((event) => {\n",
    "command confirmation subscription",
)
