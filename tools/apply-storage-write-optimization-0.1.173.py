from __future__ import annotations

from pathlib import Path

ROOT = Path.cwd()


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    value = read(path)
    count = value.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, value.replace(old, new, 1))


def replace_exact(path: str, old: str, new: str, expected: int) -> None:
    value = read(path)
    count = value.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} matches, found {count}: {old!r}")
    write(path, value.replace(old, new))


# Capture diagnostics: make persistence opt-in, cap retention, bound WAL, and
# avoid writing consecutive duplicates.
path = "bridge/src/state/capture-store.ts"
replace_once(
    path,
    "const maxPersistedCaptureRows = 50_000;\nconst capturePruneInterval = 1_000;",
    "const maxPersistedCaptureRows = 2_000;\nconst capturePruneInterval = 100;",
)
replace_once(
    path,
    "export class CaptureStore {\n  readonly #db: DatabaseSync;\n  #writesSincePrune = 0;",
    "export class CaptureStore {\n"
    "  readonly #db: DatabaseSync;\n"
    "  readonly #lastPayloadHashBySource = new Map<CaptureSource, string>();\n"
    "  #writesSincePrune = 0;",
)
replace_once(
    path,
    "      PRAGMA journal_mode = WAL;\n      PRAGMA busy_timeout = ${captureBusyTimeoutMs};",
    "      PRAGMA journal_mode = WAL;\n"
    "      PRAGMA synchronous = NORMAL;\n"
    "      PRAGMA busy_timeout = ${captureBusyTimeoutMs};\n"
    "      PRAGMA wal_autocheckpoint = 64;\n"
    "      PRAGMA journal_size_limit = 1048576;",
)
replace_once(
    path,
    "    if (record.__sanitized !== true || !sanitizedRecords.has(record)) {\n"
    "      throw new Error(\"capture records must pass through sanitizer before persistence\");\n"
    "    }\n"
    "    try {",
    "    if (record.__sanitized !== true || !sanitizedRecords.has(record)) {\n"
    "      throw new Error(\"capture records must pass through sanitizer before persistence\");\n"
    "    }\n"
    "    if (this.#lastPayloadHashBySource.get(record.source) === record.payloadHash) {\n"
    "      return;\n"
    "    }\n"
    "    try {",
)
replace_once(
    path,
    "        .run(record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash);\n"
    "      this.#writesSincePrune += 1;",
    "        .run(record.source, record.receivedAt, JSON.stringify(record.payload), record.payloadHash);\n"
    "      this.#lastPayloadHashBySource.set(record.source, record.payloadHash);\n"
    "      this.#writesSincePrune += 1;",
)
replace_once(
    path,
    "  close(): void {\n    this.#db.close();\n  }",
    "  close(): void {\n"
    "    try {\n"
    "      this.#db.exec(\"PRAGMA wal_checkpoint(TRUNCATE)\");\n"
    "    } catch {\n"
    "      // A concurrent reader may keep the WAL busy during shutdown.\n"
    "    }\n"
    "    this.#db.close();\n"
    "  }",
)

# Runtime: raw protocol captures are diagnostics, not normal durable state.
path = "bridge/src/runtime.ts"
replace_once(
    path,
    'import { CaptureStore } from "./state/capture-store.js";',
    'import { CaptureStore, type SanitizedCaptureRecord } from "./state/capture-store.js";',
)
replace_once(path, 'const bridgeVersion = "0.1.172";', 'const bridgeVersion = "0.1.173";')
replace_once(
    path,
    "  const capturePipeline = createStatusCapturePipeline(\n    captures,\n    status,",
    "  const capturePipeline = createStatusCapturePipeline(\n"
    "    captures,\n"
    "    deps.config.debugProtocolLogging === true,\n"
    "    status,",
)
replace_once(
    path,
    "function createStatusCapturePipeline(\n  captures: CaptureStore,\n  status: RuntimeStatusStore,",
    "function createStatusCapturePipeline(\n"
    "  captures: CaptureStore,\n"
    "  persistDebugCaptures: boolean,\n"
    "  status: RuntimeStatusStore,",
)
replace_once(
    path,
    "  let protocolFingerprintObserved = false;\n  let protocolBlocked = initiallyProtocolBlocked;\n  return {",
    "  let protocolFingerprintObserved = false;\n"
    "  let protocolBlocked = initiallyProtocolBlocked;\n"
    "  const persistCapture = (record: SanitizedCaptureRecord, force = false): void => {\n"
    "    if (persistDebugCaptures || force) captures.write(record);\n"
    "  };\n"
    "  return {",
)
replace_once(
    path,
    '          if (analysis?.kind !== "duplicate") captures.write(record);',
    '          if (analysis?.kind !== "duplicate") {\n'
    '            persistCapture(record, analysis?.kind === "protocol_changed");\n'
    '          }',
)
replace_once(
    path,
    '        captures.write(record);\n        if (record.source === "cdp-eventsource") {',
    '        persistCapture(record);\n        if (record.source === "cdp-eventsource") {',
)

