/** Canonical comparison only; preserve the server's original value in inventory. */
export type LocationArmState = "ARMED_AWAY" | "ARMED_STAY" | "DISARMED";

export function normalizeLocationArmState(value: unknown): LocationArmState | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "away": case "armed_away": case "armedaway": return "ARMED_AWAY";
    case "stay": case "armed_home": case "armed_stay": case "armedstay": return "ARMED_STAY";
    case "off": case "disarmed": return "DISARMED";
    default: return undefined; // Pending, arming, unknown and unrelated modes are not confirmation.
  }
}
