import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { EncryptedSessionStateStore, restoreSessionStorageState } from "../../src/security/session-state.js";

describe("encrypted SmartThings session state", () => {
  test("restores the complete verified Playwright state including IndexedDB", async () => {
    const state = {
      cookies: [{ name: "SamsungSession", value: "cookie", domain: ".smartthings.com", path: "/" }],
      origins: [{
        origin: "https://my.smartthings.com",
        localStorage: [{ name: "auth", value: "local" }],
        indexedDB: [{ name: "auth-db", version: 1, stores: [] }]
      }]
    };
    const setStorageState = vi.fn(async () => undefined);

    expect(await restoreSessionStorageState({ setStorageState }, state)).toBe("full");
    expect(setStorageState).toHaveBeenCalledWith(state);
  });

  test("reports legacy mode when full Playwright storage restore is unavailable", async () => {
    const state = { cookies: [{ name: "session" }], origins: [] };
    expect(await restoreSessionStorageState({}, state)).toBe("legacy");
  });

  test("round-trips without writing cookies or local storage in plaintext", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-session-state-"));
    try {
      const state = {
        cookies: [
          {
            name: "SamsungSession",
            value: "sensitive-cookie-value",
            domain: ".my.smartthings.com",
            path: "/",
            httpOnly: true,
            secure: true
          }
        ],
        origins: [
          {
            origin: "https://my.smartthings.com",
            localStorage: [{ name: "auth", value: "sensitive-local-storage-value" }]
          }
        ]
      };
      const store = new EncryptedSessionStateStore(
        join(root, "session-state.json"),
        "a".repeat(64)
      );

      store.save(state);

      const raw = readFileSync(join(root, "session-state.json"), "utf8");
      expect(raw).not.toContain("SamsungSession");
      expect(raw).not.toContain("sensitive-cookie-value");
      expect(raw).not.toContain("sensitive-local-storage-value");
      expect(store.load()).toEqual(state);
      expect(
        new EncryptedSessionStateStore(join(root, "session-state.json"), "b".repeat(64)).load()
      ).toBeUndefined();
      if (process.platform !== "win32") {
        expect(statSync(join(root, "session-state.json")).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects malformed storage state and keeps a missing backup non-fatal", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-session-state-invalid-"));
    try {
      const path = join(root, "session-state.json");
      const store = new EncryptedSessionStateStore(path, "a".repeat(64));

      expect(() => store.save({ cookies: [], origins: "not-an-array" })).toThrow(
        "invalid_session_storage_state"
      );
      expect(store.load()).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