# Normalized inventory: suppress timestamp-only churn and coalesce durable state.
path = "bridge/src/state/device-store.ts"
replace_once(
    path,
    "const INVENTORY_PERSIST_COALESCE_MS = 25;\nconst INVENTORY_PERSIST_RETRY_MS = 250;",
    "const INVENTORY_PERSIST_COALESCE_MS = 5_000;\nconst INVENTORY_PERSIST_RETRY_MS = 5_000;",
)
replace_once(
    path,
    "  #persistTimer: ReturnType<typeof setTimeout> | undefined;\n"
    "  #persistPending = false;\n"
    "  #sequence = 0;",
    "  #persistTimer: ReturnType<typeof setTimeout> | undefined;\n"
    "  #persistPending = false;\n"
    "  #lastPersistedInventoryJson: string | undefined;\n"
    "  #sequence = 0;",
)
replace_once(
    path,
    "      this.#db = new DatabaseSync(options.sqlitePath);\n"
    "      this.#db.exec(`\n"
    "        CREATE TABLE IF NOT EXISTS normalized_inventory",
    "      this.#db = new DatabaseSync(options.sqlitePath);\n"
    "      this.#db.exec(`\n"
    "        PRAGMA journal_mode = WAL;\n"
    "        PRAGMA synchronous = NORMAL;\n"
    "        PRAGMA wal_autocheckpoint = 64;\n"
    "        PRAGMA journal_size_limit = 1048576;\n\n"
    "        CREATE TABLE IF NOT EXISTS normalized_inventory",
)
replace_once(
    path,
    "  #setDeviceHealth(device: MutableDevice, online: boolean, updatedAt: string | null): boolean {\n"
    "    if (isOlderOrUndated(updatedAt, device.healthUpdatedAt)) {\n"
    "      return false;\n"
    "    }\n"
    "    if (device.online === online && device.healthUpdatedAt === updatedAt) {\n"
    "      return false;\n"
    "    }\n"
    "    device.healthUpdatedAt = updatedAt;\n"
    "    device.online = online;\n"
    "    return true;\n"
    "  }",
    "  #setDeviceHealth(device: MutableDevice, online: boolean, updatedAt: string | null): boolean {\n"
    "    if (isOlderOrUndated(updatedAt, device.healthUpdatedAt)) {\n"
    "      return false;\n"
    "    }\n"
    "    if (device.online === online) {\n"
    "      // Keep ordering evidence in memory without publishing or persisting a\n"
    "      // status that did not semantically change.\n"
    "      device.healthUpdatedAt = updatedAt;\n"
    "      return false;\n"
    "    }\n"
    "    device.healthUpdatedAt = updatedAt;\n"
    "    device.online = online;\n"
    "    return true;\n"
    "  }",
)
replace_once(
    path,
    "    if (current && !momentaryEvent && JSON.stringify(current) === JSON.stringify(state)) {\n"
    "      return false;\n"
    "    }\n"
    "    device.states.set(key, cloneState(state));",
    "    if (\n"
    "      current &&\n"
    "      !momentaryEvent &&\n"
    '      state.attribute !== "signalMetrics" &&\n'
    "      sameStatePayload(current, state)\n"
    "    ) {\n"
    "      // Preserve the newest ordering timestamp in memory, but do not publish a\n"
    "      // Home Assistant state event or rewrite the full inventory snapshot.\n"
    "      device.states.set(key, cloneState(state));\n"
    "      return false;\n"
    "    }\n"
    "    device.states.set(key, cloneState(state));",
)
replace_once(
    path,
    "    try {\n"
    "      return parsePersistedInventory(JSON.parse(row.inventoryJson));\n"
    "    } catch {\n"
    "      return undefined;\n"
    "    }",
    "    try {\n"
    "      const parsed = parsePersistedInventory(JSON.parse(row.inventoryJson));\n"
    "      if (parsed) this.#lastPersistedInventoryJson = row.inventoryJson;\n"
    "      return parsed;\n"
    "    } catch {\n"
    "      return undefined;\n"
    "    }",
)
replace_once(
    path,
    "  #flushPersist(): void {\n"
    "    if (!this.#db || !this.#persistPending) return;\n"
    "    this.#db\n"
    "      .prepare(`\n"
    "        INSERT INTO normalized_inventory (schema_version, inventory_json, persisted_at)\n"
    "        VALUES (1, ?, ?)\n"
    "        ON CONFLICT(schema_version) DO UPDATE SET\n"
    "          inventory_json = excluded.inventory_json,\n"
    "          persisted_at = excluded.persisted_at\n"
    "      `)\n"
    "      .run(JSON.stringify(this.snapshot()), new Date().toISOString());\n"
    "    this.#persistPending = false;\n"
    "  }\n"
    "}\n\n"
    "function snapshotDeviceStates",
    "  #flushPersist(): void {\n"
    "    if (!this.#db || !this.#persistPending) return;\n"
    "    const inventoryJson = JSON.stringify(this.snapshot());\n"
    "    if (inventoryJson === this.#lastPersistedInventoryJson) {\n"
    "      this.#persistPending = false;\n"
    "      return;\n"
    "    }\n"
    "    this.#db\n"
    "      .prepare(`\n"
    "        INSERT INTO normalized_inventory (schema_version, inventory_json, persisted_at)\n"
    "        VALUES (1, ?, ?)\n"
    "        ON CONFLICT(schema_version) DO UPDATE SET\n"
    "          inventory_json = excluded.inventory_json,\n"
    "          persisted_at = excluded.persisted_at\n"
    "      `)\n"
    "      .run(inventoryJson, new Date().toISOString());\n"
    "    this.#lastPersistedInventoryJson = inventoryJson;\n"
    "    this.#persistPending = false;\n"
    "  }\n"
    "}\n\n"
    "function sameStatePayload(left: BridgeDeviceState, right: BridgeDeviceState): boolean {\n"
    "  return (\n"
    "    left.component === right.component &&\n"
    "    left.capability === right.capability &&\n"
    "    left.attribute === right.attribute &&\n"
    "    left.unit === right.unit &&\n"
    "    left.componentRole === right.componentRole &&\n"
    "    left.capabilityRole === right.capabilityRole &&\n"
    "    JSON.stringify(left.value) === JSON.stringify(right.value)\n"
    "  );\n"
    "}\n\n"
    "function snapshotDeviceStates",
)

