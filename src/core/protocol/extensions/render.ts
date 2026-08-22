/**
 * RENDER (X Rendering Extension) — request decoders.
 *
 * Minor opcodes and layouts follow the X Render protocol / xcbproto render.xml.
 * Names appear in the UI prefixed with the negotiated extension name, e.g.
 * `RENDER:CreatePicture`.
 */
import type { ExtensionSpec } from './types.js';
import { F, colorField } from './types.js';
import { r16, r32, s16, u8, xid, type Order } from './read.js';
import { decodeValueList, type ValueBit } from '../valuelist.js';
import { BOOL, SUBWINDOW_MODE } from '../enums.js';
import { renderColorToHex } from '../types.js';

/** RENDER CreatePicture / ChangePicture value-list (CP). */
const CP_BITS: ValueBit[] = [
  { bit: 0x0001, name: 'repeat', enum: { 0: 'None', 1: 'Normal', 2: 'Pad', 3: 'Reflect' } },
  { bit: 0x0002, name: 'alpha-map', type: 'PICTURE', special: { 0: 'None' } },
  { bit: 0x0004, name: 'alpha-x-origin' },
  { bit: 0x0008, name: 'alpha-y-origin' },
  { bit: 0x0010, name: 'clip-x-origin' },
  { bit: 0x0020, name: 'clip-y-origin' },
  { bit: 0x0040, name: 'clip-mask', type: 'PIXMAP', special: { 0: 'None' } },
  { bit: 0x0080, name: 'graphics-exposure', enum: BOOL },
  { bit: 0x0100, name: 'subwindow-mode', enum: SUBWINDOW_MODE },
  { bit: 0x0200, name: 'poly-edge', enum: { 0: 'Sharp', 1: 'Smooth' } },
  { bit: 0x0400, name: 'poly-mode', enum: { 0: 'Precise', 1: 'Imprecise' } },
  { bit: 0x0800, name: 'dither', type: 'ATOM' },
  { bit: 0x1000, name: 'component-alpha', enum: BOOL },
];

const PICT_OP: Record<number, string> = {
  0: 'Clear',
  1: 'Src',
  2: 'Dst',
  3: 'Over',
  4: 'OverReverse',
  5: 'In',
  6: 'InReverse',
  7: 'Out',
  8: 'OutReverse',
  9: 'Atop',
  10: 'AtopReverse',
  11: 'Xor',
  12: 'Add',
  13: 'Saturate',
};
const op = (n: number) => PICT_OP[n] ?? `op${n}`;
const rgba = (b: Buffer, o: number, e: Order) =>
  `(${r16(b, o, e)},${r16(b, o + 2, e)},${r16(b, o + 4, e)},${r16(b, o + 6, e)})`;
/** A RENDER COLOR (4×u16) → a color Field with a swatch. */
const color = (name: string, b: Buffer, o: number, e: Order) =>
  colorField(name, rgba(b, o, e), renderColorToHex(r16(b, o, e), r16(b, o + 2, e), r16(b, o + 4, e)), o);

