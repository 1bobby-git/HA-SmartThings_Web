import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { CaptureStore, sanitizeCaptureRecord } from "../../src/state/capture-store.js";

test("capture writes, reads, heartbeat and pruning reuse prepared statements", () => {
  const root = mkdtempSync(join(tmpdir(), "stw-capture-statements-"));
  const store = new CaptureStore(join(root, "bridge.sqlite"));
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    for (let index = 0; index < 105; index += 1) {
      const record = sanitizeCaptureRecord("unit", { index }, value => value);
      store.write(record);
      store.write(record);
      expect(store.ping()).toBe(true);
    }
    const rows = store.listRecent(200);
    expect(rows).toHaveLength(105);
    expect(JSON.parse(rows[0]?.payload ?? "null")).toEqual({ index: 104 });
    expect(prepare).not.toHaveBeenCalled();
  } finally {
    prepare.mockRestore();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
