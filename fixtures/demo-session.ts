/**
 * The demo session — a synthesized X11 conversation, decoded by the real decoder.
 *
 * Hand-built X11 bytes fed through `ConnectionCapture`, so every field, span,
 * link and resource in it was produced by the shipping decoder rather than
 * staged. Shared by everything that needs a populated store without a live
 * server: `npm run screenshot` (docs/img/x11vis.png) and the workbench stories
 * under `stories/`.
 *
 * A real capture would be neither publishable nor reproducible — captures carry
 * window titles, clipboard contents and keystrokes, which is why `*.x11cap` is
 * gitignored. Keep this synthetic.
 *
 * When adding messages, note that reply/event/error sequence numbers are
 * derived by the `req()`/`seq()` counter rather than hand-written, so inserting
 * a request in the middle stays correct.
 */

import { ConnectionCapture } from '../src/core/connection.js';
import { CaptureStore } from '../src/core/store.js';
import type { CapturedMessage } from '../src/core/protocol/types.js';

/**
 * The session's wall clock: 2026-01-01 09:41 UTC. Fixed so timestamps are a
 * property of the fixture, not of when it ran — which is what makes the
 * committed screenshot diffable.
 */
export const DEMO_EPOCH_MS = Date.UTC(2026, 0, 1, 9, 41, 0);

/** A request: opcode, the byte-1 field, and a body that follows offset 4. */
function request(opcode: number, dataByte: number, body: Buffer): Buffer {
  const b = Buffer.alloc(4 + body.length);
  b[0] = opcode;
  b[1] = dataByte;
  b.writeUInt16LE((4 + body.length) / 4, 2);
  body.copy(b, 4);
  return b;
}

/** A 32-byte reply, plus whatever `extra` words follow it. */
function reply(seq: number, dataByte: number, fill: (b: Buffer) => void, extra: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(32 + extra.length);
  b[0] = 1;
  b[1] = dataByte;
  b.writeUInt16LE(seq & 0xffff, 2);
  b.writeUInt32LE(extra.length / 4, 4);
  fill(b);
  extra.copy(b, 32);
  return b;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** 12-byte LSB-first client setup, no authorization. */
function clientSetup(): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0x6c; // 'l'
  b.writeUInt16LE(11, 2);
  return b;
}

/**
 * A success setup reply with one screen — enough for the decoder to seed the
 * root window and default colormap, so a reference to either resolves to a
 * named resource rather than a bare id.
 */
function serverSetup(): Buffer {
  const vendor = 'The X.Org Foundation';
  const formats = 1;
  const screen = Buffer.alloc(40 + 8 + 24); // SCREEN + one DEPTH + one VISUALTYPE
  screen.writeUInt32LE(0x0000012e, 0); // root
  screen.writeUInt32LE(0x00000020, 4); // default colormap
  screen.writeUInt32LE(0x00ffffff, 8); // white
  screen.writeUInt32LE(0x00000000, 12); // black
  screen.writeUInt16LE(1512, 20); // width
  screen.writeUInt16LE(982, 22); // height
  screen.writeUInt16LE(400, 24);
  screen.writeUInt16LE(260, 26);
  screen.writeUInt16LE(1, 28);
  screen.writeUInt16LE(1, 30);
  screen.writeUInt32LE(0x00000021, 32); // root visual
  screen[38] = 24; // root depth
  screen[39] = 1; // one allowed depth
  screen[40] = 24; // DEPTH: depth 24
  screen.writeUInt16LE(1, 42); // one visual
  screen.writeUInt32LE(0x00000021, 48); // VISUALTYPE: id
  screen[52] = 4; // TrueColor
  screen[53] = 8; // bits per rgb
  screen.writeUInt16LE(256, 54);
  screen.writeUInt32LE(0xff0000, 56);
  screen.writeUInt32LE(0x00ff00, 60);
  screen.writeUInt32LE(0x0000ff, 64);

  const tail = pad4(vendor.length) + formats * 8 + screen.length;
  const b = Buffer.alloc(40 + tail);
  b[0] = 1; // success
  b.writeUInt16LE(11, 2);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE((32 + tail) / 4, 6); // additional data, in 4-byte units
  b.writeUInt32LE(12101013, 8); // release
  b.writeUInt32LE(0x04800000, 12); // resource-id-base
  b.writeUInt32LE(0x001fffff, 16); // resource-id-mask
  b.writeUInt32LE(256, 20);
  b.writeUInt16LE(vendor.length, 24);
  b.writeUInt16LE(65535, 26);
  b[28] = 1; // screens
  b[29] = formats;
  b[30] = 0; // LSBFirst
  b[31] = 0;
  b[32] = 32; // scanline unit
  b[33] = 32; // scanline pad
  b[34] = 8;
  b[35] = 255;
  b.write(vendor, 40, 'latin1');
  const fo = 40 + pad4(vendor.length);
  b[fo] = 24; // depth
  b[fo + 1] = 32; // bits per pixel
  b[fo + 2] = 32; // scanline pad
  screen.copy(b, fo + formats * 8);
  return b;
}

