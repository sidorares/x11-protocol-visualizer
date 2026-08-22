import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';
import { CaptureStore } from '../src/core/store.ts';

function collector() {
  const messages: CapturedMessage[] = [];
  const links: Array<{ requestId: number; replyId: number; rttMs: number }> = [];
  let id = 0;
  const sink: CaptureSink = {
    nextId: () => ++id,
    onMessage: (m) => messages.push(m),
    onLink: (requestId, replyId, rttMs) => links.push({ requestId, replyId, rttMs }),
  };
  return { sink, messages, links };
}

/** Minimal valid LSB-first client setup (no auth), 12 bytes. */
function clientSetup(): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0x6c; // 'l' = LSB-first
  b.writeUInt16LE(11, 2); // protocol-major
  // auth name len (6) and data len (8) stay 0
  return b;
}

/** Minimal 40-byte success server setup reply with resource-id base/mask. */
function serverSetupReply(): Buffer {
  const b = Buffer.alloc(40);
  b[0] = 1; // success
  b.writeUInt16LE(8, 6); // additional-data length in 4-byte units => total 40
  b.writeUInt32LE(0x04800000, 12); // resource-id-base
  b.writeUInt32LE(0x001fffff, 16); // resource-id-mask
  return b;
}

function mapWindow(win: number): Buffer {
  const b = Buffer.alloc(8);
  b[0] = 8; // MapWindow
  b.writeUInt16LE(2, 2); // length in words
  b.writeUInt32LE(win, 4);
  return b;
}

function queryExtension(name: string): Buffer {
  const namePad = (name.length + 3) & ~3;
  const b = Buffer.alloc(8 + namePad);
  b[0] = 98;
  b.writeUInt16LE(b.length / 4, 2);
  b.writeUInt16LE(name.length, 4);
  b.write(name, 8, 'latin1');
  return b;
}

function reply32(seq: number, fill: (b: Buffer) => void = () => {}): Buffer {
  const b = Buffer.alloc(32);
  b[0] = 1;
  b.writeUInt16LE(seq & 0xffff, 2);
  fill(b);
  return b;
}

function feedSetup(cap: ConnectionCapture) {
  cap.feed('c2s', clientSetup());
  cap.feed('s2c', serverSetupReply());
}

test('frames the connection setup handshake in both directions', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.category, 'setup-request');
  assert.equal(messages[0]!.name, 'ConnectionSetup');
  assert.equal(messages[1]!.category, 'setup-reply');
  assert.match(messages[1]!.summary, /base=0x04800000 mask=0x001fffff/);
});

test('frames a request and assigns a sequence number', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  cap.feed('c2s', mapWindow(0x04800001));
  const m = messages.at(-1)!;
  assert.equal(m.category, 'request');
  assert.equal(m.name, 'MapWindow');
  assert.equal(m.seq, 1);
  assert.match(m.summary, /window=0x04800001/);
});

test('links a reply to its request and records RTT', () => {
  const { sink, messages, links } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  cap.feed('c2s', queryExtension('BIG-REQUESTS')); // seq 1
  cap.feed('s2c', reply32(1, (b) => {
    b[8] = 1; // present
    b[9] = 133; // major opcode
  }));
  const reply = messages.at(-1)!;
  assert.equal(reply.category, 'reply');
  assert.equal(reply.requestId, messages.at(-2)!.id);
  assert.equal(links.length, 1);
  assert.ok(reply.rttMs !== undefined && reply.rttMs >= 0);
});

test('learns extension major opcode from QueryExtension reply', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  cap.feed('c2s', queryExtension('BIG-REQUESTS')); // seq 1
  cap.feed('s2c', reply32(1, (b) => {
    b[8] = 1;
    b[9] = 133;
  }));
  // A subsequent request with major opcode 133 should now be named by extension.
  const extReq = Buffer.alloc(4);
  extReq[0] = 133;
  extReq[1] = 0; // minor
  extReq.writeUInt16LE(1, 2);
  cap.feed('c2s', extReq);
  const m = messages.at(-1)!;
  assert.equal(m.ext, 'BIG-REQUESTS');
  assert.match(m.name, /^BIG-REQUESTS:Enable/);
});

test('handles BIG-REQUESTS zero-length extended requests', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  const big = Buffer.alloc(12);
  big[0] = 127; // NoOperation
  big.writeUInt16LE(0, 2); // 0 => big-request format
  big.writeUInt32LE(3, 4); // real length = 3 words = 12 bytes
  cap.feed('c2s', big);
  const m = messages.at(-1)!;
  assert.equal(m.name, 'NoOperation');
  assert.equal(m.bytes.length, 12);
});

