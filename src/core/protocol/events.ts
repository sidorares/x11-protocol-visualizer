/**
 * Core event decoders (codes 2–34).
 *
 * Events are the half of the protocol nobody sends and everybody reads, and a
 * row that says only `ButtonPress  seq #412` is useless: what matters is which
 * button, in which window, at which point, with which modifiers held. The
 * generated xcbproto layout already knows every fixed field of every core
 * event, so this module does not repeat it — it contributes the two things the
 * generated pass cannot produce:
 *
 * 1. **A summary.** The generic one-liner picks resources and enums in wire
 *    order, which reads as `root=0x… event=0x… child=None` for every pointer
 *    event alike. Here each event gets a line built around what identifies it.
 * 2. **The fields no layout can express** — `ClientMessage`'s data union,
 *    `KeymapNotify`'s bitmap of held keys, the two flags packed into
 *    Enter/Leave's last byte, a button number as `Button1`, and the
 *    major-opcode of the request an exposure answers.
 *
 * Everything else is left to `decodeGenerated`, which the caller merges in
 * (hand-written wins on name collisions — AGENTS.md invariant 8).
 */

import type { Field } from './types.js';
import { CORE_REQUESTS } from './tables.js';
import {
  CONFIG_WINDOW,
  COLORMAP_STATE,
  KEY_BUT_MASK,
  MAPPING_REQUEST,
  MOTION_DETAIL,
  NOTIFY_DETAIL,
  NOTIFY_MODE,
  PLACE,
  PROPERTY_STATE,
  STACK_MODE,
  VISIBILITY,
} from './enums.js';
import { setOfBits } from './valuelist.js';
import { F } from './extensions/types.js';
import { r16, r32, s16, u8, xid, type Order } from './extensions/read.js';

/** What a core event decoder needs from the connection's state. */
export interface EventCtx {
  atomName: (a: number) => string;
}

export interface DecodedEvent {
  summary: string;
  /** Only the fields the generated layout cannot produce; may be empty. */
  fields: Field[];
}

type EventFn = (b: Buffer, e: Order, ctx: EventCtx) => DecodedEvent;

const named = (v: number, table: Record<number, string>): string => table[v] ?? String(v);
/** `0x04800001`, or `None` for the null resource. */
const res = (v: number): string => (v === 0 ? 'None' : xid(v));
/** ` state=Shift | Control`, or nothing at all when no modifier is held. */
const state = (v: number): string => (v === 0 ? '' : ` state=${setOfBits(v, KEY_BUT_MASK)}`);
/** `+10-20` — X11 geometry's signed offset pair, where a negative x needs no `+`. */
const at = (x: number, y: number): string => `${x < 0 ? '' : '+'}${x}${y < 0 ? '' : '+'}${y}`;
/** `300×200+10-20` — the geometry shorthand the request decoders also use. */
const geom = (w: number, h: number, x: number, y: number): string => `${w}×${h}${at(x, y)}`;
/** ` override-redirect` when set — a bare flag reads better than `=true`. */
const opt = (on: unknown, text: string): string => (on ? ` ${text}` : '');

/**
 * Pointer and keyboard events (2–6) share one layout: `detail` is a keycode, a
 * button, or a motion hint depending on the code, and the rest is the pointer
 * position in both the root's and the event window's coordinates.
 */
function inputEvent(kind: 'key' | 'button' | 'motion'): EventFn {
  return (b, e) => {
    const detail = u8(b, 1);
    const where = `@(${s16(b, 24, e)},${s16(b, 26, e)})`;
    const fields: Field[] = [];
    let what: string;
    if (kind === 'button') {
      // The protocol numbers buttons; the name is the physical button as the
      // server's pointer mapping left it, which is what a reader expects to see.
      if (detail >= 1 && detail <= 5) fields.push(F('detail', `Button${detail} (${detail})`, 1, 1));
      what = `button=${detail} `;
    } else if (kind === 'key') {
      what = `keycode=${detail} `;
    } else {
      // A Hint says the pointer moved and the client should ask where to; the
      // coordinates are still filled in, so they stay in the line.
      fields.push(F('detail', `${named(detail, MOTION_DETAIL)} (${detail})`, 1, 1));
      what = detail === 1 ? 'Hint ' : '';
    }
    return {
      summary: `${what}${where} event=${res(r32(b, 12, e))}${state(r16(b, 28, e))}`,
      fields,
    };
  };
}

