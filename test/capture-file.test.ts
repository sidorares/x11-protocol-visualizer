import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStore } from '../src/core/store.ts';
import { ConnectionCapture } from '../src/core/connection.ts';
import { serializeCapture, loadCapture, CaptureFileError } from '../src/core/capture-file.ts';
import { computeStats } from '../src/core/stats.ts';

/** Drive a small but representative session into a fresh store. */
function buildSession(): CaptureStore {
  const store = new CaptureStore();
  store.openConnection({ id: 1, peer: '127.0.0.1:1234', target: 'unix:/tmp/.X11-unix/X0', openedAt: 1000 });
  let mono = 0;
  const clock = { mono: () => mono, wall: () => 1000 + mono };
  const cap = new ConnectionCapture(1, store, clock);

  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);

  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  sr.writeUInt32LE(0x00a00000, 12);
  mono = 1;
  cap.feed('s2c', sr);

  // GetGeometry request …
  const req = Buffer.alloc(8);
  req[0] = 14;
  req.writeUInt16LE(2, 2);
  req.writeUInt32LE(0xc0, 4);
  mono = 10;
  cap.feed('c2s', req);

  // … and its reply 25 ms later.
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(1, 2);
  reply[1] = 24;
  reply.writeUInt16LE(800, 16);
  reply.writeUInt16LE(600, 18);
  mono = 35;
  cap.feed('s2c', reply);

  // An event, which is not a round trip.
  const ev = Buffer.alloc(32);
  ev[0] = 12; // Expose
  mono = 40;
  cap.feed('s2c', ev);
  return store;
}

test('a capture round-trips: save then load reproduces messages, decode and timing', () => {
  const original = buildSession();
  const text = serializeCapture(original, 'unix:/tmp/.X11-unix/X0');

  const reloaded = new CaptureStore();
  const res = loadCapture(text, reloaded);

  assert.equal(res.messages, original.messages.length, 'same message count');
  assert.equal(res.connections, 1);

  const a = original.messages;
  const b = reloaded.messages;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i]!.name, a[i]!.name, `message ${i} name`);
    assert.equal(b[i]!.summary, a[i]!.summary, `message ${i} summary`);
    assert.equal(b[i]!.category, a[i]!.category);
    assert.deepEqual(b[i]!.bytes, a[i]!.bytes, `message ${i} bytes are byte-exact`);
    assert.equal(b[i]!.ts, a[i]!.ts, 'wall clock preserved');
  }

  // The decoded reply and its RTT survive the round trip.
  const reply = b.find((m) => m.category === 'reply')!;
  assert.match(reply.summary, /800×600/);
  assert.equal(reply.rttMs, 25, 'RTT is reconstructed from recorded timing, not load time');
});

test('loading rejects a bad header and an unsupported version', () => {
  const store = new CaptureStore();
  assert.throws(() => loadCapture('', store), CaptureFileError);
  assert.throws(() => loadCapture('not json\n', store), CaptureFileError);
  assert.throws(() => loadCapture(JSON.stringify({ x11cap: 99, connections: [] }) + '\n', store), CaptureFileError);
});

test('a truncated final line is tolerated rather than failing the load', () => {
  const text = serializeCapture(buildSession(), 't');
  const truncated = text.slice(0, text.length - 20); // chop mid-record
  const store = new CaptureStore();
  const res = loadCapture(truncated, store);
  assert.ok(res.messages >= 3, 'earlier records still load');
});

test('loading replaces any previous contents', () => {
  const store = buildSession();
  const before = store.messages.length;
  assert.ok(before > 0);
  loadCapture(serializeCapture(buildSession(), 't'), store);
  assert.equal(store.messages.length, before, 'not appended to the old contents');
});

// --- stats -----------------------------------------------------------------

test('stats count round trips, stalls and byte totals', () => {
  const store = buildSession();
  const s = computeStats(store.messages);

  assert.equal(s.total, store.messages.length);
  assert.equal(s.byCategory.request, 1);
  assert.equal(s.byCategory.reply, 1);
  assert.equal(s.byCategory.event, 1);
  assert.equal(s.roundTrips, 1);
  // The client sent nothing between the request and its reply → a stall.
  assert.equal(s.stalls, 1);
  assert.equal(s.rttMaxMs, 25);
  assert.equal(s.rttMeanMs, 25);
  assert.equal(s.slowest?.name, 'GetGeometry');
  assert.ok(s.bytesC2S > 0 && s.bytesS2C > 0);
  assert.equal(s.topRequests[0]?.name, 'GetGeometry');
});

test('a request the client did not wait on is not counted as a stall', () => {
  const store = new CaptureStore();
  let mono = 0;
  const cap = new ConnectionCapture(1, store, { mono: () => mono, wall: () => 1000 + mono });
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);

  // Two pipelined requests, then the first reply: the client kept working.
  const mk = (w: number) => {
    const b = Buffer.alloc(8);
    b[0] = 14;
    b.writeUInt16LE(2, 2);
    b.writeUInt32LE(w, 4);
    return b;
  };
  mono = 5;
  cap.feed('c2s', mk(0xc0));
  mono = 6;
  cap.feed('c2s', mk(0xc1));
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(1, 2); // answers seq 1
  mono = 20;
  cap.feed('s2c', reply);

  const s = computeStats(store.messages);
  assert.equal(s.roundTrips, 1);
  assert.equal(s.stalls, 0, 'seq 1 was not the last request when it was answered');
});
