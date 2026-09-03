import { describe, expect, test } from "vitest";

import { CommandConfirmationCoordinator } from "../../src/command/command-confirmation.js";
import { SafeCommandService } from "../../src/command/command-service.js";

describe("CommandConfirmationCoordinator", () => {
  test("is the explicit confirmation boundary while retaining SafeCommandService compatibility", () => {
    expect(CommandConfirmationCoordinator.prototype).toBeInstanceOf(SafeCommandService);
  });
});
