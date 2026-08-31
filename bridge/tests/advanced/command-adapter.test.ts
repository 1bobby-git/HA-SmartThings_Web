import { describe, expect, test, vi } from "vitest";

import {
  AdvancedCommandAdapter,
  AdvancedCommandError
} from "../../src/advanced/command-adapter.js";
import {
  CapabilityDefinitionCache,
  parseCapabilityDefinition
} from "../../src/advanced/capability-cache.js";
import {
  AdvancedSessionError,
  type AdvancedParser,
  type AdvancedRequest,
  type AuthenticatedAdvancedSession
} from "../../src/advanced/authenticated-session.js";
import type { RoutedCommandRequest } from "../../src/command/command-router.js";

class FakeSession implements AuthenticatedAdvancedSession {
  readonly requests: AdvancedRequest[] = [];
  readonly requestMock = vi.fn();
  readonly nextErrors: unknown[] = [];
  persistentError: unknown;

  constructor(public response: unknown) {}

  async request<T>(request: AdvancedRequest, parser: AdvancedParser<T>): Promise<T> {
    this.requestMock(request, parser);
    const error = this.nextErrors.shift() ?? this.persistentError;
    if (error !== undefined) throw error;
    this.requests.push(request);
    return parser(this.response);
  }
}

describe("AdvancedCommandAdapter", () => {
  test("posts a dynamic command body with resolved raw identifiers", async () => {
    const session = new FakeSession({ results: [{ id: "command-1", status: "ACCEPTED" }] });
    const adapter = new AdvancedCommandAdapter({
      session,
      resolveRawDeviceId: (value) => (value === "dev_001" ? "raw-device" : undefined),
      resolveRawIdentifier: (value) =>
        ({ identifier_main: "main", identifier_switch: "switch" })[value]
    });

    const result = await adapter.execute({
      deviceId: "dev_001",
      component: "identifier_main",
      capability: "identifier_switch",
      command: "on",
      arguments: []
    });

    expect(session.requests).toEqual([
      {
        endpoint: "commands",
        method: "POST",
        path: "/advanced/cupcake-api/api/devices/raw-device/commands",
        body: {
          commands: [
            { component: "main", capability: "switch", command: "on", arguments: [] }
          ]
        }
      }
    ]);
    expect(result).toMatchObject({
      state: "ACCEPTED",
      transport: "advanced",
      commandId: "command-1"
    });
  });

  test("validates arguments from the capability definition before sending", async () => {
    const session = new FakeSession({ results: [{ status: "ACCEPTED" }] });
    const cache = new CapabilityDefinitionCache(async () =>
      parseCapabilityDefinition({
        id: "switchLevel",
        version: 1,
        attributes: {},
        commands: {
          setLevel: {
            arguments: [
              { name: "level", schema: { type: "integer", minimum: 0, maximum: 100 } }
            ]
          }
        }
      })
    );
    const adapter = new AdvancedCommandAdapter({
      session,
      capabilityCache: cache,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (value) =>
        value === "identifier_switchLevel" ? "switchLevel" : "main"
    });

    await expect(
      adapter.execute({
        deviceId: "dev_001",
        component: "identifier_main",
        capability: "identifier_switchLevel",
        capabilityVersion: 1,
        command: "setLevel",
        arguments: [101]
      })
    ).rejects.toThrowError(new AdvancedCommandError("invalid_arguments"));
    expect(session.requestMock).not.toHaveBeenCalled();
  });

  test("does not send a request when raw identifiers are unavailable", async () => {
    const session = new FakeSession({ results: [{ status: "ACCEPTED" }] });
    const adapter = new AdvancedCommandAdapter({
      session,
      resolveRawDeviceId: () => undefined,
      resolveRawIdentifier: () => undefined
    });

    await expect(
      adapter.execute({
        deviceId: "dev_001",
        component: "identifier_main",
        capability: "identifier_switch",
        command: "on",
        arguments: []
      })
    ).rejects.toThrowError(new AdvancedCommandError("unsupported"));
    expect(session.requestMock).not.toHaveBeenCalled();
  });

  test("retries a transient request failure once without converting it to unsupported", async () => {
    const session = new FakeSession({ results: [{ status: "ACCEPTED" }] });
    session.nextErrors.push(
      new AdvancedSessionError("advanced_request_unavailable", "commands")
    );
    const adapter = new AdvancedCommandAdapter({
      session,
      maxAttempts: 2,
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (value) => (value.includes("main") ? "main" : "switch")
    });

    await expect(
      adapter.execute({
        deviceId: "dev_001",
        component: "identifier_main",
        capability: "identifier_switch",
        command: "on",
        arguments: []
      })
    ).resolves.toMatchObject({ state: "ACCEPTED" });
    expect(session.requestMock).toHaveBeenCalledTimes(2);
  });

  test("classifies permission and malformed receipt failures without fallback semantics", async () => {
    const denied = new FakeSession({});
    denied.persistentError = new AdvancedSessionError(
      "advanced_permission_denied",
      "commands",
      403
    );
    const options = {
      resolveRawDeviceId: () => "raw-device",
      resolveRawIdentifier: (value: string) => (value.includes("main") ? "main" : "switch")
    };
    const request: RoutedCommandRequest = {
      deviceId: "dev_001",
      component: "identifier_main",
      capability: "identifier_switch",
      command: "on",
      arguments: []
    };

    await expect(new AdvancedCommandAdapter({ session: denied, ...options }).execute(request))
      .rejects.toThrowError(new AdvancedCommandError("permission_denied"));

    const malformed = new FakeSession({ results: [{ status: "MAYBE" }] });
    await expect(new AdvancedCommandAdapter({ session: malformed, ...options }).execute(request))
      .rejects.toThrowError(new AdvancedCommandError("response_invalid"));
  });
});
