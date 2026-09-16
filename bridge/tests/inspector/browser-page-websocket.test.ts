import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { installBrowserObserver } from "../../src/inspector/browser-observer.js";

const url = "wss://my.smartthings.com/socket.io/?transport=websocket";
function fixture() {
  const page = new EventEmitter();
  const context = Object.assign(new EventEmitter(), { pages: () => [page] });
  const frame = vi.fn(); const close = vi.fn(); const write = vi.fn();
  installBrowserObserver(context, { write }, (value) => value,
    { onSmartThingsWebSocketFrame: frame, onSmartThingsWebSocketClose: close });
  const socket = Object.assign(new EventEmitter(), { url: () => url });
  return { page, context, socket, frame, close, write };
}

describe("page-scoped Playwright websocket observation", () => {
  test("captures socket frames emitted by an existing Page", () => {
    const f = fixture(); f.page.emit("websocket", f.socket);
    f.socket.emit("framereceived", { payload: "2" });
    expect(f.frame).toHaveBeenCalledWith("received", url, "pw_ws_1", f.page);
    expect(f.write.mock.calls.some(([record]) => record.source === "playwright-websocket-frame")).toBe(true);
  });
  test("attaches to pages created after the observer", () => {
    const f = fixture(); const newPage = new EventEmitter();
    f.context.emit("page", newPage); newPage.emit("websocket", f.socket);
    f.socket.emit("framereceived", { payload: "2" });
    expect(f.frame).toHaveBeenCalledWith("received", url, "pw_ws_1", newPage);
  });
  test("deduplicates context and page delivery while retaining the page owner", () => {
    const f = fixture(); f.context.emit("websocket", f.socket); f.page.emit("websocket", f.socket);
    f.context.emit("page", f.page); f.page.emit("websocket", f.socket);
    f.socket.emit("framereceived", { payload: "2" });
    expect(f.frame).toHaveBeenCalledOnce();
    expect(f.frame).toHaveBeenCalledWith("received", url, "pw_ws_1", f.page);
  });
  test("includes the originating page on close without confusing other tabs", () => {
    const f = fixture(); f.page.emit("websocket", f.socket); f.socket.emit("close");
    expect(f.close).toHaveBeenCalledWith(url, "pw_ws_1", f.page);
  });
  test("keeps context-only adapter compatibility", () => {
    const f = fixture(); f.context.emit("websocket", f.socket);
    f.socket.emit("framereceived", { payload: "2" });
    expect(f.frame).toHaveBeenCalledWith("received", url, "pw_ws_1");
  });
});
