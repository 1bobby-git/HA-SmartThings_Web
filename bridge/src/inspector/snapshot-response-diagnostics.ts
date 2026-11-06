import { decodeSocketIoTextFrame } from "./socketio-decoder.js";

const sections = ["basic", "cloud", "camera"] as const;
const envelopeKeys = ["data", "etag", "version", "error", "code", "name", "className"] as const;
const errorNames = ["BadRequest", "GeneralError", "NotAuthenticated", "NotFound", "Forbidden", "MethodNotAllowed", "NotAcceptable", "Conflict", "LengthRequired", "Unprocessable", "TooManyRequests", "NotImplemented", "BadGateway", "Unavailable", "Timeout"] as const;
const errorClasses = ["bad-request", "general-error", "not-authenticated", "forbidden", "not-found", "too-many-requests"] as const;
const errorCodes = [400, 401, 403, 404, 429, 500, 502, 503] as const;
const kinds = ["missing", "null", "array", "object", "string", "number", "boolean", "other"] as const;
const idKinds = ["missing", "non_string", "nonempty_string", "empty_string"] as const;
type Kind = typeof kinds[number];
type IdKind = typeof idKinds[number];

export interface CardShape {
  kind: Kind;
  sections: Array<typeof sections[number]>;
  firstSection: typeof sections[number] | "none";
  sectionTypes?: Kind[];
  hasType?: boolean;
  deviceId: IdKind;
  locationId: IdKind;
}

