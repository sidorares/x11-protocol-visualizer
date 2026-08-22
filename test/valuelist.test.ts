import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeValueList } from '../src/core/protocol/valuelist.ts';
import { CW_BITS, GC_BITS } from '../src/core/protocol/enums.ts';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

test('value-mask expands to named bits and decodes present values in bit order', () => {
  // CW mask = BackPixel(0x2) | EventMask(0x800); values: pixel, event-mask.
  const b = Buffer.alloc(16);
  b.writeUInt32LE(0x0002 | 0x0800, 0); // mask
  b.writeUInt32LE(0x00ff00ff, 4); // background-pixel
  b.writeUInt32LE(0x00000001 | 0x00008000, 8); // event-mask = KeyPress | Exposure
  const { fields, maskStr } = decodeValueList(b, 0, 'LE', CW_BITS);
  assert.equal(maskStr, 'background-pixel | event-mask');
  const pix = fields.find((f) => f.name === 'background-pixel')!;
  assert.equal(pix.color, '#ff00ff', 'pixel value previews as a color');
  const evm = fields.find((f) => f.name === 'event-mask')!;
  assert.match(evm.value, /KeyPress \| Exposure/);
});

test('GC value-list decodes enums by name', () => {
  // GC mask = Function(0x1) | LineStyle(0x20) | Foreground(0x4)
  const b = Buffer.alloc(20);
  b.writeUInt32LE(0x1 | 0x4 | 0x20, 0);
  b.writeUInt32LE(3, 4); // function = Copy
  b.writeUInt32LE(0x112233, 8); // foreground
  b.writeUInt32LE(1, 12); // line-style = OnOffDash
  const { fields } = decodeValueList(b, 0, 'LE', GC_BITS);
  assert.match(fields.find((f) => f.name === 'function')!.value, /Copy \(3\)/);
  assert.equal(fields.find((f) => f.name === 'foreground')!.color, '#112233');
  assert.match(fields.find((f) => f.name === 'line-style')!.value, /OnOffDash/);
});

function collector() {
  const messages: CapturedMessage[] = [];
  let id = 0;
  const sink: CaptureSink = { nextId: () => ++id, onMessage: (m) => messages.push(m), onLink: () => {} };
  return { sink, messages };
}
function setup(cap: ConnectionCapture) {
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
}
function negotiate(cap: ConnectionCapture, messages: CapturedMessage[], name: string, major: number) {
  const pad = (name.length + 3) & ~3;
  const req = Buffer.alloc(8 + pad);
  req[0] = 98;
  req.writeUInt16LE(req.length / 4, 2);
  req.writeUInt16LE(name.length, 4);
  req.write(name, 8, 'latin1');
  cap.feed('c2s', req);
  const seq = messages.at(-1)!.seq!;
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(seq & 0xffff, 2);
  reply[8] = 1;
  reply[9] = major;
  cap.feed('s2c', reply);
}

test('RENDER CreatePicture value-mask 0x600 reads as PolyEdge | PolyMode', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  negotiate(cap, messages, 'RENDER', 139);
  const b = Buffer.alloc(28);
  b[0] = 139;
  b[1] = 4; // CreatePicture
  b.writeUInt16LE(7, 2);
  b.writeUInt32LE(0x02000001, 4); // pid
  b.writeUInt32LE(0x000000c0, 8); // drawable
  b.writeUInt32LE(0x29, 12); // format
  b.writeUInt32LE(0x600, 16); // value-mask
  b.writeUInt32LE(1, 20); // poly-edge = Smooth
  b.writeUInt32LE(0, 24); // poly-mode = Precise
  cap.feed('c2s', b);
  const m = messages.at(-1)!;
  assert.match(m.summary, /poly-edge \| poly-mode/);
  assert.match(m.fields!.find((f) => f.name === 'poly-edge')!.value, /Smooth/);
  assert.match(m.fields!.find((f) => f.name === 'poly-mode')!.value, /Precise/);
});

test('PictFormat ids resolve to a human-readable name after QueryPictFormats', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  negotiate(cap, messages, 'RENDER', 139);
  // QueryPictFormats request (minor 1)
  const q = Buffer.alloc(4);
  q[0] = 139;
  q[1] = 1;
  q.writeUInt16LE(1, 2);
  cap.feed('c2s', q);
  const seq = messages.at(-1)!.seq!;
  // reply: num-formats=1, one Direct depth24 R8G8B8 format id 0x29
  const reply = Buffer.alloc(60);
  reply[0] = 1;
  reply.writeUInt16LE(seq & 0xffff, 2);
  reply.writeUInt32LE(7, 4); // length
  reply.writeUInt32LE(1, 8); // num-formats
  const fo = 32;
  reply.writeUInt32LE(0x29, fo); // id
  reply[fo + 4] = 1; // type = Direct
  reply[fo + 5] = 24; // depth
  reply.writeUInt16LE(0x00ff, fo + 10); // red-mask
  reply.writeUInt16LE(0x00ff, fo + 14); // green-mask
  reply.writeUInt16LE(0x00ff, fo + 18); // blue-mask
  reply.writeUInt16LE(0x0000, fo + 22); // alpha-mask
  cap.feed('s2c', reply);

  // Now a CreatePicture using format 0x29 should name it.
  const cp = Buffer.alloc(20);
  cp[0] = 139;
  cp[1] = 4;
  cp.writeUInt16LE(5, 2);
  cp.writeUInt32LE(0x02000001, 4);
  cp.writeUInt32LE(0x000000c0, 8);
  cp.writeUInt32LE(0x29, 12);
  cap.feed('c2s', cp);
  const m = messages.at(-1)!;
  assert.match(m.summary, /Direct depth24 R8G8B8/);
});
