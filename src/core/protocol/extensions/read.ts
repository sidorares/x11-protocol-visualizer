/**
 * Bounds-checked wire readers for extension decoders. Reading past the end of a
 * (possibly truncated) message returns 0 rather than throwing, so a short buffer
 * degrades one field instead of the whole row.
 */
import { xid } from '../../util/hex.js';

export type Order = 'LE' | 'BE';

export const u8 = (b: Buffer, o: number): number => (o < b.length ? b[o]! : 0);
export const r16 = (b: Buffer, o: number, e: Order): number =>
  o + 2 <= b.length ? (e === 'LE' ? b.readUInt16LE(o) : b.readUInt16BE(o)) : 0;
export const r32 = (b: Buffer, o: number, e: Order): number =>
  o + 4 <= b.length ? (e === 'LE' ? b.readUInt32LE(o) : b.readUInt32BE(o)) : 0;
export const s16 = (b: Buffer, o: number, e: Order): number =>
  o + 2 <= b.length ? (e === 'LE' ? b.readInt16LE(o) : b.readInt16BE(o)) : 0;
export const s32 = (b: Buffer, o: number, e: Order): number =>
  o + 4 <= b.length ? (e === 'LE' ? b.readInt32LE(o) : b.readInt32BE(o)) : 0;

/** X11 FP1616 fixed-point (used by XInput 2) → JS number. */
export const fp1616 = (b: Buffer, o: number, e: Order): number => s32(b, o, e) / 65536;

/** Trim a fixed-point coordinate for display. */
export const fp = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export { xid };
