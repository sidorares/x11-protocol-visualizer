/**
 * Decode a message from generated xcbproto tables.
 *
 * This is the fallback that removes the `ext139:req4` long tail: any request,
 * event or error the hand-written specs don't cover is still named, and its
 * fixed-length prefix is decoded with real byte spans, enum names, expanded
 * bitmasks and resource links.
 *
 * A message whose layout has a variable-length tail is decoded up to that point
 * and marked `partial`, so what is shown is always something we actually know
 * rather than a guess past the first list.
 */

import type { Field } from './types.js';
import {
  GENERATED,
  GENERATED_BY_XNAME,
  type GenExpr,
  type GenExtension,
  type GenMessage,
} from './generated.js';
import { setOfBits } from './valuelist.js';
import { xid as fmtXid } from '../util/hex.js';

type Order = 'LE' | 'BE';

const r = (buf: Buffer, off: number, len: number, e: Order): number => {
  try {
    if (off + len > buf.length) return 0;
    switch (len) {
      case 1: return buf[off]!;
      case 2: return e === 'LE' ? buf.readUInt16LE(off) : buf.readUInt16BE(off);
      case 4: return e === 'LE' ? buf.readUInt32LE(off) : buf.readUInt32BE(off);
      case 8: return Number(e === 'LE' ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off));
      default: return 0;
    }
  } catch {
    return 0;
  }
};

const core = (): GenExtension | undefined => GENERATED['xproto'];

export function generatedForExtension(xname: string): GenExtension | undefined {
  return GENERATED_BY_XNAME[xname];
}
export function generatedCore(): GenExtension | undefined {
  return core();
}

/** Look an enum up in the owning extension, then in the core protocol. */
function lookupEnum(ext: GenExtension | undefined, name: string): Record<number, string> | undefined {
  return ext?.enums[name] ?? core()?.enums[name];
}
function lookupMask(ext: GenExtension | undefined, name: string): { bit: number; name: string }[] | undefined {
  return ext?.masks[name] ?? core()?.masks[name];
}

export interface GenericDecode {
  fields: Field[];
  summary: string;
  partial: boolean;
}

/** Evaluate a generated length expression against the fields decoded so far. */
function evalExpr(e: GenExpr, vals: Map<string, number>): number | undefined {
  if ('value' in e) return e.value;
  if ('field' in e) return vals.get(e.field);
  const l = evalExpr(e.l, vals);
  const r = evalExpr(e.r, vals);
  if (l === undefined || r === undefined) return undefined;
  switch (e.op) {
    case '+': return l + r;
    case '-': return l - r;
    case '*': return l * r;
    // Integer division: these expressions are byte counts, and xcbproto's
    // `data_len * format / 8` is only ever exact.
    case '/': return r === 0 ? undefined : Math.floor(l / r);
    case '&': return l & r;
    case '<<': return l << r;
    case '>>': return l >>> r;
    default: return undefined;
  }
}

/** How much of a list to spell out before saying how much is left. */
const LIST_PREVIEW = 8;
const TEXT_PREVIEW = 64;

const printable = (b: Buffer) => b.every((c) => (c >= 0x20 && c < 0x7f) || c === 0x09);

/**
 * Render a list as something a person can read.
 *
 * Text is the common case and by far the most useful — an atom name, a font
 * name, a window title — so bytes that are entirely printable are shown as a
 * string. Anything else is summarised rather than dumped: the bytes are in the
 * hex pane already, and the span on this field is what highlights them there.
 */
function renderList(
  bytes: Buffer,
  item: { type: string; elem: number; resource?: boolean },
  count: number,
  order: Order,
  atomName?: (id: number) => string,
): string {
  if (count === 0) return '[]';

  if (item.elem === 1) {
    const isText = item.type === 'char' || item.type === 'STRING8';
    if (bytes.length && (isText || printable(bytes))) {
      const text = bytes.toString('latin1');
      return text.length > TEXT_PREVIEW
        ? `"${text.slice(0, TEXT_PREVIEW)}…" (${count} bytes)`
        : `"${text}"`;
    }
    return `[${count} bytes]`;
  }

  // A struct element (RECTANGLE, ModeInfo, FP3232) has internal shape the
  // generator does not carry, and printing its first machine word as if it
  // were the value would be worse than saying what it is. The bytes are in the
  // hex pane, and this field's span highlights them.
  if (!SCALAR.has(item.type) && !item.resource) {
    return `[${count} × ${item.type}]`;
  }

  const shown: string[] = [];
  for (let i = 0; i < Math.min(count, LIST_PREVIEW); i++) {
    const off = i * item.elem;
    if (off + item.elem > bytes.length) break;
    const v = r(bytes, off, item.elem, order);
    if (item.type === 'ATOM') shown.push(v === 0 ? 'None' : (atomName?.(v) ?? String(v)));
    else if (item.resource) shown.push(v === 0 ? 'None' : fmtXid(v));
    else shown.push(String(v));
  }
  const more = count > shown.length ? `, … (${count} total)` : '';
  return `[${count}] ${shown.join(', ')}${more}`;
}

