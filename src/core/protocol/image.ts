/**
 * X11 image decoding — turn PutImage / GetImage / AddGlyphs payloads into RGBA
 * pixels the UI can paint (docs/PRD.md FR-37, decoder-and-state.md §9).
 *
 * Decoding needs three things combined:
 *   - the message: format, depth, width, height, left-pad
 *   - the connection setup: image-byte-order, bitmap-bit-order, scanline-pad,
 *     and the pixmap-format (bits-per-pixel) for that depth
 *   - the visual: red/green/blue masks, to map pixel bits to colour
 *
 * Nothing here is done eagerly: the capture attaches a small *spec* (offsets
 * and the setup facts) to the message, and the UI decodes on demand when a
 * message is selected. A 4 MB PutImage costs nothing until you look at it.
 */

/** The image-relevant half of the connection setup reply. */
export interface DisplayImageInfo {
  /** 0 = LSBFirst, 1 = MSBFirst — governs multi-byte pixel reads. */
  imageByteOrder: number;
  /** 0 = LeastSignificant, 1 = MostSignificant — bit order within a bitmap unit. */
  bitmapBitOrder: number;
  scanlineUnit: number;
  scanlinePad: number;
  /** depth → { bpp, pad } from the setup's pixmap-formats list. */
  formats: Record<number, { bpp: number; pad: number }>;
  /** visual id → colour masks (TrueColor/DirectColor). */
  visuals: Record<number, { redMask: number; greenMask: number; blueMask: number }>;
  rootVisual: number;
  /**
   * Known colormap entries, pixel → 8-bit RGB, harvested from AllocColor /
   * AllocNamedColor / StoreColors. Lets indexed (PseudoColor) images render in
   * their real colours instead of as intensity. Merged across colormaps: a
   * drawable's colormap is rarely knowable from the image request alone, and a
   * pixel value is in practice unambiguous within a session.
   */
  palette?: Record<number, [number, number, number]>;
}

/** Everything needed to decode one image, resolved lazily against the buffer. */
export interface ImageSpec {
  /** 0 = Bitmap, 1 = XYPixmap, 2 = ZPixmap. */
  format: number;
  depth: number;
  width: number;
  height: number;
  leftPad: number;
  /** Byte offset of the pixel data within the message. */
  dataOff: number;
  visualId?: number;
  display: DisplayImageInfo;
}

/** One glyph's bitmap within an AddGlyphs payload. */
export interface GlyphSpec {
  width: number;
  height: number;
  /** Bits per pixel of the glyph's mask format: 1 (A1), 4 (A4), 8 (A8), 32 (ARGB32). */
  depth: number;
  dataOff: number;
}

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const shiftOf = (mask: number): number => {
  if (!mask) return 0;
  let s = 0;
  while (((mask >>> s) & 1) === 0) s++;
  return s;
};
const bitsOf = (mask: number): number => {
  let n = 0;
  let m = mask >>> 0;
  while (m) {
    n += m & 1;
    m >>>= 1;
  }
  return n;
};
/** Round `bits` up to a multiple of `pad`. */
const padTo = (bits: number, pad: number): number => Math.ceil(bits / pad) * pad;

/** Pixels above this are not auto-decoded; the UI offers an explicit render. */
export const AUTO_PREVIEW_PIXEL_CAP = 4_000_000;

/**
 * Decode an image spec to RGBA. Returns undefined for layouts we can't render
 * (e.g. multi-plane XYPixmap), so the UI can say so instead of showing garbage.
 */