test('frames a fixed 32-byte event (Expose) with no request link', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  const ev = Buffer.alloc(32);
  ev[0] = 12; // Expose
  cap.feed('s2c', ev);
  const m = messages.at(-1)!;
  assert.equal(m.category, 'event');
  assert.equal(m.name, 'Expose');
  assert.equal(m.requestId, undefined);
});

test('KeymapNotify (code 11) is framed as 32 bytes and not seq-linked', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  const km = Buffer.alloc(32);
  km[0] = 11;
  cap.feed('s2c', km);
  const m = messages.at(-1)!;
  assert.equal(m.name, 'KeymapNotify');
  assert.equal(m.bytes.length, 32);
});

test('frames a GenericEvent (XGE) longer than 32 bytes', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  const ge = Buffer.alloc(36);
  ge[0] = 35; // GenericEvent
  ge[1] = 133; // extension major
  ge.writeUInt32LE(1, 4); // length = 1 word => total 36
  ge.writeUInt16LE(7, 8); // evtype
  cap.feed('s2c', ge);
  const m = messages.at(-1)!;
  assert.equal(m.category, 'event');
  assert.equal(m.bytes.length, 36);
});

test('links an error to its request via sequence number', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  cap.feed('c2s', mapWindow(0xdeadbeef)); // seq 1
  const err = Buffer.alloc(32);
  err[0] = 0; // error
  err[1] = 3; // Window
  err.writeUInt16LE(1, 2); // sequence
  cap.feed('s2c', err);
  const m = messages.at(-1)!;
  assert.equal(m.category, 'error');
  assert.equal(m.name, 'WindowError');
  assert.equal(m.requestId, messages.find((x) => x.seq === 1)!.id);
});

test('reassembles a message split across multiple chunks', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  const before = messages.length;
  const req = queryExtension('RENDER');
  cap.feed('c2s', req.subarray(0, 3));
  assert.equal(messages.length, before, 'no message until fully buffered');
  cap.feed('c2s', req.subarray(3));
  assert.equal(messages.length, before + 1);
  assert.match(messages.at(-1)!.summary, /"RENDER"/);
});

test('two back-to-back requests in one chunk get sequential seq numbers', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  feedSetup(cap);
  cap.feed('c2s', Buffer.concat([mapWindow(1), mapWindow(2)]));
  const reqs = messages.filter((m) => m.category === 'request');
  assert.equal(reqs.length, 2);
  assert.deepEqual(reqs.map((r) => r.seq), [1, 2]);
});

// --- forward linkage (request → its answer) --------------------------------

test('a request records its answer by mutation, and knows whether to expect one', () => {
  // The mutation lives in CaptureStore.onLink — that is the point: the request
  // is updated in place when the answer arrives, so nothing has to search.
  const store = new CaptureStore();
  const messages = store.messages;
  const cap = new ConnectionCapture(1, store);
  feedSetup(cap);

  // A void request never gets an answer and never claims to be waiting.
  cap.feed('c2s', mapWindow(0x0000c0));
  const voidReq = messages.at(-1)!;
  assert.equal(voidReq.expectsReply, false, 'MapWindow generates no reply');
  assert.equal(voidReq.replyId, undefined);

  // A reply-generating request is "waiting" until its answer lands.
  const getGeometry = Buffer.alloc(8);
  getGeometry[0] = 14;
  getGeometry.writeUInt16LE(2, 2);
  getGeometry.writeUInt32LE(0xc0, 4);
  cap.feed('c2s', getGeometry);
  const req = messages.at(-1)!;
  assert.equal(req.expectsReply, true, 'GetGeometry does generate one');
  assert.equal(req.replyId, undefined, 'nothing linked yet → "no response yet"');

  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(req.seq! & 0xffff, 2);
  cap.feed('s2c', reply);
  const rep = messages.at(-1)!;

  // The link is written onto the request when the answer arrives; finding it
  // later is a field read, not a search.
  assert.equal(req.replyId, rep.id, 'forward link');
  assert.equal(rep.requestId, req.id, 'and the backward link still holds');
  assert.ok(req.rttMs !== undefined);
});

test('a request answered by an error links to the error', () => {
  const store = new CaptureStore();
  const messages = store.messages;
  const cap = new ConnectionCapture(1, store);
  feedSetup(cap);
  const getGeometry = Buffer.alloc(8);
  getGeometry[0] = 14;
  getGeometry.writeUInt16LE(2, 2);
  cap.feed('c2s', getGeometry);
  const req = messages.at(-1)!;

  const err = Buffer.alloc(32);
  err[0] = 0;
  err[1] = 9; // Drawable
  err.writeUInt16LE(req.seq! & 0xffff, 2);
  cap.feed('s2c', err);

  assert.equal(req.replyId, messages.at(-1)!.id, 'an error answers the request too');
  assert.equal(messages.at(-1)!.category, 'error');
});
