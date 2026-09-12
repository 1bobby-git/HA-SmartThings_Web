"""One-time, exact-base source patch; removed before the final pull request."""
from pathlib import Path
import hashlib

path = Path("bridge/src/browser/keeper-page.ts")
raw = path.read_bytes()
blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
assert blob == "ce513e7d3768aa954042e4f5fcbbdd56f32a8f2e", "Keeper source changed; do not overwrite concurrent work"
text = raw.decode()

def once(old: str, new: str) -> None:
    global text
    assert text.count(old) == 1, f"Expected one exact source anchor: {old[:100]!r}"
    text = text.replace(old, new, 1)

text = 'import { inspectAuthenticationPage } from "./session-application-proof.js";\n\n' + text
once("const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;", "const SESSION_RECOVERY_RETRY_MS = 5 * 60_000;\nconst SESSION_RECOVERY_MAX_RETRY_MS = 30 * 60_000;")
once('    | "login_required"\n    | "failed"', '    | "login_required"\n    | "login_page_unsettled"\n    | "sso_page_unsettled"\n    | "failed"')
once("  #lastRecoveryAttemptAtMs: number | undefined;", "  #lastRecoveryAttemptAtMs: number | undefined;\n  #consecutiveRecoveryFailures = 0;")
once('''    if (
      this.#lastRecoveryAttemptAtMs !== undefined &&
      now - this.#lastRecoveryAttemptAtMs < this.#sessionRecoveryRetryMs
    ) {
      return;
    }''', '''    // A failed, unchanged Samsung page must not create an endless fixed-rate
    // SSO loop. Keep the first retry compatible, then back off to 30 minutes.
    const retryDelayMs = Math.min(
      this.#sessionRecoveryRetryMs * 2 ** Math.min(6, Math.max(0, this.#consecutiveRecoveryFailures - 1)),
      Math.max(this.#sessionRecoveryRetryMs, SESSION_RECOVERY_MAX_RETRY_MS)
    );
    if (
      this.#lastRecoveryAttemptAtMs !== undefined &&
      now - this.#lastRecoveryAttemptAtMs < retryDelayMs
    ) {
      return;
    }''')
once('''      if (this.#sessionRecoveryInFlight === recovery) {
        this.#sessionRecoveryInFlight = undefined;
      }''', '''      if (this.#sessionRecoveryInFlight === recovery) {
        if (this.authenticationRecoveryPending()) {
          this.#consecutiveRecoveryFailures = Math.min(7, this.#consecutiveRecoveryFailures + 1);
        }
        this.#sessionRecoveryInFlight = undefined;
      }''')