# Camera cache: avoid rewriting and re-emitting identical image bytes.
path = "bridge/src/state/camera-image-store.ts"
replace_once(
    path,
    'import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";',
    'import { createHash } from "node:crypto";\n'
    'import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";',
)
replace_once(
    path,
    'interface PersistedMetadata {\n  schemaVersion: 1;\n  contentType: BridgeCameraImage["contentType"];\n  capturedAt: string;\n}',
    'interface PersistedMetadata {\n'
    '  schemaVersion: 1;\n'
    '  contentType: BridgeCameraImage["contentType"];\n'
    '  capturedAt: string;\n'
    '  sha256?: string;\n'
    '}',
)
replace_once(
    path,
    "    const bodyPath = join(this.#root, `${deviceId}.bin`);\n"
    "    const metadataPath = join(this.#root, `${deviceId}.json`);\n"
    "    const tempBody = `${bodyPath}.tmp`;",
    "    const bodyPath = join(this.#root, `${deviceId}.bin`);\n"
    "    const metadataPath = join(this.#root, `${deviceId}.json`);\n"
    '    const sha256 = createHash("sha256").update(body).digest("hex");\n'
    "    try {\n"
    '      const current = parseMetadata(JSON.parse(readFileSync(metadataPath, "utf8")));\n'
    "      if (current?.contentType === contentType && current.sha256 === sha256) {\n"
    "        return;\n"
    "      }\n"
    "    } catch {\n"
    "      // Missing or legacy metadata is replaced atomically below.\n"
    "    }\n"
    "    const tempBody = `${bodyPath}.tmp`;",
)
replace_once(
    path,
    "      JSON.stringify({ schemaVersion: 1, contentType, capturedAt } satisfies PersistedMetadata),",
    "      JSON.stringify({\n"
    "        schemaVersion: 1,\n"
    "        contentType,\n"
    "        capturedAt,\n"
    "        sha256\n"
    "      } satisfies PersistedMetadata),",
)
replace_once(
    path,
    "  const capturedAt = readString(record?.capturedAt);\n"
    "  if (\n"
    "    record?.schemaVersion !== 1 ||\n"
    "    !contentType ||\n"
    "    !capturedAt ||\n"
    "    !Number.isFinite(Date.parse(capturedAt))\n"
    "  ) {\n"
    "    return undefined;\n"
    "  }\n"
    "  return { schemaVersion: 1, contentType, capturedAt };",
    "  const capturedAt = readString(record?.capturedAt);\n"
    "  const sha256 = readString(record?.sha256);\n"
    "  if (\n"
    "    record?.schemaVersion !== 1 ||\n"
    "    !contentType ||\n"
    "    !capturedAt ||\n"
    "    !Number.isFinite(Date.parse(capturedAt)) ||\n"
    "    (sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(sha256))\n"
    "  ) {\n"
    "    return undefined;\n"
    "  }\n"
    "  return {\n"
    "    schemaVersion: 1,\n"
    "    contentType,\n"
    "    capturedAt,\n"
    "    ...(sha256 ? { sha256 } : {})\n"
    "  };",
)

