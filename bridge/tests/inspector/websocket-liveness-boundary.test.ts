import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { installBrowserObserver } from "../../src/inspector/browser-observer.js";

const url = "wss://my.smartthings.com/socket.io/?transport=websocket";

describe("websocket capture and recovery boundaries", () => {
  test("outbound raw text reaches only the explicit camera observer, not recovery", () => {
    const context = new EventEmitter();
    const raw = vi.fn();
    const recovery = vi.fn();
    const write = vi.fn();
    installBrowserObserver(context, { write }, (value) => value, {
      onRawWebSocketFrame: raw, onSmartThingsWebSocketFrame: recovery
    });
    const socket = Object.assign(new EventEmitter(), { url: () => url });
    context.emit("websocket", socket);
    const payload = '42["deviceEvent",{"deviceId":"fixture-device","value":"on"}]';
    socket.emit("framesent", { payload });
    expect(raw).toHaveBeenCalledWith("sent", payload, "pw_ws_1");
    expect(recovery).not.toHaveBeenCalled();
    expect(write.mock.calls.some(([record]) => record.source === "playwright-websocket-frame")).toBe(true);
  });

  test("inbound recovery receives metadata only after the sanitized capture", () => {
    const context = new EventEmitter();
    const order: string[] = [];
    const write = vi.fn((record) => {
      if (record.source === "playwright-websocket-frame") order.push("capture");
    });
    const recovery = vi.fn(() => { order.push("recovery"); });
    installBrowserObserver(context, { write }, () => ({ redacted: true }), {
      onRawWebSocketFrame: () => { order.push("camera"); },
      onSmartThingsWebSocketFrame: recovery
    });
    const socket = Object.assign(new EventEmitter(), { url: () => url });
    context.emit("websocket", socket);
    socket.emit("framereceived", { payload: "fixture-private-payload" });
    expect(order).toEqual(["camera", "capture", "recovery"]);
    expect(recovery).toHaveBeenCalledWith("received", url, "pw_ws_1");
    expect(JSON.stringify(write.mock.calls)).not.toContain("fixture-private-payload");
    expect(JSON.stringify(recovery.mock.calls)).not.toContain("fixture-private-payload");
  });
});