const WID = 0x04800001;
const PIXMAP = 0x04800002;
const PICTURE = 0x04800003;
const GC = 0x04800004;
const ROOT = 0x0000012e;

const ATOM_WM_NAME = 39;
const ATOM_STRING = 31;
const ATOM_RESOURCE_MANAGER = 23;
const ATOM_NET_WM_NAME = 0x0000015c;

const RENDER_MAJOR = 139;

function str(s: string): Buffer {
  const b = Buffer.alloc(pad4(s.length));
  b.write(s, 0, 'latin1');
  return b;
}

/** One step of the scripted conversation: bytes, and which way they go. */
type Step = { dir: 'c2s' | 's2c'; bytes: Buffer; gap: number };

const c2s = (bytes: Buffer, gap = 1): Step => ({ dir: 'c2s', bytes, gap });
const s2c = (bytes: Buffer, gap = 1): Step => ({ dir: 's2c', bytes, gap });

/**
 * A session shaped like the opening moments of a real react-x11 client:
 * negotiate RENDER, intern an atom, create and dress a window, build an
 * off-screen picture, draw, map — and one request that names a window the
 * server has already destroyed, because a capture with no red row in it is not
 * a picture of what this tool is for.
 */
function session(): Step[] {
  const u32 = (...v: number[]) => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((n, i) => b.writeUInt32LE(n >>> 0, i * 4));
    return b;
  };

  // CreateWindow: fixed prefix then a two-entry value list (BackPixel|EventMask).
  const createWindow = Buffer.alloc(28 + 8);
  createWindow.writeUInt32LE(WID, 0);
  createWindow.writeUInt32LE(ROOT, 4);
  createWindow.writeInt16LE(0, 8);
  createWindow.writeInt16LE(0, 10);
  createWindow.writeUInt16LE(1240, 12);
  createWindow.writeUInt16LE(780, 14);
  createWindow.writeUInt16LE(0, 16); // border width
  createWindow.writeUInt16LE(1, 18); // InputOutput
  createWindow.writeUInt32LE(0x00000021, 20); // visual
  createWindow.writeUInt32LE(0x0002 | 0x0800, 24); // BackPixel | EventMask
  createWindow.writeUInt32LE(0x000b0e14, 28);
  createWindow.writeUInt32LE(0x00028033, 32); // Exposure|StructureNotify|Key|Button

  const title = 'x11vis demo';
  const changeProperty = Buffer.concat([
    u32(WID, ATOM_WM_NAME, ATOM_STRING),
    Buffer.from([8, 0, 0, 0]), // format, then 3 pad
    u32(title.length),
    str(title),
  ]);

  const getProperty = u32(ROOT, ATOM_RESOURCE_MANAGER, 0, 0, 256);
  const xrdb = '*background:\t#0b0e14\n*foreground:\t#c8d3e0\n';

  const createPixmap = Buffer.alloc(12);
  createPixmap.writeUInt32LE(PIXMAP, 0);
  createPixmap.writeUInt32LE(WID, 4);
  createPixmap.writeUInt16LE(300, 8);
  createPixmap.writeUInt16LE(180, 10);

  // RENDER CreatePicture: pid, drawable, format, value-mask, then one value.
  const createPicture = Buffer.concat([u32(PICTURE, PIXMAP, 0x00000021, 0x0001), u32(1)]);

  const createGC = Buffer.concat([u32(GC, WID, 0x0004), u32(0x00c8d3e0)]);

  // PolyFillRectangle: drawable, gc, then RECTANGLEs.
  const rects = Buffer.alloc(8);
  rects.writeInt16LE(12, 0);
  rects.writeInt16LE(12, 2);
  rects.writeUInt16LE(300, 4);
  rects.writeUInt16LE(180, 6);
  const polyFill = Buffer.concat([u32(WID, GC), rects]);

  const changeGC = Buffer.concat([u32(GC, 0x0004), u32(0x004aa3ff)]);

  // RENDER Composite: op, three pictures, then the six coordinate pairs.
  // These offsets are into the body, which starts at wire offset 4 — so `op`
  // is body[0] (wire 4) and `dst_x` is body[24] (wire 28). Getting `mask_x`
  // and `mask_y` wrong here is exactly the mistake the generator caught in
  // this repo's hand-written RENDER table.
  const composite = Buffer.alloc(32);
  composite[0] = 3; // PictOpOver
  composite.writeUInt32LE(PICTURE, 4); // src
  composite.writeUInt32LE(0, 8); // mask: none
  composite.writeUInt32LE(PICTURE + 1, 12); // dst
  composite.writeInt16LE(0, 16); // src x/y
  composite.writeInt16LE(0, 18);
  composite.writeInt16LE(0, 20); // mask x/y, unused with no mask
  composite.writeInt16LE(0, 22);
  composite.writeInt16LE(12, 24); // dst x/y
  composite.writeInt16LE(12, 26);
  composite.writeUInt16LE(300, 28);
  composite.writeUInt16LE(180, 30);

  const copyArea = Buffer.alloc(24);
  copyArea.writeUInt32LE(PIXMAP, 0);
  copyArea.writeUInt32LE(WID, 4);
  copyArea.writeUInt32LE(GC, 8);
  copyArea.writeInt16LE(0, 12);
  copyArea.writeInt16LE(0, 14);
  copyArea.writeInt16LE(12, 16);
  copyArea.writeInt16LE(12, 18);
  copyArea.writeUInt16LE(300, 20);
  copyArea.writeUInt16LE(180, 22);

  function expose(seq: number): Buffer {
    const b = Buffer.alloc(32);
    b[0] = 12; // Expose
    b.writeUInt16LE(seq, 2);
    b.writeUInt32LE(WID, 4);
    b.writeUInt16LE(0, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt16LE(1240, 12);
    b.writeUInt16LE(780, 14);
    return b;
  }

  /**
   * A shift-click in the mapped window — the event the CreateWindow above
   * asked for by putting ButtonPress in its event-mask.
   */
  function buttonPress(seq: number): Buffer {
    const b = Buffer.alloc(32);
    b[0] = 4; // ButtonPress
    b[1] = 1; // detail = Button1
    b.writeUInt16LE(seq, 2);
    b.writeUInt32LE(0x00b4c1d2, 4); // server time
    b.writeUInt32LE(ROOT, 8);
    b.writeUInt32LE(WID, 12);
    b.writeUInt32LE(0, 16); // child = None
    b.writeInt16LE(412, 20);
    b.writeInt16LE(268, 22);
    b.writeInt16LE(312, 24);
    b.writeInt16LE(208, 26);
    b.writeUInt16LE(0x0001, 28); // state = Shift
    b[30] = 1; // same-screen
    return b;
  }

  function badWindow(seq: number, bad: number): Buffer {
    const b = Buffer.alloc(32);
    b[0] = 0; // error
    b[1] = 3; // BadWindow
    b.writeUInt16LE(seq, 2);
    b.writeUInt32LE(bad, 4);
    b.writeUInt16LE(0, 8); // minor opcode
    b[10] = 3; // major opcode: GetWindowAttributes
    return b;
  }

  // The server numbers requests in the order it receives them, and every reply,
  // event and error carries the sequence of the last request the server had
  // seen. Hand-counting those rots the moment a request is inserted in the
  // middle, so `req` counts while the list is built and `seq()` reads it back.
  // The array literal evaluates left to right, which is what makes that work.
  let n = 0;
  const req = (bytes: Buffer, gap = 1): Step => {
    n++;
    return c2s(bytes, gap);
  };
  const seq = () => n;

  return [
    c2s(clientSetup(), 0),
    s2c(serverSetup(), 4),

    // Negotiate RENDER.
    req(request(98, 0, Buffer.concat([Buffer.from([6, 0, 0, 0]), str('RENDER')])), 0),
    s2c(reply(seq(), 0, (b) => {
      b[8] = 1; // present
      b[9] = RENDER_MAJOR;
      b[10] = 0; // first event
      b[11] = 142; // first error
    }), 3),

    req(request(RENDER_MAJOR, 0, u32(0, 11)), 0),
    s2c(reply(seq(), 0, (b) => {
      b.writeUInt32LE(0, 8);
      b.writeUInt32LE(11, 12);
    }), 2),

    req(request(16, 0, Buffer.concat([Buffer.from([12, 0, 0, 0]), str('_NET_WM_NAME')])), 0),
    s2c(reply(seq(), 0, (b) => b.writeUInt32LE(ATOM_NET_WM_NAME, 8)), 2),

    // Create the window and give it a name.
    req(request(1, 24, createWindow), 0),
    req(request(18, 0, changeProperty), 1),

    // Read the resource database off the root.
    req(request(20, 0, getProperty), 0),
    s2c(reply(seq(), 8, (b) => {
      b.writeUInt32LE(ATOM_STRING, 8);
      b.writeUInt32LE(0, 12); // bytes after
      b.writeUInt32LE(xrdb.length, 16);
    }, str(xrdb)), 6),

    // An off-screen picture, a gc, a fill, and map.
    req(request(53, 24, createPixmap), 1),
    req(request(RENDER_MAJOR, 4, createPicture), 1),
    req(request(55, 0, createGC), 1),
    req(request(70, 0, polyFill), 1),
    req(request(8, 0, u32(WID)), 2),

    s2c(expose(seq()), 5),
    s2c(buttonPress(seq()), 8),

    // A frame: recolour, composite the off-screen picture over the window,
    // blit, and release what the frame allocated.
    req(request(56, 0, changeGC), 1),
    req(request(RENDER_MAJOR, 8, composite), 1),
    req(request(62, 0, copyArea), 1),
    req(request(RENDER_MAJOR, 7, u32(PICTURE)), 1),
    req(request(54, 0, u32(PIXMAP)), 1),

    // A window that is already gone.
    req(request(3, 0, u32(0x04a00099)), 0),
    s2c(badWindow(seq(), 0x04a00099), 2),
  ];
}


