import { describe, expect, test } from "vitest";

import { safeAdvancedCommandReason } from "../../src/advanced/safe-command-policy.js";
import type { AdvancedCommandDescriptor } from "../../src/advanced/command-catalog-types.js";

function descriptor(
  overrides: Partial<AdvancedCommandDescriptor> = {}
): AdvancedCommandDescriptor {
  return {
    component: "main",
    capability: "switch",
    capabilityVersion: 1,
    command: "on",
    arguments: [],
    transport: "advanced",
    confirmation: "accepted_receipt",
    label: "Power",
    labelSource: "capability",
    ...overrides
  };
}

describe("safeAdvancedCommandReason", () => {
  test("allows ordinary argument-free switch on and off commands", () => {
    expect(safeAdvancedCommandReason(descriptor({ command: "on" }))).toBeUndefined();
    expect(safeAdvancedCommandReason(descriptor({ command: "off" }))).toBeUndefined();
  });

  test("allows speech synthesis speak commands", () => {
    expect(
      safeAdvancedCommandReason(
        descriptor({
          capability: "speechSynthesis",
          command: "speak",
          arguments: [
            {
              name: "phrase",
              required: true,
              sensitive: false,
              schema: { type: "string" }
            }
          ],
          label: "Speak"
        })
      )
    ).toBeUndefined();
  });

  test("omits commands with sensitive arguments before other dangerous classification", () => {
    expect(
      safeAdvancedCommandReason(
        descriptor({
          capability: "doorControl",
          command: "open",
          arguments: [
            {
              name: "pin",
              required: true,
              sensitive: true,
              schema: { type: "string" }
            }
          ],
          label: "Open door"
        })
      )
    ).toBe("sensitive_argument");
  });

  test("omits physical security, access, valve, and Korean compound commands as dangerous", () => {
    expect(
      safeAdvancedCommandReason(
        descriptor({ componentRole: "lock", capability: "lock", command: "unlock", label: "Unlock" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "garageDoorControl", command: "open", label: "Garage door" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "valve", command: "open", label: "Open water valve" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "securitySystem", command: "disarm", label: "Security disarm" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "custom.lock", command: "unlock", label: "현관문 잠금해제" })
      )
    ).toBe("dangerous_command");
  });

  test("omits low-level OCF post and network audio topology commands as dangerous", () => {
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "ocf", command: "post", label: "Execute" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "messageBoard", command: "post", label: "Post message" })
      )
    ).toBeUndefined();
    expect(
      safeAdvancedCommandReason(
        descriptor({ capability: "ocf", command: "postCommand", label: "OCF post command" })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({
          componentRole: "speaker",
          capability: "audioGroup",
          command: "setGroupMaster",
          label: "Set network audio group master"
        })
      )
    ).toBe("dangerous_command");
    expect(
      safeAdvancedCommandReason(
        descriptor({
          capability: "mediaInputSource",
          command: "setInputSource",
          arguments: [
            {
              name: "networkChannelRole",
              required: true,
              sensitive: false,
              schema: { type: "string" }
            }
          ],
          label: "Network channel role"
        })
      )
    ).toBe("dangerous_command");
  });
});
