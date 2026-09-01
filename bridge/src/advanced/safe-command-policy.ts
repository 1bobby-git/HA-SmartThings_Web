import type { AdvancedCommandDescriptor, AdvancedCommandOmission } from "./command-catalog-types.js";

type AdvancedCommandOmissionReason = AdvancedCommandOmission["reason"];

const LOCK_ACCESS_PATTERN = /(?:\b(?:un)?lock(?:ed|ing)?\b|\baccess\s*control\b|잠금|잠금해제|출입|현관문)/u;
const ENTRY_DEVICE_PATTERN = /(?:\bdoor\b|\bgarage\b|\bvalve\b|차고|밸브|문\s*(?:열기|닫기)?)/u;
const SECURITY_PATTERN = /(?:\bsecurity\b|보안|경비)/u;
const DISARM_PATTERN = /(?:\bdisarm\b|무장\s*해제|경비\s*해제)/u;
const OCF_POST_PATTERN = /(?:\bocf\b.*\bpost(?:\s*command)?\b|\bpost(?:\s*command)?\b.*\bocf\b|\bpostcommand\b.*\bocf\b|\bocf\b.*\bpostcommand\b)/u;
const NETWORK_AUDIO_PATTERN = /(?:\bnetwork\b.*\baudio\b|\baudio\b.*\bnetwork\b|\bnetwork\b.*\bspeaker\b|\bspeaker\b.*\bnetwork\b)/u;
const TOPOLOGY_PATTERN = /(?:\bgroup\b|\bmaster\b|\bchannel\b|\brole\b|\btopology\b)/u;
const AUDIO_GROUP_PATTERN = /(?:\baudio\s*group\b|\bset\s*group\s*master\b|\bgroup\s*master\b|\bnetwork\s*channel\s*role\b)/u;

export function safeAdvancedCommandReason(
  descriptor: AdvancedCommandDescriptor
): AdvancedCommandOmissionReason | undefined {
  if (descriptor.arguments.some((argument) => argument.sensitive)) {
    return "sensitive_argument";
  }

  const normalized = normalizeDescriptor(descriptor);

  if (
    LOCK_ACCESS_PATTERN.test(normalized) ||
    ENTRY_DEVICE_PATTERN.test(normalized) ||
    (SECURITY_PATTERN.test(normalized) && DISARM_PATTERN.test(normalized)) ||
    OCF_POST_PATTERN.test(normalized) ||
    ((NETWORK_AUDIO_PATTERN.test(normalized) || AUDIO_GROUP_PATTERN.test(normalized)) &&
      TOPOLOGY_PATTERN.test(normalized))
  ) {
    return "dangerous_command";
  }

  return undefined;
}

function normalizeDescriptor(descriptor: AdvancedCommandDescriptor): string {
  const values = [
    descriptor.component,
    descriptor.componentRole,
    descriptor.capability,
    descriptor.command,
    descriptor.label,
    ...descriptor.arguments.map((argument) => argument.name)
  ];
  return values
    .filter((value): value is string => typeof value === "string")
    .map(normalizeTerm)
    .join(" ");
}

function normalizeTerm(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
