/**
 * Core event decoding (codes 2–34).
 *
 * Before this, every core event was named and then left alone: a `ButtonPress`
 * row showed its code and sequence number and nothing about which button, which
 * window, or which modifiers were held. These tests pin the fields, their byte
 * spans, and the summary line, in both byte orders — an event is decoded from
 * the same layout in LSB-first and MSB-first sessions, and the coordinates are
 * signed, which is the part that was silently wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import type { CapturedMessage, Field } from '../src/core/protocol/types.ts';

type Order = 'LE' | 'BE';

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

/** A capture with the handshake already done, in the given byte order. */
function session(order: Order = 'LE') {
  const { sink, messages } = collector();
  const cap = new ConnectionCapture(1, sink);
  const setup = Buffer.alloc(12);
  setup[0] = order === 'BE' ? 0x42 : 0x6c;
  cap.feed('c2s', setup);
  const reply = Buffer.alloc(40);
  reply[0] = 1;
  if (order === 'BE') reply.writeUInt16BE(8, 6);
  else reply.writeUInt16LE(8, 6);
  cap.feed('s2c', reply);
  return { cap, messages, order };
}

/**
 * Build a 32-byte event. `write` gets order-aware writers so the same event can
 * be built for either byte order.
 */
interface W {
  u8: (v: number, o: number) => void;
  u16: (v: number, o: number) => void;
  i16: (v: number, o: number) => void;
  u32: (v: number, o: number) => void;
  str: (v: string, o: number) => void;
}
function event(code: number, order: Order, write: (w: W) => void, seq = 3): Buffer {
  const b = Buffer.alloc(32);
  b[0] = code;
  const w: W = {
    u8: (v, o) => { b[o] = v; },
    u16: (v, o) => (order === 'BE' ? b.writeUInt16BE(v, o) : b.writeUInt16LE(v, o)),
    i16: (v, o) => (order === 'BE' ? b.writeInt16BE(v, o) : b.writeInt16LE(v, o)),
    u32: (v, o) => (order === 'BE' ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o)),
    str: (v, o) => { b.write(v, o, 'latin1'); },
  };
  // KeymapNotify's bytes 1-31 are the keymap; it carries no sequence number.
  if (code !== 11) w.u16(seq, 2);
  write(w);
  return b;
}

const field = (m: CapturedMessage, name: string): Field | undefined =>
  m.fields?.find((f) => f.name === name);
const value = (m: CapturedMessage, name: string): string | undefined => field(m, name)?.value;

/** Feed one event and return the message it produced. */
function decode(code: number, write: (w: W) => void, order: Order = 'LE'): CapturedMessage {
  const s = session(order);
  s.cap.feed('s2c', event(code, order, write));
  return s.messages.at(-1)!;
}

/** A ButtonPress: button 3, in window 0x04800001, at (12,34), with Shift held. */
const buttonPress = (w: W) => {
  w.u8(3, 1);
  w.u32(0x00112233, 4); // time
  w.u32(0x0000002a, 8); // root
  w.u32(0x04800001, 12); // event
  w.u32(0, 16); // child = None
  w.i16(500, 20);
  w.i16(300, 22);
  w.i16(12, 24);
  w.i16(34, 26);
  w.u16(0x0001, 28); // state = Shift
  w.u8(1, 30); // same-screen
};

test('ButtonPress decodes its button, window, position and modifier state', () => {
  const m = decode(4, buttonPress);
  assert.equal(m.category, 'event');
  assert.equal(m.name, 'ButtonPress');
  assert.equal(m.summary, 'button=3 @(12,34) event=0x04800001 state=Shift');
  assert.equal(value(m, 'detail'), 'Button3 (3)');
  assert.equal(value(m, 'root'), '0x0000002a');
  assert.equal(value(m, 'event'), '0x04800001');
  assert.equal(value(m, 'child'), 'None');
  assert.equal(value(m, 'root-x'), '500');
  assert.equal(value(m, 'event-y'), '34');
  assert.equal(value(m, 'state'), '0x1 (Shift)');
  assert.equal(value(m, 'same-screen'), '1');
  assert.equal(value(m, 'time'), String(0x00112233));
});

