import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CameraImageStore } from "../../src/state/camera-image-store.js";
import type { BridgeInventory } from "../../src/state/device-store.js";

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

  test("accepts a signed thumbnail URL nested in the acknowledged data envelope", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([8, 9]), {
        status: 200,
        headers: { "content-type": "image/webp", "content-length": "2" }
      })
    );
    const store = createStore(fetchImage);

    store.observeRawWebSocketFrame(
      "sent",
      '421["get","api/camera/thumbnail","raw-camera-uuid",{}]',
      "cdp-session:socket-1"
    );
    store.observeRawWebSocketFrame(
      "received",
      '431[null,{"status":200,"data":{"url":"https://media.st-av.net/camera/image.webp?token=secret"}}]',
      "cdp-session:socket-1"
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(store.get("dev_001")?.body).toEqual(Buffer.from([8, 9]));
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

  test("seeds a camera image from normalized inventory image state", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([41, 42]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "2" }
      })
    );
    const store = createStore(fetchImage);

    store.observeInventory(
      inventoryWithImageState({
        deviceId: "dev_001",
        value: "https://media.st-av.net/camera/from-inventory.jpg?token=secret"
      })
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(store.get("dev_001")).toMatchObject({
      body: Buffer.from([41, 42]),
      contentType: "image/jpeg"
    });
  });

  test("downloads nested raw Advanced image state without relying on redacted inventory URL", async () => {
    const fetchImage = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("identifier_")) {
        return new Response(null, { status: 400 });
      }
      return new Response(Uint8Array.from([71, 72, 73]), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "3" }
      });
    });
    const store = createStore(fetchImage);

    store.observeInventory(
      inventoryWithImageState({
        deviceId: "dev_001",
        value:
          "https://mediaserv.media1208.ec2.st-av.net/image?source_id=identifier_camera&image_id=identifier_still"
      })
    );
    await store.whenIdle();
    expect(store.get("dev_001")).toBeUndefined();

    store.observeRawAdvancedDeviceSnapshot({
      items: [
        {
          deviceId: "raw-camera-uuid",
          locationId: "raw-location-001",
          status: {
            components: {
              main: {
                imageCapture: {
                  image: {
                    value:
                      "https://mediaserv.media1208.ec2.st-av.net/image?source_id=camera-source&image_id=still-001",
                    timestamp: "2026-08-25T02:00:00.000Z"
                  }
                }
              }
            }
          }
        }
      ]
    });
    await store.whenIdle();

    expect(fetchImage.mock.calls.map(([input]) => input.toString())).toEqual([
      "https://mediaserv.media1208.ec2.st-av.net/image?source_id=identifier_camera&image_id=identifier_still",
      "https://mediaserv.media1208.ec2.st-av.net/image?source_id=camera-source&image_id=still-001"
    ]);
    expect(store.get("dev_001")).toMatchObject({
      body: Buffer.from([71, 72, 73]),
      contentType: "image/jpeg"
    });
  });

  test("rejects unsafe inventory image URLs before fetching", async () => {
    const fetchImage = vi.fn<typeof fetch>();
    const store = createStore(fetchImage);

    store.observeInventory(
      inventoryWithImageState({
        deviceId: "dev_001",
        value: "https://example.com/private-camera.jpg"
      })
    );
    await store.whenIdle();

    expect(fetchImage).not.toHaveBeenCalled();
    expect(store.get("dev_001")).toBeUndefined();
  });

  test("rejects invalid inventory device aliases before fetching", async () => {
    const fetchImage = vi.fn<typeof fetch>();
    const store = createStore(fetchImage);

    store.observeInventory(
      inventoryWithImageState({
        deviceId: "raw-camera-uuid",
        value: "https://media.st-av.net/camera/from-inventory.jpg?token=secret"
      })
    );
    await store.whenIdle();

    expect(fetchImage).not.toHaveBeenCalled();
    expect(store.get("raw-camera-uuid")).toBeUndefined();
  });

  test("rejects non-image inventory downloads", async () => {
    const fetchImage = vi.fn(async () =>
      new Response(Uint8Array.from([60, 61]), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2" }
      })
    );
    const store = createStore(fetchImage);

    store.observeInventory(
      inventoryWithImageState({
        deviceId: "dev_001",
        value: "https://media.st-av.net/camera/not-image"
      })
    );
    await store.whenIdle();

    expect(fetchImage).toHaveBeenCalledOnce();
    expect(store.get("dev_001")).toBeUndefined();
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

  test("bounds a chunked image response before buffering the complete body", async () => {
    let cancelled = false;
    let pulls = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(Uint8Array.from([pulls, pulls]));
          },
          cancel() {
            cancelled = true;
          }
        },
        { highWaterMark: 0 }
      ),
      { status: 200, headers: { "content-type": "image/jpeg" } }
    );
    const arrayBufferSpy = vi.spyOn(response, "arrayBuffer");
    const fetchImage = vi.fn(async () => response);
    const store = createStore(fetchImage, 3);

    store.observeRawWebSocketFrame(
      "received",
      '42["api/subscription DEVICE_EVENT",{"data":{"device_event":{"device_id":"raw-camera-uuid","attribute":"image","value":"https://media.st-av.net/image"}}}]'
    );
    await store.whenIdle();

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
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

  test("associates a Socket.IO binary thumbnail with the camera from snapshot image state", async () => {
    const fetchImage = vi.fn<typeof fetch>();
    const store = createStore(fetchImage);
    const imageUrl =
      "https://mediaserv.media1208.ec2.st-av.net/image?source_id=camera-source&image_id=still-001";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

    store.observeRawWebSocketFrame(
      "received",
      `435[null,[{"deviceId":"raw-camera-uuid","componentId":"main","capabilityId":"imageCapture","attributeName":"image","value":"${imageUrl}","timestamp":"2026-08-25T02:00:00Z"}]]`,
      "socket-camera"
    );
    store.observeRawWebSocketFrame(
      "sent",
      `421["get","api/camera/thumbnail","${imageUrl}",{}]`,
      "socket-camera"
    );
    store.observeRawWebSocketFrame(
      "received",
      '461-1[null,{"_placeholder":true,"num":0}]',
      "socket-camera"
    );
    store.observeRawWebSocketBinaryFrame("received", jpeg, "socket-camera");
    await store.whenIdle();

    expect(fetchImage).not.toHaveBeenCalled();
    expect(store.get("dev_001")).toMatchObject({
      body: jpeg,
      contentType: "image/jpeg",
      capturedAt: "2026-08-25T02:00:00.000Z"
    });
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

function inventoryWithImageState(options: { deviceId: string; value: string }): BridgeInventory {
  return {
    schemaVersion: 1,
    sequence: 1,
    locations: [{ id: "loc_001", name: "Home" }],
    rooms: [],
    devices: [
      {
        id: options.deviceId,
        locationId: "loc_001",
        roomId: null,
        name: "Camera",
        type: "camera",
        online: true,
        states: [
          {
            component: "component_main",
            capability: "identifier_imageCapture",
            attribute: "image",
            value: options.value,
            unit: null,
            updatedAt: "2026-08-25T02:00:00.000Z"
          }
        ]
      }
    ],
    scenes: []
  };
}