/**
 * Replay the session into a fresh store. The clock is scripted, so arrival
 * times and round-trip times are a property of the script rather than of how
 * fast this machine happened to run it.
 */
export function buildDemoStore(epochMs: number = DEMO_EPOCH_MS): CaptureStore {
  const store = new CaptureStore();
  let now = 0;
  const capture = new ConnectionCapture(1, store, {
    mono: () => now,
    wall: () => epochMs + now,
  });
  store.openConnection({
    id: 1,
    peer: '127.0.0.1:52344',
    target: '/tmp/.X11-unix/X0',
    openedAt: epochMs,
  });
  for (const step of session()) {
    now += step.gap;
    capture.feed(step.dir, step.bytes);
  }
  return store;
}

/**
 * One message of the session, by its decoded name (`GetProperty`,
 * `GetProperty·reply`, `WindowError`). Throws rather than returning undefined:
 * a caller naming a message the session no longer contains has a bug, and a
 * story that renders nothing is a worse way to learn about it.
 */
export function demoMessage(store: CaptureStore, name: string): CapturedMessage {
  const found = store.messages.find((m) => m.name === name);
  if (!found) {
    throw new Error(
      `the demo session has no message named "${name}" — it has: ` +
        [...new Set(store.messages.map((m) => m.name))].join(', '),
    );
  }
  return found;
}
