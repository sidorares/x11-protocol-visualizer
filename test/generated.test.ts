import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GENERATED, GENERATED_BY_XNAME } from '../src/core/protocol/generated.ts';
import { ConnectionCapture } from '../src/core/connection.ts';
import { CaptureStore } from '../src/core/store.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

// --- the generated tables themselves ---------------------------------------

test('core request layouts match the X11 spec', () => {
  const req = (op: number) => GENERATED['xproto']!.requests[op]!;
  const at = (op: number, name: string) => req(op).fields.find((f) => f.name === name)?.off;

  // CreateWindow: depth in the data byte, then wid/parent from offset 4.
  assert.equal(at(1, 'depth'), 1);
  assert.equal(at(1, 'wid'), 4);
  assert.equal(at(1, 'parent'), 8);
  assert.equal(at(1, 'class'), 22);
  assert.equal(at(1, 'value_mask'), 28);
  assert.equal(req(1).partial, true, 'stops at the value-list');

  // A request whose data byte is a pad starts its fields at 4.
  assert.equal(at(8, 'window'), 4); // MapWindow
  assert.equal(at(20, 'window'), 4); // GetProperty
  assert.equal(at(20, 'delete'), 1);
});

test('extension request layouts skip the minor-opcode byte', () => {
  const cp = GENERATED_BY_XNAME['RENDER']!.requests[4]!;
  assert.equal(cp.name, 'CreatePicture');
  const at = (n: string) => cp.fields.find((f) => f.name === n)?.off;
  // byte 1 is the minor opcode, so nothing may be laid out there.
  assert.equal(at('pid'), 4);
  assert.equal(at('drawable'), 8);
  assert.equal(at('format'), 12);
  assert.ok(!cp.fields.some((f) => f.off === 1), 'no field occupies the minor-opcode byte');
});

test('classic event layouts skip the sequence number', () => {
  const expose = GENERATED['xproto']!.events[12]!;
  assert.equal(expose.name, 'Expose');
  const at = (n: string) => expose.fields.find((f) => f.name === n)?.off;
  assert.equal(at('window'), 4, 'after code, pad and the 2-byte sequence');
  assert.equal(at('count'), 16);
});

test('XGE event layouts start after the generic-event header, via eventcopy refs', () => {
  const motion = GENERATED_BY_XNAME['XInputExtension']!.events[6]!;
  assert.equal(motion.name, 'Motion');
  const at = (n: string) => motion.fields.find((f) => f.name === n)?.off;
  assert.equal(at('deviceid'), 10, 'after 35/ext/seq/length/evtype');
  assert.equal(at('time'), 12);
  assert.equal(at('event'), 24);
});

test('enums and value-mask bits are generated', () => {
  assert.equal(GENERATED['xproto']!.enums['WindowClass']![1], 'InputOutput');
  const cw = GENERATED['xproto']!.masks['CW']!;
  assert.equal(cw.find((b) => b.name === 'BackPixel')?.bit, 0x2);
  assert.equal(cw.find((b) => b.name === 'EventMask')?.bit, 0x800);
});

test('the corpus covers every extension we care about', () => {
  for (const x of ['RENDER', 'RANDR', 'XInputExtension', 'MIT-SHM', 'DAMAGE', 'XFIXES', 'Present', 'SYNC', 'Composite']) {
    assert.ok(GENERATED_BY_XNAME[x], `${x} missing from generated tables`);
  }
});

// --- the fallback decoder in action ----------------------------------------

function session() {
  const store = new CaptureStore();
  const cap = new ConnectionCapture(1, store);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
  return { store, cap };
}

function negotiate(cap: ConnectionCapture, store: CaptureStore, name: string, major: number) {
  const pad = (name.length + 3) & ~3;
  const req = Buffer.alloc(8 + pad);
  req[0] = 98;
  req.writeUInt16LE(req.length / 4, 2);
  req.writeUInt16LE(name.length, 4);
  req.write(name, 8, 'latin1');
  cap.feed('c2s', req);
  const seq = (store.messages.at(-1) as CapturedMessage).seq!;
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(seq & 0xffff, 2);
  reply[8] = 1;
  reply[9] = major;
  cap.feed('s2c', reply);
}

test('an extension with no hand-written spec is still named and decoded', () => {
  const { store, cap } = session();
  negotiate(cap, store, 'MIT-SHM', 130);

  // MIT-SHM Attach(minor 1): shmseg@4, shmid@8, read-only@12
  const b = Buffer.alloc(16);
  b[0] = 130;
  b[1] = 1;
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(0x00500001, 4);
  b.writeUInt32LE(4242, 8);
  b[12] = 1;
  cap.feed('c2s', b);

  const m = store.messages.at(-1)!;
  assert.equal(m.name, 'MIT-SHM:Attach', 'named from the generated tables');
  const shmseg = m.fields!.find((f) => f.name === 'shmseg')!;
  assert.equal(shmseg.value, '0x00500001');
  assert.deepEqual(shmseg.span, { off: 4, len: 4 });
  assert.equal(m.fields!.find((f) => f.name === 'shmid')!.value, '4242');
});

