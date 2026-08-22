/**
 * Extension decoder registry.
 *
 * Each extension contributes a small spec: request decoders keyed by minor
 * opcode, XGE event decoders keyed by evtype (XInput 2, Present, …), classic
 * event decoders keyed by offset from the extension's first-event, and error
 * names keyed by offset from its first-error. Add an extension by writing one
 * file and listing it in `index.ts` — nothing else changes.
 */
import type { Field } from '../types.js';
import type { Order } from './read.js';

export interface DecodeCtx {
  atomName: (a: number) => string;
  /** Resolve a RENDER PICTFORMAT id to a human-readable description, if known. */
  pictFormatName?: (id: number) => string | undefined;
  /** Depth of a GLYPHSET's mask format (A1/A4/A8/ARGB32), if known. */
  glyphSetDepth?: (gsid: number) => number | undefined;
}

export interface Decoded {
  summary: string;
  fields: Field[];
  /** The resource this message creates, for jump-to-creator wiring. */
  created?: { xid: number; type: string };
  /** Glyph bitmaps carried by this message (RENDER AddGlyphs), for preview. */
  glyphs?: import('../image.js').GlyphSpec[];
  /** A resource→format association this message establishes (CreateGlyphSet). */
  glyphSetFormat?: { gsid: number; format: number };
  /** The resource id this message frees/destroys (lifecycle lints). */
  frees?: number;
}

export type DecodeFn = (buf: Buffer, order: Order, ctx: DecodeCtx) => Decoded;

export interface Def {
  name: string;
  decode?: DecodeFn;
}

export interface ExtensionSpec {
  /** minor opcode → request */
  requests?: Record<number, Def>;
  /** minor opcode → reply decoder (a reply is keyed by its request's opcode). */
  replies?: Record<number, DecodeFn>;
  /** XGE evtype → event (GenericEvent, code 35) */
  xgeEvents?: Record<number, Def>;
  /** (event code − firstEvent) → event (classic 32-byte events) */
  events?: Record<number, Def>;
  /** (error code − firstError) → error name */
  errors?: Record<number, string>;
}

/** Build a Field tersely. */
export const F = (name: string, value: string, off: number, len: number, type?: string): Field => ({
  name,
  value,
  span: { off, len },
  type,
});

/** Build a color Field (with a swatch preview) from a RENDER COLOR at `off`. */
export const colorField = (name: string, rgbaText: string, hex: string, off: number, len = 8): Field => ({
  name,
  value: rgbaText,
  span: { off, len },
  color: hex,
});

/** Map a name list (minor-opcode order, contiguous from 0) to request defs. */
export const reqNames = (arr: string[]): Record<number, Def> =>
  Object.fromEntries(arr.map((name, i) => [i, { name }]));

/** Map a name list to a code→name record (errors, keyed by offset from first). */
export const codeNames = (arr: string[]): Record<number, string> =>
  Object.fromEntries(arr.map((name, i) => [i, name]));

/** Map a name list to event defs, keyed by offset from first-event. */
export const evtNames = (arr: string[]): Record<number, Def> =>
  Object.fromEntries(arr.map((name, i) => [i, { name }]));