export const RENDER: ExtensionSpec = {
  requests: {
    0: {
      name: 'QueryVersion',
      decode: (b, e) => ({
        summary: `client ${r32(b, 4, e)}.${r32(b, 8, e)}`,
        fields: [F('client-major', String(r32(b, 4, e)), 4, 4), F('client-minor', String(r32(b, 8, e)), 8, 4)],
      }),
    },
    1: { name: 'QueryPictFormats' },
    2: { name: 'QueryPictIndexValues' },
    4: {
      name: 'CreatePicture',
      decode: (b, e, ctx) => {
        const pid = r32(b, 4, e);
        const drawable = r32(b, 8, e);
        const format = r32(b, 12, e);
        const fmtName = ctx.pictFormatName?.(format);
        const vlist = decodeValueList(b, 16, e, CP_BITS);
        return {
          summary:
            `pict=${xid(pid)} drawable=${xid(drawable)} format=${fmtName ?? xid(format)}` +
            (vlist.maskStr !== 'none' ? ` {${vlist.maskStr}}` : ''),
          created: { xid: pid, type: 'Picture' },
          fields: [
            F('pid', xid(pid), 4, 4, 'PICTURE'),
            F('drawable', xid(drawable), 8, 4, 'DRAWABLE'),
            F('format', fmtName ? `${xid(format)} (${fmtName})` : xid(format), 12, 4, 'PICTFORMAT'),
            ...vlist.fields,
          ],
        };
      },
    },
    5: {
      name: 'ChangePicture',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        const vlist = decodeValueList(b, 8, e, CP_BITS);
        return {
          summary: `picture=${xid(p)}` + (vlist.maskStr !== 'none' ? ` {${vlist.maskStr}}` : ''),
          fields: [F('picture', xid(p), 4, 4, 'PICTURE'), ...vlist.fields],
        };
      },
    },
    6: {
      name: 'SetPictureClipRectangles',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        return { summary: `picture=${xid(p)}`, fields: [F('picture', xid(p), 4, 4, 'PICTURE')] };
      },
    },
    7: {
      name: 'FreePicture',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        return { summary: `picture=${xid(p)}`, frees: p, fields: [F('picture', xid(p), 4, 4, 'PICTURE')] };
      },
    },
    8: {
      name: 'Composite',
      decode: (b, e) => {
        const o = u8(b, 4);
        const src = r32(b, 8, e);
        const mask = r32(b, 12, e);
        const dst = r32(b, 16, e);
        return {
          summary: `${op(o)} src=${xid(src)} → dst=${xid(dst)}`,
          fields: [
            F('op', op(o), 4, 1),
            F('src', xid(src), 8, 4, 'PICTURE'),
            F('mask', mask ? xid(mask) : 'None', 12, 4, 'PICTURE'),
            F('dst', xid(dst), 16, 4, 'PICTURE'),
            F('src-x', String(s16(b, 20, e)), 20, 2),
            F('src-y', String(s16(b, 22, e)), 22, 2),
            F('mask-x', String(s16(b, 24, e)), 24, 2),
            F('mask-y', String(s16(b, 26, e)), 26, 2),
            F('dst-x', String(s16(b, 28, e)), 28, 2),
            F('dst-y', String(s16(b, 30, e)), 30, 2),
            F('width', String(r16(b, 32, e)), 32, 2),
            F('height', String(r16(b, 34, e)), 34, 2),
          ],
        };
      },
    },
    10: { name: 'Trapezoids' },
    11: { name: 'Triangles' },
    12: { name: 'TriStrip' },
    13: { name: 'TriFan' },
    17: {
      name: 'CreateGlyphSet',
      decode: (b, e, ctx) => {
        const gsid = r32(b, 4, e);
        const format = r32(b, 8, e);
        const fmtName = ctx.pictFormatName?.(format);
        return {
          summary: `glyphset=${xid(gsid)} format=${fmtName ?? xid(format)}`,
          created: { xid: gsid, type: 'GlyphSet' },
          glyphSetFormat: { gsid, format },
          fields: [
            F('gsid', xid(gsid), 4, 4, 'GLYPHSET'),
            F('format', fmtName ? `${xid(format)} (${fmtName})` : xid(format), 8, 4, 'PICTFORMAT'),
          ],
        };
      },
    },
    18: {
      name: 'ReferenceGlyphSet',
      decode: (b, e) => {
        const gsid = r32(b, 4, e);
        const existing = r32(b, 8, e);
        return {
          summary: `glyphset=${xid(gsid)} ← ${xid(existing)}`,
          created: { xid: gsid, type: 'GlyphSet' },
          fields: [F('gsid', xid(gsid), 4, 4, 'GLYPHSET'), F('existing', xid(existing), 8, 4, 'GLYPHSET')],
        };
      },
    },
    19: {
      name: 'FreeGlyphSet',
      decode: (b, e) => {
        const g = r32(b, 4, e);
        return { summary: `glyphset=${xid(g)}`, frees: g, fields: [F('glyphset', xid(g), 4, 4, 'GLYPHSET')] };
      },
    },
    20: {
      name: 'AddGlyphs',
      decode: (b, e, ctx) => {
        const g = r32(b, 4, e);
        const n = r32(b, 8, e);
        // Layout: glyphids (4×n), then GLYPHINFOs (12×n), then the bitmaps —
        // each glyph's rows padded to 4 bytes, in the glyphset's mask format.
        const infoOff = 12 + n * 4;
        const depth = ctx.glyphSetDepth?.(g) ?? 8; // A8 is the common case
        const fields = [
          F('glyphset', xid(g), 4, 4, 'GLYPHSET'),
          F('num-glyphs', String(n), 8, 4),
        ];
        const glyphs: import('../image.js').GlyphSpec[] = [];
        let dataOff = infoOff + n * 12;
        for (let i = 0; i < n; i++) {
          const io = infoOff + i * 12;
          if (io + 12 > b.length) break;
          const w = r16(b, io, e);
          const h = r16(b, io + 2, e);
          const stride = Math.ceil((w * (depth === 32 ? 32 : depth)) / 32) * 4;
          glyphs.push({ width: w, height: h, depth, dataOff });
          if (i < 8) F(`glyph[${i}]`, `${w}×${h}`, io, 12);
          dataOff += stride * h;
        }
        const dataLen = Math.max(0, b.length - (infoOff + n * 12));
        fields.push(F('data', `[Buffer ${dataLen} bytes]`, infoOff + n * 12, dataLen));
        return {
          summary: `glyphset=${xid(g)} glyphs=${n} [Buffer ${dataLen} bytes]`,
          fields,
          glyphs,
        };
      },
    },
    22: {
      name: 'FreeGlyphs',
      decode: (b, e) => {
        const g = r32(b, 4, e);
        return { summary: `glyphset=${xid(g)}`, fields: [F('glyphset', xid(g), 4, 4, 'GLYPHSET')] };
      },
    },
    23: { name: 'CompositeGlyphs8', decode: compositeGlyphs },
    24: { name: 'CompositeGlyphs16', decode: compositeGlyphs },
    25: { name: 'CompositeGlyphs32', decode: compositeGlyphs },
    26: {
      name: 'FillRectangles',
      decode: (b, e) => {
        const o = u8(b, 4);
        const dst = r32(b, 8, e);
        const rects = Math.max(0, (b.length - 20) / 8);
        return {
          summary: `${op(o)} dst=${xid(dst)} rgba=${rgba(b, 12, e)} rects=${rects}`,
          fields: [
            F('op', op(o), 4, 1),
            F('dst', xid(dst), 8, 4, 'PICTURE'),
            color('color', b, 12, e),
            F('num-rects', String(rects), 20, Math.max(0, b.length - 20)),
          ],
        };
      },
    },
    27: {
      name: 'CreateCursor',
      decode: (b, e) => {
        const cid = r32(b, 4, e);
        const src = r32(b, 8, e);
        return {
          summary: `cursor=${xid(cid)} source=${xid(src)} @(${r16(b, 12, e)},${r16(b, 14, e)})`,
          created: { xid: cid, type: 'Cursor' },
          fields: [
            F('cid', xid(cid), 4, 4, 'CURSOR'),
            F('source', xid(src), 8, 4, 'PICTURE'),
            F('x', String(r16(b, 12, e)), 12, 2),
            F('y', String(r16(b, 14, e)), 14, 2),
          ],
        };
      },
    },
    28: {
      name: 'SetPictureTransform',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        return { summary: `picture=${xid(p)}`, fields: [F('picture', xid(p), 4, 4, 'PICTURE')] };
      },
    },
    29: { name: 'QueryFilters' },
    30: {
      name: 'SetPictureFilter',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        return { summary: `picture=${xid(p)}`, fields: [F('picture', xid(p), 4, 4, 'PICTURE')] };
      },
    },
    31: { name: 'CreateAnimCursor' },
    32: { name: 'AddTraps' },
    33: {
      name: 'CreateSolidFill',
      decode: (b, e) => {
        const p = r32(b, 4, e);
        return {
          summary: `picture=${xid(p)} rgba=${rgba(b, 8, e)}`,
          created: { xid: p, type: 'Picture' },
          fields: [F('picture', xid(p), 4, 4, 'PICTURE'), color('color', b, 8, e)],
        };
      },
    },
    34: { name: 'CreateLinearGradient', decode: gradient(24) },
    35: { name: 'CreateRadialGradient', decode: gradient(32) },
    36: { name: 'CreateConicalGradient', decode: gradient(20) },
  },
  replies: {
    0: (b, e) => ({
      summary: `version ${r32(b, 8, e)}.${r32(b, 12, e)}`,
      fields: [F('major-version', String(r32(b, 8, e)), 8, 4), F('minor-version', String(r32(b, 12, e)), 12, 4)],
    }),
  },
  errors: {
    0: 'PictFormat',
    1: 'Picture',
    2: 'PictOp',
    3: 'GlyphSet',
    4: 'Glyph',
  },
};