export function decodeImage(buf: Buffer, spec: ImageSpec): RGBAImage | undefined {
  const { format, depth, width, height, leftPad, dataOff, display } = spec;
  if (width <= 0 || height <= 0) return undefined;

  const out = new Uint8ClampedArray(width * height * 4);

  // --- Bitmap (0) and single-plane XYPixmap (1): one bit per pixel ---------
  if (format === 0 || (format === 1 && depth === 1)) {
    const strideBits = padTo(width + leftPad, display.scanlinePad);
    const strideBytes = strideBits / 8;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bitIndex = leftPad + x;
        const byteOff = dataOff + y * strideBytes + (bitIndex >> 3);
        if (byteOff >= buf.length) continue;
        const byte = buf[byteOff]!;
        // Bit order within the byte follows bitmap-format-bit-order.
        const bit = display.bitmapBitOrder === 1 ? 7 - (bitIndex & 7) : bitIndex & 7;
        const on = (byte >> bit) & 1;
        const v = on ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    return { width, height, data: out };
  }

  // --- ZPixmap (2): bits-per-pixel from the depth's pixmap-format ----------
  if (format === 2) {
    const fmt = display.formats[depth];
    const bpp = fmt?.bpp ?? (depth <= 8 ? 8 : depth <= 16 ? 16 : 32);
    const pad = fmt?.pad ?? display.scanlinePad;
    const strideBytes = padTo(width * bpp, pad) / 8;

    const visual =
      (spec.visualId != null ? display.visuals[spec.visualId] : undefined) ??
      display.visuals[display.rootVisual];
    // Depth 24/32 without a known visual is overwhelmingly 8-8-8.
    const rMask = visual?.redMask || 0xff0000;
    const gMask = visual?.greenMask || 0x00ff00;
    const bMask = visual?.blueMask || 0x0000ff;
    const rS = shiftOf(rMask), gS = shiftOf(gMask), bS = shiftOf(bMask);
    const rMax = (1 << bitsOf(rMask)) - 1 || 1;
    const gMax = (1 << bitsOf(gMask)) - 1 || 1;
    const bMax = (1 << bitsOf(bMask)) - 1 || 1;
    const msb = display.imageByteOrder === 1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const off = dataOff + y * strideBytes + Math.floor((x * bpp) / 8);
        let px = 0;
        if (bpp === 32) {
          if (off + 4 > buf.length) continue;
          px = msb ? buf.readUInt32BE(off) : buf.readUInt32LE(off);
        } else if (bpp === 24) {
          if (off + 3 > buf.length) continue;
          px = msb
            ? (buf[off]! << 16) | (buf[off + 1]! << 8) | buf[off + 2]!
            : (buf[off + 2]! << 16) | (buf[off + 1]! << 8) | buf[off]!;
        } else if (bpp === 16) {
          if (off + 2 > buf.length) continue;
          px = msb ? buf.readUInt16BE(off) : buf.readUInt16LE(off);
        } else if (bpp === 8) {
          if (off >= buf.length) continue;
          px = buf[off]!;
        } else if (bpp === 4) {
          if (off >= buf.length) continue;
          const hi = x % 2 === (msb ? 0 : 1);
          px = hi ? (buf[off]! >> 4) & 0xf : buf[off]! & 0xf;
        } else if (bpp === 1) {
          if (off >= buf.length) continue;
          const bi = x & 7;
          const bit = display.bitmapBitOrder === 1 ? 7 - bi : bi;
          px = (buf[off]! >> bit) & 1;
        } else continue;

        const o = (y * width + x) * 4;
        const pal = depth <= 8 ? display.palette?.[px] : undefined;
        if (pal) {
          // Indexed colour with a colormap entry we watched being allocated.
          out[o] = pal[0];
          out[o + 1] = pal[1];
          out[o + 2] = pal[2];
        } else if (depth <= 8 && !visual) {
          // No colormap entry — render intensity so structure is still visible.
          const v = depth === 1 ? (px ? 255 : 0) : Math.round((px / ((1 << depth) - 1)) * 255);
          out[o] = v;
          out[o + 1] = v;
          out[o + 2] = v;
        } else {
          out[o] = Math.round((((px & rMask) >>> rS) / rMax) * 255);
          out[o + 1] = Math.round((((px & gMask) >>> gS) / gMax) * 255);
          out[o + 2] = Math.round((((px & bMask) >>> bS) / bMax) * 255);
        }
        out[o + 3] = 255;
      }
    }
    return { width, height, data: out };
  }

  // Multi-plane XYPixmap: planar layout we deliberately don't guess at.
  return undefined;
}

/** A cursor's parts, resolved to the messages that uploaded their bitmaps. */
export interface CursorSpec {
  /** Message id of the PutImage that filled the source pixmap, if seen. */
  sourceImageId?: number;
  /** Message id of the PutImage that filled the mask pixmap, if seen. */
  maskImageId?: number;
  /** Foreground / background as 8-bit RGB. */
  fore: [number, number, number];
  back: [number, number, number];
  hotX: number;
  hotY: number;
}

/**
 * Compose a cursor image: source bits choose foreground vs background, mask
 * bits decide which pixels are drawn at all. Either part may be missing (we may
 * not have watched the pixmap being filled), in which case the cursor is shown
 * with whatever is available.
 */
export function composeCursor(
  source: RGBAImage | undefined,
  mask: RGBAImage | undefined,
  spec: CursorSpec,
): RGBAImage | undefined {
  const base = source ?? mask;
  if (!base) return undefined;
  const { width, height } = base;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    // Both parts are depth-1 bitmaps, decoded to white(255)/black(0).
    const bit = source ? source.data[o]! > 127 : true;
    const inMask = mask && i * 4 < mask.data.length ? mask.data[o]! > 127 : true;
    const rgb = bit ? spec.fore : spec.back;
    out[o] = rgb[0];
    out[o + 1] = rgb[1];
    out[o + 2] = rgb[2];
    out[o + 3] = inMask ? 255 : 0;
  }
  return { width, height, data: out };
}

/**
 * Decode one RENDER glyph to RGBA. Glyph masks are alpha coverage (A1/A4/A8)
 * or full ARGB32; rows are padded to 4 bytes. Coverage is rendered as white
 * ink on transparency, which is how it will actually be composited.
 */
export function decodeGlyph(buf: Buffer, g: GlyphSpec): RGBAImage | undefined {
  const { width, height, depth, dataOff } = g;
  if (width <= 0 || height <= 0) return undefined;
  const strideBytes = padTo(width * (depth === 32 ? 32 : depth), 32) / 8;
  const out = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let a = 0;
      let r = 255, gg = 255, b = 255;
      if (depth === 32) {
        const off = dataOff + y * strideBytes + x * 4;
        if (off + 4 > buf.length) continue;
        b = buf[off]!;
        gg = buf[off + 1]!;
        r = buf[off + 2]!;
        a = buf[off + 3]!;
      } else if (depth === 8) {
        const off = dataOff + y * strideBytes + x;
        if (off >= buf.length) continue;
        a = buf[off]!;
      } else if (depth === 4) {
        const off = dataOff + y * strideBytes + (x >> 1);
        if (off >= buf.length) continue;
        a = ((x & 1 ? buf[off]! & 0xf : (buf[off]! >> 4) & 0xf) * 255) / 15;
      } else {
        const off = dataOff + y * strideBytes + (x >> 3);
        if (off >= buf.length) continue;
        a = ((buf[off]! >> (x & 7)) & 1) ? 255 : 0;
      }
      out[o] = r;
      out[o + 1] = gg;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}
