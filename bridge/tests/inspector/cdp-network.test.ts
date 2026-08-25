import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { installCdpNetworkObserver } from "../../src/inspector/cdp-network.js";
import { SqliteAliasStore } from "../../src/security/alias-store.js";
import { createRedactor } from "../../src/security/redactor.js";
import { CaptureStore } from "../../src/state/capture-store.js";

class FakeSession {
  handlers = new Map<string, ((payload: unknown) => void)[]>();
  bodyResult: unknown = { body: '{"locationId":"raw-location","token":"secret"}', base64Encoded: false };
  send = vi.fn(async (method: string) => {
    if (method === "Network.getResponseBody") {
      if (this.bodyResult instanceof Error) {
        throw this.bodyResult;
      }
      return this.bodyResult;
    }
    return {};
  });

  on(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  async emit(event: string, payload: unknown): Promise<void> {
    await Promise.all((this.handlers.get(event) ?? []).map((handler) => handler(payload)));
  }
}

async function withPersistedCaptures<T>(
  fn: (store: CaptureStore, redact: ReturnType<typeof createRedactor>) => T | Promise<T>
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "stw-cdp-capture-"));
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

describe("installCdpNetworkObserver", () => {
  test("records sanitized CDP frames and bounded response bodies", async () => {
    const session = new FakeSession();
    const write = vi.fn();
    const redact = vi.fn((value: unknown) =>
      JSON.parse(JSON.stringify(value).replaceAll("raw-location", "loc_001").replaceAll("secret", "[REDACTED]"))
    );

    await installCdpNetworkObserver(session, { write }, redact, { responseBodyLimitBytes: 200 });
    await session.emit("Network.webSocketFrameReceived", {
      requestId: "1",
      response: { payloadData: '{"locationId":"raw-location"}', opcode: 1 }
    });
    await session.emit("Network.eventSourceMessageReceived", {
      requestId: "2",
      eventName: "message",
      data: '{"token":"secret"}'
    });
    await session.emit("Network.responseReceived", {
      requestId: "3",
      response: { mimeType: "application/json", url: "https://example.test/state" },
      type: "XHR"
    });
    await session.handlers.get("Network.loadingFinished")?.[0]?.({ requestId: "3" });

    expect(session.send).toHaveBeenCalledWith("Network.enable");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "cdp-websocket-frame" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "cdp-eventsource" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ source: "cdp-response-body" }));
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/raw-location|secret/);
  });

  test("records CDP binary websocket frames as decoded metadata without raw payload", async () => {
    const session = new FakeSession();
    const write = vi.fn();
    await installCdpNetworkObserver(session, { write }, (value) => value);
    const bytes = Uint8Array.from([0, 1, 2, 3, 4]);
    const payloadData = Buffer.from(bytes).toString("base64");

    await session.emit("Network.webSocketFrameReceived", {
      requestId: "1",
      response: { payloadData, opcode: 2 }
    });

    const frameRecord = write.mock.calls.find(([record]) => record.source === "cdp-websocket-frame")?.[0];
    expect(frameRecord.payload).toMatchObject({
      direction: "received",
      payload: {
        opcode: 2,
        binary: true,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    });
    expect(JSON.stringify(frameRecord.payload)).not.toContain(payloadData);
  });

  test("bounds CDP opcode-1 websocket payloadData by UTF-8 bytes", async () => {
    const session = new FakeSession();
    const write = vi.fn();
    const redact = vi.fn((value: unknown) =>
      JSON.parse(JSON.stringify(value).replaceAll("raw-location", "loc_001").replaceAll("secret", "[REDACTED]"))
    );

    const payloadData = '{"locationId":"raw-location","suffix":"secret-tail"}';

    await installCdpNetworkObserver(session, { write }, redact, { responseBodyLimitBytes: 12 });
    await session.emit("Network.webSocketFrameReceived", {
      requestId: "1",
      response: {
        payloadData,
        opcode: 1
      }
    });

    const frameRecord = write.mock.calls.find(([record]) => record.source === "cdp-websocket-frame")?.[0];
    expect(frameRecord.payload).toMatchObject({
      direction: "received",
      payload: {
        requestId: "1",
        response: {
          opcode: 1,
          payloadData: '{"locationId',
          byteLength: Buffer.byteLength(payloadData, "utf8"),
          truncated: true
        }
      }
    });
    expect(JSON.stringify(frameRecord.payload)).not.toMatch(/raw-location|secret-tail/);
  });

  test("tags CDP websocket frames with a session-scoped Chrome request id", async () => {
    const session = new FakeSession();
    const write = vi.fn();

    await installCdpNetworkObserver(session, { write }, (value) => value);
    await session.emit("Network.webSocketFrameSent", {
      requestId: "socket-1",
      response: { payloadData: '421["find","api/room",{}]', opcode: 1 }
    });
    await session.emit("Network.webSocketFrameReceived", {
      requestId: "socket-2",
      response: { payloadData: "431[null,[]]", opcode: 1 }
    });

    const frames = write.mock.calls
      .map(([record]) => record)
      .filter((record) => record.source === "cdp-websocket-frame")
      .map((record) => record.payload);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(
      expect.objectContaining({ direction: "sent", connectionId: expect.stringMatching(/:socket-1$/u) })
    );
    expect(frames[1]).toEqual(
      expect.objectContaining({ direction: "received", connectionId: expect.stringMatching(/:socket-2$/u) })
    );
    expect(String(frames[0]?.connectionId).split(":", 1)[0]).toBe(
      String(frames[1]?.connectionId).split(":", 1)[0]
    );
  });

  test("keeps reused Chrome request ids isolated across CDP sessions", async () => {
    const first = new FakeSession();
    const second = new FakeSession();
    const firstObserver = vi.fn();
    const secondObserver = vi.fn();

    await installCdpNetworkObserver(first, { write: vi.fn() }, (value) => value, {
      onRawWebSocketFrame: firstObserver
    });
    await installCdpNetworkObserver(second, { write: vi.fn() }, (value) => value, {
      onRawWebSocketFrame: secondObserver
    });
    const payload = {
      requestId: "socket-1",
      response: { payloadData: '421["get","api/camera/thumbnail","raw-camera-uuid",{}]', opcode: 1 }
    };

    await first.emit("Network.webSocketFrameSent", payload);
    await second.emit("Network.webSocketFrameSent", payload);

    const firstConnection = firstObserver.mock.calls[0]?.[2];
    const secondConnection = secondObserver.mock.calls[0]?.[2];
    expect(firstConnection).toMatch(/:socket-1$/u);
    expect(secondConnection).toMatch(/:socket-1$/u);
    expect(firstConnection).not.toBe(secondConnection);
  });

  test("offers raw CDP text websocket frames only to the explicit in-memory observer before sanitization", async () => {
    const session = new FakeSession();
    const write = vi.fn();
    const onRawWebSocketFrame = vi.fn();

    await installCdpNetworkObserver(session, { write }, () => ({ redacted: true }), {
      onRawWebSocketFrame
    });
    await session.emit("Network.webSocketFrameSent", {
      requestId: "socket-1",
      response: {
        payloadData:
          '421["get","api/camera/thumbnail","raw-camera-uuid",{"token":"secret"}]',
        opcode: 1
      }
    });
    await session.emit("Network.webSocketFrameReceived", {
      requestId: "socket-1",
      response: { payloadData: "raw-binary-value", opcode: 2 }
    });

    expect(onRawWebSocketFrame).toHaveBeenCalledOnce();
    expect(onRawWebSocketFrame).toHaveBeenCalledWith(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-uuid",{"token":"secret"}]',
      expect.stringMatching(/:socket-1$/u)
    );
    expect(JSON.stringify(write.mock.calls)).not.toMatch(/raw-camera-uuid|secret/);
  });

  test("redacts CDP opcode-1 websocket payloadData before byte bounding and persistence", async () => {
    await withPersistedCaptures(async (store, redact) => {
      const session = new FakeSession();
      const payloadData =
        '{"token":"secret-super-sensitive-suffix","locationId":"raw-location-001","deviceId":"raw-device-001"}';

      await installCdpNetworkObserver(session, store, redact, { responseBodyLimitBytes: 18 });
      await session.emit("Network.webSocketFrameReceived", {
        requestId: "1",
        response: { payloadData, opcode: 1 }
      });

      const rows = store.listRecent(5);
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain("secret");
      expect(persisted).not.toContain("super-sensitive-suffix");
      expect(persisted).not.toContain("raw-location-001");
      expect(persisted).not.toContain("raw-device-001");

      const framePayload = JSON.parse(rows[0]?.payload ?? "{}") as {
        payload?: { response?: { byteLength?: number; truncated?: boolean } };
      };
      expect(framePayload.payload?.response).toMatchObject({
        byteLength: Buffer.byteLength(payloadData, "utf8"),
        truncated: true
      });
    });
  });

  test("bounds EventSource data by UTF-8 bytes", async () => {
    const session = new FakeSession();
    const write = vi.fn();
    const redact = vi.fn((value: unknown) =>
      JSON.parse(JSON.stringify(value).replaceAll("raw-location", "loc_001").replaceAll("secret", "[REDACTED]"))
    );

    const data = "가나다 raw-location secret-tail";

    await installCdpNetworkObserver(session, { write }, redact, { responseBodyLimitBytes: 5 });
    await session.emit("Network.eventSourceMessageReceived", {
      requestId: "2",
      eventName: "message",
      data
    });

    const eventRecord = write.mock.calls.find(([record]) => record.source === "cdp-eventsource")?.[0];
    expect(eventRecord.payload).toMatchObject({
      requestId: "2",
      eventName: "message",
      data: "가",
      byteLength: Buffer.byteLength(data, "utf8"),
      truncated: true
    });
    expect(JSON.stringify(eventRecord.payload)).not.toMatch(/raw-location|secret-tail/);
  });

  test("redacts EventSource data before byte bounding and persistence", async () => {
    await withPersistedCaptures(async (store, redact) => {
      const session = new FakeSession();
      const data =
        '{"token":"secret-super-sensitive-suffix","locationId":"raw-location-001","deviceId":"raw-device-001"}';

      await installCdpNetworkObserver(session, store, redact, { responseBodyLimitBytes: 18 });
      await session.emit("Network.eventSourceMessageReceived", {
        requestId: "2",
        eventName: "message",
        data
      });

      const rows = store.listRecent(5);
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain("secret");
      expect(persisted).not.toContain("super-sensitive-suffix");
      expect(persisted).not.toContain("raw-location-001");
      expect(persisted).not.toContain("raw-device-001");

      const eventPayload = JSON.parse(rows[0]?.payload ?? "{}") as { byteLength?: number; truncated?: boolean };
      expect(eventPayload).toMatchObject({
        byteLength: Buffer.byteLength(data, "utf8"),
        truncated: true
      });
    });
  });

  test("bounds textual XHR and fetch response bodies by UTF-8 bytes", async () => {
    const session = new FakeSession();
    session.bodyResult = { body: "가나다", base64Encoded: false };
    const write = vi.fn();

    await installCdpNetworkObserver(session, { write }, (value) => value, { responseBodyLimitBytes: 5 });
    await session.emit("Network.responseReceived", {
      requestId: "xhr-1",
      response: { mimeType: "application/json", url: "https://example.test/state" },
      type: "XHR"
    });
    await session.emit("Network.loadingFinished", { requestId: "xhr-1" });
    await session.emit("Network.responseReceived", {
      requestId: "fetch-1",
      response: { mimeType: "text/plain", url: "https://example.test/fetch" },
      type: "Fetch"
    });
    await session.emit("Network.loadingFinished", { requestId: "fetch-1" });

    const bodies = write.mock.calls
      .map(([record]) => record)
      .filter((record) => record.source === "cdp-response-body")
      .map((record) => record.payload);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: "xhr-1", body: "가", byteLength: 9, truncated: true }),
        expect.objectContaining({ requestId: "fetch-1", body: "가", byteLength: 9, truncated: true })
      ])
    );
  });

  test("redacts XHR and fetch bodies before byte bounding and persistence", async () => {
    await withPersistedCaptures(async (store, redact) => {
      const session = new FakeSession();
      const body =
        '{"token":"secret-super-sensitive-suffix","locationId":"raw-location-001","deviceId":"raw-device-001"}';
      session.bodyResult = { body, base64Encoded: false };

      await installCdpNetworkObserver(session, store, redact, { responseBodyLimitBytes: 18 });
      for (const requestId of ["xhr-1", "fetch-1"]) {
        await session.emit("Network.responseReceived", {
          requestId,
          response: { mimeType: "application/json", url: `https://example.test/${requestId}` },
          type: requestId.startsWith("xhr") ? "XHR" : "Fetch"
        });
        await session.emit("Network.loadingFinished", { requestId });
      }

      const rows = store.listRecent(5);
      const persisted = JSON.stringify(rows);
      expect(persisted).not.toContain("secret");
      expect(persisted).not.toContain("super-sensitive-suffix");
      expect(persisted).not.toContain("raw-location-001");
      expect(persisted).not.toContain("raw-device-001");

      const bodyPayloads = rows
        .filter((row) => row.source === "cdp-response-body")
        .map((row) => JSON.parse(row.payload) as { byteLength?: number; truncated?: boolean });
      expect(bodyPayloads).toHaveLength(2);
      expect(bodyPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ byteLength: Buffer.byteLength(body, "utf8"), truncated: true }),
          expect.objectContaining({ byteLength: Buffer.byteLength(body, "utf8"), truncated: true })
        ])
      );
    });
  });

  test("records generic body-unavailable metadata when getResponseBody fails", async () => {
    const session = new FakeSession();
    session.bodyResult = new Error("token=secret raw-location stack details");
    const write = vi.fn();

    await installCdpNetworkObserver(session, { write }, (value) => value);
    await session.emit("Network.responseReceived", {
      requestId: "3",
      response: { mimeType: "application/json", url: "https://example.test/state" },
      type: "XHR"
    });
    await expect(session.emit("Network.loadingFinished", { requestId: "3" })).resolves.toBeUndefined();

    const bodyRecord = write.mock.calls.find(([record]) => record.source === "cdp-response-body")?.[0];
    expect(bodyRecord.payload).toMatchObject({
      requestId: "3",
      bodyUnavailable: true,
      error: "response body unavailable"
    });
    expect(JSON.stringify(bodyRecord.payload)).not.toMatch(/secret|raw-location|stack details/);
  });
});
