import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocationCommandSession } from '../dist/bridge/src/command/location-command-session.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('page stays open while authoritative confirmation is pending', async () => {
  const gate = deferred();
  let closed = false, clicks = 0, returned = false;
  const work = runLocationCommandSession(
    async () => { clicks++; },
    async () => { closed = true; },
    () => gate.promise
  ).then(() => { returned = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(returned, false);
  assert.equal(clicks, 1);
  gate.resolve(); await work;
  assert.equal(closed, true);
  assert.equal(returned, true);
});

test('deferred browser work is not cancelled by premature page close', async () => {
  const gate = deferred();
  let closed = false;
  const work = runLocationCommandSession(
    async () => {}, async () => { closed = true; }, () => gate.promise
  );
  await Promise.resolve();
  assert.equal(closed, false);
  gate.resolve(); await work;
  assert.equal(closed, true);
});

test('confirmation timeout is not changed to a successful alarm state', async () => {
  let closed = 0;
  const timeout = new Error('command_confirmation_timeout');
  await assert.rejects(runLocationCommandSession(
    async () => {}, async () => { closed++; }, async () => { throw timeout; }
  ), error => error === timeout);
  assert.equal(closed, 1);
});

test('missing control closes the page without waiting or repeating dispatch', async () => {
  let waits = 0, clicks = 0, closes = 0;
  await assert.rejects(runLocationCommandSession(
    async () => { clicks++; throw new Error('command_control_not_found'); },
    async () => { closes++; }, async () => { waits++; }
  ), /command_control_not_found/);
  assert.deepEqual([clicks, waits, closes], [1, 0, 1]);
});

test('cleanup failure does not hide a confirmation failure', async () => {
  const expected = new Error('command_confirmation_timeout');
  await assert.rejects(runLocationCommandSession(
    async () => {}, async () => { throw new Error('page_already_closed'); },
    async () => { throw expected; }
  ), error => error === expected);
});

test('legacy callers without a confirmation hook keep their previous contract', async () => {
  const events = [];
  await runLocationCommandSession(async () => { events.push('dispatch'); }, async () => { events.push('close'); });
  assert.deepEqual(events, ['dispatch', 'close']);
});