/** EnterNotify / LeaveNotify (7–8): two flags share the last byte. */
const crossingEvent: EventFn = (b, e) => {
  const event = r32(b, 12, e);
  const ssf = u8(b, 31);
  const on = [ssf & 0x02 ? 'same-screen' : '', ssf & 0x01 ? 'focus' : ''].filter(Boolean);
  return {
    summary:
      `event=${res(event)} @(${s16(b, 24, e)},${s16(b, 26, e)})` +
      ` mode=${named(u8(b, 30), NOTIFY_MODE)} detail=${named(u8(b, 1), NOTIFY_DETAIL)}` +
      state(r16(b, 28, e)),
    fields: [F('same-screen-focus', `0x${ssf.toString(16)} (${on.join(' | ') || 'none'})`, 31, 1)],
  };
};

/** FocusIn / FocusOut (9–10). */
const focusEvent: EventFn = (b, e) => ({
  summary: `event=${res(r32(b, 4, e))} mode=${named(u8(b, 8), NOTIFY_MODE)} detail=${named(u8(b, 1), NOTIFY_DETAIL)}`,
  fields: [],
});

/**
 * KeymapNotify (11) — a 248-bit bitmap of the keys held down, sent right after
 * an Enter or FocusIn. Bit k of byte i is keycode i*8+k, and byte 0 covers
 * keycodes 0–7, which the protocol reserves; a client reads this to find what
 * is already down, so spelling the keycodes out is the whole point.
 */
const keymapNotify: EventFn = (b) => {
  const keys: number[] = [];
  for (let i = 0; i < 31; i++) {
    const byte = u8(b, 1 + i);
    if (!byte) continue;
    for (let k = 0; k < 8; k++) if (byte & (1 << k)) keys.push(i * 8 + k);
  }
  return {
    summary: keys.length ? `${keys.length} key${keys.length > 1 ? 's' : ''} down: ${keys.join(', ')}` : 'no keys down',
    fields: [F('keys', keys.length ? `[${keys.join(', ')}]` : '[] (no keys down)', 1, 31)],
  };
};

/** The request an exposure answers, named — the field is a bare opcode. */
const majorOpcode = (b: Buffer, off: number): { name: string; field: Field } => {
  const code = u8(b, off);
  const name = CORE_REQUESTS[code] ?? `request ${code}`;
  return { name, field: F('major-opcode', `${code} (${name})`, off, 1) };
};

/** Expose (12). */
const expose: EventFn = (b, e) => ({
  summary:
    `window=${res(r32(b, 4, e))} ` +
    geom(r16(b, 12, e), r16(b, 14, e), r16(b, 8, e), r16(b, 10, e)) +
    ` count=${r16(b, 16, e)}`,
  fields: [],
});

/** GraphicsExposure (13) — an exposure caused by a CopyArea / CopyPlane. */
const graphicsExposure: EventFn = (b, e) => {
  const major = majorOpcode(b, 20);
  return {
    summary:
      `drawable=${res(r32(b, 4, e))} ` +
      geom(r16(b, 12, e), r16(b, 14, e), r16(b, 8, e), r16(b, 10, e)) +
      ` count=${r16(b, 18, e)} ${major.name}`,
    fields: [major.field],
  };
};

/** NoExposure (14) — the same copy, with nothing to repaint. */
const noExposure: EventFn = (b, e) => {
  const major = majorOpcode(b, 10);
  return { summary: `drawable=${res(r32(b, 4, e))} ${major.name}`, fields: [major.field] };
};

/** CirculateNotify / CirculateRequest (26-27) — restacked to top or bottom. */
const circulate: EventFn = (b, e) => ({
  summary: `window=${res(r32(b, 8, e))} place=${named(u8(b, 16), PLACE)}`,
  fields: [],
});

