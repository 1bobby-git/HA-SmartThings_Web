/**
 * Keep the command page alive until the authoritative state waiter settles.
 * A DOM interaction alone must never report an armed/disarmed state.
 */
export async function runLocationCommandSession(
  dispatch: () => Promise<void>,
  closePage: () => Promise<unknown>,
  waitForConfirmation?: () => Promise<void>
): Promise<void> {
  try {
    await dispatch();
    if (waitForConfirmation) await waitForConfirmation();
  } finally {
    // Cleanup must not mask the actual dispatch or confirmation error.
    await closePage().catch(() => undefined);
  }
}
