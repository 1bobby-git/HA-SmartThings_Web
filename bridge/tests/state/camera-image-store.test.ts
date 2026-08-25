import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CameraImageStore } from "../../src/state/camera-image-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CameraImageStore", () => {
  test("downloads a camera thumbnail from the observed signed media URL and persists bytes only", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" }
      })
    );
    const store = createStore(fetchImage);

    store.observeRawWebSocketFrame(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-uuid",{}]'
    );
    store.observeRawWebSocketFrame(
      "received",
      '431[null,{"url":"https://mediaserv.media1203.ec2.st-av.net/image?token=raw-secret","type":"image/jpeg"}]'
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(store.get("dev_001")).toMatchObject({
      body: Buffer.from([1, 2, 3]),
      contentType: "image/jpeg",
      capturedAt: "2026-08-25T02:00:00.000Z"
    });
  });

  test("keeps pending thumbnail ACKs isolated by websocket connection", async () => {
    const fetchImage = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      const bytes = url.includes("/camera-a/")
        ? Uint8Array.from([10, 11])
        : Uint8Array.from([20, 21]);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": String(bytes.byteLength) }
      });
    });
    const store = createStore(fetchImage, undefined, (rawDeviceId) =>
      rawDeviceId === "raw-camera-a" ? "dev_001" : "dev_002"
    );

    store.observeRawWebSocketFrame(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-a",{}]',
      "socket-a"
    );
    store.observeRawWebSocketFrame(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-b",{}]',
      "socket-b"
    );
    store.observeRawWebSocketFrame(
      "received",
      '431[null,{"url":"https://media.st-av.net/camera-b/image.jpg?token=secret"}]',
      "socket-b"
    );
    store.observeRawWebSocketFrame(
      "received",
      '431[null,{"url":"https://media.st-av.net/camera-a/image.jpg?token=secret"}]',
      "socket-a"
    );
    await store.whenIdle();

    expect(store.get("dev_001")?.body).toEqual(Buffer.from([10, 11]));
    expect(store.get("dev_002")?.body).toEqual(Buffer.from([20, 21]));
  });

  test("refreshes from an authoritative DEVICE_EVENT image value", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([7, 8]), {
        status: 200,
        headers: { "content-type": "image/png" }
      })
    );
    const store = createStore(fetchImage);

    store.observeRawWebSocketFrame(
      "received",
      '42["api/subscription DEVICE_EVENT",{"data":{"device_event":{"device_id":"raw-camera-uuid","attribute":"image","value":"https://media.st-av.net/image?token=secret"}}}]'
    );
    await store.whenIdle();

    expect(store.get("dev_001")?.body).toEqual(Buffer.from([7, 8]));
  });

  test("rejects untrusted hosts, redirects, non-images, and oversized bodies", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([1]), { status: 200, headers: { "content-type": "text/html" } })
    );
    const store = createStore(fetchImage, 1);

    store.observeRawWebSocketFrame(
      "received",
      '42["api/subscription DEVICE_EVENT",{"data":{"device_event":{"device_id":"raw-camera-uuid","attribute":"image","value":"https://example.com/private"}}}]'
    );
    store.observeRawWebSocketFrame(
      "received",
      '42["api/subscription DEVICE_EVENT",{"data":{"device_event":{"device_id":"raw-camera-uuid","attribute":"image","value":"https://media.st-av.net/image"}}}]'
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(store.get("dev_001")).toBeUndefined();
  });

  test("restores a cached image after restart without persisting the signed URL", async () => {
    const root = temporaryRoot();
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([4, 5, 6]), {
        status: 200,
        headers: { "content-type": "image/webp" }
      })
    );
    const first = new CameraImageStore({
      dataDir: root,
      aliasDeviceId: () => "dev_001",
      fetchImage,
      now: () => new Date("2026-08-25T02:00:00.000Z")
    });
    first.observeRawWebSocketFrame(
      "received",
      '42["api/subscription DEVICE_EVENT",{"data":{"device_event":{"device_id":"raw-camera-uuid","attribute":"image","value":"https://media.st-av.net/image?token=secret"}}}]'
    );
    await first.whenIdle();

    const restored = new CameraImageStore({
      dataDir: root,
      aliasDeviceId: () => "dev_001",
      fetchImage
    });
    expect(restored.get("dev_001")?.body).toEqual(Buffer.from([4, 5, 6]));
  });
});

function createStore(
  fetchImage: typeof fetch,
  maxBytes?: number,
  aliasDeviceId: (rawDeviceId: string) => string = () => "dev_001"
): CameraImageStore {
  return new CameraImageStore({
    dataDir: temporaryRoot(),
    aliasDeviceId,
    fetchImage,
    now: () => new Date("2026-08-25T02:00:00.000Z"),
    ...(maxBytes === undefined ? {} : { maxBytes })
  });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stw-camera-image-"));
  roots.push(root);
  return root;
}
