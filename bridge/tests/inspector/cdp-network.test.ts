import { describe, expect, test, vi } from "vitest";

import { installCdpNetworkObserver } from "../../src/inspector/cdp-network.js";

class FakeSession {
  handlers = new Map<string, ((payload: unknown) => void)[]>();
  send = vi.fn(async (method: string) => {
    if (method === "Network.getResponseBody") {
      return { body: '{"locationId":"raw-location","token":"secret"}', base64Encoded: false };
    }
    return {};
  });

  on(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
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
    session.emit("Network.webSocketFrameReceived", {
      requestId: "1",
      response: { payloadData: '{"locationId":"raw-location"}', opcode: 1 }
    });
    session.emit("Network.eventSourceMessageReceived", {
      requestId: "2",
      eventName: "message",
      data: '{"token":"secret"}'
    });
    session.emit("Network.responseReceived", {
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
});
