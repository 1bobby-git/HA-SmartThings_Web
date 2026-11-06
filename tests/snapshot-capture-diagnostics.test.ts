import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
// @ts-expect-error The standalone add-on CLI deliberately has no TypeScript declaration.
import { summarizeAckArgs } from '../tools/inspect-snapshot-captures.mjs';

const script = resolve('tools/inspect-snapshot-captures.mjs');

describe('snapshot capture diagnostics', () => {
  test('reports only fixed shape fields and never arbitrary secrets or keys', () => {
    const secret = 'SECRET_DEVICE_OR_TOKEN_123';
    const summary = summarizeAckArgs([null, { data: [
      { basic: { deviceId: secret, locationId: secret, token: secret }, privateSecretKey: secret },
      { basic: {}, cloud: { deviceId: secret, locationId: secret } }
    ], privateEnvelopeKey: secret }]);
    const output = JSON.stringify(summary);
    expect(summary?.cards).toMatchObject({ total: 2, missingDeviceId: 1, missingLocationId: 1 });
    expect(summary?.firstCards[1]).toMatchObject({ firstSection: 'basic', deviceId: 'missing' });
    expect(output).not.toContain(secret);
    expect(output).not.toContain('privateSecretKey');
    expect(output).not.toContain('privateEnvelopeKey');
  });

  test('distinguishes an allowlisted 401 error from mixed malformed cards', () => {
    expect(summarizeAckArgs([{ name: 'NotAuthenticated', code: 401, className: 'not-authenticated', message: 'SECRET' }])?.error)
      .toEqual({ code: 401, name: 'NotAuthenticated', className: 'not-authenticated', messageType: 'string' });
    expect(summarizeAckArgs([null, { data: [{ basic: { deviceId: 'a', locationId: 'b' } }, { basic: {} }] }])?.cards)
      .toMatchObject({ total: 2, missingDeviceId: 1, missingLocationId: 1 });
    expect(summarizeAckArgs([{ data: [{ basic: { deviceId: 'a', locationId: 'b' } }] }]))
      .toMatchObject({ bodyType: 'array', singleArgEnvelope: true, dataType: 'array', cards: { total: 1 } });
    expect(summarizeAckArgs([null, { basic: { deviceId: 'a', locationId: 'b' } }]))
      .toMatchObject({ bodyType: 'object', dataType: 'missing', cards: { total: 1 }, firstCards: [{ firstSection: 'basic' }] });
  });

  test('reads captured ACKs without altering the database and bounds CLI output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snapshot-diag-'));
    const dbPath = join(dir, 'bridge.sqlite');
    const protocolPath = join(dir, 'protocol-fingerprint.json');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE captures (id INTEGER PRIMARY KEY, source TEXT, payload_json TEXT)');
      const raw = '431[null,{"data":[{"basic":{"deviceId":"SECRET","locationId":"SECRET"}}]}]';
      db.prepare('INSERT INTO captures (source,payload_json) VALUES (?,?)').run('playwright-websocket-frame', JSON.stringify({ direction: 'received', frame: { payload: raw } }));
      db.prepare('INSERT INTO captures (source,payload_json) VALUES (?,?)').run('cdp-websocket-frame', JSON.stringify({ direction: 'received', payload: { response: { payloadData: '43/namespace,2[{"name":"NotAuthenticated","code":401,"className":"not-authenticated","message":"SECRET"}]' } } }));
      db.prepare('INSERT INTO captures (source,payload_json) VALUES (?,?)').run('cdp-websocket-frame', JSON.stringify({ direction: 'received', payload: { response: { payloadData: raw, truncated: true } } }));
      db.close();
      writeFileSync(protocolPath, JSON.stringify({ protocol_contract_version: 6, last_mismatch: { kind: 'surface', surface: 'snapshot:device_cards:response_shape' }, secret: 'SECRET' }));
      const before = readFileSync(dbPath);
      const stdout = execFileSync(process.execPath, [script, '--db', dbPath, '--protocol', protocolPath], { encoding: 'utf8' });
      const result = JSON.parse(stdout);
      expect(result.protocol).toEqual({ contractVersion: 6, lastMismatchSurface: 'snapshot:device_cards:response_shape' });
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].error.name).toBe('NotAuthenticated');
      expect(result.candidates[1].cards.total).toBe(1);
      expect(stdout).not.toContain('SECRET');
      expect(stdout).not.toContain(dbPath);
      const stdinOutput = execFileSync(process.execPath, ['--input-type=module', '-', '--db', dbPath, '--protocol', protocolPath],
        { input: readFileSync(script), encoding: 'utf8' });
      expect(JSON.parse(stdinOutput)).toEqual(result);
      expect(readFileSync(dbPath).equals(before)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
