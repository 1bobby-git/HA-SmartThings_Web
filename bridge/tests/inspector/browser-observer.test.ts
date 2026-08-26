import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { installBrowserObserver } from "../../src/inspector/browser-observer.js";
import { DEFAULT_CAPTURE_TEXT_LIMIT_BYTES } from "../../src/inspector/text-normalizer.js";
import { SqliteAliasStore } from "../../src/security/alias-store.js";
import { createRedactor } from "../../src/security/redactor.js";
import { CaptureStore } from "../../src/state/capture-store.js";

class Emitter {
  handlers = new Map<string, ((value: unknown) => void)[]>();

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(value);
    }
  }
}

async function withPersistedCaptures<T>(
  fn: (store: CaptureStore, redact: ReturnType<typeof createRedactor>) => T | Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "stw-inspector-capture-"));
  let aliases: SqliteAliasStore | undefined;
  let store: CaptureStore | undefined;
  try {
    aliases = new SqliteAliasStore(join(root, "aliases.sqlite"), "unit-secret");
    store = new CaptureStore(join(root, "captures.sqlite"));
    return await fn(store, createRedactor(aliases));
  } finally {
    store?.close();
    aliases?.close();
    rmSync(root, { force: true, recursive: true });
  }
}

describe("installBrowserObserver", () => {
  test("default text limit retains the largest bounded live snapshot observed in Phase 1", () => {
    expect(DEFAULT_CAPTURE_TEXT_LIMIT_BYTES).toBe(1_048_576);
    expect(DEFAULT_CAPTURE_TEXT_LIMIT_BYTES).toBeGreaterThan(482_235);
  });
  test("records sanitized request, response, websocket, and service-worker metadata without routing", () => {
    const context = new Emitter() as Emitter & { route?: unknown };
    const write = vi.fn();
    const redact = vi.fn((value: unknown) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll("raw-device", "dev_001")
          .replaceAll("raw-location", "loc_001")
          .replaceAll("Bearer secret", "[REDACTED]")
          .replaceAll("sid=secret", "[REDACTED]")
          .replaceAll("token=secret", "token=[REDACTED]")
      )
    );

    installBrowserObserver(context, { write }, redact);

    context.emit("request", {
      url: () => "https://example.test/?deviceId=raw-device&token=secret",
      method: () => "GET",
      resourceType: () => "xhr",
      headers: () => ({ authorization: "Bearer secret" })
    });
    context.emit("response", {
      url: () => "https://example.test/location/raw-location",
      status: () => 200,
      headers: () => ({ "set-cookie": "sid=secret" })
    });
    const socket = new Emitter() as Emitter & { url: () => string };
    socket.url = () => "wss://example.test/socket?locationId=raw-location";
    context.emit("websocket", socket);
    socket.emit("framereceived", { payload: '{"deviceId":"raw-device"}' });
    context.emit("serviceworker", { url: () => "https://example.test/sw.js" });

    expect(context.route).toBeUndefined();
    expect(redact).toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "playwright-request" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "playwright-response" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "playwright-websocket-frame" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "playwright-service-worker" }));
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/raw-device|raw-location|Bearer secret|sid=secret/);
  });

  test.each([
    ["Buffer", Buffer.from([1, 2, 3, 4]), Buffer.from([1, 2, 3, 4])],
    ["ArrayBuffer", Uint8Array.from([1, 2, 3, 4]).buffer, Buffer.from([1, 2, 3, 4])],
    ["typed array", Uint8Array.from([1, 2, 3, 4]), Buffer.from([1, 2, 3, 4])]
  ])("records Playwright %s websocket frames as metadata only", (_name, payload, bytes) => {
    const context = new Emitter();
    const write = vi.fn();
    installBrowserObserver(context, { write }, (value) => value);

    const socket = new Emitter() as Emitter & { url: () => string };
    socket.url = () => "wss://example.test/socket";
    context.emit("websocket", socket);
    socket.emit("framesent", { payload });

    const frameRecord = write.mock.calls.find(([record]) => record.source === "playwright-websocket-frame")?.[0];
    expect(frameRecord.payload).toMatchObject({
      direction: "sent",
      frame: {
        binary: true,
        byteLength: 4,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    });
    expect(JSON.stringify(frameRecord.payload)).not.toContain("[1,2,3,4]");
  });

  test("bounds Playwright text websocket frames by UTF-8 bytes before persistence", () => {
    const context = new Emitter();
    const write = vi.fn();
    installBrowserObserver(context, { write }, (value) => value, { textLimitBytes: 5 });

    const socket = new Emitter() as Emitter & { url: () => string };
    socket.url = () => "wss://example.test/socket";
    context.emit("websocket", socket);
    socket.emit("framereceived", { payload: "가나다" });

    const frameRecord = write.mock.calls.find(([record]) => record.source === "playwright-websocket-frame")?.[0];
    expect(frameRecord.payload).toMatchObject({
      direction: "received",
      frame: {
        payload: "가",
        byteLength: 9,
        truncated: true
      }
    });
  });

  test("tags Playwright websocket frames with a per-socket connection id", () => {
    const context = new Emitter();
    const write = vi.fn();
    installBrowserObserver(context, { write }, (value) => value);

    const first = new Emitter() as Emitter & { url: () => string };
    first.url = () => "wss://example.test/socket";
    const second = new Emitter() as Emitter & { url: () => string };
    second.url = () => "wss://example.test/socket";

    context.emit("websocket", first);
    context.emit("websocket", second);
    first.emit("framesent", { payload: '421["find","api/room",{}]' });
    second.emit("framereceived", { payload: "431[null,[]]" });

    const frames = write.mock.calls
      .map(([record]) => record)
      .filter((record) => record.source === "playwright-websocket-frame")
      .map((record) => record.payload);
    expect(frames).toEqual([
      expect.objectContaining({ direction: "sent", connectionId: "pw_ws_1" }),
      expect.objectContaining({ direction: "received", connectionId: "pw_ws_2" })
    ]);
  });

  test("offers raw text frames only to the explicit in-memory observer before sanitization", () => {
    const context = new Emitter();
    const write = vi.fn();
    const onRawWebSocketFrame = vi.fn();
    installBrowserObserver(context, { write }, () => ({ redacted: true }), {
      onRawWebSocketFrame
    });
    const socket = new Emitter() as Emitter & { url: () => string };
    socket.url = () => "wss://example.test/socket";

    context.emit("websocket", socket);
    socket.emit("framereceived", { payload: "raw-session-only" });
    socket.emit("framesent", { payload: Uint8Array.from([1, 2, 3]) });

    expect(onRawWebSocketFrame).toHaveBeenCalledOnce();
    expect(onRawWebSocketFrame).toHaveBeenCalledWith(
      "received",
      "raw-session-only",
      "pw_ws_1"
    );
    expect(JSON.stringify(write.mock.calls)).not.toContain("raw-session-only");
  });

  test("reports only SmartThings Socket.IO closes to the recovery observer", () => {
    const context = new Emitter();
    const write = vi.fn();
    const onSmartThingsWebSocketClose = vi.fn();
    installBrowserObserver(context, { write }, (value) => value, {
      onSmartThingsWebSocketClose
    });
    const smartThings = new Emitter() as Emitter & { url: () => string };
    smartThings.url = () => "wss://my.smartthings.com/socket.io/?EIO=4&transport=websocket";
    const unrelated = new Emitter() as Emitter & { url: () => string };
    unrelated.url = () => "wss://example.test/socket.io/";

    context.emit("websocket", smartThings);
    context.emit("websocket", unrelated);
    smartThings.emit("close", undefined);
    unrelated.emit("close", undefined);

    expect(onSmartThingsWebSocketClose).toHaveBeenCalledOnce();
    expect(onSmartThingsWebSocketClose).toHaveBeenCalledWith(
      "wss://my.smartthings.com/socket.io/?EIO=4&transport=websocket",
      "pw_ws_1"
    );
  });

  test("redacts Playwright websocket text before byte bounding and persistence", async () => {
    await withPersistedCaptures((store, redact) => {
      const context = new Emitter();
      installBrowserObserver(context, store, redact, { textLimitBytes: 18 });
      const socket = new Emitter() as Emitter & { url: () => string };
      socket.url = () => "wss://example.test/socket";
      const payload =
        '{"token":"secret-super-sensitive-suffix","locationId":"raw-location-001","deviceId":"raw-device-001"}';

      context.emit("websocket", socket);
      socket.emit("framereceived", { payload });

      const rows = store.listRecent(5);
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain("secret");
      expect(persisted).not.toContain("super-sensitive-suffix");
      expect(persisted).not.toContain("raw-location-001");
      expect(persisted).not.toContain("raw-device-001");

      const frameRow = rows.find((row) => row.source === "playwright-websocket-frame");
      const framePayload = JSON.parse(frameRow?.payload ?? "{}") as {
        frame?: { byteLength?: number; truncated?: boolean };
      };
      expect(framePayload.frame).toMatchObject({
        byteLength: Buffer.byteLength(payload, "utf8"),
        truncated: true
      });
    });
  });

  test("attaches console and crash listeners to existing and future pages", () => {
    const existingPage = new Emitter();
    const futurePage = new Emitter();
    const context = new Emitter() as Emitter & { pages: () => Emitter[] };
    context.pages = () => [existingPage];
    const write = vi.fn();

    installBrowserObserver(context, { write }, (value) => value);
    context.emit("page", futurePage);
    existingPage.emit("console", { type: () => "warn", text: () => "existing-page" });
    futurePage.emit("crash", undefined);

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "page-console" }));
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ source: "page-lifecycle", payload: expect.objectContaining({ event: "crash" }) })
    );
  });

  test("records service-worker lifecycle metadata without script interception", () => {
    const context = new Emitter() as Emitter & { route?: unknown };
    const worker = new Emitter() as Emitter & { url: () => string };
    worker.url = () => "https://example.test/sw.js";
    const write = vi.fn();

    installBrowserObserver(context, { write }, (value) => value);
    context.emit("serviceworker", worker);
    worker.emit("close", undefined);

    expect(context.route).toBeUndefined();
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "playwright-service-worker",
        payload: expect.objectContaining({ url: "https://example.test/sw.js", event: "created" })
      })
    );
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "playwright-service-worker",
        payload: expect.objectContaining({ url: "https://example.test/sw.js", event: "close" })
      })
    );
  });

  test("records existing service workers and avoids duplicate close listeners", () => {
    const existingWorker = new Emitter() as Emitter & { url: () => string };
    existingWorker.url = () => "https://example.test/existing-sw.js";
    const context = new Emitter() as Emitter & { serviceWorkers: () => Emitter[] };
    context.serviceWorkers = () => [existingWorker];
    const write = vi.fn();

    installBrowserObserver(context, { write }, (value) => value);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "playwright-service-worker",
        payload: expect.objectContaining({ url: "https://example.test/existing-sw.js", event: "created" })
      })
    );

    context.emit("serviceworker", existingWorker);
    existingWorker.emit("close", undefined);

    const serviceWorkerPayloads = write.mock.calls
      .map(([record]) => record)
      .filter((record) => record.source === "playwright-service-worker")
      .map((record) => record.payload);
    expect(serviceWorkerPayloads).toEqual([
      expect.objectContaining({ url: "https://example.test/existing-sw.js", event: "created" }),
      expect.objectContaining({ url: "https://example.test/existing-sw.js", event: "close" })
    ]);
    expect(existingWorker.handlers.get("close")).toHaveLength(1);
  });
});
