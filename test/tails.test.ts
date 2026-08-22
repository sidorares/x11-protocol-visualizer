/**
 * Variable-length tails: lists whose length is a field, a literal, an
 * arithmetic expression over earlier fields, or the rest of the message.
 *
 * Before this, generation stopped at the first `<list>` and the request was
 * marked `partial` — so `InternAtom` showed `only-if-exists` and `name-len`
 * but never the name, which is the one thing anyone reads it for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGenerated, generatedCore, type GenericDecode } from '../src/core/protocol/generic.ts';
import type { Field } from '../src/core/protocol/types.ts';
import { GENERATED } from '../src/core/protocol/generated.ts';

const core = () => generatedCore();
const req = (opcode: number) => GENERATED['xproto']!.requests[opcode]!;

/** A request: opcode, the byte-1 field, and a body that follows offset 4. */
function request(opcode: number, dataByte: number, body: Buffer): Buffer {
  const b = Buffer.alloc(4 + body.length);
  b[0] = opcode;
  b[1] = dataByte;
  b.writeUInt16LE((4 + body.length) / 4, 2);
  body.copy(b, 4);
  return b;
}

const pad4 = (n: number) => (n + 3) & ~3;
function str(s: string): Buffer {
  const b = Buffer.alloc(pad4(s.length));
  b.write(s, 0, 'latin1');
  return b;
}

const field = (d: GenericDecode, name: string): Field | undefined =>
  d.fields.find((f) => f.name === name);

test('InternAtom decodes the atom name, not just its length', () => {
  const name = 'WM_PROTOCOLS';
  const body = Buffer.concat([
    Buffer.from([name.length, 0, 0, 0]), // name-len, then 2 pad
    str(name),
  ]);
  const buf = request(16, 0, body);

  const d = decodeGenerated(req(16), buf, 'LE', core());

  assert.equal(field(d, 'name')?.value, '"WM_PROTOCOLS"');
  assert.equal(d.partial, false);
  // The span is what lights up the hex, so it must be the name's own bytes —
  // offset 8, and 12 long rather than the padded 12... which here is the same.
  assert.deepEqual(field(d, 'name')?.span, { off: 8, len: 12 });
  assert.match(d.summary, /"WM_PROTOCOLS"/);
});

test('a name-len that lies is reported rather than read past the end', () => {
  const body = Buffer.concat([Buffer.from([200, 0, 0, 0]), str('WM_NAME')]);
  const d = decodeGenerated(req(16), request(16, 0, body), 'LE', core());

  assert.equal(d.partial, true, 'a truncated list leaves the decode partial');
  // What is there is still shown, clipped to the bytes that exist.
  const f = field(d, 'name');
  assert.ok(f, 'the field is still emitted');
  assert.ok(f!.span!.off + f!.span!.len <= request(16, 0, body).length);
});

test('QueryExtension names the extension it asks about', () => {
  const body = Buffer.concat([Buffer.from([6, 0, 0, 0]), str('RENDER')]);
  const d = decodeGenerated(req(98), request(98, 0, body), 'LE', core());
  assert.equal(field(d, 'name')?.value, '"RENDER"');
});

test('ChangeProperty evaluates data_len * format / 8', () => {
  const text = 'x11vis';
  const body = Buffer.concat([
    u32(0x04800001, 39, 31), // window, property=WM_NAME, type=STRING
    Buffer.from([8, 0, 0, 0]), // format=8, then 3 pad
    u32(text.length),
    str(text),
  ]);
  const d = decodeGenerated(req(18), request(18, 0, body), 'LE', core());

  // 6 * 8 / 8 = 6 bytes — *not* the 8 the padded message would suggest.
  assert.equal(field(d, 'data')?.value, '"x11vis"');
  assert.equal(field(d, 'data')?.span?.len, 6);
  assert.equal(d.partial, false);
});

test('ChangeProperty with format 32 counts words, not bytes', () => {
  const body = Buffer.concat([
    u32(0x04800001, 372, 4), // window, property, type=ATOM
    Buffer.from([32, 0, 0, 0]), // format=32
    u32(2), // data-len: two 32-bit values
    u32(0x11111111, 0x22222222),
  ]);
  const d = decodeGenerated(req(18), request(18, 0, body), 'LE', core());
  // 2 * 32 / 8 = 8 bytes.
  assert.equal(field(d, 'data')?.span?.len, 8);
  assert.equal(field(d, 'data')?.value, '[8 bytes]');
});

test('a list with no declared length takes the rest of the message', () => {
  // PolyFillRectangle: drawable, gc, then RECTANGLEs to the end.
  const rects = Buffer.alloc(16);
  rects.writeInt16LE(1, 0); rects.writeInt16LE(2, 2);
  rects.writeUInt16LE(30, 4); rects.writeUInt16LE(40, 6);
  rects.writeInt16LE(5, 8); rects.writeInt16LE(6, 10);
  rects.writeUInt16LE(70, 12); rects.writeUInt16LE(80, 14);

  const d = decodeGenerated(
    req(70),
    request(70, 0, Buffer.concat([u32(0x04800001, 0x04800002), rects])),
    'LE',
    core(),
  );

  const f = field(d, 'rectangles');
  assert.equal(f?.value, '[2 × RECTANGLE]', 'a struct list says what it is rather than misreading it');
  assert.deepEqual(f?.span, { off: 12, len: 16 });
  assert.equal(d.partial, false);
});

test('binary that is not text is summarised, not dumped', () => {
  const blob = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x00, 0x02, 0x03, 0x04]);
  const body = Buffer.concat([
    u32(0x04800001, 39, 31),
    Buffer.from([8, 0, 0, 0]),
    u32(blob.length),
    blob,
  ]);
  const d = decodeGenerated(req(18), request(18, 0, body), 'LE', core());
  assert.equal(field(d, 'data')?.value, '[8 bytes]');
});

test('a switch still marks the message partial rather than guessing', () => {
  // CreateWindow ends in a <switch> over its value-mask.
  assert.equal(req(1).partial, true);
  assert.equal(req(1).tail, undefined);
});

test('the generated tables carry tails for the common requests', () => {
  const partial = Object.values(GENERATED).reduce(
    (a, e) => a + Object.values(e.requests).filter((m) => m.partial).length,
    0,
  );
  // 156 before lists were generated. The rest are switches, unions and
  // lengths needing popcount/sumof.
  assert.ok(partial < 80, `expected far fewer partial requests, got ${partial}`);
  assert.equal(req(16).partial, false, 'InternAtom');
  assert.equal(req(45).partial, false, 'OpenFont');
});

function u32(...v: number[]): Buffer {
  const b = Buffer.alloc(v.length * 4);
  v.forEach((n, i) => b.writeUInt32LE(n >>> 0, i * 4));
  return b;
}
