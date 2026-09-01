import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";

import { describe, expect, test } from "vitest";

import {
  evaluateWebParity,
  reportHasFailingParity
} from "../tools/smartthings-web-parity-audit-core.js";

describe("SmartThings Web parity audit", () => {
  test("reports every safe omission and zero dangerous exposure", () => {
    const inventory = {
      devices: [
        {
          id: "dev_003",
          controls: [],
          advancedCommands: [],
          commandOmissions: [
            { capability: "identifier_missing", reason: "definition_unavailable" }
          ]
        }
      ]
    };
    const projection = [
      {
        deviceId: "dev_003",
        entityId: "sensor.device_status",
        uniqueId: "dev_003_main_status_status",
        domain: "sensor",
        originalName: "Status",
        userNamed: false
      }
    ];

    const report = evaluateWebParity(inventory, projection);

    expect(report.summary.dangerousCommandsExposed).toBe(0);
    expect(report.summary.duplicateUniqueIds).toBe(0);
    expect(report.summary.devices).toBe(1);
    expect(report.summary.safeCommands).toBe(0);
    expect(report.summary.locationControls).toBe(0);
    expect(report.summary.advancedControls).toBe(0);
    expect(report.summary.omissions).toBe(1);
    expect(report.summary.projectedEntities).toBe(1);
    expect(report.omissions).toEqual([
      expect.objectContaining({ deviceId: "dev_003", reason: "definition_unavailable" })
    ]);
    expect(reportHasFailingParity(report)).toBe(false);
  });

  test("counts only exact control transports and fails on dangerous exposure, duplicate unique IDs, and duplicate generated names", () => {
    const report = evaluateWebParity(
      {
        devices: [
          {
            id: "dev_001",
            controls: [
              {
                id: "advanced:main:lock:lock",
                kind: "toggle",
                capability: "lock",
                attribute: "lock",
                commands: ["lock", "unlock"],
                transport: "advanced"
              },
              {
                id: "location:main:switch:switch",
                kind: "toggle",
                capability: "switch",
                attribute: "switch",
                commands: ["on", "off"],
                transport: "location_native"
              },
              {
                id: "unknown:main:switch:switch",
                kind: "toggle",
                capability: "switch",
                attribute: "switch",
                commands: ["on", "off"],
                transport: "smartapp"
              }
            ],
            advancedCommands: [
              {
                component: "main",
                capability: "switch",
                capabilityVersion: 1,
                command: "on",
                arguments: [],
                transport: "advanced",
                confirmation: "accepted_receipt",
                label: "On",
                labelSource: "capability"
              }
            ],
            commandOmissions: []
          }
        ]
      },
      [
        {
          deviceId: "dev_001",
          entityId: "switch.first",
          uniqueId: "dev_001_main_switch_switch",
          domain: "switch",
          originalName: "Power",
          userNamed: false
        },
        {
          deviceId: "dev_001",
          entityId: "switch.second",
          uniqueId: "dev_001_main_switch_switch",
          domain: "switch",
          originalName: "Power",
          userNamed: false
        }
      ]
    );

    expect(report.summary.dangerousCommandsExposed).toBe(1);
    expect(report.summary.duplicateUniqueIds).toBe(1);
    expect(report.summary.duplicateGeneratedNames).toBe(1);
    expect(report.summary.safeCommands).toBe(1);
    expect(report.summary.locationControls).toBe(1);
    expect(report.summary.advancedControls).toBe(1);
    expect(reportHasFailingParity(report)).toBe(true);
  });

  test("accepts real bridge control and argument descriptor shapes without leaking argument data", () => {
    const report = evaluateWebParity(
      {
        devices: [
          {
            id: "dev_001",
            controls: [
              {
                id: "advanced:main:speechSynthesis:speak",
                kind: "button",
                component: "main",
                capability: "speechSynthesis",
                attribute: "speak",
                command: "speak",
                commands: ["speak"],
                label: "말하기",
                options: ["안녕하세요"],
                optionLabels: { "안녕하세요": "안녕하세요" },
                optionCommands: { "안녕하세요": "speak" },
                min: 0,
                max: 100,
                step: 1,
                transport: "advanced"
              }
            ],
            advancedCommands: [
              {
                component: "main",
                capability: "speechSynthesis",
                capabilityVersion: 1,
                command: "speak",
                arguments: [
                  {
                    name: "phrase",
                    required: true,
                    sensitive: false,
                    unit: "text",
                    schema: { type: "string" }
                  },
                  {
                    name: "payload",
                    required: false,
                    sensitive: false,
                    schema: { type: "object" }
                  },
                  {
                    name: "items",
                    required: false,
                    sensitive: false,
                    schema: { type: "array" }
                  }
                ],
                transport: "advanced",
                confirmation: "accepted_receipt",
                label: "Speak",
                labelSource: "capability"
              }
            ],
            commandOmissions: []
          }
        ]
      },
      []
    );

    const json = JSON.stringify(report);
    expect(report.summary.safeCommands).toBe(1);
    expect(report.summary.advancedControls).toBe(1);
    expect(json).not.toContain("안녕하세요");
    expect(json).not.toContain("payload");
    expect(json).not.toContain("phrase");
  });

  test("accepts the full bridge inventory envelope and scans every control command", () => {
    const report = evaluateWebParity(
      {
        schemaVersion: 5,
        sequence: 12,
        ready: true,
        bridgeVersion: "0.1.154",
        protocolVersion: 5,
        locations: [],
        rooms: [],
        scenes: [],
        deviceAliases: { "44f66c7d-885d-47a1-242a-695aa571782b": "dev_204" },
        devices: [
          {
            id: "dev_001",
            locationId: "loc_001",
            roomId: "room_001",
            name: "멀티탭",
            type: "OCF",
            online: true,
            healthUpdatedAt: "2026-09-01T00:00:00.000Z",
            presentation: { manufacturerName: "Samsung" },
            states: { main: { switch: { switch: "off" } } },
            advanced: { deviceId: "dev_001" },
            controls: [
              {
                id: "advanced:main:switch:switch",
                kind: "toggle",
                component: "main",
                capability: "switch",
                attribute: "switch",
                commands: ["on", "unlock"],
                transport: "advanced"
              }
            ],
            advancedCommands: [],
            commandOmissions: []
          }
        ]
      },
      []
    );

    expect(report.summary.devices).toBe(1);
    expect(report.summary.dangerousCommandsExposed).toBe(1);
    expect(JSON.stringify(report.failures)).not.toContain("unlock");
  });

  test("fails closed for invalid omissions but permits known safe omission reasons", () => {
    const safe = evaluateWebParity(
      {
        devices: [
          {
            id: "dev_001",
            controls: [],
            advancedCommands: [],
            commandOmissions: [
              { component: "main", capability: "lock", command: "unlock", reason: "dangerous_command" },
              { component: "main", capability: "speechSynthesis", command: "speak", reason: "sensitive_argument" },
              { component: "main", capability: "broken", command: "run", reason: "schema_invalid" },
              { component: "main", capability: "switch", command: "on", reason: "definition_unavailable" }
            ]
          }
        ]
      },
      []
    );

    expect(reportHasFailingParity(safe)).toBe(false);
    expect(() =>
      {
        evaluateWebParity(
          {
            devices: [
              {
                id: "dev_001",
                controls: [],
                advancedCommands: [],
                commandOmissions: [
                  { component: "main", capability: "switch", command: "on", reason: "unexpected" }
                ]
              }
            ]
          },
          []
        );
      }
    ).toThrow(/web_parity_audit_input_invalid/);
  });

  test.each([
    ["lock access", { component: "main", capability: "lock", command: "unlock" }],
    ["entry door", { component: "main", capability: "door", command: "open" }],
    ["garage", { component: "main", capability: "garageDoorControl", command: "open" }],
    ["valve", { component: "main", capability: "valve", command: "open" }],
    ["security", { component: "main", capability: "securitySystem", command: "armAway" }],
    ["alarm", { component: "main", capability: "alarm", command: "both" }],
    ["siren", { component: "main", capability: "siren", command: "siren" }],
    ["ocf", { component: "main", capability: "ocf", command: "postCommand" }],
    ["network group topology", { component: "main", capability: "samsungim.networkAudioGroupInfo", command: "setGroupMaster" }]
  ])("flags dangerous command class: %s", (_name, command) => {
    const report = evaluateWebParity(
      {
        devices: [
          {
            id: "dev_001",
            controls: [],
            advancedCommands: [
              {
                ...command,
                capabilityVersion: 1,
                arguments: [],
                transport: "advanced",
                confirmation: "accepted_receipt",
                label: "Command",
                labelSource: "capability"
              }
            ],
            commandOmissions: []
          }
        ]
      },
      []
    );

    expect(report.summary.dangerousCommandsExposed).toBe(1);
    expect(reportHasFailingParity(report)).toBe(true);
  });

  test("user named entities do not count as duplicate generated names", () => {
    const report = evaluateWebParity(
      { devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }] },
      [
        {
          deviceId: "dev_001",
          entityId: "switch.first",
          uniqueId: "dev_001_main_switch_switch",
          domain: "switch",
          originalName: "Power",
          userNamed: true
        },
        {
          deviceId: "dev_001",
          entityId: "switch.second",
          uniqueId: "dev_001_aux_switch_switch",
          domain: "switch",
          originalName: "Power",
          userNamed: false
        }
      ]
    );

    expect(report.summary.duplicateGeneratedNames).toBe(0);
  });

  test("accepts localized web labels in the HA projection", () => {
    const report = evaluateWebParity(
      { devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }] },
      [
        {
          deviceId: "dev_001",
          entityId: "switch.multi_outlet_power",
          uniqueId: "dev_001_main_switch_switch",
          domain: "switch",
          originalName: "전원",
          userNamed: false
        },
        {
          deviceId: "dev_001",
          entityId: "sensor.multi_outlet_status",
          uniqueId: "dev_001_main_yjswitchstatus_status",
          domain: "sensor",
          originalName: "장치 상태",
          userNamed: false
        }
      ]
    );

    expect(report.summary.projectedEntities).toBe(2);
    expect(reportHasFailingParity(report)).toBe(false);
  });

  test("serialized report contains aliases and counts but no raw IDs or secrets", () => {
    const json = JSON.stringify(
      evaluateWebParity(
        {
          devices: [
            {
              id: "dev_001",
              controls: [],
              advancedCommands: [
                {
                  component: "main",
                  capability: "speechSynthesis",
                  capabilityVersion: 1,
                  command: "speak",
                  arguments: [],
                  transport: "advanced",
                  confirmation: "accepted_receipt",
                  label: "Speak",
                  labelSource: "capability"
                }
              ],
              commandOmissions: [
                {
                  component: "main",
                  capability: "speaker",
                  command: "announce",
                  reason: "schema_invalid"
                }
              ]
            }
          ]
        },
        [
          {
            deviceId: "dev_001",
            entityId: "sensor.safe",
            uniqueId: "dev_001_main_safe_value",
            domain: "sensor",
            originalName: "Safe",
            userNamed: false
          }
        ]
      )
    );

    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/iu);
    expect(json).not.toMatch(/cookie|authorization|token|secret|password|session/iu);
  });

  test.each([
    [
      "raw uuid device id",
      {
        devices: [
          {
            id: "123e4567-e89b-12d3-a456-426614174000",
            controls: [],
            advancedCommands: [],
            commandOmissions: []
          }
        ]
      },
      []
    ],
    [
      "secret-bearing capability",
      {
        devices: [
          {
            id: "dev_001",
            controls: [],
            advancedCommands: [
              {
                component: "main",
                capability: "speechSynthesis",
                capabilityVersion: 1,
                command: "speak",
                arguments: [],
                transport: "advanced",
                confirmation: "accepted_receipt",
                label: "Speak",
                labelSource: "capability",
                accessToken: "redacted"
              }
            ],
            commandOmissions: []
          }
        ]
      },
      []
    ],
    [
      "secret-bearing projection",
      { devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }] },
      [
        {
          deviceId: "dev_001",
          entityId: "sensor.safe",
          uniqueId: "dev_001_main_safe_value",
          domain: "sensor",
          originalName: "Safe",
          userNamed: false,
          refreshToken: "redacted"
        }
      ]
    ]
  ])("fails closed without leaking report data for %s", (_name, inventory, projection) => {
    expect(() => evaluateWebParity(inventory, projection)).toThrow(/web_parity_audit_input_invalid/);
  });

  test("rejects malformed and overbounded inputs", () => {
    expect(() =>
      evaluateWebParity({ devices: [{ id: "dev_001", controls: "bad", advancedCommands: [], commandOmissions: [] }] }, [])
    ).toThrow(/web_parity_audit_input_invalid/);
    expect(() =>
      evaluateWebParity(
        { devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }] },
        Array.from({ length: 20_001 }, (_, index) => ({
          deviceId: "dev_001",
          entityId: `sensor.safe_${index}`,
          uniqueId: `dev_001_main_safe_${index}`,
          domain: "sensor",
          originalName: `Safe ${index}`,
          userNamed: false
        }))
      )
    ).toThrow(/web_parity_audit_input_invalid/);
  });

  test("omissions are deduplicated and sorted deterministically", () => {
    const report = evaluateWebParity(
      {
        devices: [
          {
            id: "dev_002",
            controls: [],
            advancedCommands: [],
            commandOmissions: [
              { component: "main", capability: "z", command: "b", reason: "definition_unavailable" },
              { component: "main", capability: "a", command: "b", reason: "dangerous_command" },
              { component: "main", capability: "z", command: "b", reason: "definition_unavailable" }
            ]
          },
          {
            id: "dev_001",
            controls: [],
            advancedCommands: [],
            commandOmissions: [
              { component: "main", capability: "z", command: "a", reason: "dangerous_command" }
            ]
          }
        ]
      },
      []
    );

    expect(report.omissions).toEqual([
      { deviceId: "dev_001", component: "main", capability: "z", command: "a", reason: "dangerous_command" },
      { deviceId: "dev_002", component: "main", capability: "a", command: "b", reason: "dangerous_command" },
      { deviceId: "dev_002", component: "main", capability: "z", command: "b", reason: "definition_unavailable" }
    ]);
  });

  test("CLI reads explicit JSON files and exits nonzero on failed invariants", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-parity-audit-"));
    const inventoryPath = join(root, "inventory.json");
    const projectionPath = join(root, "projection.json");
    writeFileSync(
      inventoryPath,
      JSON.stringify({
        devices: [{ id: "dev_001", controls: [], advancedCommands: [], commandOmissions: [] }]
      })
    );
    writeFileSync(
      projectionPath,
      JSON.stringify([
        {
          deviceId: "dev_001",
          entityId: "sensor.safe",
          uniqueId: "dev_001_main_safe_value",
          domain: "sensor",
          originalName: "Safe",
          userNamed: false
        }
      ])
    );

    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/smartthings-web-parity-audit.ts",
        "--inventory",
        inventoryPath,
        "--projection",
        projectionPath
      ],
      { encoding: "utf8" }
    );

    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: 1,
      summary: { devices: 1, projectedEntities: 1 }
    });

    writeFileSync(
      projectionPath,
      JSON.stringify([
        {
          deviceId: "dev_001",
          entityId: "sensor.safe",
          uniqueId: "dev_001_main_safe_value",
          domain: "sensor",
          originalName: "Safe",
          userNamed: false
        },
        {
          deviceId: "dev_001",
          entityId: "sensor.safe_2",
          uniqueId: "dev_001_main_safe_value",
          domain: "sensor",
          originalName: "Safe 2",
          userNamed: false
        }
      ])
    );

    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "tools/smartthings-web-parity-audit.ts",
          "--inventory",
          inventoryPath,
          "--projection",
          projectionPath
        ],
        { encoding: "utf8", stdio: "pipe" }
      )
    ).toThrow();
    expect(readFileSync(inventoryPath, "utf8")).toContain("dev_001");
  });

  test("CLI rejects unsafe bridge URLs and token command-line arguments", () => {
    const root = mkdtempSync(join(tmpdir(), "stw-parity-audit-"));
    const projectionPath = join(root, "projection.json");
    writeFileSync(projectionPath, JSON.stringify([]));

    for (const args of [
      ["--bridge-url", "https://example.com", "--projection", projectionPath],
      ["--bridge-url", "http://127.0.0.1:9000/path?authorization=secret", "--projection", projectionPath],
      ["--bridge-url", "http://127.0.0.1:9000", "--projection", projectionPath, "--token", "secret"]
    ]) {
      expect(() =>
        execFileSync(process.execPath, ["--import", "tsx", "tools/smartthings-web-parity-audit.ts", ...args], {
          encoding: "utf8",
          stdio: "pipe"
        })
      ).toThrow();
    }
  });

  test("CLI maps missing files and invalid environment tokens to safe errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-parity-audit-"));
    const inventoryPath = join(root, "missing-inventory.json");
    const projectionPath = join(root, "projection.json");
    writeFileSync(projectionPath, JSON.stringify([]));

    const missing = await runAuditCli(["--inventory", inventoryPath, "--projection", projectionPath]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("web_parity_audit_file_read_failed\n");
    expect(missing.stderr).not.toContain(inventoryPath);

    const invalidToken = await runAuditCli(
      ["--bridge-url", "http://127.0.0.1:9", "--projection", projectionPath],
      { SMARTTHINGS_WEB_PARITY_AUDIT_TOKEN: "bad\u007fvalue" }
    );
    expect(invalidToken.status).toBe(1);
    expect(invalidToken.stderr).toBe("web_parity_audit_token_invalid\n");
  });

  test("CLI fetches inventory from loopback bridge and maps malformed JSON to a safe error", async () => {
    const root = mkdtempSync(join(tmpdir(), "stw-parity-audit-"));
    const projectionPath = join(root, "projection.json");
    const tokenPath = join(root, "bridge-secret");
    writeFileSync(projectionPath, JSON.stringify([]));
    writeFileSync(tokenPath, "local-token");

    const server = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer local-token") {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ devices: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("listen_failed");
    try {
      const run = await runAuditCli([
        "--bridge-url",
        `http://127.0.0.1:${address.port}`,
        "--token-file",
        tokenPath,
        "--projection",
        projectionPath
      ]);
      expect(run.status).toBe(0);
      const output = run.stdout;
      expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, summary: { devices: 0 } });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    writeFileSync(projectionPath, "{bad");
    const badJson = await runAuditCli(["--inventory", projectionPath, "--projection", projectionPath]);
    expect(badJson.status).toBe(1);
    expect(badJson.stderr).toBe("web_parity_audit_json_invalid\n");
  });
});

function runAuditCli(
  args: string[],
  env?: Record<string, string>
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tools/smartthings-web-parity-audit.ts", ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