test('ButtonPress decodes identically MSB-first', () => {
  const le = decode(4, buttonPress, 'LE');
  const be = decode(4, buttonPress, 'BE');
  assert.equal(be.summary, le.summary);
  assert.deepEqual(be.fields, le.fields);
});

test('every decoded field carries the byte span it came from, in wire order', () => {
  const m = decode(4, buttonPress);
  const spans = m.fields!.map((f) => f.span);
  for (const s of spans) {
    assert.ok(s.off >= 0 && s.off + s.len <= 32, `span ${s.off}+${s.len} outside the event`);
  }
  const offs = spans.map((s) => s.off);
  assert.deepEqual(offs, [...offs].sort((a, b) => a - b));
  // The header is where the reader looks first, so it must be at the top.
  assert.equal(m.fields![0]!.name, 'code');
  assert.equal(m.fields![1]!.name, 'detail');
  assert.equal(m.fields![2]!.name, 'sequence');
});

test('ButtonRelease names buttons above 5 by number rather than inventing one', () => {
  const m = decode(5, (w) => {
    w.u8(9, 1);
    w.u32(0x04800001, 12);
  });
  assert.equal(m.name, 'ButtonRelease');
  assert.match(m.summary, /^button=9 /);
  assert.equal(value(m, 'detail'), '9');
});

test('KeyPress reports its keycode and every held modifier', () => {
  const m = decode(2, (w) => {
    w.u8(38, 1);
    w.u32(0x04800001, 12);
    w.i16(7, 24);
    w.i16(9, 26);
    w.u16(0x0005, 28); // Shift | Control
  });
  assert.equal(m.name, 'KeyPress');
  assert.equal(m.summary, 'keycode=38 @(7,9) event=0x04800001 state=Shift | Control');
  assert.equal(value(m, 'state'), '0x5 (Shift | Control)');
});

test('a pointer position outside its window decodes as a negative coordinate', () => {
  const m = decode(6, (w) => {
    w.u32(0x04800001, 12);
    w.i16(-7, 24);
    w.i16(-1, 26);
  });
  assert.equal(m.name, 'MotionNotify');
  assert.equal(value(m, 'event-x'), '-7');
  assert.equal(value(m, 'event-y'), '-1');
  assert.equal(m.summary, '@(-7,-1) event=0x04800001');
});

test('MotionNotify says when the server sent a compressed Hint', () => {
  const m = decode(6, (w) => {
    w.u8(1, 1);
    w.u32(0x04800001, 12);
  });
  assert.equal(value(m, 'detail'), 'Hint (1)');
  assert.match(m.summary, /^Hint @\(0,0\)/);
});

test('EnterNotify splits the two flags packed into its last byte', () => {
  const m = decode(7, (w) => {
    w.u8(2, 1); // detail = Inferior
    w.u32(0x04800001, 12);
    w.i16(12, 24);
    w.i16(34, 26);
    w.u8(1, 30); // mode = Grab
    w.u8(0x02, 31); // same-screen, not focus
  });
  assert.equal(m.name, 'EnterNotify');
  assert.equal(m.summary, 'event=0x04800001 @(12,34) mode=Grab detail=Inferior');
  assert.equal(value(m, 'mode'), 'Grab (1)');
  assert.equal(value(m, 'detail'), 'Inferior (2)');
  assert.equal(value(m, 'same-screen-focus'), '0x2 (same-screen)');
  assert.deepEqual(field(m, 'same-screen-focus')!.span, { off: 31, len: 1 });
});

test('FocusOut reports mode and detail from its short layout', () => {
  const m = decode(10, (w) => {
    w.u8(3, 1); // Nonlinear
    w.u32(0x04800001, 4);
    w.u8(2, 8); // Ungrab
  });
  assert.equal(m.name, 'FocusOut');
  assert.equal(m.summary, 'event=0x04800001 mode=Ungrab detail=Nonlinear');
});

