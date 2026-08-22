/**
 * X11 value-list (LISTofVALUE) and bitmask/enum decoding.
 *
 * Many requests carry a `value-mask` (a bitmask) followed by exactly the set
 * bits' values, as CARD32s in bit order — CreateWindow, CreateGC, RENDER
 * CreatePicture, etc. This turns `0x600` into `PolyEdge | PolyMode` and each
 * following value into its named enum / bit set, with a byte span per value so
 * the hex view highlights it. See docs/decoder-and-state.md §8.
 */
import type { Field } from './types.js';
import { pixelToHex } from './types.js';
import { xid } from '../util/hex.js';

export type Order = 'LE' | 'BE';
const r32 = (b: Buffer, o: number, e: Order): number =>
  o + 4 <= b.length ? (e === 'LE' ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0;

export interface ValueBit {
  bit: number;
  name: string;
  /** Resource type → jump-to-creator link. */
  type?: string;
  /** value → enum name. */
  enum?: Record<number, string>;
  /** value → set-of-bits names (e.g. event-mask). */
  bits?: Record<number, string>;
  /** Special-cased sentinel values (e.g. 0 = None / CopyFromParent). */
  special?: Record<number, string>;
  /** This value is a pixel — preview its low 24 bits as a color swatch. */
  pixel?: boolean;
}

/** Render a bitmask as `A | B | C`. */
export function maskNames(mask: number, defs: ValueBit[]): string {
  const on = defs.filter((d) => (mask & d.bit) !== 0).map((d) => d.name);
  return on.length ? on.join(' | ') : 'none';
}

/** Render a SETof… value (a bitmask over named bits). */
export function setOfBits(v: number, bits: Record<number, string>): string {
  const on: string[] = [];
  for (const k of Object.keys(bits)) {
    const bit = Number(k);
    if ((v & bit) !== 0) on.push(bits[bit]!);
  }
  return on.length ? on.join(' | ') : 'none';
}

/** Render a single value per its ValueBit definition. */
export function renderValue(v: number, d: ValueBit): string {
  if (d.special && d.special[v] !== undefined) return `${d.special[v]} (${v})`;
  if (d.enum && d.enum[v] !== undefined) return `${d.enum[v]} (${v})`;
  if (d.bits) return `0x${v.toString(16)} (${setOfBits(v, d.bits)})`;
  if (d.type) return xid(v);
  return String(v);
}

/**
 * Decode a value-mask at `maskOff` plus the value-list that follows it.
 * Returns the mask field, one field per present value, and the offset just
 * past the list.
 */
export function decodeValueList(
  buf: Buffer,
  maskOff: number,
  order: Order,
  defs: ValueBit[],
): { fields: Field[]; maskStr: string; endOff: number } {
  const mask = r32(buf, maskOff, order);
  const maskStr = maskNames(mask, defs);
  const fields: Field[] = [
    { name: 'value-mask', value: `0x${mask.toString(16)} (${maskStr})`, span: { off: maskOff, len: 4 } },
  ];
  let off = maskOff + 4;
  for (const d of defs) {
    if ((mask & d.bit) === 0) continue;
    const v = r32(buf, off, order);
    fields.push({
      name: d.name,
      value: renderValue(v, d),
      span: { off, len: 4 },
      type: d.type,
      color: d.pixel ? pixelToHex(v) : undefined,
    });
    off += 4;
  }
  return { fields, maskStr, endOff: off };
}