test('a core request with no hand-written decoder falls back to generated fields', () => {
  const { store, cap } = session();
  // ClearArea(61): exposures@1, window@4, x@8, y@10, width@12, height@14
  const b = Buffer.alloc(16);
  b[0] = 61;
  b[1] = 1;
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(0x00600007, 4);
  b.writeInt16LE(5, 8);
  b.writeInt16LE(6, 10);
  b.writeUInt16LE(100, 12);
  b.writeUInt16LE(50, 14);
  cap.feed('c2s', b);

  const m = store.messages.at(-1)!;
  assert.equal(m.name, 'ClearArea');
  assert.equal(m.fields!.find((f) => f.name === 'window')!.value, '0x00600007');
  assert.equal(m.fields!.find((f) => f.name === 'width')!.value, '100');
});

test('generated resource fields still link to their creator', () => {
  const { store, cap } = session();
  // Create a pixmap, then ClearArea-style reference it through generated decode.
  const cp = Buffer.alloc(16);
  cp[0] = 53;
  cp[1] = 24;
  cp.writeUInt16LE(4, 2);
  cp.writeUInt32LE(0x00600007, 4);
  cp.writeUInt32LE(0xc0, 8);
  cap.feed('c2s', cp);
  const creator = store.messages.at(-1)!;

  const b = Buffer.alloc(16);
  b[0] = 61; // ClearArea — decoded generically, window is a WINDOW resource
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(0x00600007, 4);
  cap.feed('c2s', b);

  const win = store.messages.at(-1)!.fields!.find((f) => f.name === 'window')!;
  assert.equal(win.type, 'WINDOW', 'resource type survives generation');
  assert.equal(win.ref, creator.id, 'and still resolves to the creating message');
});

test('a hand-written decoder that only builds a summary still gets its fields', () => {
  // The regression: GetProperty produced a good summary but pushed no fields,
  // so the detail pane showed nothing but the opcode.
  const { store, cap } = session();
  const b = Buffer.alloc(24);
  b[0] = 20; // GetProperty
  b.writeUInt16LE(6, 2);
  b.writeUInt32LE(0xc0, 4); // window
  b.writeUInt32LE(23, 8); // property = RESOURCE_MANAGER (predefined)
  b.writeUInt32LE(0, 12); // type = AnyPropertyType
  b.writeUInt32LE(100, 20); // long-length
  cap.feed('c2s', b);

  const m = store.messages.at(-1)!;
  assert.match(m.summary, /RESOURCE_MANAGER/, 'the hand-written summary is kept');
  const names = m.fields!.map((f) => f.name);
  for (const n of ['window', 'property', 'type', 'long-offset', 'long-length']) {
    assert.ok(names.includes(n), `field ${n} is present`);
  }
  assert.equal(m.fields!.find((f) => f.name === 'property')!.value, 'RESOURCE_MANAGER',
    'atoms read as names in generated fields too');
  assert.equal(m.fields!.find((f) => f.name === 'window')!.value, '0x000000c0');
});

test('merged fields are ordered by their position on the wire', () => {
  const { store, cap } = session();
  const b = Buffer.alloc(24);
  b[0] = 20;
  b.writeUInt16LE(6, 2);
  b.writeUInt32LE(0xc0, 4);
  cap.feed('c2s', b);
  const offs = store.messages.at(-1)!.fields!.map((f) => f.span.off);
  assert.deepEqual([...offs].sort((x, y) => x - y), offs, 'already in offset order');
});

test('hand-written richness wins over the generated version of the same field', () => {
  const { store, cap } = session();
  // CreateWindow's hand-written decoder expands the value-list; the generated
  // one only knows the mask. The expanded fields must survive the merge.
  const b = Buffer.alloc(36);
  b[0] = 1;
  b[1] = 24;
  b.writeUInt16LE(9, 2);
  b.writeUInt32LE(0x00a00001, 4);
  b.writeUInt32LE(0xc0, 8);
  b.writeUInt16LE(0x0002, 28); // value-mask = BackPixel
  b.writeUInt32LE(0x00ff00, 32);
  cap.feed('c2s', b);
  const m = store.messages.at(-1)!;
  const names = m.fields!.map((f) => f.name);
  assert.ok(names.includes('background-pixel'), 'value-list expansion kept');
  assert.equal(names.filter((n) => n === 'wid').length, 1, 'no duplicate fields');
});
