import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeReply } from '../src/core/protocol/replies.ts';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

function reply(len32: number, fill: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(32 + len32 * 4);
  b[0] = 1;
  b.writeUInt32LE(len32, 4);
  fill(b);
  return b;
}

test('GetGeometry reply decodes geometry with spans', () => {
  const b = reply(0, (x) => {
    x[1] = 24; // depth
    x.writeUInt32LE(0x0000012c, 8); // root
    x.writeInt16LE(10, 12);
    x.writeInt16LE(20, 14);
    x.writeUInt16LE(800, 16);
    x.writeUInt16LE(600, 18);
    x.writeUInt16LE(2, 20);
  });
  const d = decodeReply(14, b, 'LE')!;
  assert.equal(d.summary, '800×600+10+20 depth=24');
  const w = d.fields.find((f) => f.name === 'width')!;
  assert.deepEqual(w.span, { off: 16, len: 2 });
  assert.equal(w.value, '800');
});

test('GetInputFocus reply names PointerRoot and revert-to', () => {
  const b = reply(0, (x) => {
    x[1] = 2; // revert-to = Parent
    x.writeUInt32LE(1, 8); // PointerRoot
  });
  const d = decodeReply(43, b, 'LE')!;
  assert.match(d.summary, /focus=PointerRoot/);
  assert.match(d.summary, /revert=Parent/);
});

test('GetProperty reply decodes an 8-bit string value', () => {
  const text = 'hello';
  const b = reply(2, (x) => {
    x[1] = 8; // format
    x.writeUInt32LE(31, 8); // type = STRING
    x.writeUInt32LE(0, 12); // bytes-after
    x.writeUInt32LE(text.length, 16);
    x.write(text, 32, 'latin1');
  });
  const d = decodeReply(20, b, 'LE', { atomName: (a) => (a === 31 ? 'STRING' : String(a)) })!;
  assert.match(d.summary, /STRING\/8 len=5 "hello"/);
  const v = d.fields.find((f) => f.name === 'value')!;
  assert.deepEqual(v.span, { off: 32, len: 5 });
});

test('GetProperty reply renders a 32-bit ATOM list by name', () => {
  const b = reply(2, (x) => {
    x[1] = 32;
    x.writeUInt32LE(4, 8); // type = ATOM
    x.writeUInt32LE(0, 12);
    x.writeUInt32LE(2, 16); // value-len
    x.writeUInt32LE(39, 32); // WM_NAME
    x.writeUInt32LE(67, 36); // WM_CLASS
  });
  const names: Record<number, string> = { 4: 'ATOM', 39: 'WM_NAME', 67: 'WM_CLASS' };
  const d = decodeReply(20, b, 'LE', { atomName: (a) => names[a] ?? String(a) })!;
  assert.match(d.summary, /WM_NAME, WM_CLASS/);
});

test('ListExtensions reply decodes the STRING8 list', () => {
  const names = ['BIG-REQUESTS', 'RENDER'];
  const payload = Buffer.concat(
    names.map((n) => Buffer.concat([Buffer.from([n.length]), Buffer.from(n, 'latin1')])),
  );
  const words = Math.ceil(payload.length / 4);
  const b = reply(words, (x) => {
    x[1] = names.length;
    payload.copy(x, 32);
  });
  const d = decodeReply(99, b, 'LE')!;
  assert.match(d.summary, /2: BIG-REQUESTS, RENDER/);
});

test('QueryBestSize reply decodes dimensions', () => {
  const b = reply(0, (x) => {
    x.writeUInt16LE(64, 8);
    x.writeUInt16LE(64, 10);
  });
  assert.equal(decodeReply(97, b, 'LE')!.summary, '64×64');
});

test('big-endian replies decode with the connection byte order', () => {
  const b = Buffer.alloc(32);
  b[0] = 1;
  b.writeUInt16BE(800, 16);
  b.writeUInt16BE(600, 18);
  b[1] = 24;
  const d = decodeReply(14, b, 'BE')!;
  assert.match(d.summary, /800×600/);
});

test('an unknown request opcode yields no specific decode', () => {
  assert.equal(decodeReply(200, reply(0, () => {}), 'LE'), undefined);
});

// --- end-to-end through the connection state machine -----------------------

function collector() {
  const messages: CapturedMessage[] = [];
  let id = 0;
  const sink: CaptureSink = {
    nextId: () => ++id,
    onMessage: (m) => messages.push(m),
    onLink: () => {},
  };
  return { sink, messages };
}

test('a reply is decoded using the opcode of the request it answers', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  // setup
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);

  // GetGeometry request (opcode 14), seq 1
  const req = Buffer.alloc(8);
  req[0] = 14;
  req.writeUInt16LE(2, 2);
  req.writeUInt32LE(0x0000012c, 4);
  cap.feed('c2s', req);

  // its reply
  cap.feed(
    's2c',
    reply(0, (x) => {
      x.writeUInt16LE(1, 2); // sequence
      x[1] = 24;
      x.writeUInt16LE(1024, 16);
      x.writeUInt16LE(768, 18);
    }),
  );

  const rep = messages.at(-1)!;
  assert.equal(rep.category, 'reply');
  assert.equal(rep.name, 'GetGeometry·reply');
  assert.match(rep.summary, /1024×768\+0\+0 depth=24/);
  // fields include the generic header plus the decoded body
  assert.ok(rep.fields!.some((f) => f.name === 'width' && f.value === '1024'));
});