const CORE_EVENT_DECODERS: Record<number, EventFn> = {
  2: inputEvent('key'),
  3: inputEvent('key'),
  4: inputEvent('button'),
  5: inputEvent('button'),
  6: inputEvent('motion'),
  7: crossingEvent,
  8: crossingEvent,
  9: focusEvent,
  10: focusEvent,
  11: keymapNotify,
  12: expose,
  13: graphicsExposure,
  14: noExposure,
  15: (b, e) => ({
    summary: `window=${res(r32(b, 4, e))} state=${named(u8(b, 8), VISIBILITY)}`,
    fields: [],
  }),
  16: (b, e) => ({
    summary:
      `window=${res(r32(b, 8, e))} parent=${res(r32(b, 4, e))} ` +
      geom(r16(b, 16, e), r16(b, 18, e), s16(b, 12, e), s16(b, 14, e)) +
      opt(r16(b, 20, e), `border=${r16(b, 20, e)}`) +
      opt(u8(b, 22), 'override-redirect'),
    fields: [],
  }),
  17: (b, e) => ({ summary: `window=${res(r32(b, 8, e))} event=${res(r32(b, 4, e))}`, fields: [] }),
  18: (b, e) => ({
    summary: `window=${res(r32(b, 8, e))} event=${res(r32(b, 4, e))}${opt(u8(b, 12), 'from-configure')}`,
    fields: [],
  }),
  19: (b, e) => ({
    summary: `window=${res(r32(b, 8, e))} event=${res(r32(b, 4, e))}${opt(u8(b, 12), 'override-redirect')}`,
    fields: [],
  }),
  20: (b, e) => ({ summary: `window=${res(r32(b, 8, e))} parent=${res(r32(b, 4, e))}`, fields: [] }),
  21: (b, e) => ({
    summary:
      `window=${res(r32(b, 8, e))} parent=${res(r32(b, 12, e))} ${at(s16(b, 16, e), s16(b, 18, e))}` +
      opt(u8(b, 20), 'override-redirect'),
    fields: [],
  }),
  22: (b, e) => ({
    summary:
      `window=${res(r32(b, 8, e))} ` +
      geom(r16(b, 20, e), r16(b, 22, e), s16(b, 16, e), s16(b, 18, e)) +
      ` above=${res(r32(b, 12, e))}` +
      opt(r16(b, 24, e), `border=${r16(b, 24, e)}`) +
      opt(u8(b, 26), 'override-redirect'),
    fields: [],
  }),
  // ConfigureRequest (23): the value-mask says which of the parameters that
  // follow the client actually asked for. Reporting the others would be
  // reporting whatever the server left in the wire's padding.
  23: (b, e) => {
    const mask = r16(b, 26, e);
    const asked: string[] = [];
    if (mask & 0x01) asked.push(`x=${s16(b, 16, e)}`);
    if (mask & 0x02) asked.push(`y=${s16(b, 18, e)}`);
    if (mask & 0x04) asked.push(`width=${r16(b, 20, e)}`);
    if (mask & 0x08) asked.push(`height=${r16(b, 22, e)}`);
    if (mask & 0x10) asked.push(`border-width=${r16(b, 24, e)}`);
    if (mask & 0x20) asked.push(`sibling=${res(r32(b, 12, e))}`);
    if (mask & 0x40) asked.push(`stack-mode=${named(u8(b, 1), STACK_MODE)}`);
    return {
      summary: `window=${res(r32(b, 8, e))} {${asked.join(' ') || 'nothing'}}`,
      fields: [F('value-mask', `0x${mask.toString(16)} (${setOfBits(mask, CONFIG_WINDOW)})`, 26, 2)],
    };
  },
  24: (b, e) => ({
    summary: `window=${res(r32(b, 8, e))} ${at(s16(b, 12, e), s16(b, 14, e))}`,
    fields: [],
  }),
  25: (b, e) => ({
    summary: `window=${res(r32(b, 4, e))} ${r16(b, 8, e)}×${r16(b, 10, e)}`,
    fields: [],
  }),
  26: circulate,
  27: circulate,
  28: (b, e, ctx) => ({
    summary: `window=${res(r32(b, 4, e))} ${ctx.atomName(r32(b, 8, e))} ${named(u8(b, 16), PROPERTY_STATE)}`,
    fields: [],
  }),
  29: (b, e, ctx) => ({
    summary: `owner=${res(r32(b, 8, e))} selection=${ctx.atomName(r32(b, 12, e))}`,
    fields: [],
  }),
  30: (b, e, ctx) => ({
    summary:
      `requestor=${res(r32(b, 12, e))} selection=${ctx.atomName(r32(b, 16, e))}` +
      ` target=${ctx.atomName(r32(b, 20, e))} property=${atomOrNone(r32(b, 24, e), ctx)}`,
    fields: [],
  }),
  31: (b, e, ctx) => ({
    summary:
      `requestor=${res(r32(b, 8, e))} selection=${ctx.atomName(r32(b, 12, e))}` +
      ` target=${ctx.atomName(r32(b, 16, e))} property=${atomOrNone(r32(b, 20, e), ctx)}`,
    fields: [],
  }),
  32: (b, e) => ({
    summary:
      `window=${res(r32(b, 4, e))} colormap=${res(r32(b, 8, e))}` +
      ` state=${named(u8(b, 13), COLORMAP_STATE)}${opt(u8(b, 12), 'new')}`,
    fields: [],
  }),
  33: clientMessage,
  34: (b) => ({
    summary:
      `request=${named(u8(b, 4), MAPPING_REQUEST)}` +
      (u8(b, 4) === 1 ? ` first-keycode=${u8(b, 5)} count=${u8(b, 6)}` : ''),
    fields: [],
  }),
};