start = text.index("  private async recoverViaSamsungSsoInSeparatePage(")
end = text.index("  private observeSessionTouchOutcome(", start)
text = text[:start] + '''  private async recoverViaSamsungSsoInSeparatePage(original: BrowserPageLike): Promise<void> {
    const originalUrl = original.url();
    const originalIsCurrent = () => this.#canNavigate() && this.currentKeeper() === original &&
      !original.isClosed() && original.url() === originalUrl;
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("sso_attempt");
    try {
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      await probe.goto(SAMSUNG_ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      // Let Samsung's ordinary redirect/cookie bootstrap finish before leaving
      // its document. All waits are bounded and the user's tab stays untouched.
      await waitForSettledKeeperPage(probe, 5_000);
      if (!originalIsCurrent()) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }

      if (!isKeeperSettledUrl(probe.url())) {
        await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
        await waitForSettledKeeperPage(probe);
      }
      if (isSamsungLoginUrl(probe.url())) {
        await this.recordLoginPage(probe, "sso");
        const diagnostic = await inspectAuthenticationPage(probe);
        if (!originalIsCurrent()) {
          this.recoveryDiagnostic("sso_stale");
          return;
        }
        if (!hasVisibleAuthenticationInput(diagnostic.surface)) {
          // A blank/iframe/custom/loading page is unknown, not proof of an MFA
          // requirement. Never replace a recoverable keeper with that page.
          this.recoveryDiagnostic("sso_page_unsettled");
          return;
        }
        if (isSamsungLoginUrl(originalUrl)) {
          // The user's existing sign-in/MFA tab is the interaction surface.
          this.recoveryDiagnostic("sso_login_required");
          return;
        }
        this.invalidateTouch();
        this.#keeper = probe;
        this.#commandPages.delete(probe);
        this.#sessionReauthObservedAtMs = undefined;
        this.#loginObservedAtMs = this.#now();
        probe = undefined;
        await original.close().catch(() => undefined);
        this.recoveryDiagnostic("sso_login_required");
        return;
      }
      if (!isKeeperSettledUrl(probe.url())) {
        this.recoveryDiagnostic("sso_failed");
        return;
      }

      const candidate = probe;
      const candidateUrl = candidate.url();
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false, onSessionProbe: (diagnostic) => this.#onSessionProbe?.(diagnostic) }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(outcome === "reauth" ? "sso_login_required" : "sso_failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }
      if (!(await this.verifyRecoveredApplication(candidate))) {
        this.recoveryDiagnostic("sso_failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl ||
          !(await this.promoteVerifiedKeeper(candidate))) {
        this.recoveryDiagnostic("sso_stale");
        return;
      }
      probe = undefined;
      // Unlike the former app-only SSO caller, login recovery may retain a form.
      // Close it only AFTER a fully verified replacement has become the keeper.
      if (isSamsungLoginUrl(originalUrl)) await original.close().catch(() => undefined);
      this.recoveryDiagnostic("sso_verified");
    } catch {
      this.recoveryDiagnostic("sso_failed");
    } finally {
      if (probe) this.#commandPages.delete(probe);
      await probe?.close().catch(() => undefined);
    }
  }

  private async verifyRecoveredApplication(candidate: BrowserPageLike): Promise<boolean> {
    if (!this.#verifyRefreshCandidate) return true;
    const target = candidate.url();
    // Reuse the runtime's existing read-only native Location proof. Advanced
    // HTTP success alone must not promote a disconnected application shell.
    return isConcreteLocationUrl(target) && await this.#verifyRefreshCandidate(candidate, target);
  }

  /** Use the existing profile's ordinary SSO redirect chain without touching the
   * user's sign-in/MFA form. Promote only after protected and native reads pass.
   */
  private async recoverLoginInSeparatePage(original: BrowserPageLike): Promise<void> {
    const originalUrl = original.url();
    const originalIsCurrent = () => this.#canNavigate() && this.currentKeeper() === original &&
      !original.isClosed() && original.url() === originalUrl;
    let probe: BrowserPageLike | undefined;
    this.recoveryDiagnostic("attempt");
    try {
      const originalDiagnostic = await inspectAuthenticationPage(original);
      if (!originalIsCurrent()) {
        this.recoveryDiagnostic("stale");
        return;
      }
      if (hasVisibleAuthenticationInput(originalDiagnostic.surface)) {
        this.recoveryDiagnostic("login_required");
        return;
      }
      probe = await this.context.newPage();
      this.#commandPages.add(probe);
      await probe.goto(KEEPER_URL, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await waitForSettledKeeperPage(probe);
      if (!isKeeperSettledUrl(probe.url())) {
        await this.recordLoginPage(probe, "recovery");
        const diagnostic = await inspectAuthenticationPage(probe);
        if (!originalIsCurrent()) {
          this.recoveryDiagnostic("stale");
          return;
        }
        const samsungLogin = isSamsungLoginUrl(probe.url());
        if (samsungLogin && !hasVisibleAuthenticationInput(diagnostic.surface)) {
          this.recoveryDiagnostic("login_page_unsettled");
          // This route was previously missing once the keeper itself reached
          // Samsung Account: every retry just repeated the same failed URL.
          // Absence of inputs is NOT proof that no challenge exists; use only
          // ordinary navigation in a separate tab, never credential injection.
          if (this.#authenticatedOnce) await this.recoverViaSamsungSsoInSeparatePage(original);
        } else {
          this.recoveryDiagnostic(samsungLogin ? "login_required" : "failed");
        }
        return;
      }
      const candidate = probe;
      const candidateUrl = candidate.url();
      const verifier = new KeeperPageManager(
        { pages: () => [candidate], newPage: async () => candidate },
        { canNavigate: () => false, onSessionProbe: (diagnostic) => this.#onSessionProbe?.(diagnostic) }
      );
      await verifier.reconcileRestoredPages();
      const outcome = await verifier.touchAuthenticatedSession();
      if (outcome !== "ok") {
        this.recoveryDiagnostic(outcome === "reauth" ? "login_required" : "failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl) {
        this.recoveryDiagnostic("stale");
        return;
      }
      if (!(await this.verifyRecoveredApplication(candidate))) {
        this.recoveryDiagnostic("failed");
        return;
      }
      if (!originalIsCurrent() || candidate.isClosed() || candidate.url() !== candidateUrl ||
          !isKeeperSettledUrl(candidate.url())) {
        this.recoveryDiagnostic("stale");
        return;
      }
      this.invalidateTouch();
      this.#keeper = candidate;
      this.#commandPages.delete(candidate);
      this.#authenticatedOnce = true;
      this.clearRecoveryState();
      probe = undefined;
      await original.close().catch(() => undefined);
      this.recoveryDiagnostic("verified");
    } catch {
      this.recoveryDiagnostic("failed");
    } finally {
      if (probe) this.#commandPages.delete(probe);
      await probe?.close().catch(() => undefined);
    }
  }

''' + text[end:]
once('''    this.#loginObservedAtMs = undefined;
    this.#lastRecoveryAttemptAtMs = undefined;
  }
}''', '''    this.#loginObservedAtMs = undefined;
    this.#lastRecoveryAttemptAtMs = undefined;
    this.#consecutiveRecoveryFailures = 0;
  }
}''')
once("function validDelay(value: number | undefined, fallback: number): number {", '''function hasVisibleAuthenticationInput(surface: string): boolean {
  return surface === "password_input" || surface === "otp_input" || surface === "email_input";
}

function validDelay(value: number | undefined, fallback: number): number {''')
path.write_text(text)
print("Applied bounded SSO recovery patch to the verified keeper source.")
