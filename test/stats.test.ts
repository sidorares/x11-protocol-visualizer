import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStore } from '../src/core/store.ts';
import { ConnectionCapture } from '../src/core/connection.ts';
import { computeStats, formatStats } from '../src/core/stats.ts';

/** A session with the handshake done, ready to be fed requests and replies. */
function session(): { store: CaptureStore; cap: ConnectionCapture; seq: number } {
  const store = new CaptureStore();
  const cap = new ConnectionCapture(1, store);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
  return { store, cap, seq: 0 };
}

/** A 24-byte GetProperty (opcode 20); `del` sets the delete-on-read flag. */
function getProperty(del: 0 | 1, property: number): Buffer {
  const b = Buffer.alloc(24);
  b[0] = 20;
  b[1] = del;
  b.writeUInt16LE(6, 2);
  b.writeUInt32LE(0x400, 4); // window
  b.writeUInt32LE(property, 8);
  return b;
}

function getInputFocus(): Buffer {
  const b = Buffer.alloc(4);
  b[0] = 43;
  b.writeUInt16LE(1, 2);
  return b;
}

/** A 32-byte reply carrying `seq`. */
function reply(seq: number): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 1;
  b.writeUInt16LE(seq & 0xffff, 2);
  return b;
}

/** Send `n` copies of `req`, answering each, and return the stats. */
function repeat(req: Buffer, n: number) {
  const s = session();
  for (let i = 1; i <= n; i++) {
    s.cap.feed('c2s', req);
    s.cap.feed('s2c', reply(i));
  }
  return computeStats(s.store.messages);
}

const dupHotspot = (stats: ReturnType<typeof computeStats>) =>
  stats.hotspots.find((h) => /repeated identical quer/.test(h.title));

test('a repeated cacheable query is reported as waste', () => {
  const stats = repeat(getProperty(0, 0x21), 5);
  const hotspot = dupHotspot(stats);
  assert.ok(hotspot, 'expected a repeated-query hotspot');
  assert.match(hotspot!.detail, /GetProperty/);
});

test('a delete-on-read GetProperty is a mailbox poll, not a repeat', () => {
  // Same bytes every time, but the request consumes what it reads, so the
  // answer differs — ntk's shared-glyph directory polls a property this way.
  assert.equal(dupHotspot(repeat(getProperty(1, 0x21), 5)), undefined);
});

test('GetInputFocus repeats are sync traffic, not repeated queries', () => {
  // The protocol's fence, and what node-x11 injects so a void request's
  // callback has something to fire on. Already priced as blocking round trips.
  assert.equal(dupHotspot(repeat(getInputFocus(), 8)), undefined);
});

test('formatStats reports the headline counters', () => {
  const stats = repeat(getProperty(0, 0x21), 4);
  const text = formatStats(stats);
  assert.match(text, /messages over/);
  assert.match(text, /round trips, \d+ blocking/);
  assert.match(text, /top requests/);
  assert.match(text, /GetProperty/);
});