test('KeymapNotify spells out the keycodes its bitmap says are down', () => {
  // Bit k of byte i is keycode i*8+k. Byte 4 bit 6 => 38; byte 8 bit 0 => 64.
  const m = decode(11, (w) => {
    w.u8(1 << 6, 1 + 4);
    w.u8(1 << 0, 1 + 8);
  });
  assert.equal(m.name, 'KeymapNotify');
  assert.equal(value(m, 'keys'), '[38, 64]');
  assert.deepEqual(field(m, 'keys')!.span, { off: 1, len: 31 });
  assert.equal(m.summary, '2 keys down: 38, 64');
  // No sequence field — bytes 2-3 are keymap, not a sequence number.
  assert.equal(field(m, 'sequence'), undefined);
});

test('an empty KeymapNotify says so instead of showing 31 zero bytes', () => {
  const m = decode(11, () => {});
  assert.equal(m.summary, 'no keys down');
  assert.equal(value(m, 'keys'), '[] (no keys down)');
});

test('Expose reports the rectangle to repaint and how many follow', () => {
  const m = decode(12, (w) => {
    w.u32(0x04800001, 4);
    w.u16(10, 8);
    w.u16(20, 10);
    w.u16(300, 12);
    w.u16(200, 14);
    w.u16(2, 16);
  });
  assert.equal(m.summary, 'window=0x04800001 300×200+10+20 count=2');
  assert.equal(value(m, 'count'), '2');
});

test('GraphicsExposure names the request that caused it', () => {
  const m = decode(13, (w) => {
    w.u32(0x04800002, 4);
    w.u16(4, 12);
    w.u16(5, 14);
    w.u16(1, 18);
    w.u8(62, 20); // CopyArea
  });
  assert.equal(value(m, 'major-opcode'), '62 (CopyArea)');
  assert.match(m.summary, /count=1 CopyArea$/);
});

test('NoExposure names the request that produced nothing to repaint', () => {
  const m = decode(14, (w) => {
    w.u32(0x04800002, 4);
    w.u8(63, 10); // CopyPlane
  });
  assert.equal(m.summary, 'drawable=0x04800002 CopyPlane');
  assert.equal(value(m, 'major-opcode'), '63 (CopyPlane)');
});

test('VisibilityNotify names its state', () => {
  const m = decode(15, (w) => {
    w.u32(0x04800001, 4);
    w.u8(1, 8);
  });
  assert.equal(m.summary, 'window=0x04800001 state=PartiallyObscured');
});

test('CreateNotify reports the new window, its parent and its geometry', () => {
  const m = decode(16, (w) => {
    w.u32(0x0000002a, 4);
    w.u32(0x04800005, 8);
    w.i16(-10, 12);
    w.i16(20, 14);
    w.u16(300, 16);
    w.u16(200, 18);
    w.u16(2, 20);
    w.u8(1, 22);
  });
  assert.equal(
    m.summary,
    'window=0x04800005 parent=0x0000002a 300×200-10+20 border=2 override-redirect',
  );
});

test('ConfigureNotify reports the geometry the window ended up with', () => {
  const m = decode(22, (w) => {
    w.u32(0x04800001, 4);
    w.u32(0x04800001, 8);
    w.u32(0, 12); // above-sibling = None
    w.i16(10, 16);
    w.i16(-20, 18);
    w.u16(300, 20);
    w.u16(200, 22);
  });
  assert.equal(m.summary, 'window=0x04800001 300×200+10-20 above=None');
  assert.equal(value(m, 'above-sibling'), 'None');
});

test('ConfigureRequest reports only the parameters its value-mask asks for', () => {
  const m = decode(23, (w) => {
    w.u8(1, 1); // stack-mode = Below (not requested)
    w.u32(0x0000002a, 4);
    w.u32(0x04800001, 8);
    w.i16(999, 16); // x, not requested
    w.u16(640, 20);
    w.u16(480, 22);
    w.u16(0x0c, 26); // Width | Height
  });
  assert.equal(m.summary, 'window=0x04800001 {width=640 height=480}');
  assert.equal(value(m, 'value-mask'), '0xc (width | height)');
  assert.doesNotMatch(m.summary, /x=999/);
});

test('ConfigureRequest that asks for a stacking change names the mode', () => {
  const m = decode(23, (w) => {
    w.u8(4, 1); // Opposite
    w.u32(0x04800001, 8);
    w.u32(0x04800002, 12);
    w.u16(0x60, 26); // Sibling | StackMode
  });
  assert.equal(m.summary, 'window=0x04800001 {sibling=0x04800002 stack-mode=Opposite}');
});