/** Element types whose value is a single number worth printing. */
const SCALAR = new Set([
  'CARD8', 'CARD16', 'CARD32', 'CARD64',
  'INT8', 'INT16', 'INT32', 'INT64',
  'BYTE', 'BOOL', 'ATOM', 'TIMESTAMP', 'VISUALID', 'KEYSYM', 'KEYCODE', 'KEYCODE32', 'BUTTON',
]);

/**
 * Decode `msg`'s fixed prefix out of `buf`. `ext` is the extension the message
 * belongs to (undefined for core), used to resolve its enums and masks.
 */
export function decodeGenerated(
  msg: GenMessage,
  buf: Buffer,
  order: Order,
  ext: GenExtension | undefined,
  /** Resolves an atom id to its name, so ATOM parameters read as names. */
  atomName?: (id: number) => string,
): GenericDecode {
  const fields: Field[] = [];
  const parts: string[] = [];
  /** Raw numeric values, for the tail's length expressions. */
  const vals = new Map<string, number>();

  for (const f of msg.fields) {
    if (f.off + f.len > buf.length) break; // truncated message; stop cleanly
    const raw = r(buf, f.off, f.len, order);
    vals.set(f.name, raw);

    let value: string;
    if (f.type === 'ATOM') {
      // An atom is an id, but nobody thinks in atom ids.
      value = raw === 0 ? 'None' : (atomName?.(raw) ?? String(raw));
    } else if (f.resource) {
      value = raw === 0 ? 'None' : fmtXid(raw);
    } else if (f.mask) {
      const bits = lookupMask(ext, f.mask);
      value = bits
        ? `0x${raw.toString(16)} (${setOfBits(raw, Object.fromEntries(bits.map((b) => [b.bit, b.name])))})`
        : `0x${raw.toString(16)}`;
    } else if (f.enum) {
      const en = lookupEnum(ext, f.enum);
      value = en?.[raw] !== undefined ? `${en[raw]} (${raw})` : String(raw);
    } else {
      value = String(raw);
    }

    fields.push({
      name: f.name.replace(/_/g, '-'),
      value,
      span: { off: f.off, len: f.len },
      type: f.type === 'ATOM' ? 'ATOM' : f.resource ? f.type : undefined,
    });

    // A readable one-liner: resources and named values are what identify a
    // message at a glance; plain counters mostly are not.
    if (parts.length < 4 && (f.resource || f.enum || f.mask)) {
      parts.push(`${f.name.replace(/_/g, '-')}=${value}`);
    }
  }

  // The variable-length tail. Offsets here are not known until the lengths
  // ahead of them have been read, so this walks rather than indexes; anything
  // that does not add up stops the walk and leaves the message partial.
  let partial = msg.partial;
  if (msg.tail && msg.tailOff !== undefined) {
    let off = msg.tailOff;
    for (const it of msg.tail) {
      if (off > buf.length) { partial = true; break; }

      if (it.kind === 'pad') {
        off += it.len;
        continue;
      }
      if (it.kind === 'align') {
        off = it.to > 0 ? Math.ceil(off / it.to) * it.to : off;
        continue;
      }
      if (it.kind === 'field') {
        if (off + it.len > buf.length) { partial = true; break; }
        const raw = r(buf, off, it.len, order);
        vals.set(it.name, raw);
        fields.push({
          name: it.name.replace(/_/g, '-'),
          value: it.resource ? (raw === 0 ? 'None' : fmtXid(raw))
            : it.enum ? (lookupEnum(ext, it.enum)?.[raw] !== undefined
                ? `${lookupEnum(ext, it.enum)![raw]} (${raw})` : String(raw))
            : String(raw),
          span: { off, len: it.len },
          type: it.resource ? it.type : undefined,
        });
        off += it.len;
        continue;
      }

      // A list: resolve its element count, then take that many elements.
      const count =
        it.lenFrom !== undefined ? vals.get(it.lenFrom)
        : it.lenConst !== undefined ? it.lenConst
        : it.lenExpr !== undefined ? evalExpr(it.lenExpr, vals)
        : it.lenRest ? Math.max(0, Math.floor((buf.length - off) / it.elem))
        : undefined;
      if (count === undefined || count < 0) { partial = true; break; }

      const len = count * it.elem;
      // A length that runs past the message means the layout and the bytes
      // disagree; show what is there and say the decode is incomplete.
      const avail = Math.max(0, Math.min(len, buf.length - off));
      if (avail < len) partial = true;

      const name = it.name.replace(/_/g, '-');
      const value = renderList(buf.subarray(off, off + avail), it, count, order, atomName);
      fields.push({ name, value, span: { off, len: avail } });
      // A name or a string is what identifies these requests at a glance —
      // InternAtom("WM_PROTOCOLS") beats InternAtom(name-len=12).
      if (parts.length < 4 && value.startsWith('"')) parts.push(`${name}=${value}`);

      off += len;
      if (avail < len) break;
    }
  }

  return {
    fields,
    summary: parts.join(' ') + (partial && parts.length ? ' …' : ''),
    partial,
  };
}
