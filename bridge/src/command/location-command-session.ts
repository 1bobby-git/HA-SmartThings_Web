/**
 * Keep the command page and its UI queue slot until authoritative confirmation settles.
 * A successful DOM interaction alone must never report an armed/disarmed state.
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
    // Cleanup must not replace the original dispatch or confirmation error.
    try {
      await closePage();
    } catch {
      // The browser or page may already have closed during failure recovery.
    }
  }
}
