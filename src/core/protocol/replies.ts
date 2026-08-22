/**
 * Reply body decoding.
 *
 * A reply carries no opcode of its own — it is identified only by the sequence
 * number of the request it answers (docs/decoder-and-state.md §4). So decoding
 * is keyed by the *originating request's* major opcode, which the connection's
 * sequence table supplies.
 *
 * Every field carries its byte span within the reply buffer, so the hex view
 * can highlight exactly the bytes an argument came from.
 */

import type { Field } from './types.js';
import { xid } from '../util/hex.js';

type Order = 'LE' | 'BE';
const r16 = (b: Buffer, o: number, e: Order) =>
  e === 'LE' ? b.readUInt16LE(o) : b.readUInt16BE(o);
const r32 = (b: Buffer, o: number, e: Order) =>
  e === 'LE' ? b.readUInt32LE(o) : b.readUInt32BE(o);
const s16 = (b: Buffer, o: number, e: Order) =>
  e === 'LE' ? b.readInt16LE(o) : b.readInt16BE(o);

export interface ReplyDecode {
  summary: string;
  fields: Field[];
}

export interface ReplyContext {
  /** Resolve an atom id to a name, if known. */
  atomName?: (atom: number) => string;
}

const BOOL = (v: number) => (v ? 'true' : 'false');

const MAP_STATE = ['Unmapped', 'Unviewable', 'Viewable'];
const WIN_CLASS = ['CopyFromParent', 'InputOutput', 'InputOnly'];
const GRAB_STATUS = ['Success', 'AlreadyGrabbed', 'InvalidTime', 'NotViewable', 'Frozen'];
const REVERT_TO = ['None', 'PointerRoot', 'Parent'];
const PROP_FORMAT_NAME: Record<number, string> = { 0: 'None', 8: '8', 16: '16', 32: '32' };

/** A latin1 string that may run past the fixed 32-byte header. */
function str(b: Buffer, off: number, len: number): string {
  return b.subarray(off, Math.min(off + len, b.length)).toString('latin1');
}

/**
 * Make a string safe to show in one line. Property values are frequently
 * NUL-separated lists (RESOURCE_MANAGER, WM_CLASS) and would otherwise render
 * as tofu; escaping keeps the separators visible and the row single-line.
 */
function printable(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return c === 0 ? '\\0' : c === 10 ? '\\n' : c === 9 ? '\\t' : c === 13 ? '\\r' : '·';
  });
}

/**
 * Decode a reply given the major opcode of the request it answers.
 * Returns undefined when we have no specific decoder (caller falls back to
 * the generic header decode).
 */
