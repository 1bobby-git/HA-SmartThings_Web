import { describe, expect, test, vi } from "vitest";

import { installBrowserObserver } from "../../src/inspector/browser-observer.js";

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

describe("installBrowserObserver", () => {
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
});
