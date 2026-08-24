import { describe, expect, test } from "vitest";

import { startupFailureToken } from "../src/main.js";

describe("startup failure diagnostics", () => {
  test("reports only allowlisted error-code characters", () => {
    expect(startupFailureToken({ code: "EACCES" })).toBe("EACCES");
    expect(startupFailureToken({ code: "SQLITE_CANTOPEN" })).toBe("SQLITE_CANTOPEN");
  });

  test("does not expose messages, paths, or malformed codes", () => {
    expect(startupFailureToken(new Error("secret path /data/private"))).toBe("UNKNOWN");
    expect(startupFailureToken({ code: "EACCES:/data/private" })).toBe("UNKNOWN");
    expect(startupFailureToken({ code: "" })).toBe("UNKNOWN");
  });
});