/** A property/target atom, where 0 means the request was refused. */
function atomOrNone(a: number, ctx: EventCtx): string {
  return a === 0 ? 'None' : ctx.atomName(a);
}

/**
 * Which words of a format-32 ClientMessage are themselves atoms. Only the
 * message type knows: `WM_PROTOCOLS` carries the protocol atom in its first
 * word (this is how a window manager asks a client to close), and
 * `_NET_WM_STATE` puts the properties being toggled in its second and third.
 */
const ATOM_DATA_WORDS: Record<string, number[]> = {
  WM_PROTOCOLS: [0],
  _NET_WM_STATE: [1, 2],
};

/**
 * ClientMessage (33) — 20 bytes of payload whose shape only `format` says and
 * whose meaning only the `type` atom says. xcbproto models it as a union, which
 * is exactly what the generator gives up on, so this is the one core event
 * whose data would otherwise not be decoded at all.
 */
function clientMessage(b: Buffer, e: Order, ctx: EventCtx): DecodedEvent {
  const format = u8(b, 1);
  const type = ctx.atomName(r32(b, 8, e));
  const fields: Field[] = [];
  const OFF = 12;
  const LEN = 20;
  let rendered: string;

  if (format === 8) {
    const raw = b.subarray(OFF, Math.min(OFF + LEN, b.length));
    const text = raw.toString('latin1').replace(/\0+$/, '');
    rendered = text.length > 0 && /^[\x20-\x7e]*$/.test(text) ? `"${text}"` : `[${raw.length} bytes]`;
    fields.push(F('data', rendered, OFF, LEN));
  } else if (format === 16) {
    const words: string[] = [];
    for (let i = 0; i < 10; i++) words.push(String(r16(b, OFF + i * 2, e)));
    rendered = `[${words.join(', ')}]`;
    fields.push(F('data', rendered, OFF, LEN));
  } else {
    // Format 32 is the interesting one: five words, each given its own span so
    // selecting it highlights the right four bytes in the hex view.
    const atomWords = ATOM_DATA_WORDS[type] ?? [];
    const shown: string[] = [];
    for (let i = 0; i < 5; i++) {
      const w = r32(b, OFF + i * 4, e);
      const isAtom = atomWords.includes(i) && w !== 0;
      shown.push(isAtom ? ctx.atomName(w) : String(w));
      fields.push(F(`data[${i}]`, shown[i]!, OFF + i * 4, 4, isAtom ? 'ATOM' : undefined));
    }
    rendered = `[${shown.join(', ')}]`;
  }

  return { summary: `window=${res(r32(b, 4, e))} ${type} format=${format} data=${rendered}`, fields };
}

/**
 * Decode core event `code` (2–34). Returns `undefined` for a code with no
 * hand-written decoder, leaving the caller with the generated layout alone.
 */
export function decodeCoreEvent(
  code: number,
  buf: Buffer,
  order: Order,
  ctx: EventCtx,
): DecodedEvent | undefined {
  return CORE_EVENT_DECODERS[code]?.(buf, order, ctx);
}
