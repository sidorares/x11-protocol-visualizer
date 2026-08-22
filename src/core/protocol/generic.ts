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
import { GENERATED, GENERATED_BY_XNAME, type GenExtension, type GenMessage } from './generated.js';
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

  for (const f of msg.fields) {
    if (f.off + f.len > buf.length) break; // truncated message; stop cleanly
    const raw = r(buf, f.off, f.len, order);

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

  return {
    fields,
    summary: parts.join(' ') + (msg.partial && parts.length ? ' …' : ''),
    partial: msg.partial,
  };
}
