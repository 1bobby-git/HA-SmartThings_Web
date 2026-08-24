import { randomInt, timingSafeEqual } from "node:crypto";

const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PAIRING_ATTEMPTS = 8;

export class BridgeAuth {
  readonly #token: Buffer;
  #pairingCode: string | undefined;
  #pairingExpiresAtMs = 0;
  #pairingAttempts = 0;

  constructor(token: string) {
    if (token.length < 32 || token.length > 512) {
      throw new Error("bridge_auth_token_invalid");
    }
    this.#token = Buffer.from(token, "utf8");
  }

  authenticate(authorization: string | undefined): boolean {
    if (!authorization?.startsWith("Bearer ")) return false;
    const candidate = Buffer.from(authorization.slice(7), "utf8");
    return candidate.length === this.#token.length && timingSafeEqual(candidate, this.#token);
  }

  createPairingCode(nowMs = Date.now()): { code: string; expiresAt: string } {
    this.#pairingCode = String(randomInt(0, 100_000_000)).padStart(8, "0");
    this.#pairingExpiresAtMs = nowMs + PAIRING_TTL_MS;
    this.#pairingAttempts = 0;
    return {
      code: this.#pairingCode,
      expiresAt: new Date(this.#pairingExpiresAtMs).toISOString()
    };
  }

  exchangePairingCode(code: string, nowMs = Date.now()): string | null {
    if (
      !/^\d{8}$/u.test(code) ||
      !this.#pairingCode ||
      nowMs > this.#pairingExpiresAtMs ||
      this.#pairingAttempts >= MAX_PAIRING_ATTEMPTS
    ) {
      return null;
    }
    this.#pairingAttempts += 1;
    const expected = Buffer.from(this.#pairingCode, "utf8");
    const candidate = Buffer.from(code, "utf8");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      return null;
    }
    this.#pairingCode = undefined;
    this.#pairingExpiresAtMs = 0;
    this.#pairingAttempts = 0;
    return this.#token.toString("utf8");
  }
}