# Chromium: keep login state persistent while moving disposable caches to /tmp.
path = "bridge/src/browser/persistent-context.ts"
replace_once(
    path,
    '        "--password-store=basic",\n        "--restore-last-session",',
    '        "--password-store=basic",\n'
    '        "--restore-last-session",\n'
    '        "--disk-cache-dir=/tmp/smartthings-web-chromium-cache",\n'
    '        "--disk-cache-size=67108864",\n'
    '        "--media-cache-size=33554432",\n'
    '        "--disable-breakpad",\n'
    '        "--disable-crash-reporter",',
)

# Add-on startup: perform recursive ownership migration once and clear only
# disposable Chromium caches. Samsung authentication data stays intact.
write(
    "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
    """#!/command/with-contenv sh
set -eu

test -d /data

ownership_marker=/data/.smartthings-web-ownership-v1
if [ ! -e "$ownership_marker" ]; then
  chown -R pwuser:pwuser /data
  : > "$ownership_marker"
  chown pwuser:pwuser "$ownership_marker"
  chmod 0600 "$ownership_marker"
else
  chown pwuser:pwuser /data
fi

for directory in /data/chromium-profile /data/downloads /data/camera-images; do
  mkdir -p "$directory"
  chown pwuser:pwuser "$directory"
  chmod 0700 "$directory"
done

for cache_path in \
  /data/chromium-profile/Default/Cache \
  "/data/chromium-profile/Default/Code Cache" \
  /data/chromium-profile/Default/GPUCache \
  "/data/chromium-profile/Default/Service Worker/CacheStorage" \
  "/data/chromium-profile/Default/Service Worker/ScriptCache" \
  /data/chromium-profile/GrShaderCache \
  /data/chromium-profile/ShaderCache \
  /data/chromium-profile/GraphiteDawnCache \
  /data/chromium-profile/DawnGraphiteCache \
  /data/chromium-profile/DawnWebGPUCache \
  /data/chromium-profile/Crashpad; do
  rm -rf -- "$cache_path" 2>/dev/null || true
done

find /data/downloads -mindepth 1 -type f -mtime +7 -delete 2>/dev/null || true
""",
)

# Synchronize product versions.
replace_once("package.json", '"version": "0.1.172"', '"version": "0.1.173"')
replace_exact("package-lock.json", '"version": "0.1.172"', '"version": "0.1.173"', 2)
replace_once(
    "custom_components/smartthings_web/manifest.json",
    '"version": "0.1.172"',
    '"version": "0.1.173"',
)
replace_once(
    "addon/smartthings_web_bridge/config.yaml",
    "version: 0.1.172",
    "version: 0.1.173",
)

changelog = read("addon/smartthings_web_bridge/CHANGELOG.md")
if not changelog.startswith("## 0.1.172\n"):
    raise SystemExit("unexpected changelog head")
