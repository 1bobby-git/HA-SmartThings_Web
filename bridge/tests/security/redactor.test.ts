import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { SqliteAliasStore } from "../../src/security/alias-store.js";
import { createRedactor } from "../../src/security/redactor.js";

const raw = {
  locationId: "loc-raw-7d99e9a2",
  device_id: "dev-raw-70b36b31",
  userId: "user-raw-7a0e92c1",
  token: "tok_live_abcdef0123456789",
  ip: "203.0.113.77",
  ipv6: "2001:db8:85a3::8a2e:370:7334",
  uuid: "7e57c0de-1234-4d3a-9aa7-b78da775b8f5",
  csrf: "csrf-live-012345"
};

function withRedactor<T>(fn: (redact: ReturnType<typeof createRedactor>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "stw-redactor-"));
  let aliases: SqliteAliasStore | undefined;
  try {
    aliases = new SqliteAliasStore(join(root, "aliases.sqlite"), "unit-secret");
    return fn(createRedactor(aliases));
  } finally {
    aliases?.close();
    rmSync(root, { force: true, recursive: true });
  }
}

describe("redactor", () => {
  test("redacts nested JSON, headers, raw IDs, URL query values, and IP addresses", () => {
    withRedactor((redact) => {
      const sanitized = redact({
        url: `https://example.test/device?locationId=${raw.locationId}&session_token=${raw.token}&safe=ok`,
        headers: {
          authorization: `Bearer ${raw.token}`,
          cookie: `sid=${raw.token}`,
          "x-request-id": "synthetic-request"
        },
        body: {
          locationId: raw.locationId,
          device_id: raw.device_id,
          userId: raw.userId,
          nested: {
            password: "p@ssw0rd!",
            remoteAddress: raw.ip,
            csrfToken: raw.csrf
          }
        }
      });

      const text = JSON.stringify(sanitized);
      expect(text).not.toContain(raw.locationId);
      expect(text).not.toContain(raw.device_id);
      expect(text).not.toContain(raw.userId);
      expect(text).not.toContain(raw.token);
      expect(text).not.toContain(raw.ip);
      expect(text).not.toContain(raw.csrf);
      expect(text).toContain("loc_001");
      expect(text).toContain("dev_001");
      expect(text).toMatch(/user_[a-f0-9]{12}/);
      expect(text).toContain("[REDACTED]");
      expect((sanitized as { url: string }).url).toContain("safe=ok");
    });
  });

  test("redacts JSON string frames and preserves stable aliases across calls", () => {
    withRedactor((redact) => {
      const first = redact(
        JSON.stringify({
          event: "device",
          location_id: raw.locationId,
          deviceId: raw.device_id,
          setCookie: `sid=${raw.token}`
        })
      );
      const second = redact({
        locationId: raw.locationId,
        device_id: raw.device_id
      });

      const text = JSON.stringify([first, second]);
      expect(text).not.toContain(raw.locationId);
      expect(text).not.toContain(raw.device_id);
      expect(text).not.toContain(raw.token);
      expect(text.match(/loc_001/g)?.length).toBe(2);
      expect(text.match(/dev_001/g)?.length).toBe(2);
      expect(text).toContain("[REDACTED]");
    });
  });

  test("redacts sensitive values in non-JSON text", () => {
    withRedactor((redact) => {
      const sanitized = redact(
        `authorization=Bearer ${raw.token} ip=${raw.ip} deviceId=${raw.device_id} locationId=${raw.locationId}`
      );

      expect(sanitized).not.toContain(raw.token);
      expect(sanitized).not.toContain(raw.ip);
      expect(sanitized).not.toContain(raw.device_id);
      expect(sanitized).not.toContain(raw.locationId);
      expect(sanitized).toContain("loc_001");
      expect(sanitized).toContain("dev_001");
      expect(sanitized).toContain("[REDACTED]");
    });
  });

  test("redacts IPv6 addresses in non-JSON text", () => {
    withRedactor((redact) => {
      const sanitized = redact(`peer=${raw.ipv6} event=connected`);

      expect(sanitized).not.toContain(raw.ipv6);
      expect(sanitized).toContain("[REDACTED]");
    });
  });

  test("redacts session query values", () => {
    withRedactor((redact) => {
      const sanitized = redact({
        url: "https://example.test/?session=alpha-session&session_id=beta-session&session-token=gamma-session&safe=ok"
      });

      const url = (sanitized as { url: string }).url;
      expect(url).not.toContain("alpha-session");
      expect(url).not.toContain("beta-session");
      expect(url).not.toContain("gamma-session");
      expect(url).toContain("session=[REDACTED]");
      expect(url).toContain("session_id=[REDACTED]");
      expect(url).toContain("session-token=[REDACTED]");
      expect(url).toContain("safe=ok");
    });
  });

  test("redacts UUID-like raw IDs embedded in URL paths and text", () => {
    withRedactor((redact) => {
      const first = redact({
        url: `https://example.test/locations/${raw.uuid}/devices/${raw.uuid}`
      });
      const second = redact(`observed raw id ${raw.uuid} in frame`);

      const text = JSON.stringify([first, second]);
      expect(text).not.toContain(raw.uuid);
      expect(text.match(/identifier_[a-f0-9]{12}/g)?.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("aliases plural ID arrays by their parent key kind", () => {
    withRedactor((redact) => {
      const sanitized = redact({
        deviceIds: ["device-raw-a", "device-raw-b"],
        locationIds: ["location-raw-a", "location-raw-b"],
        accountIds: ["account-raw-a", "account-raw-b"],
        userIds: ["user-raw-a", "user-raw-b"]
      });

      const text = JSON.stringify(sanitized);
      expect(text).not.toContain("device-raw-a");
      expect(text).not.toContain("device-raw-b");
      expect(text).not.toContain("location-raw-a");
      expect(text).not.toContain("location-raw-b");
      expect(text).not.toContain("account-raw-a");
      expect(text).not.toContain("account-raw-b");
      expect(text).not.toContain("user-raw-a");
      expect(text).not.toContain("user-raw-b");
      expect(text).toContain("dev_001");
      expect(text).toContain("dev_002");
      expect(text).toContain("loc_001");
      expect(text).toContain("loc_002");
      expect(text).toMatch(/account_[a-f0-9]{12}/);
      expect(text).toMatch(/user_[a-f0-9]{12}/);
    });
  });

  test("sanitizes balanced embedded JSON segments in surrounding text", () => {
    withRedactor((redact) => {
      const embeddedDevice = "embedded-device-raw";
      const embeddedLocation = "embedded-location-raw";
      const embeddedUser = "embedded-user-raw";
      const embeddedToken = "embedded-token-raw";
      const sanitized = redact(
        `prefix frame={"deviceId":"${embeddedDevice}","token":"${embeddedToken}","nested":{"locationIds":["${embeddedLocation}"],"items":[{"userId":"${embeddedUser}"}]}} suffix`
      );

      expect(sanitized).toContain("prefix frame=");
      expect(sanitized).toContain(" suffix");
      expect(sanitized).not.toContain(embeddedDevice);
      expect(sanitized).not.toContain(embeddedLocation);
      expect(sanitized).not.toContain(embeddedUser);
      expect(sanitized).not.toContain(embeddedToken);
      expect(sanitized).toContain("dev_001");
      expect(sanitized).toContain("loc_001");
      expect(sanitized).toMatch(/user_[a-f0-9]{12}/);
      expect(sanitized).toContain("[REDACTED]");
    });
  });
});