function compositeGlyphs(b: Buffer, e: Order) {
  const o = u8(b, 4);
  const src = r32(b, 8, e);
  const dst = r32(b, 12, e);
  const glyphset = r32(b, 20, e);
  return {
    summary: `${op(o)} src=${xid(src)} → dst=${xid(dst)} glyphset=${xid(glyphset)}`,
    fields: [
      F('op', op(o), 4, 1),
      F('src', xid(src), 8, 4, 'PICTURE'),
      F('dst', xid(dst), 12, 4, 'PICTURE'),
      F('mask-format', xid(r32(b, 16, e)), 16, 4, 'PICTFORMAT'),
      F('glyphset', xid(glyphset), 20, 4, 'GLYPHSET'),
      F('src-x', String(s16(b, 24, e)), 24, 2),
      F('src-y', String(s16(b, 26, e)), 26, 2),
    ],
  };
}

/**
 * A gradient create request: a picture, a stop count at `numStopsOff`, then
 * `n` FIXED stop positions and `n` COLOR stops. We preview each stop color.
 */
function gradient(numStopsOff: number) {
  return (b: Buffer, e: Order) => {
    const p = r32(b, 4, e);
    const n = r32(b, numStopsOff, e);
    const colorsOff = numStopsOff + 4 + n * 4;
    const fields = [F('picture', xid(p), 4, 4, 'PICTURE'), F('num-stops', String(n), numStopsOff, 4)];
    for (let i = 0; i < Math.min(n, 12); i++) {
      const co = colorsOff + i * 8;
      if (co + 8 <= b.length) fields.push(color(`stop[${i}]`, b, co, e));
    }
    return { summary: `picture=${xid(p)} stops=${n}`, created: { xid: p, type: 'Picture' }, fields };
  };
}
