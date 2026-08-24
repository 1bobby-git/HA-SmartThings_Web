import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

import { scanSanitizedFixtureText } from "../tools/sanitized-fixture-audit.js";

const requiredDocs = [
  "MANUAL_TEST.md",
  "docs/architecture.md",
  "docs/feasibility-report.md",
  "docs/protocol-report.md",
  "docs/session-behavior.md",
  "docs/api-free-audit.md",
  "docs/official-parity-matrix.md",
  "docs/customize-compatibility.md",
  "docs/security.md",
  "protocol/fixtures/README.md"
];

describe("Phase 1 documentation gate", () => {
  test("keeps evidence-only decisions and real-account gaps explicit", () => {
    for (const path of requiredDocs) {
      expect(existsSync(path), path).toBe(true);
    }

    const feasibility = readFileSync("docs/feasibility-report.md", "utf8");
    const readme = readFileSync("README.md", "utf8");
    const protocol = readFileSync("docs/protocol-report.md", "utf8");
    const manual = readFileSync("MANUAL_TEST.md", "utf8");
    const fixtures = readFileSync("protocol/fixtures/README.md", "utf8");
    const session = readFileSync("docs/session-behavior.md", "utf8");
    const security = readFileSync("docs/security.md", "utf8");
    const apiFree = readFileSync("docs/api-free-audit.md", "utf8");
    const addonDocs = readFileSync("addon/smartthings_web_bridge/DOCS.md", "utf8");
    const addonReadme = readFileSync("addon/smartthings_web_bridge/README.md", "utf8");
    const addonChangelog = readFileSync("addon/smartthings_web_bridge/CHANGELOG.md", "utf8");
    const evidencePath = "protocol/fixtures/2026-08-20-controlled-chrome-summary.json";
    const evidenceHashPath = `${evidencePath}.sha256`;
    const smokePath = "protocol/fixtures/2026-08-20-addon-smoke-summary.json";
    const smokeHashPath = `${smokePath}.sha256`;
    const haosLoginPath = "protocol/fixtures/2026-08-24-haos-addon-login-summary.json";
    const haosLoginHashPath = `${haosLoginPath}.sha256`;
    const duplicatePath = "protocol/fixtures/2026-08-20-device-event-duplicate.sanitized.json";
    const duplicateHashPath = `${duplicatePath}.sha256`;
    const snapshotPath = "protocol/fixtures/2026-08-20-snapshot-ack-correlations.sanitized.json";
    const snapshotHashPath = `${snapshotPath}.sha256`;
    const runtimeAuditPath = "protocol/fixtures/2026-08-24-runtime-api-audit-summary.json";
    const runtimeAuditHashPath = `${runtimeAuditPath}.sha256`;
    const captureOriginAuditPath =
      "protocol/fixtures/2026-08-24-haos-capture-origin-audit-summary.json";
    const captureOriginAuditHashPath = `${captureOriginAuditPath}.sha256`;
    const gitattributes = readFileSync(".gitattributes", "utf8");
    const packageMetadata = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(gitattributes).toContain("protocol/fixtures/*.json text eol=lf");
    expect(gitattributes).toContain("protocol/fixtures/*.sha256 text eol=lf");
    expect(gitattributes).toContain("protocol/fixtures/**/*.json text eol=lf");
    expect(gitattributes).toContain("protocol/fixtures/**/*.sha256 text eol=lf");

    expect(feasibility.trimEnd()).toMatch(/DECISION: (GO|LIMITED|STOP)$/);
    expect(feasibility).not.toContain("DECISION: PENDING");
    expect(feasibility).toContain("DECISION: LIMITED");
    expect(readme).toContain("Current gate: `DECISION: LIMITED`");
    expect(readme).toContain("do not install or manage Docker yourself");
    expect(readme).toContain("npm ci");
    expect(readme).toContain("npm run package:addon");
    expect(readme).toContain("dist-addon/smartthings_web_bridge");
    expect(readme).toContain("/addons/smartthings_web_bridge");
    expect(readme).toContain("Settings → Apps → Install app");
    expect(readme).toContain("The folder path and add-on slug are different");
    expect(readme).toContain("local_smartthings_web_bridge");
    expect(readme).toContain("Do not copy the raw `addon/smartthings_web_bridge` source folder");
    expect(readme).toContain("generated monorepo build inputs");
    expect(readme).toContain("canonicalizes generated text files to UTF-8 with LF line endings");
    expect(readme).toContain("/data/protocol-fingerprint.json");
    expect(readme).toContain("same contract cannot self-heal");
    expect(readme).toContain("numeric `protocol_version` bump");
    expect(readme).toContain("npx tsx tools/haos-capture-origin-audit.ts");
    expect(readme).not.toContain("Current gate: `DECISION: STOP`");
    expect(feasibility).toContain("bounded controlled Chrome sample");
    expect(feasibility).toContain("not a GO decision");
    expect(feasibility).toContain("not causally tied to a user-triggered physical action");
    expect(feasibility).toContain("Phase 2 remains closed");
    expect(readme).toContain(
      "Version 0.1.26 contains the in-memory physical-action correlation probe, but it has not been deployed to HAOS."
    );
    expect(readme).toContain(
      "Physical-action correlation remains unverified until a real safe user action produces one unique passing result."
    );
    expect(readme).toContain(
      "Do not install or start 0.1.26 until the active 0.1.25 72-hour soak is sealed."
    );
    expect(readme).toContain(
      "The probe adds no browser command, DOM state scraping, direct SmartThings API call, Home Assistant entity, or persistent event journal."
    );
    for (const document of [feasibility, protocol, session]) {
      expect(document).toContain(
        "Version 0.1.26 is implemented and packaged locally but has not been deployed to HAOS."
      );
      expect(document).toContain("Physical-action correlation remains unverified");
    }
    expect(manual).toContain("POST /probe/physical-action/arm");
    expect(manual).toContain("GET /probe/physical-action");
    expect(manual).toContain("POST /probe/physical-action/reset");
    expect(manual).toContain("npm run probe:physical-action:haos -- status");
    expect(manual).toContain(
      "npm run probe:physical-action:haos -- arm --action contact_open --window-seconds 60 --wait"
    );
    expect(manual).toContain("npm run probe:physical-action:haos -- reset");
    expect(manual).toContain("0.1.25 correctly returns the fixed `not_found` result");
    expect(readme).toContain("npm run probe:physical-action:haos");
    expect(packageMetadata.scripts?.["probe:physical-action:haos"]).toBe(
      "tsx tools/haos-physical-action-probe.ts"
    );
    expect(readme).toContain("npm run soak:deployment-gate");
    expect(manual).toContain("npm run soak:deployment-gate");
    expect(packageMetadata.scripts?.["soak:deployment-gate"]).toBe(
      "tsx tools/haos-soak-deployment-gate.ts"
    );
    expect(readme).toContain("npm run deploy:haos:preflight");
    expect(manual).toContain("npm run deploy:haos:preflight");
    expect(packageMetadata.scripts?.["deploy:haos:preflight"]).toBe(
      "tsx tools/haos-candidate-preflight.ts"
    );
    const soakDocs = readFileSync("docs/haos-soak.md", "utf8");
    expect(soakDocs).toContain("It never reads `samples.jsonl`");
    expect(soakDocs).toContain("Exit code `0` and `deploymentEligible=true`");
    expect(soakDocs).toContain("at least 865 successful samples");
    expect(soakDocs).toContain("The preflight has no execute mode");
    expect(soakDocs).toContain("It drops the Ingress URL, IP address, options");
    expect(soakDocs).toContain("npm run soak:haos -- --resume");
    expect(soakDocs).toContain("allows exactly one collector");
    expect(soakDocs).toContain("does not hide downtime");
    expect(manual).toContain("It does not copy files, reload Supervisor, rebuild");
    expect(`${readme}\n${manual}\n${soakDocs}`).toContain(
      "final-summary.json.sha256"
    );
    expect(manual).toContain(
      "Do not install or start 0.1.26 until the active 0.1.25 72-hour soak is sealed."
    );
    expect(addonChangelog).toContain("## 0.1.26");
    expect(addonChangelog).toContain("in-memory physical-action correlation probe");
    expect(`${readme}\n${feasibility}\n${protocol}\n${session}`).not.toContain(
      "0.1.26 was deployed"
    );
    expect(feasibility).toContain("live Home Assistant OS 18.2 add-on");
    expect(protocol).toContain("111 requests");
    expect(protocol).toContain("Socket.IO");
    expect(protocol).toContain("api/subscription DEVICE_EVENT");
    expect(protocol).toContain("27 unique event IDs");
    expect(protocol).toContain("20-second background-tab window");
    expect(protocol).toContain("954 frames");
    expect(protocol).toContain("motionSensor");
    expect(protocol).toContain("1 MiB");
    expect(protocol).toContain("No synthetic SmartThings protocol payloads");
    expect(protocol).toContain("Semantic protocol integrity");
    expect(protocol).toContain("/data/protocol-fingerprint.json");
    expect(protocol).toContain("0600");
    expect(protocol).toContain("locations, rooms, device_cards, device_states, device_health, scenes, and DEVICE_EVENT");
    expect(protocol).toContain("Optional surfaces and inventory-count variation are not blocking");
    expect(protocol).toContain("PROTOCOL_CHANGED");
    expect(protocol).toContain("parser health remains false");
    expect(protocol).toContain("readiness remains false");
    expect(protocol).toContain("liveness and Ingress status pages stay up");
    expect(protocol).toContain("same semantic contract cannot self-heal");
    expect(protocol).toContain("reviewed sanitized evidence");
    expect(protocol).toContain("numeric `protocol_version` bump");
    expect(protocol).toContain("Historical change count is not a current-failure signal");
    expect(protocol).toContain("mismatch surface is safe diagnostics only");
    expect(protocol).toContain("Live HAOS add-on validation");
    expect(protocol).toContain("bridge version `0.1.22`");
    expect(protocol).toContain("Version 0.1.23 keeps that current-context initial snapshot proof valid");
    expect(protocol).toContain("observedDeviceCount=213");
    expect(protocol).toContain("protocolChangeCount=0");
    expect(protocol).toContain("restartCount=0");
    expect(protocol).toContain("0.1.24 was deployed through Supervisor");
    expect(protocol).toContain("initialSnapshotAgeMs=147196");
    expect(protocol).not.toMatch(/raw (payload|device ID|location ID|event ID)s?/i);
    expect(manual).toContain("Do not enter Samsung credentials into this repository");
    expect(manual).toContain("location-only");
    expect(manual).toContain("network outage");
    expect(manual).toContain("decision rubric");
    expect(manual).toContain("real device event");
    expect(fixtures).toContain("sanitized real captures only");
    expect(fixtures).toContain("Raw events remained transient");
    expect(fixtures).toContain("2026-08-24-haos-addon-login-summary.json");
    expect(session).toContain("Short-window background delivery and two add-on/browser restart restores are verified");
    expect(session).toContain("long-idle background delivery remain unverified");
    expect(session).toContain("known incompatible ACK/event shape or corrupt protocol store");
    expect(session).toContain("PROTOCOL_CHANGED");
    expect(session).toContain("liveness and Ingress stay available");
    expect(session).toContain("Home Assistant OS 18.2 Supervisor install is now verified");
    expect(session).toContain("logged-in add-on observation");
    expect(session).toContain("repeated automatic session/snapshot restore after add-on updates");
    expect(addonDocs).toContain("DECISION: LIMITED");
    expect(addonDocs).toContain("npm ci");
    expect(addonDocs).toContain("npm run package:addon");
    expect(addonDocs).toContain("dist-addon/smartthings_web_bridge");
    expect(addonDocs).toContain("/addons/smartthings_web_bridge");
    expect(addonDocs).toContain("Do not copy the raw `addon/smartthings_web_bridge` source folder");
    expect(addonDocs).toContain("generated monorepo build inputs");
    expect(addonDocs).toContain("Generated text is canonical UTF-8/LF");
    expect(addonDocs).toContain("Keep backup copies outside `/addons`");
    expect(addonDocs).toContain("local_smartthings_web_bridge");
    expect(addonDocs).toContain("Supervisor-loaded AppArmor profile is enforced");
    expect(addonDocs).toContain("Version 0.1.23 fixes the old 120-second readiness drop");
    expect(addonDocs).toContain("Version 0.1.24 was then verified");
    expect(manual).toContain("dist-addon/smartthings_web_bridge");
    expect(manual).toContain("Do not copy the raw `addon/smartthings_web_bridge` source folder");
    expect(manual).toContain("Keep backup copies outside `/addons`");
    expect(manual).toContain("local_smartthings_web_bridge");
    expect(manual).toContain("red protocol warning");
    expect(manual).toContain("Do not delete or rewrite `/data/protocol-fingerprint.json` manually");
    expect(manual).toContain("Do not automatically accept the new fingerprint");
    expect(security).toContain("/data/settings.json");
    expect(security).toContain("/data/protocol-fingerprint.json");
    expect(security).toContain("0600");
    expect(security).toContain("safe mismatch surface");
    expect(security).toContain("Home Assistant OS 18.2");
    expect(security).toContain("AppArmor profile is enforced");
    expect(addonReadme).toContain("npm ci");
    expect(addonReadme).toContain("npm run package:addon");
    expect(addonReadme).toContain("dist-addon/smartthings_web_bridge");
    expect(addonReadme).toContain("/addons/smartthings_web_bridge");
    expect(addonReadme).toContain("Do not copy the raw `addon/smartthings_web_bridge` source folder");
    expect(addonReadme).toContain("generated monorepo build inputs");
    expect(addonReadme).toContain("Generated text is canonical UTF-8/LF");
    expect(addonReadme).toContain("Keep backup copies outside `/addons`");
    expect(addonChangelog).toContain("LIMITED evidence gate");
    expect(addonChangelog).toContain("## 0.1.23");
    expect(addonChangelog).toContain("old 120-second snapshot TTL");
    expect(addonChangelog).not.toContain("provisional STOP");
    expect(existsSync(evidencePath)).toBe(true);
    expect(existsSync(evidenceHashPath)).toBe(true);
    const evidenceText = readFileSync(evidencePath, "utf8");
    expect(scanSanitizedFixtureText(evidencePath, evidenceText)).toEqual([]);
    const evidence = JSON.parse(evidenceText) as {
      decision?: string;
      initial_reload?: { requests?: number };
      live_device_events?: { unique_event_ids?: number };
      background_window?: { duration_seconds?: number; frames?: number };
      later_capability_window?: { capability_families?: string[] };
    };
    expect(evidence.decision).toBe("LIMITED");
    expect(evidence.initial_reload?.requests).toBe(111);
    expect(evidence.live_device_events?.unique_event_ids).toBe(27);
    expect(evidence.background_window).toMatchObject({ duration_seconds: 20, frames: 954 });
    expect(evidenceText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    const capabilityFamilies = evidence.later_capability_window?.capability_families ?? [];
    expect(capabilityFamilies).toEqual([
      "motionSensor",
      "presenceSensor",
      "battery",
      "temperatureMeasurement",
      "illuminanceMeasurement",
      "signalStrength",
      "airQualitySensor"
    ]);
    const protocolAndFeasibility = `${protocol}\n${feasibility}`;
    for (const capabilityFamily of capabilityFamilies) {
      expect(protocolAndFeasibility).toContain(capabilityFamily);
    }
    if (!capabilityFamilies.includes("movement")) {
      expect(protocolAndFeasibility).not.toMatch(/\bmovement\b/);
    }
    const expectedHash = readFileSync(evidenceHashPath, "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(evidenceText).digest("hex")).toBe(expectedHash);
    expect(protocol).toContain(evidencePath);
    expect(protocol).toContain(duplicatePath);
    expect(protocol).toContain("3 sanitized deliveries decoded to 1 logical event");
    expect(protocol).toContain("runtime capture sink");
    expect(protocol).toContain(snapshotPath);
    expect(protocol).toContain("6 request/ACK correlations");
    expect(existsSync(smokePath)).toBe(true);
    expect(existsSync(smokeHashPath)).toBe(true);
    const smokeText = readFileSync(smokePath, "utf8");
    expect(scanSanitizedFixtureText(smokePath, smokeText)).toEqual([]);
    const smoke = JSON.parse(smokeText) as {
      observed_at?: string;
      image?: string;
      manifest_sha256?: string;
      local_image_id?: string;
      state?: string;
      live?: boolean;
      ready?: boolean;
      chromium_running?: boolean;
      browser_restart_count?: number;
      protocol_version?: number;
      protocol_state?: string;
      ingress_allowed_status?: number;
      ingress_ready_status?: number;
      ingress_status_page_status?: number;
      ingress_novnc_status?: number;
      ingress_denied_status?: number;
      published_host_ports?: number;
      container_node_version?: string;
      playwright_version?: string;
      chromium_version?: string;
      liveness_observed_after_seconds?: number;
      build_context?: string;
      permissions?: Record<string, string>;
      container_restart_smoke?: {
        live?: boolean;
        liveness_status?: number;
        eventually_state?: string;
        data_file_hashes_preserved?: boolean;
        chromium_running?: boolean;
      };
      corrupt_protocol_fingerprint_smoke?: {
        wrote_invalid_temp_volume_file?: boolean;
        liveness_status?: number;
        ready_status?: number;
        state?: string;
        parser_healthy?: boolean;
        chromium_running?: boolean;
        protocol_version?: number;
        protocol_state?: string;
        status_page_indicates_changed?: boolean;
        status_page_indicates_phase_2_closed?: boolean;
        status_page_indicates_readiness_blocked?: boolean;
        log_event?: string;
        raw_content_logged?: boolean;
      };
      limitations?: string[];
      cleanup?: {
        temp_container_removed?: boolean;
        temp_volume_removed?: boolean;
        temp_network_removed?: boolean;
        docker_stopped?: boolean;
      };
    };
    expect(smoke).toMatchObject({
      observed_at: "2026-08-20T20:16:40+09:00",
      image: "ha-smartthings-web-addon:phase1-release-candidate",
      manifest_sha256: "1c72223a3876404c5865449f60c7c16e1c0f503ab86e1c963ba9ac5ffe1bf59a",
      local_image_id: "sha256:9fc550052b29d3745fc3ef385fb4bc225ca570f2b8d4aea78f4a532b9b816001",
      state: "LOGIN_REQUIRED",
      live: true,
      ready: false,
      chromium_running: true,
      browser_restart_count: 0,
      protocol_version: 1,
      protocol_state: "discovering",
      ingress_allowed_status: 200,
      ingress_ready_status: 503,
      ingress_status_page_status: 200,
      ingress_novnc_status: 200,
      ingress_denied_status: 403,
      published_host_ports: 0,
      container_node_version: "24.18.1",
      playwright_version: "1.62.1",
      chromium_version: "151.0.7922.34",
      liveness_observed_after_seconds: 14,
      build_context: "dist-addon/smartthings_web_bridge only",
      permissions: {
        "/data": "0700",
        "/data/chromium-profile": "0700",
        "/data/downloads": "0700",
        "/data/bridge-secret": "0600",
        "/data/bridge.sqlite": "0600",
        "/data/settings.json": "0600",
        "/data/protocol-fingerprint.json": "0600"
      },
      container_restart_smoke: {
        live: true,
        liveness_status: 200,
        eventually_state: "LOGIN_REQUIRED",
        data_file_hashes_preserved: true,
        chromium_running: true
      },
      corrupt_protocol_fingerprint_smoke: {
        wrote_invalid_temp_volume_file: true,
        liveness_status: 200,
        ready_status: 503,
        state: "PROTOCOL_CHANGED",
        parser_healthy: false,
        chromium_running: false,
        protocol_version: 1,
        protocol_state: "discovering",
        status_page_indicates_changed: true,
        status_page_indicates_phase_2_closed: true,
        status_page_indicates_readiness_blocked: true,
        log_event: "protocol_integrity_store_failed",
        raw_content_logged: false
      },
      cleanup: {
        temp_container_removed: true,
        temp_volume_removed: true,
        temp_network_removed: true,
        docker_stopped: true
      }
    });
    expect(smoke.limitations).toEqual([
      "The smoke test used Docker Desktop, not Home Assistant Supervisor.",
      "The custom AppArmor profile was not enforced in this test.",
      "No Samsung credentials or live SmartThings session were entered into the add-on test container."
    ]);
    const expectedSmokeHash = readFileSync(smokeHashPath, "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(smokeText).digest("hex")).toBe(expectedSmokeHash);
    expect(existsSync(haosLoginPath)).toBe(true);
    expect(existsSync(haosLoginHashPath)).toBe(true);
    const haosLoginText = readFileSync(haosLoginPath, "utf8");
    expect(scanSanitizedFixtureText(haosLoginPath, haosLoginText)).toEqual([]);
    const haosLogin = JSON.parse(haosLoginText) as {
      decision?: string;
      environment?: {
        home_assistant_os_version?: string;
        home_assistant_core_version?: string;
        installed_supervisor_slug?: string;
        bridge_version?: string;
        chromium_version?: string;
      };
      container_posture?: {
        privileged?: boolean;
        network_mode?: string;
        full_access?: boolean;
        addon_privilege_list_empty?: boolean;
        apparmor_mode?: string;
        browser_uid?: number;
        chromium_sandbox_enabled?: boolean;
        no_no_sandbox_flag?: boolean;
      };
      manual_login_observation?: {
        state_after_login?: string;
        ready_initially_true?: boolean;
        observed_device_count?: number;
        decoded_device_event_count_increased?: boolean;
        protocol_change_count?: number;
        restart_count?: number;
      };
      readiness_defect?: {
        old_snapshot_ttl_ms?: number;
        observed_ready_after_old_ttl?: boolean;
        fixed_in_bridge_version?: string;
        fixed_semantics?: string;
      };
      post_dedupe_fix_verification?: {
        bridge_version?: string;
        state?: string;
        ready_after_old_snapshot_ttl?: boolean;
        initial_snapshot_age_ms?: number;
        observed_device_count?: number;
        decoded_device_event_count?: number;
        unique_logical_event_count?: number;
        duplicate_delivery_count?: number;
        protocol_change_count?: number;
        restart_count?: number;
        local_source_candidate_count?: number;
      };
      limitations?: string[];
    };
    expect(haosLogin).toMatchObject({
      decision: "LIMITED",
      environment: {
        home_assistant_os_version: "18.2",
        home_assistant_core_version: "2026.8.3",
        installed_supervisor_slug: "local_smartthings_web_bridge",
        bridge_version: "0.1.22",
        chromium_version: "151.0.7922.34"
      },
      container_posture: {
        privileged: false,
        network_mode: "bridge",
        full_access: false,
        addon_privilege_list_empty: true,
        apparmor_mode: "enforce",
        browser_uid: 1001,
        chromium_sandbox_enabled: true,
        no_no_sandbox_flag: true
      },
      manual_login_observation: {
        state_after_login: "CONNECTED",
        ready_initially_true: true,
        observed_device_count: 213,
        decoded_device_event_count_increased: true,
        protocol_change_count: 0,
        restart_count: 0
      },
      readiness_defect: {
        old_snapshot_ttl_ms: 120000,
        observed_ready_after_old_ttl: false,
        fixed_in_bridge_version: "0.1.23",
        fixed_semantics: "current-context initial snapshot proof persists while heartbeat freshness recent push traffic and current-context parser proof gate readiness"
      },
      post_fix_verification: {
        bridge_version: "0.1.24",
        addon_restart_session_restored: true,
        observer_first_keeper_reload: true,
        state: "CONNECTED",
        ready_after_old_snapshot_ttl: true,
        initial_snapshot_age_ms: 147196,
        old_snapshot_ttl_exceeded: true,
        observed_device_count: 213,
        decoded_device_event_count: 77,
        protocol_change_count: 0,
        restart_count: 0,
        ingress_backend_status: 200,
        novnc_asset_status: 200,
        novnc_websocket_status: 101,
        apparmor_mode: "enforce"
      },
      post_dedupe_fix_verification: {
        bridge_version: "0.1.25",
        state: "CONNECTED",
        ready_after_old_snapshot_ttl: true,
        initial_snapshot_age_ms: 145892,
        observed_device_count: 213,
        decoded_device_event_count: 170,
        unique_logical_event_count: 85,
        duplicate_delivery_count: 85,
        protocol_change_count: 0,
        restart_count: 0,
        local_source_candidate_count: 1
      }
    });
    expect(haosLogin.limitations).toEqual([
      "Host reboot recovery is unverified.",
      "Physical-action correlation is unverified.",
      "Long-idle durability is unverified.",
      "Command behavior remains out of Phase 1 scope.",
      "Complete API independence remains limited to observed samples."
    ]);
    const expectedHaosLoginHash = readFileSync(haosLoginHashPath, "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(haosLoginText).digest("hex")).toBe(expectedHaosLoginHash);
    const version = JSON.parse(readFileSync("protocol/version.json", "utf8")) as {
      container_node_version?: string;
    };
    expect(version.container_node_version).toBe("24.18.1");
    expect(existsSync(duplicatePath)).toBe(true);
    expect(existsSync(duplicateHashPath)).toBe(true);
    const duplicateText = readFileSync(duplicatePath, "utf8");
    expect(scanSanitizedFixtureText(duplicatePath, duplicateText)).toEqual([]);
    const expectedDuplicateHash = readFileSync(duplicateHashPath, "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(duplicateText).digest("hex")).toBe(expectedDuplicateHash);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(existsSync(snapshotHashPath)).toBe(true);
    const snapshotText = readFileSync(snapshotPath, "utf8");
    expect(scanSanitizedFixtureText(snapshotPath, snapshotText)).toEqual([]);
    const expectedSnapshotHash = readFileSync(snapshotHashPath, "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(snapshotText).digest("hex")).toBe(expectedSnapshotHash);
    expect(existsSync(runtimeAuditPath)).toBe(true);
    expect(existsSync(runtimeAuditHashPath)).toBe(true);
    const runtimeAuditText = readFileSync(runtimeAuditPath, "utf8");
    expect(scanSanitizedFixtureText(runtimeAuditPath, runtimeAuditText)).toEqual([]);
    const runtimeAudit = JSON.parse(runtimeAuditText) as {
      status?: string;
      sampleCount?: number;
      bridge?: { establishedExternalCount?: number };
      chromium?: { establishedExternalCount?: number };
      checks?: {
        bridgeExternalConnectionObserved?: boolean;
        browserExternalConnectionObserved?: boolean;
      };
      limitations?: string[];
    };
    expect(runtimeAudit).toMatchObject({
      status: "pass",
      sampleCount: 4,
      bridge: { establishedExternalCount: 0 },
      chromium: { establishedExternalCount: 3 },
      checks: {
        bridgeExternalConnectionObserved: false,
        browserExternalConnectionObserved: true
      }
    });
    expect(runtimeAudit.limitations).toContain("bounded_sample_not_complete_network_history");
    const expectedRuntimeAuditHash = readFileSync(runtimeAuditHashPath, "utf8")
      .trim()
      .split(/\s+/)[0];
    expect(createHash("sha256").update(runtimeAuditText).digest("hex")).toBe(
      expectedRuntimeAuditHash
    );
    expect(apiFree).toContain("npm run audit:api-free:runtime");
    expect(apiFree).toContain("4/4 process-socket samples passed");
    expect(apiFree).toContain(runtimeAuditPath);
    expect(feasibility).toContain("Bridge-owned external TCP connections remained zero");
    expect(fixtures).toContain(runtimeAuditPath);
    expect(existsSync(captureOriginAuditPath)).toBe(true);
    expect(existsSync(captureOriginAuditHashPath)).toBe(true);
    const captureOriginAuditText = readFileSync(captureOriginAuditPath, "utf8");
    expect(scanSanitizedFixtureText(captureOriginAuditPath, captureOriginAuditText)).toEqual([]);
    const captureOriginAudit = JSON.parse(captureOriginAuditText) as {
      result?: string;
      classification?: string;
      analyzedCaptureRowCount?: number;
      urlBearingCaptureRowCount?: number;
      originCounts?: {
        publicSmartThingsApi?: number;
        consumerSmartThingsWeb?: number;
      };
      limitations?: string[];
    };
    expect(captureOriginAudit).toMatchObject({
      result: "no_public_api_observed",
      classification: "consumer_web_only_observed",
      analyzedCaptureRowCount: 1999,
      urlBearingCaptureRowCount: 1985,
      originCounts: {
        publicSmartThingsApi: 0,
        consumerSmartThingsWeb: 12
      }
    });
    expect(captureOriginAudit.limitations).toContain(
      "retained_capture_history_not_complete_network_history"
    );
    const expectedCaptureOriginAuditHash = readFileSync(captureOriginAuditHashPath, "utf8")
      .trim()
      .split(/\s+/)[0];
    expect(createHash("sha256").update(captureOriginAuditText).digest("hex")).toBe(
      expectedCaptureOriginAuditHash
    );
    expect(apiFree).toContain("npx tsx tools/haos-capture-origin-audit.ts");
    expect(apiFree).toContain(captureOriginAuditPath);
    expect(feasibility).toContain("zero public SmartThings API records");
    expect(fixtures).toContain("2026-08-24-haos-capture-origin-audit-summary.json");
    expect(`${feasibility}\n${protocol}`).not.toMatch(/DECISION: GO/);

    const baselines = YAML.parse(readFileSync("upstream-baselines.yaml", "utf8")) as {
      project?: { production_bridge_modules?: string; phase_2_gate?: string };
    };
    expect(baselines.project?.production_bridge_modules).toBe("phase-1-created");
    expect(baselines.project?.phase_2_gate).toBe("LIMITED");
  });
});
