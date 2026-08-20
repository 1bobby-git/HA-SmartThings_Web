import { isIP } from "node:net";

import type { AliasKind, SqliteAliasStore } from "./alias-store.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

const REDACTED = "[REDACTED]";
const sensitiveKeyPattern =
  /(?:authorization|cookie|set[-_]?cookie|password|token|secret|csrf|mfa|captcha|session(?:[-_]?id)?|session[-_]?token)/i;
const locationKeyPattern = /(?:^|[_-])locations?(?:[_-]?ids?)?$|locationIds?/i;
const deviceKeyPattern = /(?:^|[_-])devices?(?:[_-]?ids?)?$|deviceIds?/i;
const accountKeyPattern = /(?:^|[_-])accounts?(?:[_-]?ids?)?$|accountIds?/i;
const userKeyPattern = /(?:^|[_-])users?(?:[_-]?ids?)?$|userIds?/i;
const idKeyPattern = /(?:^|[_-])id$|(?:^|[_-])[a-z]+[_-]?id$|[a-z]+Id$/i;
const ipAddressPattern =
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const possibleIpv6Pattern = /(?<![A-Za-z0-9])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.%]+(?![A-Za-z0-9])/g;
const uuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

export function createRedactor(aliasStore: SqliteAliasStore) {
  const sanitize = (value: unknown, keyHint?: string): unknown => {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      return redactString(value, keyHint);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitize(item, keyHint));
    }

    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(value)) {
        if (sensitiveKeyPattern.test(key)) {
          result[key] = REDACTED;
          continue;
        }
        result[key] = sanitize(nested, key);
      }
      return result;
    }

    return REDACTED;
  };

  const redactString = (value: string, keyHint?: string): string => {
    if (keyHint && sensitiveKeyPattern.test(keyHint)) {
      return REDACTED;
    }

    if (keyHint === "url") {
      return redactUrl(value);
    }

    const aliasKind = keyHint ? aliasKindForKey(keyHint) : undefined;
    if (aliasKind && value.length > 0) {
      return aliasStore.alias(aliasKind, value);
    }

    const parsed = parseJson(value);
    if (parsed !== undefined) {
      return JSON.stringify(sanitize(parsed));
    }

    return redactText(value);
  };

  const redactUrl = (value: string): string => {
    try {
      const url = new URL(value);
      for (const [key, queryValue] of [...url.searchParams.entries()]) {
        if (sensitiveKeyPattern.test(key)) {
          url.searchParams.set(key, REDACTED);
          continue;
        }
        const kind = aliasKindForKey(key);
        if (kind) {
          url.searchParams.set(key, aliasStore.alias(kind, queryValue));
        }
      }
      return redactText(url.toString());
    } catch {
      return redactText(value);
    }
  };

  const redactText = (value: string): string => {
    let output = sanitizeEmbeddedJsonSegments(value, sanitize)
      .replace(ipAddressPattern, (candidate) => (isIP(candidate) ? REDACTED : candidate))
      .replace(possibleIpv6Pattern, (candidate) => {
        const address = candidate.startsWith("[") && candidate.endsWith("]")
          ? candidate.slice(1, -1)
          : candidate;
        return isIP(address) ? REDACTED : candidate;
      });

    output = output.replace(
      /(authorization|cookie|set[-_]?cookie|password|token|secret|csrf|mfa|captcha|session(?:[-_]?id)?|session[-_]?token)(\s*[:=]\s*)(?:Bearer\s+)?[^\s,;&"']+/gi,
      (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`
    );

    output = output.replace(uuidPattern, (raw) => aliasStore.alias("identifier", raw));

    output = output.replace(
      /\b(locationId|location_id)(\s*[:=]\s*)([A-Za-z0-9._:-]+)/gi,
      (_match, key: string, sep: string, raw: string) =>
        `${key}${sep}${aliasStore.alias("location", raw)}`
    );
    output = output.replace(
      /\b(deviceId|device_id)(\s*[:=]\s*)([A-Za-z0-9._:-]+)/gi,
      (_match, key: string, sep: string, raw: string) =>
        `${key}${sep}${aliasStore.alias("device", raw)}`
    );
    output = output.replace(
      /\b(accountId|account_id)(\s*[:=]\s*)([A-Za-z0-9._:-]+)/gi,
      (_match, key: string, sep: string, raw: string) =>
        `${key}${sep}${aliasStore.alias("account", raw)}`
    );
    output = output.replace(
      /\b(userId|user_id)(\s*[:=]\s*)([A-Za-z0-9._:-]+)/gi,
      (_match, key: string, sep: string, raw: string) =>
        `${key}${sep}${aliasStore.alias("user", raw)}`
    );

    return output;
  };

  return sanitize;
}

function sanitizeEmbeddedJsonSegments(value: string, sanitize: (value: unknown) => unknown): string {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const start = findNextJsonStart(value, cursor);
    if (start === -1) {
      output += value.slice(cursor);
      break;
    }

    output += value.slice(cursor, start);
    const end = findBalancedJsonEnd(value, start);
    if (end === -1) {
      output += value.slice(start);
      break;
    }

    const candidate = value.slice(start, end + 1);
    try {
      output += JSON.stringify(sanitize(JSON.parse(candidate) as JsonValue));
    } catch {
      output += candidate;
    }
    cursor = end + 1;
  }

  return output;
}

function findNextJsonStart(value: string, from: number): number {
  const objectStart = value.indexOf("{", from);
  const arrayStart = value.indexOf("[", from);
  if (objectStart === -1) {
    return arrayStart;
  }
  if (arrayStart === -1) {
    return objectStart;
  }
  return Math.min(objectStart, arrayStart);
}

function findBalancedJsonEnd(value: string, start: number): number {
  const stack: string[] = [value[start] === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === undefined) {
      return -1;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return -1;
      }
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }

  return -1;
}

function aliasKindForKey(key: string): AliasKind | undefined {
  if (locationKeyPattern.test(key)) {
    return "location";
  }
  if (deviceKeyPattern.test(key)) {
    return "device";
  }
  if (accountKeyPattern.test(key)) {
    return "account";
  }
  if (userKeyPattern.test(key)) {
    return "user";
  }
  if (idKeyPattern.test(key)) {
    return "identifier";
  }
  return undefined;
}

function parseJson(value: string): JsonValue | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return undefined;
  }
}
