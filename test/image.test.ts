import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeImage, decodeGlyph, type DisplayImageInfo } from '../src/core/protocol/image.ts';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

const display24: DisplayImageInfo = {
  imageByteOrder: 0, // LSBFirst
  bitmapBitOrder: 0,
  scanlineUnit: 32,
  scanlinePad: 32,
  formats: { 24: { bpp: 32, pad: 32 }, 1: { bpp: 1, pad: 32 } },
  visuals: { 0x21: { redMask: 0xff0000, greenMask: 0x00ff00, blueMask: 0x0000ff } },
  rootVisual: 0x21,
};

test('ZPixmap depth-24 decodes to correct RGBA via the visual masks', () => {
  // 2×2, 32bpp LSBFirst: red, green / blue, white
  const px = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];
  const buf = Buffer.alloc(16);
  px.forEach((p, i) => buf.writeUInt32LE(p, i * 4));
  const img = decodeImage(buf, {
    format: 2, depth: 24, width: 2, height: 2, leftPad: 0, dataOff: 0,
    visualId: 0x21, display: display24,
  })!;
  assert.equal(img.width, 2);
  assert.equal(img.height, 2);
  const at = (i: number) => [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
  assert.deepEqual(at(0), [255, 0, 0], 'red');
  assert.deepEqual(at(1), [0, 255, 0], 'green');
  assert.deepEqual(at(2), [0, 0, 255], 'blue');
  assert.deepEqual(at(3), [255, 255, 255], 'white');
});

test('MSBFirst byte order is honoured', () => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(0xff0000, 0);
  const img = decodeImage(buf, {
    format: 2, depth: 24, width: 1, height: 1, leftPad: 0, dataOff: 0,
    visualId: 0x21, display: { ...display24, imageByteOrder: 1 },
  })!;
  assert.deepEqual([img.data[0], img.data[1], img.data[2]], [255, 0, 0]);
});

test('Bitmap (depth 1) decodes bits with scanline padding', () => {
  // 4×2 bitmap, rows padded to 32 bits (4 bytes each): 0b0101, 0b1010
  const buf = Buffer.alloc(8);
  buf[0] = 0b0101;
  buf[4] = 0b1010;
  const img = decodeImage(buf, {
    format: 0, depth: 1, width: 4, height: 2, leftPad: 0, dataOff: 0, display: display24,
  })!;
  const on = (x: number, y: number) => img.data[(y * 4 + x) * 4] === 255;
  assert.deepEqual([on(0, 0), on(1, 0), on(2, 0), on(3, 0)], [true, false, true, false]);
  assert.deepEqual([on(0, 1), on(1, 1), on(2, 1), on(3, 1)], [false, true, false, true]);
});

test('an unsupported multi-plane XYPixmap returns undefined rather than garbage', () => {
  const img = decodeImage(Buffer.alloc(64), {
    format: 1, depth: 24, width: 2, height: 2, leftPad: 0, dataOff: 0, display: display24,
  });
  assert.equal(img, undefined);
});

test('A8 glyph coverage decodes to alpha with 4-byte row padding', () => {
  // 2×2 A8 glyph: rows padded to 4 bytes.
  const buf = Buffer.alloc(8);
  buf[0] = 0; buf[1] = 255;
  buf[4] = 128; buf[5] = 64;
  const g = decodeGlyph(buf, { width: 2, height: 2, depth: 8, dataOff: 0 })!;
  const alpha = (i: number) => g.data[i * 4 + 3];
  assert.equal(alpha(0), 0);
  assert.equal(alpha(1), 255);
  assert.equal(alpha(2), 128);
  assert.equal(alpha(3), 64);
});

// --- end-to-end: the capture attaches a spec, decoding stays lazy ----------

function collector() {
  const messages: CapturedMessage[] = [];
  let id = 0;
  const sink: CaptureSink = { nextId: () => ++id, onMessage: (m) => messages.push(m), onLink: () => {} };
  return { sink, messages };
}

/** Setup reply with one 32bpp/depth-24 format and a TrueColor visual. */
function setupReply(): Buffer {
  const b = Buffer.alloc(88);
  b[0] = 1;
  b.writeUInt16LE((b.length - 8) / 4, 6);
  b.writeUInt16LE(0, 24); // vendor len
  b[28] = 1; // screens
  b[29] = 1; // formats
  b[30] = 0; // image-byte-order LSB
  b[31] = 0; // bitmap bit order
  b[32] = 32; b[33] = 32; // scanline unit / pad
  // FORMAT @40
  b[40] = 24; b[41] = 32; b[42] = 32;
  // SCREEN @48
  const s = 48;
  b.writeUInt32LE(0xc0, s); // root
  b.writeUInt32LE(0x20, s + 4);
  b.writeUInt32LE(0x21, s + 32); // root-visual
  b[s + 39] = 0; // no depths (visual masks fall back to 8-8-8)
  return b;
}

test('PutImage attaches a decodable image spec (decoded lazily, not eagerly)', () => {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  cap.feed('s2c', setupReply());

  // PutImage: ZPixmap 2×1 depth 24, 32bpp → 8 bytes of data.
  const req = Buffer.alloc(32);
  req[0] = 72;
  req[1] = 2; // ZPixmap
  req.writeUInt16LE(8, 2);
  req.writeUInt32LE(0xc0, 4); // drawable
  req.writeUInt32LE(0x00a00001, 8); // gc
  req.writeUInt16LE(2, 12); // width
  req.writeUInt16LE(1, 14); // height
  req[21] = 24; // depth
  req.writeUInt32LE(0xff0000, 24);
  req.writeUInt32LE(0x0000ff, 28);
  cap.feed('c2s', req);

  const m = messages.at(-1)!;
  assert.equal(m.name, 'PutImage');
  assert.match(m.summary, /2×1.*depth=24 ZPixmap/);
  assert.ok(m.image, 'an image spec is attached');
  assert.equal(m.image!.format, 2);
  assert.equal(m.image!.dataOff, 24);
  // The setup's pixmap-format (32bpp) was picked up.
  assert.equal(m.image!.display.formats[24]?.bpp, 32);

  // Decoding on demand yields the right pixels.
  const img = decodeImage(m.bytes, m.image!)!;
  assert.deepEqual([img.data[0], img.data[1], img.data[2]], [255, 0, 0]);
  assert.deepEqual([img.data[4], img.data[5], img.data[6]], [0, 0, 255]);
});