test('ResizeRequest reports the size asked for', () => {
  const m = decode(25, (w) => {
    w.u32(0x04800001, 4);
    w.u16(640, 8);
    w.u16(480, 10);
  });
  assert.equal(m.summary, 'window=0x04800001 640×480');
});

test('CirculateNotify names the place the window moved to', () => {
  const m = decode(26, (w) => {
    w.u32(0x04800001, 4);
    w.u32(0x04800002, 8);
    w.u8(1, 16);
  });
  assert.equal(m.summary, 'window=0x04800002 place=OnBottom');
});

test('MappingNotify reports the keycode range only for a keyboard change', () => {
  const keyboard = decode(34, (w) => {
    w.u8(1, 4);
    w.u8(8, 5);
    w.u8(248, 6);
  });
  assert.equal(keyboard.summary, 'request=Keyboard first-keycode=8 count=248');
  const pointer = decode(34, (w) => w.u8(2, 4));
  assert.equal(pointer.summary, 'request=Pointer');
});

test('a SendEvent-flagged event is still fully decoded', () => {
  const m = decode(4 | 0x80, buttonPress);
  assert.equal(m.name, 'ButtonPress (SendEvent)');
  assert.equal(m.summary, 'button=3 @(12,34) event=0x04800001 state=Shift');
});

test('a truncated event degrades to the fields that fit instead of throwing', () => {
  // The framer only hands over whole 32-byte events, so reach past it to prove
  // the decoders themselves are bounds-safe.
  const short = event(4, 'LE', buttonPress).subarray(0, 20);
  const s = session();
  assert.doesNotThrow(() => s.cap.feed('s2c', Buffer.concat([short, Buffer.alloc(12)])));
});

// ---- events that name atoms ------------------------------------------------

/** Intern `name` so the capture's atom table can resolve it by id. */
function intern(cap: ConnectionCapture, name: string, atom: number, seq: number): void {
  const pad = (name.length + 3) & ~3;
  const req = Buffer.alloc(8 + pad);
  req[0] = 16;
  req.writeUInt16LE(req.length / 4, 2);
  req.writeUInt16LE(name.length, 4);
  req.write(name, 8, 'latin1');
  cap.feed('c2s', req);
  const reply = Buffer.alloc(32);
  reply[0] = 1;
  reply.writeUInt16LE(seq, 2);
  reply.writeUInt32LE(atom, 8);
  cap.feed('s2c', reply);
}