write(
    "addon/smartthings_web_bridge/CHANGELOG.md",
    """## 0.1.173

- 일반 실행에서는 원시 프로토콜 캡처를 SQLite에 계속 저장하지 않고 `debug_protocol_logging`을 켠 경우에만 진단 캡처를 보존합니다. 프로토콜 불일치는 설정과 관계없이 정제된 단일 근거를 남깁니다.
- 진단 캡처 보존 한도를 50,000건에서 2,000건으로 줄이고, 연속 중복 레코드와 과도한 WAL 증가를 억제합니다.
- 값은 같고 타임스탬프만 갱신된 상태 및 상태 확인 이벤트는 Home Assistant에 다시 발행하지 않으며, 전체 인벤토리 SQLite 저장을 5초 단위로 병합하고 동일 JSON 재기록을 건너뜁니다.
- 동일한 카메라 이미지 바이트는 다시 파일로 쓰거나 이미지 이벤트를 재발행하지 않습니다.
- Samsung 로그인 데이터는 유지하면서 Chromium HTTP·미디어·서비스 워커 캐시를 임시 파일시스템으로 이동하거나 시작 시 정리하고 크기를 제한합니다.
- 앱 시작 때마다 수행하던 `/data` 전체 재귀 `chown`을 최초 호환 마이그레이션 한 번으로 제한하고 7일이 지난 다운로드 임시 파일을 정리합니다.

"""
    + changelog,
)

# Regression tests.
path = "bridge/tests/browser/persistent-context.test.ts"
replace_once(
    path,
    '    expect(launch.options.args).toContain("--restore-last-session");\n'
    '    expect(launch.options.args).toContain("--hide-crash-restore-bubble");',
    '    expect(launch.options.args).toContain("--restore-last-session");\n'
    '    expect(launch.options.args).toContain("--disk-cache-dir=/tmp/smartthings-web-chromium-cache");\n'
    '    expect(launch.options.args).toContain("--disk-cache-size=67108864");\n'
    '    expect(launch.options.args).toContain("--media-cache-size=33554432");\n'
    '    expect(launch.options.args).toContain("--disable-breakpad");\n'
    '    expect(launch.options.args).toContain("--disable-crash-reporter");\n'
    '    expect(launch.options.args).toContain("--hide-crash-restore-bubble");',
)

path = "bridge/tests/state/capture-store.test.ts"
replace_once(path, "SELECT value + 1 FROM rows WHERE value < 50010", "SELECT value + 1 FROM rows WHERE value < 2010")
replace_once(
    path,
    "expect(aggregate).toEqual({ count: 50000, minId: 11, maxId: 50010 });",
    "expect(aggregate).toEqual({ count: 2000, minId: 11, maxId: 2010 });",
)
replace_once(path, "SELECT value + 1 FROM rows WHERE value < 50000", "SELECT value + 1 FROM rows WHERE value < 2000")
replace_once(
    path,
    "expect(aggregate).toEqual({ count: 50000, minId: 1001, maxId: 51000 });",
    "expect(aggregate).toEqual({ count: 2000, minId: 1001, maxId: 3000 });",
)
marker = '\n  test("retains only the newest bounded diagnostic capture window on startup", () => {'
dedupe_test = r'''
  test("skips consecutive records with the same source and sanitized payload hash", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-capture-dedupe-"));
    let store: CaptureStore | undefined;
    try {
      store = new CaptureStore(join(root, "capture.sqlite"));
      store.write(sanitizeCaptureRecord("unit", { value: "same" }, (value) => value));
      store.write(sanitizeCaptureRecord("unit", { value: "same" }, (value) => value));

      expect(store.listRecent(5)).toHaveLength(1);
    } finally {
      store?.close();
      rmSync(root, { force: true, recursive: true });
    }
  });
'''
value = read(path)
if value.count(marker) != 1:
    raise SystemExit("capture-store test insertion marker missing")
write(path, value.replace(marker, dedupe_test + marker, 1))

