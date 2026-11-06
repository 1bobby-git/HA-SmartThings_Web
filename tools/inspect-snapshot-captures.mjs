#!/usr/bin/env node
// Run inside the add-on. Only fixed, bounded structural facts leave this process.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const surfaces = new Set([
  'snapshot:locations:response_shape', 'snapshot:rooms:response_shape',
  'snapshot:device_cards:response_shape', 'snapshot:device_states:response_shape',
  'snapshot:device_health:response_shape', 'snapshot:scenes:response_shape',
  'event:device_event:identity'
]);
const errorNames = new Set(['BadRequest', 'GeneralError', 'NotAuthenticated', 'NotFound', 'Forbidden', 'MethodNotAllowed', 'NotAcceptable', 'Conflict', 'LengthRequired', 'Unprocessable', 'TooManyRequests', 'NotImplemented', 'BadGateway', 'Unavailable', 'Timeout']);
const errorClasses = new Set(['bad-request', 'general-error', 'not-authenticated', 'forbidden', 'not-found', 'too-many-requests']);
const errorCodes = new Set([400, 401, 403, 404, 429, 500, 502, 503]);
const sections = ['basic', 'cloud', 'camera'];
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const rec = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const kind = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' :
  typeof value === 'object' ? 'object' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'other';
const idKind = (obj, key) => !own(obj, key) ? 'missing' :
  typeof obj[key] !== 'string' ? 'non_string' : obj[key].length ? 'nonempty_string' : 'empty_string';
const limited = (count) => Math.min(Math.max(count, 0), 1000000);

function summarizeCard(card) {
  if (!rec(card)) return { kind: kind(card), sections: [], firstSection: 'none', deviceId: 'missing', locationId: 'missing' };
  const present = sections.filter((key) => own(card, key));
  const first = sections.find((key) => rec(card[key]));
  const source = first ? card[first] : null;
  return {
    kind: 'object', sections: present, firstSection: first ?? 'none',
    sectionTypes: sections.map((key) => own(card, key) ? kind(card[key]) : 'missing'),
    hasType: own(card, 'type'),
    deviceId: source ? idKind(source, 'deviceId') : 'missing',
    locationId: source ? idKind(source, 'locationId') : 'missing'
  };
}

export function summarizeAckArgs(args) {
  if (!Array.isArray(args)) return null;
  const body = args[0] === null ? args[1] : args;
  const singleArg = args.length === 1 ? rec(args[0]) : null;
  const envelope = rec(body) ?? singleArg;
  const source = envelope;
  const data = envelope && own(envelope, 'data') ? envelope.data : undefined;
  const rows = Array.isArray(data) ? data : rec(data) ? [data] :
    rec(body) ? [body] : Array.isArray(body) ? body : [];
  const counts = { total: limited(rows.length), nonObjects: 0, noSection: 0, missingDeviceId: 0, missingLocationId: 0, validDeviceIds: 0, validLocationIds: 0 };
  for (const row of rows) {
    const card = summarizeCard(row);
    if (card.kind !== 'object') counts.nonObjects++;
    if (card.firstSection === 'none') counts.noSection++;
    if (card.deviceId !== 'nonempty_string') counts.missingDeviceId++;
    else counts.validDeviceIds++;
    if (card.locationId !== 'nonempty_string') counts.missingLocationId++;
    else counts.validLocationIds++;
  }
  const error = args.length === 1 ? rec(args[0]) : null;
  return {
    argCount: limited(args.length), argTypes: args.slice(0, 5).map(kind),
    bodyType: kind(body), singleArgEnvelope: Boolean(singleArg && own(singleArg, 'data')),
    dataType: data === undefined ? 'missing' : kind(data),
    envelopeKeys: ['data', 'etag', 'version', 'error', 'code', 'name', 'className'].filter((key) => source && own(source, key)),
    error: error ? {
      code: errorCodes.has(error.code) ? error.code : 'other_or_missing',
      name: errorNames.has(error.name) ? error.name : 'other_or_missing',
      className: errorClasses.has(error.className) ? error.className : 'other_or_missing',
      messageType: own(error, 'message') ? kind(error.message) : 'missing'
    } : null,
    cards: counts,
    firstCards: rows.slice(0, 3).map(summarizeCard)
  };
}

function parseAck(raw) {
  if (typeof raw !== 'string' || raw.length > 1048576 || !/^43(?:\/[^,\r\n]{1,80},)?\d{1,12}\[/u.test(raw)) return null;
  try {
    const args = JSON.parse(raw.slice(raw.indexOf('[')));
    return Array.isArray(args) ? args : null;
  } catch { return null; }
}

function captureText(payload) {
  const root = rec(payload);
  if (!root || root.direction !== 'received') return null;
  const frame = rec(root.frame);
  if (frame && frame.truncated !== true && typeof frame.payload === 'string') return frame.payload;
  const response = rec(rec(root.payload)?.response);
  if (response && response.truncated !== true && typeof response.payloadData === 'string') return response.payloadData;
  return null;
}

function protocolSummary(path) {
  try {
    const value = rec(JSON.parse(readFileSync(path, 'utf8')));
    const version = value?.protocol_contract_version ?? value?.protocolContractVersion;
    const mismatch = rec(value?.last_mismatch ?? value?.lastMismatch);
    return {
      contractVersion: Number.isSafeInteger(version) && version >= 0 && version <= 100 ? version : null,
      lastMismatchSurface: mismatch?.kind === 'surface' && surfaces.has(mismatch.surface) ? mismatch.surface : null
    };
  } catch { return { contractVersion: null, lastMismatchSurface: null }; }
}

function options(argv) {
  let db = '/data/bridge.sqlite';
  let protocol = '/data/protocol-fingerprint.json';
  for (let i = 0; i < argv.length; i += 2) {
    if (i + 1 >= argv.length || !['--db', '--protocol'].includes(argv[i])) throw new Error('invalid_arguments');
    if (argv[i] === '--db') db = argv[i + 1];
    else protocol = argv[i + 1];
  }
  return { db, protocol };
}

export function inspect(dbPath, protocolPath) {
  const protocol = protocolSummary(protocolPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const candidates = [];
  let scannedRows = 0;
  try {
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare("SELECT source, payload_json FROM captures WHERE source IN ('playwright-websocket-frame','cdp-websocket-frame') ORDER BY id DESC LIMIT 2000").iterate();
    for (const row of rows) {
      scannedRows++;
      try {
        const args = parseAck(captureText(JSON.parse(row.payload_json)));
        if (args) candidates.push(summarizeAckArgs(args));
      } catch { /* Never expose malformed capture content. */ }
      if (candidates.length === 10) break;
    }
  } finally { db.close(); }
  return { schemaVersion: 1, protocol, scannedRows: limited(scannedRows), candidates };
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  try {
    const { db, protocol } = options(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(inspect(db, protocol))}\n`);
  } catch {
    process.stdout.write('{"schemaVersion":1,"error":"inspection_unavailable"}\n');
    process.exitCode = 1;
  }
}
