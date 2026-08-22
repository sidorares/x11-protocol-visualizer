import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';
import { RENDER } from '../src/core/protocol/extensions/render.ts';
import { XINPUT } from '../src/core/protocol/extensions/xinput.ts';

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

function setup(cap: ConnectionCapture) {
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
}

/** Feed a QueryExtension(name) request + reply that assigns a major opcode. */
function negotiate(cap: ConnectionCapture, messages: CapturedMessage[], name: string, major: number, firstEvent = 0, firstError = 0) {
  const namePad = (name.length + 3) & ~3;
  const req = Buffer.alloc(8 + namePad);
  req[0] = 98; // QueryExtension
  req.writeUInt16LE(req.length / 4, 2);
  req.writeUInt16LE(name.length, 4);
  req.write(name, 8, 'latin1');
  cap.feed('c2s', req);
  const seq = messages.at(-1)!.seq!;
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(seq & 0xffff, 2);
  reply[8] = 1; // present
  reply[9] = major;
  reply[10] = firstEvent;
  reply[11] = firstError;
  cap.feed('s2c', reply);
}

// --- unit-level: the specs are well formed --------------------------------

test('RENDER exposes the expected request names', () => {
  assert.equal(RENDER.requests![4]!.name, 'CreatePicture');
  assert.equal(RENDER.requests![8]!.name, 'Composite');
  assert.equal(RENDER.requests![26]!.name, 'FillRectangles');
  assert.equal(RENDER.errors![1], 'Picture');
});

test('XInput XGE event names cover the core XI2 set', () => {
  assert.equal(XINPUT.xgeEvents![6]!.name, 'Motion');
  assert.equal(XINPUT.xgeEvents![4]!.name, 'ButtonPress');
  assert.equal(XINPUT.xgeEvents![11]!.name, 'Hierarchy');
});

// --- end-to-end through the connection ------------------------------------

test('a RENDER request is named and decoded via the registry', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  negotiate(cap, messages, 'RENDER', 139);

  // RENDER:CreatePicture(minor 4): pid, drawable, format, value-mask.
  const req = Buffer.alloc(20);
  req[0] = 139; // major
  req[1] = 4; // minor = CreatePicture
  req.writeUInt16LE(5, 2);
  req.writeUInt32LE(0x02000001, 4); // pid
  req.writeUInt32LE(0x000000c0, 8); // drawable
  req.writeUInt32LE(0x00000021, 12); // format
  cap.feed('c2s', req);

  const m = messages.at(-1)!;
  assert.equal(m.ext, 'RENDER');
  assert.equal(m.name, 'RENDER:CreatePicture');
  assert.match(m.summary, /pict=0x02000001/);
  const pid = m.fields!.find((f) => f.name === 'pid')!;
  assert.deepEqual(pid.span, { off: 4, len: 4 });
});

test('a RENDER Picture links a later reference to its creator', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  negotiate(cap, messages, 'RENDER', 139);

  const create = Buffer.alloc(20);
  create[0] = 139;
  create[1] = 4;
  create.writeUInt16LE(5, 2);
  create.writeUInt32LE(0x02000001, 4);
  create.writeUInt32LE(0x000000c0, 8);
  cap.feed('c2s', create);
  const creator = messages.at(-1)!;

  // FreePicture(minor 7) referencing the same picture.
  const free = Buffer.alloc(8);
  free[0] = 139;
  free[1] = 7;
  free.writeUInt16LE(2, 2);
  free.writeUInt32LE(0x02000001, 4);
  cap.feed('c2s', free);
  const m = messages.at(-1)!;
  const pic = m.fields!.find((f) => f.name === 'picture')!;
  assert.equal(pic.ref, creator.id, 'picture reference links to CreatePicture');
});

test('an XInput2 Motion event (XGE) is named and decoded', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  negotiate(cap, messages, 'XInputExtension', 131, 90, 140);

  const ev = Buffer.alloc(56);
  ev[0] = 35; // GenericEvent
  ev[1] = 131; // extension major
  ev.writeUInt16LE(7, 2); // sequence
  ev.writeUInt32LE(6, 4); // length (words beyond 32) => total 56
  ev.writeUInt16LE(6, 8); // evtype = Motion
  ev.writeUInt16LE(3, 10); // deviceid
  ev.writeUInt32LE(0x11223344, 12); // time
  ev.writeUInt32LE(1, 16); // detail
  ev.writeUInt32LE(0x000000c0, 20); // root
  ev.writeUInt32LE(0x02000009, 24); // event window
  ev.writeInt32LE(100 * 65536, 40); // event-x = 100.0
  ev.writeInt32LE(50 * 65536, 44); // event-y = 50.0
  cap.feed('s2c', ev);

  const m = messages.at(-1)!;
  assert.equal(m.category, 'event');
  assert.equal(m.ext, 'XInputExtension');
  assert.equal(m.name, 'XInputExtension:Motion');
  assert.match(m.summary, /dev=3 Motion/);
  assert.match(m.summary, /@\(100,50\)/);
  assert.ok(m.fields!.some((f) => f.name === 'event-x' && f.value === '100'));
});

// --- root pre-seeding -----------------------------------------------------

/** A minimal but structurally valid success setup reply with one screen. */
function setupReplyWithScreen(root: number, cmap: number): Buffer {
  // 40-byte header + 0 vendor + 0 formats + one SCREEN (40 fixed, 0 depths).
  const b = Buffer.alloc(80);
  b[0] = 1; // success
  b.writeUInt16LE((b.length - 8) / 4, 6); // length
  b.writeUInt16LE(0, 24); // vendor len
  b[28] = 1; // num screens
  b[29] = 0; // num formats
  const s = 40;
  b.writeUInt32LE(root, s + 0);
  b.writeUInt32LE(cmap, s + 4);
  b.writeUInt16LE(1920, s + 20); // width
  b.writeUInt16LE(1080, s + 22); // height
  b[s + 39] = 0; // num depths
  return b;
}

test('root window from the setup reply is pre-seeded and links references', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  cap.feed('s2c', setupReplyWithScreen(0x000000c0, 0x00000020));
  const setupReply = messages.at(-1)!;

  // CreateWindow with parent = root.
  const cw = Buffer.alloc(32);
  cw[0] = 1; // CreateWindow
  cw.writeUInt16LE(8, 2);
  cw.writeUInt32LE(0x02000001, 4); // wid
  cw.writeUInt32LE(0x000000c0, 8); // parent = root
  cap.feed('c2s', cw);

  const m = messages.at(-1)!;
  const parent = m.fields!.find((f) => f.name === 'parent')!;
  assert.equal(parent.ref, setupReply.id, 'parent=root links to the setup reply');
});
