import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  formatSanitizedFixtureFinding,
  scanSanitizedFixtureText,
  scanSanitizedFixtures
} from "../tools/sanitized-fixture-audit.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ha-st-fixture-audit-"));
}

function write(root: string, path: string, text: string): void {
  const fullPath = join(root, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, text);
}

describe("sanitized fixture audit", () => {
  test("reports only path, rule, and jsonPath for unsafe fixture material", () => {
    const rawValues = {
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      bearer: "bEaReR abcdefghijklmnopqrstuvwxyz123456",
      ipv4: "192.0.2.44",
      ipv6: "2001:db8::44",
      access_token: "synthetic-token-value",
      device_id: "raw-device-id-value",
      locationId: "raw-location-id-value",
      account_id: "raw-account-id-value",
      userId: "raw-user-id-value",
      event_id: "raw-event-id-value",
      subscription_id: "raw-subscription-id-value",
      ack_id: "raw-ack-id-value"
    };

    const findings = scanSanitizedFixtureText("protocol/fixtures/bad.json", JSON.stringify(rawValues));

    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "uuid",
        "bearer-material",
        "ip-address",
        "sensitive-key",
        "identifier-value"
      ])
    );
    for (const finding of findings) {
      expect(Object.keys(finding).sort()).toEqual(["jsonPath", "path", "rule"]);
    }
    const serializedFindings = JSON.stringify(findings);
    for (const rawValue of Object.values(rawValues)) {
      expect(serializedFindings).not.toContain(rawValue);
    }
  });

  test("allows redacted sensitive keys, safe identifier aliases, and protocol field-name strings", () => {
    const findings = scanSanitizedFixtureText(
      "protocol/fixtures/good.json",
      JSON.stringify({
        access_token: "[REDACTED]",
        cookie: "[REDACTED]",
        device_id: "dev_001",
        locationId: "loc_001",
        account_id: "acct_001",
        userId: "user_001",
        event_id: "evt_001",
        subscription_id: "sub_001",
        ack_id: "ack_001",
        owner_id: "owner_001",
        deviceIds: [["dev_001", "dev_002"]],
        location_ids: [["loc_001", "loc_002"]],
        accountIds: [["acct_001"]],
        user_ids: [["user_001"]],
        eventIds: [["evt_001"]],
        subscription_ids: [["sub_001"]],
        ackIds: [["ack_001"]],
        event_name: "api/subscription DEVICE_EVENT",
        request_event: "find",
        request_query: "api/device/status",
        response_item_keys: ["deviceId", "locationId", "ownerId", "value", "id"]
      })
    );

    expect(findings).toEqual([]);
  });

  test("fails safely on malformed JSON without echoing text", () => {
    const findings = scanSanitizedFixtureText("protocol/fixtures/bad.json", "{");

    expect(findings).toEqual([
      {
        path: "protocol/fixtures/bad.json",
        rule: "invalid-json",
        jsonPath: "$"
      }
    ]);
  });

  test("scans every protocol fixture JSON file and keeps current fixtures clean", () => {
    expect(scanSanitizedFixtures()).toEqual([]);
  });

  test("scans protocol fixture files from an explicit root", () => {
    const root = tempRoot();
    write(root, "protocol/fixtures/nested/clean.json", "{\"device_id\":\"dev_001\"}\n");
    write(root, "protocol/fixtures/nested/dirty.json", "{\"device_id\":\"raw-device-id-value\"}\n");
    write(root, "protocol/fixtures/dirty.json.sha256", "ignored");

    expect(scanSanitizedFixtures({ cwd: root })).toEqual([
      {
        path: "protocol/fixtures/nested/dirty.json",
        rule: "identifier-value",
        jsonPath: "$.device_id"
      }
    ]);
  });

  test("flags fixture symlinks without following them when symlinks are supported", () => {
    const root = tempRoot();
    write(root, "outside.json", "{\"device_id\":\"raw-device-id-value\"}\n");
    mkdirSync(join(root, "protocol", "fixtures"), { recursive: true });
    try {
      symlinkSync(join(root, "outside.json"), join(root, "protocol", "fixtures", "linked.json"));
    } catch {
      return;
    }

    expect(scanSanitizedFixtures({ cwd: root })).toEqual([
      {
        path: "protocol/fixtures/linked.json",
        rule: "filesystem-entry",
        jsonPath: "$"
      }
    ]);
  });

  test("preserves plural identifier context through nested arrays", () => {
    const rawValues = {
      deviceIds: [["raw-device-id-value"]],
      location_ids: [["raw-location-id-value"]],
      accountIds: [["raw-account-id-value"]],
      user_ids: [["raw-user-id-value"]],
      eventIds: [["raw-event-id-value"]],
      subscription_ids: [["raw-subscription-id-value"]],
      ackIds: [["raw-ack-id-value"]],
      ownerIds: [["raw-owner-id-value"]]
    };

    const findings = scanSanitizedFixtureText("protocol/fixtures/bad.json", JSON.stringify(rawValues));

    expect(findings).toEqual([
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.deviceIds[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.location_ids[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.accountIds[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.user_ids[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.eventIds[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.subscription_ids[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.ackIds[0][0]" },
      { path: "protocol/fixtures/bad.json", rule: "identifier-value", jsonPath: "$.ownerIds[0][0]" }
    ]);
    const serializedFindings = JSON.stringify(findings);
    for (const rawValue of Object.values(rawValues).flat(2)) {
      expect(serializedFindings).not.toContain(rawValue);
    }
  });

  test("redacts unsafe path segments and unsafe JSON keys from findings", () => {
    const root = tempRoot();
    const rawUuid = "123e4567-e89b-12d3-a456-426614174000";
    const rawToken = "sk_live_abcdefghijklmnopqrstuvwxyz123456";
    const rawDirectory = "Bearer abcdefghijklmnopqrstuvwxyz123456";
    const rawKey = "user@example.com";
    write(
      root,
      `protocol/fixtures/${rawDirectory}/${rawUuid}/${rawToken}.json`,
      JSON.stringify({
        [rawKey]: "192.0.2.44"
      })
    );

    const findings = scanSanitizedFixtures({ cwd: root });

    expect(findings).toEqual([
      {
        path: "protocol/fixtures/[REDACTED_PATH]/[REDACTED_PATH]/[REDACTED_PATH]",
        rule: "ip-address",
        jsonPath: "$.[REDACTED_KEY]"
      }
    ]);
    const serializedFindings = JSON.stringify(findings);
    for (const rawValue of [rawUuid, rawToken, rawDirectory, rawKey]) {
      expect(serializedFindings).not.toContain(rawValue);
    }
    expect(serializedFindings).not.toContain("..");
  });

  test("redacts unsafe path and key segments in CLI-formatted output", () => {
    const root = tempRoot();
    const rawUuid = "123e4567-e89b-12d3-a456-426614174000";
    const rawToken = "sk_live_abcdefghijklmnopqrstuvwxyz123456";
    const rawKey = "raw-key@example.com";
    write(
      root,
      `protocol/fixtures/${rawUuid}/${rawToken}.json`,
      JSON.stringify({
        [rawKey]: "2001:db8::44"
      })
    );

    const output = scanSanitizedFixtures({ cwd: root }).map(formatSanitizedFixtureFinding).join("\n");

    expect(output).toContain("[REDACTED_PATH]");
    expect(output).toContain("[REDACTED_KEY]");
    for (const rawValue of [rawUuid, rawToken, rawKey]) {
      expect(output).not.toContain(rawValue);
    }
  });

  test("redacts path segments containing IP address substrings or IP filename stems", () => {
    const root = tempRoot();
    const rawIpv4Stem = "192.0.2.44.json";
    const rawIpv4Embedded = "capture-192.0.2.44.json";
    write(root, `protocol/fixtures/${rawIpv4Stem}`, "{\"device_id\":\"raw-device-id-value\"}\n");
    write(root, `protocol/fixtures/${rawIpv4Embedded}`, "{\"device_id\":\"raw-device-id-value\"}\n");
    write(root, "protocol/fixtures/2026-08-20-normal-fixture.json", "{\"device_id\":\"raw-device-id-value\"}\n");

    const findings = scanSanitizedFixtures({ cwd: root });
    const formatted = findings.map(formatSanitizedFixtureFinding).join("\n");

    expect(findings.map((finding) => finding.path).sort()).toEqual([
      "protocol/fixtures/2026-08-20-normal-fixture.json",
      "protocol/fixtures/[REDACTED_PATH]",
      "protocol/fixtures/[REDACTED_PATH]"
    ]);
    for (const rawValue of [rawIpv4Stem, rawIpv4Embedded]) {
      expect(JSON.stringify(findings)).not.toContain(rawValue);
      expect(formatted).not.toContain(rawValue);
    }
    expect(formatted).toContain("2026-08-20-normal-fixture.json");
  });

  test("redacts IPv6 substrings in direct path and formatted output", () => {
    const rawIpv6Stem = "[2001:db8::1].json";

    const findings = scanSanitizedFixtureText(
      `protocol/fixtures/${rawIpv6Stem}`,
      "{\"device_id\":\"raw-device-id-value\"}\n"
    );
    const formatted = findings.map(formatSanitizedFixtureFinding).join("\n");

    expect(findings).toEqual([
      {
        path: "protocol/fixtures/[REDACTED_PATH]",
        rule: "identifier-value",
        jsonPath: "$.device_id"
      }
    ]);
    expect(JSON.stringify(findings)).not.toContain(rawIpv6Stem);
    expect(formatted).not.toContain(rawIpv6Stem);
  });
});
