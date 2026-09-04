import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";

import { SseEventWriter } from "../../src/server/http-server.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  acceptsWrites = true;
  readonly writes: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(String(chunk));
    return this.acceptsWrites;
  }
}

const responseFor = (response: FakeResponse): ServerResponse =>
  response as unknown as ServerResponse;

describe("SseEventWriter", () => {
  test("coalesces rapid inventory markers to the newest sequence", async () => {
    vi.useFakeTimers();
    try {
      const response = new FakeResponse();
      const writer = new SseEventWriter(responseFor(response), () => 3, {
        inventoryCoalesceMs: 75
      });

      writer.write({ schemaVersion: 1, sequence: 1, type: "inventory" });
      writer.write({ schemaVersion: 1, sequence: 2, type: "inventory" });
      writer.write({ schemaVersion: 1, sequence: 3, type: "inventory" });
      expect(response.writes).toEqual([]);

      await vi.advanceTimersByTimeAsync(75);

      expect(response.writes).toEqual([
        'data: {"schemaVersion":1,"sequence":3,"type":"inventory"}\n\n'
      ]);
      writer.close();
    } finally {
      vi.useRealTimers();
    }
  });

  test("flushes a pending inventory marker before a following state event", () => {
    const response = new FakeResponse();
    const writer = new SseEventWriter(responseFor(response), () => 2);

    writer.write({ schemaVersion: 1, sequence: 1, type: "inventory" });
    writer.write({
      schemaVersion: 1,
      sequence: 2,
      type: "state",
      deviceId: "dev_001",
      state: {
        component: "main",
        capability: "switch",
        attribute: "switch",
        value: "on",
        unit: null,
        updatedAt: "2026-09-04T00:00:00Z"
      }
    });

    expect(response.writes).toHaveLength(2);
    expect(response.writes[0]).toContain('"type":"inventory"');
    expect(response.writes[1]).toContain('"type":"state"');
    writer.close();
  });

  test("collapses an overflowing blocked queue to one recovery inventory marker", () => {
    const response = new FakeResponse();
    response.acceptsWrites = false;
    let sequence = 1;
    const writer = new SseEventWriter(responseFor(response), () => sequence, {
      inventoryCoalesceMs: 0,
      maxPendingEvents: 2
    });

    writer.write({ schemaVersion: 1, sequence, type: "state" });
    for (sequence = 2; sequence <= 4; sequence += 1) {
      writer.write({ schemaVersion: 1, sequence, type: "state" });
    }
    sequence = 4;
    response.acceptsWrites = true;
    response.emit("drain");

    expect(response.writes).toHaveLength(2);
    expect(response.writes[1]).toBe(
      'data: {"schemaVersion":1,"sequence":4,"type":"inventory"}\n\n'
    );
    writer.close();
  });
});