export interface SnapshotResponseShape {
  argCount: number;
  argTypes: Kind[];
  bodyType: Kind;
  singleArgEnvelope: boolean;
  dataType: Kind;
  envelopeKeys: Array<typeof envelopeKeys[number]>;
  error: { code: number | "other_or_missing"; name: string; className: string; messageType: Kind } | null;
  cards: { total: number; nonObjects: number; noSection: number; missingDeviceId: number; missingLocationId: number; validDeviceIds: number; validLocationIds: number };
  firstCards: CardShape[];
  cardShapeGroups: Array<{ shape: CardShape; count: number }>;
  omittedCardShapeCount: number;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const own = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const limited = (value: number): number => Math.min(Math.max(value, 0), 1_000_000);
const kind = (value: unknown): Kind => value === null ? "null" : Array.isArray(value) ? "array" :
  typeof value === "object" ? "object" :
  typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "other";
const idKind = (value: Record<string, unknown>, key: string): IdKind => !own(value, key) ? "missing" :
  typeof value[key] !== "string" ? "non_string" : value[key].length ? "nonempty_string" : "empty_string";

function summarizeCard(value: unknown): CardShape {
  const card = rec(value);
  if (!card) return { kind: kind(value), sections: [], firstSection: "none", deviceId: "missing", locationId: "missing" };
  const present = sections.filter((key) => own(card, key));
  const first = sections.find((key) => rec(card[key]) !== null);
  const source = first ? rec(card[first]) : null;
  return {
    kind: "object", sections: present, firstSection: first ?? "none",
    sectionTypes: sections.map((key) => own(card, key) ? kind(card[key]) : "missing"),
    hasType: own(card, "type"),
    deviceId: source ? idKind(source, "deviceId") : "missing",
    locationId: source ? idKind(source, "locationId") : "missing"
  };
}

export function summarizeAckArgs(args: unknown[]): SnapshotResponseShape {
  const body: unknown = args[0] === null ? args[1] : args;
  const singleArg = args.length === 1 ? rec(args[0]) : null;
  const envelope = rec(body) ?? singleArg;
  const data = envelope && own(envelope, "data") ? envelope["data"] : undefined;
  const rows = Array.isArray(data) ? data : rec(data) ? [data] :
    rec(body) ? [body] : Array.isArray(body) ? body : [];
  const counts = { total: limited(rows.length), nonObjects: 0, noSection: 0, missingDeviceId: 0, missingLocationId: 0, validDeviceIds: 0, validLocationIds: 0 };
  const cardShapeGroups: SnapshotResponseShape["cardShapeGroups"] = [];
  const groupByShape = new Map<string, number>();
  let omittedCardShapeCount = 0;
  for (const row of rows) {
    const card = summarizeCard(row);
    const signature = JSON.stringify(card);
    const existing = groupByShape.get(signature);
    if (existing !== undefined) cardShapeGroups[existing]!.count = limited(cardShapeGroups[existing]!.count + 1);
    else if (cardShapeGroups.length < 8) {
      groupByShape.set(signature, cardShapeGroups.length);
      cardShapeGroups.push({ shape: card, count: 1 });
    } else omittedCardShapeCount = limited(omittedCardShapeCount + 1);
    if (card.kind !== "object") counts.nonObjects++;
    if (card.firstSection === "none") counts.noSection++;
    if (card.deviceId !== "nonempty_string") counts.missingDeviceId++; else counts.validDeviceIds++;
    if (card.locationId !== "nonempty_string") counts.missingLocationId++; else counts.validLocationIds++;
  }
  const error = args.length === 1 ? rec(args[0]) : null;
  return {
    argCount: limited(args.length), argTypes: args.slice(0, 5).map(kind),
    bodyType: kind(body), singleArgEnvelope: Boolean(singleArg && own(singleArg, "data")),
    dataType: data === undefined ? "missing" : kind(data),
    envelopeKeys: envelopeKeys.filter((key) => envelope && own(envelope, key)),
    error: error ? {
      code: errorCodes.find((value) => value === error["code"]) ?? "other_or_missing",
      name: errorNames.find((value) => value === error["name"]) ?? "other_or_missing",
      className: errorClasses.find((value) => value === error["className"]) ?? "other_or_missing",
      messageType: own(error, "message") ? kind(error["message"]) : "missing"
    } : null,
    cards: counts, firstCards: rows.slice(0, 3).map(summarizeCard), cardShapeGroups, omittedCardShapeCount
  };
}

export function summarizeAckFrame(raw: string): SnapshotResponseShape | null {
  const decoded = decodeSocketIoTextFrame(raw);
  return decoded.kind === "ack" ? summarizeAckArgs(decoded.args) : null;
}

export function captureReceivedFrame(payload: unknown): string | null {
  const root = rec(payload);
  if (!root || root["direction"] !== "received") return null;
  const frame = rec(root["frame"]);
  if (frame && frame["truncated"] !== true && typeof frame["payload"] === "string") return frame["payload"];
  const response = rec(rec(root["payload"])?.["response"]);
  return response && response["truncated"] !== true && typeof response["payloadData"] === "string" ? response["payloadData"] : null;
}

// Persisted JSON is untrusted. Rebuild every field from fixed vocabularies; reject malformed rows.
export function validateSnapshotResponseShape(value: unknown): SnapshotResponseShape | null {
  const shape = rec(value);
  if (!shape) return null;
  const number = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000 ? v as number : null;
  const choice = <T extends readonly (string | number)[]>(v: unknown, allowed: T): T[number] | null => allowed.find((item) => item === v) ?? null;
  const types = shape["argTypes"];
  const keys = shape["envelopeKeys"];
  const cards = rec(shape["cards"]);
  const first = shape["firstCards"];
  const groups = shape["cardShapeGroups"];
  if (number(shape["argCount"]) === null || !Array.isArray(types) || types.length > 5 || types.some((v) => !choice(v, kinds)) ||
    !choice(shape["bodyType"], kinds) || typeof shape["singleArgEnvelope"] !== "boolean" || !choice(shape["dataType"], kinds) ||
    !Array.isArray(keys) || keys.length > envelopeKeys.length || keys.some((v) => !choice(v, envelopeKeys)) || !cards ||
    !Array.isArray(first) || first.length > 3 || !Array.isArray(groups) || groups.length > 8 || number(shape["omittedCardShapeCount"]) === null) return null;
  const countNames = ["total", "nonObjects", "noSection", "missingDeviceId", "missingLocationId", "validDeviceIds", "validLocationIds"] as const;
  if (countNames.some((key) => number(cards[key]) === null)) return null;
  const safeFirst: CardShape[] = [];
  const safeGroups: SnapshotResponseShape["cardShapeGroups"] = [];
  for (const item of [...first, ...groups.map((group: unknown) => rec(group)?.["shape"])]) {
    const card = rec(item);
    if (!card || !choice(card["kind"], kinds) || !Array.isArray(card["sections"]) || card["sections"].length > 3 ||
      card["sections"].some((v) => !choice(v, sections)) || !choice(card["firstSection"], [...sections, "none"] as const) ||
      !choice(card["deviceId"], idKinds) || !choice(card["locationId"], idKinds)) return null;
    if (card["kind"] === "object" && (!Array.isArray(card["sectionTypes"]) || card["sectionTypes"].length !== 3 ||
      card["sectionTypes"].some((v) => !choice(v, kinds)) || typeof card["hasType"] !== "boolean")) return null;
    const safeCard: CardShape = { kind: card["kind"] as Kind, sections: card["sections"] as CardShape["sections"],
      firstSection: card["firstSection"] as CardShape["firstSection"],
      ...(card["kind"] === "object" ? { sectionTypes: card["sectionTypes"] as Kind[], hasType: card["hasType"] as boolean } : {}),
      deviceId: card["deviceId"] as IdKind, locationId: card["locationId"] as IdKind };
    if (safeFirst.length < first.length) safeFirst.push(safeCard);
    else {
      const group = rec(groups[safeGroups.length]);
      if (!group || number(group["count"]) === null) return null;
      safeGroups.push({ shape: safeCard, count: group["count"] as number });
    }
  }
  const rawError = shape["error"];
  const error = rec(rawError);
  if (rawError !== null && (!error || !(choice(error["code"], errorCodes) || error["code"] === "other_or_missing") ||
    !(choice(error["name"], errorNames) || error["name"] === "other_or_missing") ||
    !(choice(error["className"], errorClasses) || error["className"] === "other_or_missing") ||
    !choice(error["messageType"], kinds))) return null;
  return {
    argCount: shape["argCount"] as number, argTypes: types as Kind[], bodyType: shape["bodyType"] as Kind,
    singleArgEnvelope: shape["singleArgEnvelope"] as boolean, dataType: shape["dataType"] as Kind,
    envelopeKeys: keys as SnapshotResponseShape["envelopeKeys"],
    error: error ? { code: error["code"] as number | "other_or_missing",
      name: error["name"] as string, className: error["className"] as string, messageType: error["messageType"] as Kind } : null,
    cards: Object.fromEntries(countNames.map((key) => [key, cards[key]])) as SnapshotResponseShape["cards"],
    firstCards: safeFirst, cardShapeGroups: safeGroups, omittedCardShapeCount: shape["omittedCardShapeCount"] as number
  };
}
