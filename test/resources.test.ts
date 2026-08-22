import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

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

function createGC(cid: number, drawable: number): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 55; // CreateGC
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(cid, 4);
  b.writeUInt32LE(drawable, 8);
  return b;
}

function createPixmap(pid: number, drawable: number): Buffer {
  const b = Buffer.alloc(16);
  b[0] = 53; // CreatePixmap
  b[1] = 24;
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(pid, 4);
  b.writeUInt32LE(drawable, 8);
  b.writeUInt16LE(64, 12);
  b.writeUInt16LE(64, 14);
  return b;
}

function polyFillRectangle(drawable: number, gc: number): Buffer {
  const b = Buffer.alloc(20); // 12 header + one 8-byte rectangle
  b[0] = 70;
  b.writeUInt16LE(5, 2);
  b.writeUInt32LE(drawable, 4);
  b.writeUInt32LE(gc, 8);
  return b;
}

test('a reference links back to the request that created the resource', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);

  // Create a pixmap 0x00200001 and a GC 0x00200002.
  cap.feed('c2s', createPixmap(0x00200001, 0x000000c0));
  const pixmapMsg = messages.at(-1)!;
  cap.feed('c2s', createGC(0x00200002, 0x00200001)); // GC's drawable = the pixmap
  const gcMsg = messages.at(-1)!;

  // The GC's `drawable` field should point back to the CreatePixmap message.
  const draw = gcMsg.fields!.find((f) => f.name === 'drawable')!;
  assert.equal(draw.ref, pixmapMsg.id, 'drawable links to the pixmap creator');

  // Now draw into the pixmap with the GC — both args should link to creators.
  cap.feed('c2s', polyFillRectangle(0x00200001, 0x00200002));
  const fill = messages.at(-1)!;
  const fd = fill.fields!.find((f) => f.name === 'drawable')!;
  const fg = fill.fields!.find((f) => f.name === 'gc')!;
  assert.equal(fd.ref, pixmapMsg.id, 'fill drawable → pixmap');
  assert.equal(fg.ref, gcMsg.id, 'fill gc → CreateGC');
});

test("a creating request does not link its own destination field to itself", () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  cap.feed('c2s', createPixmap(0x00200001, 0x000000c0));
  const m = messages.at(-1)!;
  const pid = m.fields!.find((f) => f.name === 'pid')!;
  assert.equal(pid.ref, undefined, 'no self-link on the created resource');
});

test('a reference to an unknown (server-owned) XID stays unlinked', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  setup(cap);
  // GC whose drawable is a root window we never saw created.
  cap.feed('c2s', createGC(0x00200002, 0x000000c0));
  const m = messages.at(-1)!;
  const draw = m.fields!.find((f) => f.name === 'drawable')!;
  assert.equal(draw.ref, undefined);
});