path = "bridge/tests/state/device-store.test.ts"
marker = "\n});\n\nfunction persistedState("
state_test = r'''

  test("suppresses timestamp-only state and health churn while retaining ordering evidence", () => {
    const store = new DeviceStore();
    observeSnapshotState(store, {
      componentId: "main",
      capabilityId: "temperatureMeasurement",
      attributeName: "temperature",
      value: 21.5,
      unit: "C",
      timestamp: "2026-09-04T00:00:00.000Z"
    });
    observeHealthSnapshot(store, {
      deviceId: "dev_001",
      locationId: "loc_001",
      status: "ONLINE",
      updatedAt: "2026-09-04T00:00:01.000Z"
    });
    const before = store.currentSequence();
    const listener = vi.fn();
    store.subscribe(listener);

    store.observe(
      liveStateEvent({
        capability: "temperatureMeasurement",
        attribute: "temperature",
        value: 21.5,
        unit: "C",
        event_time: Date.parse("2026-09-04T00:01:00.000Z")
      })
    );
    store.observe(
      liveHealthEvent({
        locationId: "loc_001",
        status: "ONLINE",
        eventTime: "2026-09-04T00:01:01.000Z"
      })
    );

    expect(store.currentSequence()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot().devices[0]).toMatchObject({
      online: true,
      healthUpdatedAt: "2026-09-04T00:01:01.000Z",
      states: [
        expect.objectContaining({
          attribute: "temperature",
          value: 21.5,
          updatedAt: "2026-09-04T00:01:00.000Z"
        })
      ]
    });
  });
'''
value = read(path)
if value.count(marker) != 1:
    raise SystemExit("device-store test insertion marker missing")
write(path, value.replace(marker, state_test + marker, 1))

path = "bridge/tests/state/camera-image-store.test.ts"
marker = "\n});\n\nfunction createStore("
image_test = r'''

  test("does not rewrite or publish identical camera image bytes", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0x01]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "4" }
      })
    );
    const store = createStore(fetchImage);
    const listener = vi.fn();
    store.subscribe(listener);

    store.observeRawWebSocketFrame(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-uuid",{}]'
    );
    store.observeRawWebSocketFrame(
      "received",
      '431[null,{"url":"https://media.st-av.net/camera/image.jpg?token=one"}]'
    );
    await store.whenIdle();
    store.observeRawWebSocketFrame(
      "sent",
      '422["get","api/camera/thumbnail","raw-camera-uuid",{}]'
    );
    store.observeRawWebSocketFrame(
      "received",
      '432[null,{"url":"https://media.st-av.net/camera/image.jpg?token=two"}]'
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.get("dev_001")?.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0x01]));
  });
'''
value = read(path)
if value.count(marker) != 1:
    raise SystemExit("camera-image-store test insertion marker missing")
write(path, value.replace(marker, image_test + marker, 1))

write(
    "tests/storage-hygiene.test.ts",
    r'''import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("HAOS storage hygiene", () => {
  test("keeps normal protocol capture persistence opt-in", () => {
    const runtime = readFileSync("bridge/src/runtime.ts", "utf8");
    expect(runtime).toContain("deps.config.debugProtocolLogging === true");
    expect(runtime).toContain(
      'persistCapture(record, analysis?.kind === "protocol_changed")'
    );
  });

  test("performs recursive data ownership migration only behind a marker", () => {
    const script = readFileSync(
      "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data",
      "utf8"
    );
    expect(script).toContain("ownership_marker=/data/.smartthings-web-ownership-v1");
    expect(script).toMatch(/if \[ ! -e "\$ownership_marker" \]/);
    expect(script.match(/chown -R pwuser:pwuser \/data/g)).toHaveLength(1);
    expect(script).toContain("/data/chromium-profile/Default/Cache");
    expect(script).toContain("/data/chromium-profile/Default/Service Worker/CacheStorage");
    expect(script).not.toContain("/data/chromium-profile/Default/Cookies");
    expect(script).not.toContain("/data/chromium-profile/Default/Local Storage");
    expect(script).not.toContain("/data/chromium-profile/Default/IndexedDB");
  });
});
''',
)

for product_file in (
    "package.json",
    "package-lock.json",
    "custom_components/smartthings_web/manifest.json",
    "addon/smartthings_web_bridge/config.yaml",
    "bridge/src/runtime.ts",
):
    if "0.1.172" in read(product_file):
        raise SystemExit(f"stale product version in {product_file}")

# The helper and triggering workflow are temporary and must not ship.
(ROOT / ".github/workflows/apply-storage-write-optimization-0.1.173.yml").unlink(missing_ok=True)
Path(__file__).unlink(missing_ok=True)