export function decodeReply(
  reqOpcode: number,
  buf: Buffer,
  order: Order,
  ctx: ReplyContext = {},
): ReplyDecode | undefined {
  const f: Field[] = [];
  const atom = (a: number) => ctx.atomName?.(a) ?? String(a);
  const add = (name: string, value: string, off: number, len: number, type?: string) =>
    f.push({ name, value, span: { off, len }, type });

  switch (reqOpcode) {
    case 3: {
      // GetWindowAttributes
      const backing = buf[1]!;
      const visual = r32(buf, 8, order);
      const cls = r16(buf, 12, order);
      const mapState = buf[24]!;
      add('backing-store', String(backing), 1, 1);
      add('visual', xid(visual), 8, 4, 'VISUALID');
      add('class', WIN_CLASS[cls] ?? String(cls), 12, 2);
      add('map-state', MAP_STATE[mapState] ?? String(mapState), 24, 1);
      add('your-event-mask', '0x' + r32(buf, 28, order).toString(16), 28, 4);
      return { summary: `${WIN_CLASS[cls] ?? cls} ${MAP_STATE[mapState] ?? ''}`.trim(), fields: f };
    }
    case 14: {
      // GetGeometry
      const depth = buf[1]!;
      const root = r32(buf, 8, order);
      const x = s16(buf, 12, order);
      const y = s16(buf, 14, order);
      const w = r16(buf, 16, order);
      const h = r16(buf, 18, order);
      const bw = r16(buf, 20, order);
      add('depth', String(depth), 1, 1);
      add('root', xid(root), 8, 4, 'WINDOW');
      add('x', String(x), 12, 2);
      add('y', String(y), 14, 2);
      add('width', String(w), 16, 2);
      add('height', String(h), 18, 2);
      add('border-width', String(bw), 20, 2);
      return { summary: `${w}×${h}+${x}+${y} depth=${depth}`, fields: f };
    }
    case 15: {
      // QueryTree
      const root = r32(buf, 8, order);
      const parent = r32(buf, 12, order);
      const n = r16(buf, 16, order);
      add('root', xid(root), 8, 4, 'WINDOW');
      add('parent', parent ? xid(parent) : 'None', 12, 4, 'WINDOW');
      add('num-children', String(n), 16, 2);
      for (let i = 0; i < Math.min(n, 8); i++) {
        add(`children[${i}]`, xid(r32(buf, 32 + i * 4, order)), 32 + i * 4, 4, 'WINDOW');
      }
      return { summary: `parent=${parent ? xid(parent) : 'None'} children=${n}`, fields: f };
    }
    case 16: {
      // InternAtom
      const a = r32(buf, 8, order);
      add('atom', String(a), 8, 4, 'ATOM');
      return { summary: `atom=${a}`, fields: f };
    }
    case 17: {
      // GetAtomName
      const len = r16(buf, 8, order);
      const name = printable(str(buf, 32, len));
      add('name-len', String(len), 8, 2);
      add('name', `"${name}"`, 32, len);
      return { summary: `"${name}"`, fields: f };
    }
    case 20: {
      // GetProperty
      const format = buf[1]!;
      const type = r32(buf, 8, order);
      const bytesAfter = r32(buf, 12, order);
      const valueLen = r32(buf, 16, order);
      add('format', PROP_FORMAT_NAME[format] ?? String(format), 1, 1);
      add('type', type ? atom(type) : 'None', 8, 4, 'ATOM');
      add('bytes-after', String(bytesAfter), 12, 4);
      add('value-len', String(valueLen), 16, 4);
      const typeName = type ? atom(type) : 'None';
      let preview = '';
      if (format === 8 && valueLen > 0) {
        const nbytes = Math.min(valueLen, buf.length - 32);
        const text = printable(str(buf, 32, nbytes));
        preview = `"${text.length > 40 ? text.slice(0, 40) + '…' : text}"`;
        add('value', preview, 32, nbytes);
      } else if (format === 32 && valueLen > 0) {
        const isAtomList = typeName === 'ATOM';
        const parts: string[] = [];
        for (let i = 0; i < Math.min(valueLen, 8) && 32 + i * 4 + 4 <= buf.length; i++) {
          const v = r32(buf, 32 + i * 4, order);
          parts.push(isAtomList ? atom(v) : xid(v));
          add(`value[${i}]`, isAtomList ? atom(v) : xid(v), 32 + i * 4, 4, isAtomList ? 'ATOM' : undefined);
        }
        preview = parts.join(', ');
      } else if (valueLen === 0) {
        preview = '(empty)';
      }
      return { summary: `${typeName}/${format} len=${valueLen}${preview ? ' ' + preview : ''}`, fields: f };
    }
    case 21: {
      // ListProperties
      const n = r16(buf, 8, order);
      add('num-atoms', String(n), 8, 2);
      const names: string[] = [];
      for (let i = 0; i < Math.min(n, 12) && 32 + i * 4 + 4 <= buf.length; i++) {
        const a = r32(buf, 32 + i * 4, order);
        names.push(atom(a));
        add(`atoms[${i}]`, atom(a), 32 + i * 4, 4, 'ATOM');
      }
      return { summary: `${n} properties${names.length ? ': ' + names.slice(0, 6).join(', ') : ''}`, fields: f };
    }
    case 23: {
      // GetSelectionOwner
      const owner = r32(buf, 8, order);
      add('owner', owner ? xid(owner) : 'None', 8, 4, 'WINDOW');
      return { summary: `owner=${owner ? xid(owner) : 'None'}`, fields: f };
    }
    case 26:
    case 31: {
      // GrabPointer / GrabKeyboard
      const st = buf[1]!;
      add('status', GRAB_STATUS[st] ?? String(st), 1, 1);
      return { summary: GRAB_STATUS[st] ?? String(st), fields: f };
    }
    case 38: {
      // QueryPointer
      const same = buf[1]!;
      const root = r32(buf, 8, order);
      const child = r32(buf, 12, order);
      const rx = s16(buf, 16, order);
      const ry = s16(buf, 18, order);
      const wx = s16(buf, 20, order);
      const wy = s16(buf, 22, order);
      add('same-screen', BOOL(same), 1, 1);
      add('root', xid(root), 8, 4, 'WINDOW');
      add('child', child ? xid(child) : 'None', 12, 4, 'WINDOW');
      add('root-x', String(rx), 16, 2);
      add('root-y', String(ry), 18, 2);
      add('win-x', String(wx), 20, 2);
      add('win-y', String(wy), 22, 2);
      add('mask', '0x' + r16(buf, 24, order).toString(16), 24, 2);
      return { summary: `root=+${rx}+${ry} win=+${wx}+${wy}`, fields: f };
    }
    case 40: {
      // TranslateCoordinates
      const same = buf[1]!;
      const child = r32(buf, 8, order);
      const dx = s16(buf, 12, order);
      const dy = s16(buf, 14, order);
      add('same-screen', BOOL(same), 1, 1);
      add('child', child ? xid(child) : 'None', 8, 4, 'WINDOW');
      add('dst-x', String(dx), 12, 2);
      add('dst-y', String(dy), 14, 2);
      return { summary: `+${dx}+${dy}`, fields: f };
    }
    case 43: {
      // GetInputFocus
      const revert = buf[1]!;
      const focus = r32(buf, 8, order);
      add('revert-to', REVERT_TO[revert] ?? String(revert), 1, 1);
      add('focus', focus > 1 ? xid(focus) : focus === 1 ? 'PointerRoot' : 'None', 8, 4, 'WINDOW');
      return {
        summary: `focus=${focus > 1 ? xid(focus) : focus === 1 ? 'PointerRoot' : 'None'} revert=${REVERT_TO[revert] ?? revert}`,
        fields: f,
      };
    }
    case 49:
    case 52: {
      // ListFonts / GetFontPath — a count plus a STRING8 list
      const n = r16(buf, 8, order);
      add(reqOpcode === 49 ? 'num-names' : 'num-paths', String(n), 8, 2);
      let off = 32;
      const items: string[] = [];
      for (let i = 0; i < Math.min(n, 6) && off < buf.length; i++) {
        const len = buf[off]!;
        const s = printable(str(buf, off + 1, len));
        items.push(s);
        add(`[${i}]`, `"${s}"`, off, 1 + len);
        off += 1 + len;
      }
      return { summary: `${n} entries${items.length ? ': ' + items.slice(0, 3).join(', ') : ''}`, fields: f };
    }
    case 73: {
      // GetImage
      const depth = buf[1]!;
      const visual = r32(buf, 8, order);
      const dataLen = Math.max(0, buf.length - 32);
      add('depth', String(depth), 1, 1);
      add('visual', xid(visual), 8, 4, 'VISUALID');
      add('data', `[Buffer ${dataLen} bytes]`, 32, dataLen);
      return { summary: `depth=${depth} [Buffer ${dataLen} bytes]`, fields: f };
    }
    case 83: {
      // ListInstalledColormaps
      const n = r16(buf, 8, order);
      add('num-cmaps', String(n), 8, 2);
      return { summary: `${n} colormaps`, fields: f };
    }
    case 84: {
      // AllocColor
      const red = r16(buf, 8, order);
      const green = r16(buf, 10, order);
      const blue = r16(buf, 12, order);
      const pixel = r32(buf, 16, order);
      add('red', String(red), 8, 2);
      add('green', String(green), 10, 2);
      add('blue', String(blue), 12, 2);
      add('pixel', xid(pixel), 16, 4);
      return { summary: `pixel=${xid(pixel)} rgb=(${red},${green},${blue})`, fields: f };
    }
    case 92: {
      // LookupColor
      const er = r16(buf, 8, order);
      const eg = r16(buf, 10, order);
      const eb = r16(buf, 12, order);
      add('exact-red', String(er), 8, 2);
      add('exact-green', String(eg), 10, 2);
      add('exact-blue', String(eb), 12, 2);
      return { summary: `exact=(${er},${eg},${eb})`, fields: f };
    }
    case 97: {
      // QueryBestSize
      const w = r16(buf, 8, order);
      const h = r16(buf, 10, order);
      add('width', String(w), 8, 2);
      add('height', String(h), 10, 2);
      return { summary: `${w}×${h}`, fields: f };
    }
    case 98: {
      // QueryExtension
      const present = buf[8]!;
      const major = buf[9]!;
      const firstEvent = buf[10]!;
      const firstError = buf[11]!;
      add('present', BOOL(present), 8, 1);
      add('major-opcode', String(major), 9, 1);
      add('first-event', String(firstEvent), 10, 1);
      add('first-error', String(firstError), 11, 1);
      return {
        summary: present
          ? `major=${major} firstEvent=${firstEvent} firstError=${firstError}`
          : 'not present',
        fields: f,
      };
    }
    case 99: {
      // ListExtensions — count in the data byte, then STRING8 list
      const n = buf[1]!;
      add('num-names', String(n), 1, 1);
      let off = 32;
      const names: string[] = [];
      for (let i = 0; i < n && off < buf.length; i++) {
        const len = buf[off]!;
        const s = printable(str(buf, off + 1, len));
        names.push(s);
        if (i < 12) add(`names[${i}]`, `"${s}"`, off, 1 + len);
        off += 1 + len;
      }
      return { summary: `${n}: ${names.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''}`, fields: f };
    }
    case 101: {
      // GetKeyboardMapping
      const per = buf[1]!;
      const total = Math.max(0, (buf.length - 32) / 4);
      add('keysyms-per-keycode', String(per), 1, 1);
      add('keysyms', `[${total} keysyms]`, 32, buf.length - 32);
      return { summary: `${per} keysyms/keycode, ${total} total`, fields: f };
    }
    case 117: {
      // GetPointerMapping
      const n = buf[1]!;
      add('length', String(n), 1, 1);
      const map: number[] = [];
      for (let i = 0; i < Math.min(n, 16) && 32 + i < buf.length; i++) map.push(buf[32 + i]!);
      if (map.length) add('map', map.join(','), 32, map.length);
      return { summary: `${n} buttons: ${map.join(',')}`, fields: f };
    }
    case 119: {
      // GetModifierMapping
      const per = buf[1]!;
      add('keycodes-per-modifier', String(per), 1, 1);
      return { summary: `${per} keycodes/modifier`, fields: f };
    }
    default:
      return undefined;
  }
}
