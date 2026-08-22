import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStore } from '../src/core/store.ts';
import { ConnectionCapture } from '../src/core/connection.ts';
import { decodeImage, composeCursor, type DisplayImageInfo } from '../src/core/protocol/image.ts';

/** Setup reply with a depth-8 format and one screen. */
function setupReply(): Buffer {
  const b = Buffer.alloc(88);
  b[0] = 1;
  b.writeUInt16LE((b.length - 8) / 4, 6);
  b[28] = 1; // screens
  b[29] = 1; // formats
  b[32] = 32;
  b[33] = 32;
  b[40] = 8; b[41] = 8; b[42] = 32; // depth 8, 8bpp
  const s = 48;
  b.writeUInt32LE(0xc0, s);
  b[s + 39] = 0;
  return b;
}

function session() {
  const store = new CaptureStore();
  const cap = new ConnectionCapture(1, store);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  cap.feed('s2c', setupReply());
  return { store, cap };
}

// --- colormap-aware indexed rendering --------------------------------------

test('AllocColor pairs its reply pixel with the request colormap to build a palette', () => {
  const { store, cap } = session();
  // AllocColor(cmap, r, g, b)
  const req = Buffer.alloc(16);
  req[0] = 84;
  req.writeUInt16LE(4, 2);
  req.writeUInt32LE(0x20, 4); // cmap
  req.writeUInt16LE(0xffff, 8);
  req.writeUInt16LE(0x8000, 10);
  req.writeUInt16LE(0x0000, 12);
  cap.feed('c2s', req);
  const seq = store.messages.at(-1)!.seq!;

  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(seq & 0xffff, 2);
  reply.writeUInt16LE(0xffff, 8); // red
  reply.writeUInt16LE(0x8000, 10); // green
  reply.writeUInt16LE(0x0000, 12); // blue
  reply.writeUInt32LE(7, 16); // pixel 7
  cap.feed('s2c', reply);

  // A subsequent depth-8 PutImage of pixel 7 should render in that colour.
  const put = Buffer.alloc(28);
  put[0] = 72;
  put[1] = 2; // ZPixmap
  put.writeUInt16LE(7, 2);
  put.writeUInt32LE(0xc0, 4);
  put.writeUInt16LE(1, 12); // width
  put.writeUInt16LE(1, 14); // height
  put[21] = 8; // depth
  put[24] = 7; // the allocated pixel
  cap.feed('c2s', put);

  const m = store.messages.at(-1)!;
  assert.ok(m.image, 'PutImage attached a spec');
  assert.deepEqual(m.image!.display.palette?.[7], [255, 128, 0], 'palette learned from AllocColor');
  const img = decodeImage(m.bytes, m.image!)!;
  assert.deepEqual([img.data[0], img.data[1], img.data[2]], [255, 128, 0], 'rendered in real colour, not intensity');
});

test('an indexed pixel with no colormap entry still renders as intensity', () => {
  const display: DisplayImageInfo = {
    imageByteOrder: 0, bitmapBitOrder: 0, scanlineUnit: 32, scanlinePad: 32,
    formats: { 8: { bpp: 8, pad: 32 } }, visuals: {}, rootVisual: 0,
  };
  const buf = Buffer.from([255, 0, 0, 0]);
  const img = decodeImage(buf, { format: 2, depth: 8, width: 1, height: 1, leftPad: 0, dataOff: 0, display })!;
  assert.deepEqual([img.data[0], img.data[1], img.data[2]], [255, 255, 255]);
});

// --- cursor previews -------------------------------------------------------

test('CreateCursor is decoded with colours, hotspot and links to its bitmaps', () => {
  const { store, cap } = session();

  // Fill the source pixmap first, so the cursor can find its bits.
  const put = (drawable: number, byte: number) => {
    const b = Buffer.alloc(28);
    b[0] = 72;
    b[1] = 0; // Bitmap
    b.writeUInt16LE(7, 2);
    b.writeUInt32LE(drawable, 4);
    b.writeUInt16LE(4, 12);
    b.writeUInt16LE(1, 14);
    b[21] = 1; // depth 1
    b[24] = byte;
    return b;
  };
  cap.feed('c2s', put(0x300001, 0b0101));
  const srcMsg = store.messages.at(-1)!;
  cap.feed('c2s', put(0x300002, 0b1111));
  const mskMsg = store.messages.at(-1)!;

  const cc = Buffer.alloc(32);
  cc[0] = 93; // CreateCursor
  cc.writeUInt16LE(8, 2);
  cc.writeUInt32LE(0x300010, 4); // cid
  cc.writeUInt32LE(0x300001, 8); // source
  cc.writeUInt32LE(0x300002, 12); // mask
  cc.writeUInt16LE(0xffff, 16); // fore r
  cc.writeUInt16LE(0x0000, 18);
  cc.writeUInt16LE(0x0000, 20);
  cc.writeUInt16LE(0x0000, 22); // back r
  cc.writeUInt16LE(0x0000, 24);
  cc.writeUInt16LE(0xffff, 26); // back b
  cc.writeUInt16LE(2, 28); // hot x
  cc.writeUInt16LE(3, 30); // hot y
  cap.feed('c2s', cc);

  const m = store.messages.at(-1)!;
  assert.equal(m.name, 'CreateCursor');
  assert.ok(m.cursor, 'a cursor spec is attached');
  assert.equal(m.cursor!.sourceImageId, srcMsg.id, 'source resolves to the PutImage that filled it');
  assert.equal(m.cursor!.maskImageId, mskMsg.id);
  assert.deepEqual(m.cursor!.fore, [255, 0, 0]);
  assert.deepEqual(m.cursor!.back, [0, 0, 255]);
  assert.equal(m.cursor!.hotX, 2);
  assert.equal(m.cursor!.hotY, 3);
  assert.equal(m.creates?.type, 'Cursor');

  // Composing it yields foreground where the source bit is set.
  const src = decodeImage(srcMsg.bytes, srcMsg.image!)!;
  const msk = decodeImage(mskMsg.bytes, mskMsg.image!)!;
  const img = composeCursor(src, msk, m.cursor!)!;
  assert.equal(img.width, 4);
  const px = (i: number) => [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2], img.data[i * 4 + 3]];
  assert.deepEqual(px(0), [255, 0, 0, 255], 'bit set → foreground');
  assert.deepEqual(px(1), [0, 0, 255, 255], 'bit clear → background');
});

test('a cursor whose bitmaps were never captured composes to nothing rather than throwing', () => {
  const spec = { fore: [255, 0, 0] as [number, number, number], back: [0, 0, 0] as [number, number, number], hotX: 0, hotY: 0 };
  assert.equal(composeCursor(undefined, undefined, spec), undefined);
});

test('mask bits control transparency', () => {
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) };
  const mask = { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) };
  const img = composeCursor(src, mask, {
    fore: [10, 20, 30], back: [0, 0, 0], hotX: 0, hotY: 0,
  })!;
  assert.equal(img.data[3], 255, 'inside the mask → opaque');
  assert.equal(img.data[7], 0, 'outside the mask → transparent');
});