test('PropertyNotify names the property that changed', () => {
  const s = session();
  intern(s.cap, '_NET_WM_NAME', 400, 1);
  s.cap.feed(
    's2c',
    event(28, 'LE', (w) => {
      w.u32(0x04800001, 4);
      w.u32(400, 8);
      w.u32(9999, 12);
      w.u8(1, 16);
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(m.summary, 'window=0x04800001 _NET_WM_NAME Delete');
  assert.equal(value(m, 'atom'), '_NET_WM_NAME');
});

test('SelectionNotify names selection and target, and None for a refusal', () => {
  const s = session();
  intern(s.cap, 'CLIPBOARD', 401, 1);
  intern(s.cap, 'UTF8_STRING', 402, 2);
  s.cap.feed(
    's2c',
    event(31, 'LE', (w) => {
      w.u32(0x04800001, 8);
      w.u32(401, 12);
      w.u32(402, 16);
      w.u32(0, 20); // property = None: the request was refused
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(
    m.summary,
    'requestor=0x04800001 selection=CLIPBOARD target=UTF8_STRING property=None',
  );
});

test('a format-32 ClientMessage gives each data word its own span', () => {
  const s = session();
  intern(s.cap, '_NET_WM_SYNC_REQUEST', 410, 1);
  s.cap.feed(
    's2c',
    event(33, 'LE', (w) => {
      w.u8(32, 1);
      w.u32(0x04800001, 4);
      w.u32(410, 8);
      for (let i = 0; i < 5; i++) w.u32(i + 1, 12 + i * 4);
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(
    m.summary,
    'window=0x04800001 _NET_WM_SYNC_REQUEST format=32 data=[1, 2, 3, 4, 5]',
  );
  assert.deepEqual(field(m, 'data[0]')!.span, { off: 12, len: 4 });
  assert.deepEqual(field(m, 'data[4]')!.span, { off: 28, len: 4 });
  assert.equal(value(m, 'data[2]'), '3');
});

test('WM_PROTOCOLS ClientMessage resolves the protocol atom in its first word', () => {
  const s = session();
  intern(s.cap, 'WM_PROTOCOLS', 420, 1);
  intern(s.cap, 'WM_DELETE_WINDOW', 421, 2);
  s.cap.feed(
    's2c',
    event(33, 'LE', (w) => {
      w.u8(32, 1);
      w.u32(0x04800001, 4);
      w.u32(420, 8);
      w.u32(421, 12);
      w.u32(1234, 16); // timestamp
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(
    m.summary,
    'window=0x04800001 WM_PROTOCOLS format=32 data=[WM_DELETE_WINDOW, 1234, 0, 0, 0]',
  );
  assert.equal(value(m, 'data[0]'), 'WM_DELETE_WINDOW');
  assert.equal(field(m, 'data[0]')!.type, 'ATOM');
});

test('_NET_WM_STATE ClientMessage resolves the properties being toggled', () => {
  const s = session();
  intern(s.cap, '_NET_WM_STATE', 430, 1);
  intern(s.cap, '_NET_WM_STATE_FULLSCREEN', 431, 2);
  s.cap.feed(
    's2c',
    event(33, 'LE', (w) => {
      w.u8(32, 1);
      w.u32(0x04800001, 4);
      w.u32(430, 8);
      w.u32(2, 12); // _NET_WM_STATE_TOGGLE
      w.u32(431, 16);
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(value(m, 'data[1]'), '_NET_WM_STATE_FULLSCREEN');
  assert.equal(value(m, 'data[2]'), '0');
  assert.match(m.summary, /data=\[2, _NET_WM_STATE_FULLSCREEN, 0, 0, 0\]$/);
});

test('a format-8 ClientMessage shows printable data as the string it is', () => {
  const m = decode(33, (w) => {
    w.u8(8, 1);
    w.u32(0x04800001, 4);
    w.u32(31, 8); // STRING
    w.str('hello', 12);
  });
  assert.equal(value(m, 'data'), '"hello"');
  assert.deepEqual(field(m, 'data')!.span, { off: 12, len: 20 });
  assert.equal(m.summary, 'window=0x04800001 STRING format=8 data="hello"');
});

test('a format-8 ClientMessage that is not text says how many bytes it is', () => {
  const m = decode(33, (w) => {
    w.u8(8, 1);
    w.u32(0x04800001, 4);
    w.u32(31, 8);
    w.u8(0xff, 12);
  });
  assert.equal(value(m, 'data'), '[20 bytes]');
});

test('a format-16 ClientMessage decodes its ten words', () => {
  const m = decode(33, (w) => {
    w.u8(16, 1);
    w.u32(0x04800001, 4);
    w.u32(31, 8);
    w.u16(7, 12);
    w.u16(9, 14);
  });
  assert.equal(value(m, 'data'), '[7, 9, 0, 0, 0, 0, 0, 0, 0, 0]');
});

// ---- linkage ---------------------------------------------------------------

test('a window an event names links back to the request that created it', () => {
  const s = session();
  // CreateWindow wid=0x04800001, parent=0x2a
  const cw = Buffer.alloc(32);
  cw[0] = 1;
  cw.writeUInt16LE(8, 2);
  cw.writeUInt32LE(0x04800001, 4);
  cw.writeUInt32LE(0x0000002a, 8);
  s.cap.feed('c2s', cw);
  const creator = s.messages.at(-1)!;
  s.cap.feed(
    's2c',
    event(4, 'LE', (w) => {
      w.u8(1, 1);
      w.u32(0x04800001, 12);
    }),
  );
  const m = s.messages.at(-1)!;
  assert.equal(field(m, 'event')!.ref, creator.id);
});
