import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStore } from '../src/core/store.ts';
import { ConnectionCapture } from '../src/core/connection.ts';
import { diffCaptures, formatDiff } from '../src/core/diff.ts';

/** Build a session containing `n` MapWindow requests (plus the handshake). */
function build(n: number, extra?: (cap: ConnectionCapture) => void): CaptureStore {
  const store = new CaptureStore();
  const cap = new ConnectionCapture(1, store);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
  for (let i = 0; i < n; i++) {
    const b = Buffer.alloc(8);
    b[0] = 8; // MapWindow
    b.writeUInt16LE(2, 2);
    b.writeUInt32LE(0x100 + i, 4);
    cap.feed('c2s', b);
  }
  extra?.(cap);
  return store;
}

test('identical captures diff to no change', () => {
  const diff = diffCaptures(build(3).messages, build(3).messages);
  assert.equal(diff.totals.messages.delta, 0);
  assert.equal(diff.changed.length, 0);
  assert.match(diff.summary, /No change/);
});

test('a reduction in a request count is reported with its delta', () => {
  const diff = diffCaptures(build(10).messages, build(4).messages);
  assert.equal(diff.totals.messages.delta, -6);
  const mw = diff.changed.find((c) => c.name === 'MapWindow')!;
  assert.equal(mw.before, 10);
  assert.equal(mw.after, 4);
  assert.equal(mw.delta, -6);
  assert.match(diff.summary, /6 fewer messages/);
});

test('messages present on only one side are called out', () => {
  const after = build(3, (cap) => {
    const gc = Buffer.alloc(16);
    gc[0] = 55; // CreateGC
    gc.writeUInt16LE(4, 2);
    gc.writeUInt32LE(0x900, 4);
    cap.feed('c2s', gc);
  });
  const diff = diffCaptures(build(3).messages, after.messages);
  assert.deepEqual(diff.onlyAfter, ['CreateGC']);
  assert.deepEqual(diff.onlyBefore, []);
});

test('the handshake is excluded so it never shows as noise', () => {
  const diff = diffCaptures(build(1).messages, build(1).messages);
  assert.ok(!diff.changed.some((c) => c.name.startsWith('ConnectionSetup')));
});

test('changed counts are ordered by magnitude', () => {
  const before = build(1);
  const after = build(30, (cap) => {
    const gc = Buffer.alloc(16);
    gc[0] = 55;
    gc.writeUInt16LE(4, 2);
    gc.writeUInt32LE(0x900, 4);
    cap.feed('c2s', gc);
  });
  const diff = diffCaptures(before.messages, after.messages);
  assert.equal(diff.changed[0]!.name, 'MapWindow', 'biggest movement first');
  assert.ok(Math.abs(diff.changed[0]!.delta) >= Math.abs(diff.changed[1]!.delta));
});

test('formatDiff renders a readable report', () => {
  const text = formatDiff(diffCaptures(build(2).messages, build(5).messages));
  assert.match(text, /more messages/);
  assert.match(text, /MapWindow/);
  assert.match(text, /metric/);
});
