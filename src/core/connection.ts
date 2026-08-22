/**
 * Per-connection X11 framing + state engine.
 *
 * Splits each direction's byte stream into discrete messages (setup handshake,
 * then requests / replies+events+errors), latches byte order, assigns and
 * reconstructs sequence numbers, links replies/errors back to their requests,
 * and tracks just enough extension/atom state to name things well.
 *
 * Framing never depends on decode success: message boundaries come only from
 * length fields, so a decode failure degrades one row, never the stream.
 * See docs/decoder-and-state.md §3–§6.
 */

import type { CapturedMessage, Category, Direction, Field } from './protocol/types.js';
import { RESOURCE_TYPES } from './protocol/types.js';
import {
  CORE_ERRORS,
  CORE_EVENTS,
  CORE_REQUESTS,
  CORE_RESOURCE_CREATORS,
  CORE_RESOURCE_FREERS,
  PREDEFINED_ATOMS,
} from './protocol/tables.js';
import { decodeReply } from './protocol/replies.js';
import { EXTENSIONS } from './protocol/extensions/index.js';
import type { CursorSpec, DisplayImageInfo, GlyphSpec } from './protocol/image.js';
import { decodeValueList } from './protocol/valuelist.js';
import { decodeGenerated, generatedCore, generatedForExtension } from './protocol/generic.js';
import { CW_BITS, GC_BITS, WINDOW_CLASS } from './protocol/enums.js';
import { xid } from './util/hex.js';

type Order = 'LE' | 'BE';

interface PendingReq {
  id: number;
  mono: number;
  code: number;
  minor: number;
  name: string;
  /** The request's bytes — a reply sometimes needs its request's arguments
   *  (GetImage returns pixels but only the request knows their geometry). */
  bytes: Buffer;
}

interface ResourceRec {
  type: string;
  creatorId: number;
  summary: string;
}

const XID_RE = /^0x[0-9a-f]+$/i;

/**
 * Fold generated fields into a hand-written decode.
 *
 * Hand-written decoders are richer where they exist (atom names, expanded
 * value-lists, colour swatches) but many only build a summary and never name
 * their parameters. The generated layout knows every fixed field, so anything
 * the hand-written pass did not name is filled in from it and the whole list is
 * shown in wire order.
 */
function mergeFields(into: Field[], generated: Field[]): void {
  const have = new Set(into.map((f) => f.name));
  for (const g of generated) if (!have.has(g.name)) into.push(g);
  into.sort((a, b) => a.span.off - b.span.off || a.span.len - b.span.len);
}
const IMAGE_FORMAT: Record<number, string> = { 0: 'Bitmap', 1: 'XYPixmap', 2: 'ZPixmap' };

export interface CaptureSink {
  nextId(): number;
  onMessage(msg: CapturedMessage): void;
  /** Link a reply/error back to its request and record RTT. */
  onLink(requestId: number, replyId: number, rttMs: number): void;
}

const pad4 = (n: number) => (n + 3) & ~3;
const r16 = (b: Buffer, o: number, order: Order) =>
  order === 'LE' ? b.readUInt16LE(o) : b.readUInt16BE(o);
const r32 = (b: Buffer, o: number, order: Order) =>
  order === 'LE' ? b.readUInt32LE(o) : b.readUInt32BE(o);
const s16 = (b: Buffer, o: number, order: Order) =>
  order === 'LE' ? b.readInt16LE(o) : b.readInt16BE(o);

const RETAIN_SEQ = 8192;

export class ConnectionCapture {
  private c2s: Buffer = Buffer.alloc(0);
  private s2c: Buffer = Buffer.alloc(0);
  private order: Order | undefined;
  private c2sPhase: 'setup' | 'body' = 'setup';
  private s2cPhase: 'setup' | 'body' = 'setup';
  private seqCounter = 0;

  private recent = new Map<number, PendingReq>();
  private pendingQueryExt = new Map<number, string>();
  private extByMajor = new Map<
    number,
    { name: string; firstEvent: number; firstError: number }
  >();
  private pendingInternAtom = new Map<number, string>();
  private atoms = new Map<number, string>();
  /** XID → the resource it names and the message that created it. */
  private resources = new Map<number, ResourceRec>();
  /** RENDER PICTFORMAT id → human-readable description (from QueryPictFormats). */
  private pictFormats = new Map<number, string>();
  /** RENDER PICTFORMAT id → its depth, for decoding glyph masks. */
  private pictFormatDepth = new Map<number, number>();
  /** RENDER GLYPHSET id → the depth of its mask format. */
  private glyphSetDepth = new Map<number, number>();
  /** drawable → id of the most recent PutImage that filled it, for previews. */
  private lastImageFor = new Map<number, number>();
  /** Image-relevant setup facts, needed to decode PutImage/GetImage payloads. */
  private display: DisplayImageInfo = {
    imageByteOrder: 0,
    bitmapBitOrder: 0,
    scanlineUnit: 32,
    scanlinePad: 32,
    formats: {},
    visuals: {},
    rootVisual: 0,
  };

  /**
   * `clock` lets a replayed capture supply its recorded timestamps, so loading
   * a `.x11cap` reproduces the original timing (and therefore RTTs) instead of
   * stamping everything at load time.
   */
  constructor(
    public readonly connId: number,
    private readonly sink: CaptureSink,
    private readonly clock: { mono: () => number; wall: () => number } = {
      mono: () => performance.now(),
      wall: () => Date.now(),
    },
  ) {}

  feed(dir: Direction, chunk: Buffer): void {
    if (dir === 'c2s') {
      this.c2s = this.c2s.length ? Buffer.concat([this.c2s, chunk]) : chunk;
      this.drainC2S();
    } else {
      this.s2c = this.s2c.length ? Buffer.concat([this.s2c, chunk]) : chunk;
      this.drainS2C();
    }
  }

  // ---- client → server ----------------------------------------------------

  private drainC2S(): void {
    for (;;) {
      const buf = this.c2s;
      if (this.c2sPhase === 'setup') {
        if (buf.length < 12) return;
        const b0 = buf[0]!;
        if (b0 !== 0x42 && b0 !== 0x6c) {
          // Not a valid setup byte-order; can't frame. Drop to avoid a spin.
          this.c2s = Buffer.alloc(0);
          return;
        }
        this.order = b0 === 0x42 ? 'BE' : 'LE';
        const n = r16(buf, 6, this.order);
        const d = r16(buf, 8, this.order);
        const total = 12 + pad4(n) + pad4(d);
        if (buf.length < total) return;
        this.emitSimple('c2s', 'setup-request', buf.subarray(0, total), 'ConnectionSetup', {
          summary: `byteOrder=${this.order === 'BE' ? 'MSB' : 'LSB'}`,
        });
        this.c2s = buf.subarray(total);
        this.c2sPhase = 'body';
        continue;
      }

      // body phase — a request
      if (buf.length < 4) return;
      const order = this.order ?? 'LE';
      let total = r16(buf, 2, order) * 4;
      if (total === 0) {
        // BIG-REQUESTS extended length
        if (buf.length < 8) return;
        total = r32(buf, 4, order) * 4;
      }
      if (total < 4 || total > 0x4000_0000) {
        // implausible; resync by dropping a word to avoid infinite loop
        this.c2s = buf.subarray(4);
        continue;
      }
      if (buf.length < total) return;
      const msgBuf = buf.subarray(0, total);
      this.emitRequest(msgBuf, order);
      this.c2s = buf.subarray(total);
    }
  }

  private emitRequest(buf: Buffer, order: Order): void {
    const code = buf[0]!;
    const minor = buf[1]!;
    this.seqCounter += 1;
    const seq = this.seqCounter;

    const dec = this.decodeRequest(code, minor, buf, order);
    const msg: CapturedMessage = {
      id: this.sink.nextId(),
      connId: this.connId,
      dir: 'c2s',
      category: 'request',
      ts: this.clock.wall(),
      mono: this.clock.mono(),
      bytes: Buffer.from(buf),
      code,
      minor: code >= 128 ? minor : undefined,
      seq,
      name: dec.name,
      ext: dec.ext,
      summary: dec.summary,
      fields: dec.fields,
      image: dec.image,
      glyphs: dec.glyphs,
      creates: dec.created,
      frees: dec.frees,
      cursor: dec.cursor,
      expectsReply: dec.expectsReply,
    };

    // Remember which message last filled each drawable, so a cursor (whose
    // bitmaps live in pixmaps, not in its own request) can be previewed.
    if (dec.image && code === 72) this.lastImageFor.set(r32(buf, 4, order), msg.id);

    // Record a resource this request creates (core or extension) before
    // linking, so later references resolve back here (docs §6).
    if (dec.created) {
      this.resources.set(dec.created.xid, {
        type: dec.created.type,
        creatorId: msg.id,
        summary: dec.summary || dec.name,
      });
    }
    this.linkRefs(msg.fields, msg.id);

    // stateful tracking keyed by this request's seq
    if (code === 98) this.pendingQueryExt.set(seq, dec.extNameArg ?? '');
    if (code === 16) this.pendingInternAtom.set(seq, dec.atomNameArg ?? '');

    this.recent.set(seq, {
      id: msg.id, mono: msg.mono, code, minor: code >= 128 ? minor : 0, name: dec.name, bytes: msg.bytes,
    });
    if (this.recent.size > RETAIN_SEQ) {
      const oldest = this.recent.keys().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }

    this.sink.onMessage(msg);
  }

  // ---- server → client ----------------------------------------------------

  private drainS2C(): void {
    for (;;) {
      const buf = this.s2c;
      if (this.s2cPhase === 'setup') {
        if (buf.length < 8) return;
        const order = this.order ?? 'LE';
        const total = 8 + r16(buf, 6, order) * 4;
        if (buf.length < total) return;
        const status = buf[0]!;
        const name =
          status === 1
            ? 'ConnectionSetupReply'
            : status === 0
              ? 'ConnectionSetupFailed'
              : 'ConnectionSetupAuthenticate';
        const setupMsg = this.emitSimple('s2c', 'setup-reply', buf.subarray(0, total), name, {
          summary: this.describeSetupReply(buf.subarray(0, total), order),
        });
        if (status === 1) this.seedSetupResources(buf.subarray(0, total), order, setupMsg.id);
        this.s2c = buf.subarray(total);
        this.s2cPhase = 'body';
        continue;
      }

      if (buf.length < 32) return; // every reply/event/error is >= 32 bytes
      const order = this.order ?? 'LE';
      const code = buf[0]!;
      let total = 32;
      if (code === 1 || code === 35) {
        total = 32 + r32(buf, 4, order) * 4;
      }
      if (buf.length < total) return;
      const msgBuf = buf.subarray(0, total);
      this.emitReplyEventError(code, msgBuf, order);
      this.s2c = buf.subarray(total);
    }
  }

  private emitReplyEventError(code: number, buf: Buffer, order: Order): void {
    let category: Category;
    let name: string;
    let ext: string | undefined;
    let eventSummary = '';
    const fields: Field[] = [{ name: 'code', value: String(code), span: { off: 0, len: 1 } }];

    if (code === 0) {
      category = 'error';
      const errCode = buf[1]!;
      const extErr = errCode >= 128 ? this.extErrorOwner(errCode) : undefined;
      if (extErr) {
        const en = EXTENSIONS[extErr.name]?.errors?.[errCode - extErr.firstError];
        name = `${extErr.name}:${en ?? `error${errCode - extErr.firstError}`}Error`;
      } else {
        name = (CORE_ERRORS[errCode] ?? `Error(${errCode})`) + 'Error';
      }
      fields.push(
        { name: 'error-code', value: String(errCode), span: { off: 1, len: 1 } },
        { name: 'sequence', value: String(r16(buf, 2, order)), span: { off: 2, len: 2 } },
        { name: 'bad-value', value: xid(r32(buf, 4, order)), span: { off: 4, len: 4 } },
        { name: 'minor-opcode', value: String(r16(buf, 8, order)), span: { off: 8, len: 2 } },
        { name: 'major-opcode', value: String(buf[10]!), span: { off: 10, len: 1 } },
      );
    } else if (code === 1) {
      category = 'reply';
      name = 'Reply';
      fields.push(
        { name: 'sequence', value: String(r16(buf, 2, order)), span: { off: 2, len: 2 } },
        { name: 'length', value: String(r32(buf, 4, order)), span: { off: 4, len: 4 } },
      );
    } else {
      category = 'event';
      const evCode = code & 0x7f;
      const fromSend = (code & 0x80) !== 0;
      const ctx = { atomName: (a: number) => this.atomName(a) };
      if (evCode === 35) {
        // Generic event (XGE): byte 1 = extension major, bytes 8-9 = evtype.
        const extMajor = buf[1]!;
        const evtype = r16(buf, 8, order);
        const known = this.extByMajor.get(extMajor);
        const evDef = known ? EXTENSIONS[known.name]?.xgeEvents?.[evtype] : undefined;
        name = known
          ? `${known.name}:${evDef?.name ?? `GenericEvent(${evtype})`}`
          : `ext${extMajor}:GenericEvent(${evtype})`;
        ext = known?.name;
        fields.push({ name: 'extension', value: `${extMajor}${known ? ` (${known.name})` : ''}`, span: { off: 1, len: 1 } });
        if (evDef?.decode) {
          try {
            const d = evDef.decode(buf, order, ctx);
            eventSummary = d.summary;
            fields.push(...d.fields);
          } catch {
            /* ignore */
          }
        } else if (known) {
          const gen = generatedForExtension(known.name);
          const gm = gen?.events?.[evtype];
          if (gm) {
            name = `${known.name}:${gm.name}`;
            try {
              const g = decodeGenerated(gm, buf, order, gen, (a) => this.atomName(a));
              eventSummary = g.summary;
              fields.push(...g.fields);
            } catch {
              /* ignore */
            }
          }
        }
      } else if (evCode >= 2 && evCode <= 34) {
        name = CORE_EVENTS[evCode] ?? `Event(${evCode})`;
      } else {
        const owner = this.extEventOwner(evCode);
        const evDef = owner ? EXTENSIONS[owner.name]?.events?.[evCode - owner.firstEvent] : undefined;
        name = owner
          ? `${owner.name}:${evDef?.name ?? `event${evCode - owner.firstEvent}`}`
          : `Event(${evCode})`;
        ext = owner?.name;
        if (evDef?.decode) {
          try {
            const d = evDef.decode(buf, order, ctx);
            eventSummary = d.summary;
            fields.push(...d.fields);
          } catch {
            /* ignore */
          }
        }
      }
      if (fromSend) name += ' (SendEvent)';
      // KeymapNotify (11) has no sequence field.
      if (evCode !== 11) {
        fields.push({ name: 'sequence', value: String(r16(buf, 2, order)), span: { off: 2, len: 2 } });
      }
    }

    const msg: CapturedMessage = {
      id: this.sink.nextId(),
      connId: this.connId,
      dir: 's2c',
      category,
      ts: this.clock.wall(),
      mono: this.clock.mono(),
      bytes: Buffer.from(buf),
      code,
      name,
      ext,
      summary: eventSummary,
      fields,
    };

    // Link window/resource references carried by events (XI2 root/event/child).
    if (category === 'event') this.linkRefs(msg.fields, msg.id);

    if (category === 'reply' || category === 'error') {
      const req = this.link(r16(buf, 2, order), msg);
      // A reply carries no opcode of its own — decode its body using the
      // opcode of the request it answers (docs/decoder-and-state.md §4).
      if (category === 'reply' && req) {
        try {
          if (req.code >= 128) {
            const known = this.extByMajor.get(req.code);
            const spec = known ? EXTENSIONS[known.name] : undefined;
            // RENDER QueryPictFormats: harvest the format table for later naming.
            if (known?.name === 'RENDER' && req.minor === 1) this.parsePictFormats(buf, order);
            const rdef = spec?.replies?.[req.minor];
            if (rdef) {
              const d = rdef(buf, order, this.decodeCtx());
              msg.fields = [...fields, ...d.fields];
              msg.summary = d.summary;
            }
          } else {
            const dec = decodeReply(req.code, buf, order, this.decodeCtx());
            if (dec) {
              msg.fields = [...fields, ...dec.fields];
              msg.summary = dec.summary;
            }
            // Colormap entries: the reply carries the pixel, the request the
            // colormap. Together they let indexed images render in real colour.
            if (req.code === 84 || req.code === 85) {
              const pixOff = req.code === 84 ? 16 : 8;
              const rgbOff = req.code === 84 ? 8 : 12;
              const pixel = r32(buf, pixOff, order);
              this.display.palette ??= {};
              this.display.palette[pixel] = [
                r16(buf, rgbOff, order) >> 8,
                r16(buf, rgbOff + 2, order) >> 8,
                r16(buf, rgbOff + 4, order) >> 8,
              ];
            }
            // GetImage returns raw pixels; only its request knows the geometry.
            if (req.code === 73) {
              const w = r16(req.bytes, 12, order);
              const h = r16(req.bytes, 14, order);
              msg.image = {
                format: req.bytes[1]!,
                depth: buf[1]!,
                width: w,
                height: h,
                leftPad: 0,
                dataOff: 32,
                visualId: r32(buf, 8, order),
                display: this.display,
              };
              msg.summary = `${w}×${h} depth=${buf[1]} ${IMAGE_FORMAT[req.bytes[1]!] ?? ''} ${msg.summary}`.trim();
            }
          }
          this.linkRefs(msg.fields, msg.id);
        } catch {
          msg.undecoded = true;
        }
      }
      // May refine the summary further using names only the request knew.
      this.postProcessReply(code, buf, order, msg);
    }

    this.sink.onMessage(msg);
  }

  /**
   * Widen a 16-bit wire sequence to our 32-bit counter and link to the request.
   * Returns the originating request, which is what tells a reply how to decode
   * its own body.
   */
  private link(seq16: number, replyMsg: CapturedMessage): PendingReq | undefined {
    const base = this.seqCounter & ~0xffff;
    let full = base | seq16;
    if (full > this.seqCounter) full -= 0x10000;
    replyMsg.seq = full;
    const req = this.recent.get(full);
    if (!req) return undefined;
    this.recent.delete(full);
    replyMsg.requestId = req.id;
    const rtt = replyMsg.mono - req.mono;
    replyMsg.rttMs = rtt;
    // Improve the reply/error name using the request it answers.
    if (replyMsg.category === 'reply') replyMsg.name = `${req.name}·reply`;
    else replyMsg.summary = `for ${req.name} (#${req.id})`;
    this.sink.onLink(req.id, replyMsg.id, rtt);
    return req;
  }

  /** Extract extension/atom facts carried by replies. */
  private postProcessReply(code: number, buf: Buffer, order: Order, msg: CapturedMessage): void {
    if (code !== 1 || msg.seq === undefined) return;
    const seq = msg.seq;

    const extName = this.pendingQueryExt.get(seq);
    if (extName !== undefined) {
      this.pendingQueryExt.delete(seq);
      const present = buf[8] === 1;
      const major = buf[9]!;
      const firstEvent = buf[10]!;
      const firstError = buf[11]!;
      if (present && major >= 128) {
        this.extByMajor.set(major, { name: extName, firstEvent, firstError });
      }
      msg.summary = present
        ? `${extName}: major=${major} firstEvent=${firstEvent} firstError=${firstError}`
        : `${extName}: not present`;
    }

    const atomName = this.pendingInternAtom.get(seq);
    if (atomName !== undefined) {
      this.pendingInternAtom.delete(seq);
      const atom = r32(buf, 8, order);
      if (atom) this.atoms.set(atom, atomName);
      msg.summary = `${atomName} → ${atom}`;
    }
  }

  private extEventOwner(code: number) {
    let best: { name: string; firstEvent: number; firstError: number } | undefined;
    for (const info of this.extByMajor.values()) {
      if (info.firstEvent && code >= info.firstEvent) {
        if (!best || info.firstEvent > best.firstEvent) best = info;
      }
    }
    return best;
  }

  private extErrorOwner(code: number) {
    let best: { name: string; firstEvent: number; firstError: number } | undefined;
    for (const info of this.extByMajor.values()) {
      if (info.firstError && code >= info.firstError) {
        if (!best || info.firstError > best.firstError) best = info;
      }
    }
    return best;
  }

  private atomName(atom: number): string {
    return this.atoms.get(atom) ?? PREDEFINED_ATOMS[atom] ?? String(atom);
  }

  /** Shared decode context handed to request/reply decoders. */
  private decodeCtx() {
    return {
      atomName: (a: number) => this.atomName(a),
      pictFormatName: (id: number) => this.pictFormats.get(id),
      glyphSetDepth: (gsid: number) => this.glyphSetDepth.get(gsid),
    };
  }

  /** Parse a RENDER QueryPictFormats reply into id → "Direct depth24 R8G8B8". */
  private parsePictFormats(buf: Buffer, order: Order): void {
    try {
      const n = r32(buf, 8, order);
      const pop = (m: number) => {
        let c = 0;
        while (m) {
          c += m & 1;
          m >>>= 1;
        }
        return c;
      };
      let off = 32;
      for (let i = 0; i < n && off + 28 <= buf.length; i++) {
        const id = r32(buf, off, order);
        const type = buf[off + 4]!; // 0=Indexed, 1=Direct
        const depth = buf[off + 5]!;
        const rm = r16(buf, off + 10, order);
        const gm = r16(buf, off + 14, order);
        const bm = r16(buf, off + 18, order);
        const am = r16(buf, off + 22, order);
        const desc =
          type === 1
            ? `Direct depth${depth} ${am ? `A${pop(am)}` : ''}R${pop(rm)}G${pop(gm)}B${pop(bm)}`
            : `Indexed depth${depth}`;
        this.pictFormats.set(id, desc);
        this.pictFormatDepth.set(id, depth);
        off += 28;
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Point each resource-typed field at the message that created its XID, so the
   * UI can jump from a reference to its creator. Skips the creating message's
   * own destination field (no self-links).
   */
  private linkRefs(fields: Field[] | undefined, selfId: number): void {
    if (!fields) return;
    for (const f of fields) {
      if (!f.type || !RESOURCE_TYPES.has(f.type) || !XID_RE.test(f.value)) continue;
      const rec = this.resources.get(parseInt(f.value, 16));
      if (rec && rec.creatorId !== selfId) f.ref = rec.creatorId;
    }
  }

  // ---- decode helpers -----------------------------------------------------

  private decodeRequest(
    code: number,
    minor: number,
    buf: Buffer,
    order: Order,
  ): {
    name: string;
    ext?: string;
    summary: string;
    fields: Field[];
    extNameArg?: string;
    atomNameArg?: string;
    created?: { xid: number; type: string };
    frees?: number;
    image?: import('./protocol/image.js').ImageSpec;
    glyphs?: GlyphSpec[];
    cursor?: CursorSpec;
    expectsReply?: boolean;
  } {
    // Extension requests dispatch through the extension registry (major → name
    // → spec, then minor opcode). See protocol/extensions/.
    if (code >= 128) {
      const known = this.extByMajor.get(code);
      const spec = known ? EXTENSIONS[known.name] : undefined;
      const def = spec?.requests?.[minor];
      // Anything the hand-written spec misses falls back to the generated
      // xcbproto tables, so an extension request is never just `req4`.
      const gen = known ? generatedForExtension(known.name) : undefined;
      const genMsg = gen?.requests?.[minor];
      const name = known
        ? `${known.name}:${def?.name ?? genMsg?.name ?? `req${minor}`}`
        : `ext${code}:req${minor}`;
      const fields: Field[] = [
        { name: 'opcode', value: `${code} (${name})`, span: { off: 0, len: 1 } },
        { name: 'minor-opcode', value: String(minor), span: { off: 1, len: 1 } },
        { name: 'length', value: String(r16(buf, 2, order) * 4 || buf.length), span: { off: 2, len: 2 } },
      ];
      let summary = '';
      let created: { xid: number; type: string } | undefined;
      let glyphs: GlyphSpec[] | undefined;
      let frees: number | undefined;
      if (def?.decode) {
        try {
          const d = def.decode(buf, order, this.decodeCtx());
          summary = d.summary;
          fields.push(...d.fields);
          created = d.created;
          glyphs = d.glyphs;
          frees = d.frees;
          // Remember a glyphset's mask depth so its AddGlyphs can be decoded.
          if (d.glyphSetFormat) {
            const depth = this.pictFormatDepth.get(d.glyphSetFormat.format);
            if (depth !== undefined) this.glyphSetDepth.set(d.glyphSetFormat.gsid, depth);
          }
        } catch {
          /* framing already succeeded; leave the row minimally decoded */
        }
      }
      if (genMsg) {
        try {
          const g = decodeGenerated(genMsg, buf, order, gen, (a) => this.atomName(a));
          mergeFields(fields, g.fields);
          if (!summary) summary = g.summary;
        } catch {
          /* ignore */
        }
      }
      return { name, ext: known?.name, summary, fields, created, glyphs, frees, expectsReply: !!genMsg?.reply };
    }

    const name = CORE_REQUESTS[code] ?? `UnknownRequest(${code})`;
    const ext: string | undefined = undefined;
    const fields: Field[] = [
      { name: 'opcode', value: `${code} (${name})`, span: { off: 0, len: 1 } },
      { name: 'length', value: String(r16(buf, 2, order) * 4 || buf.length), span: { off: 2, len: 2 } },
    ];

    let summary = '';
    let extNameArg: string | undefined;
    let atomNameArg: string | undefined;
    let image: import('./protocol/image.js').ImageSpec | undefined;
    let cursor: CursorSpec | undefined;

    const readString = (lenOff: number, strOff: number): string => {
      const len = r16(buf, lenOff, order);
      const end = Math.min(strOff + len, buf.length);
      return buf.subarray(strOff, end).toString('latin1');
    };

    switch (code) {
      case 1: {
        // CreateWindow
        const wid = r32(buf, 4, order);
        const parent = r32(buf, 8, order);
        const x = s16(buf, 12, order);
        const y = s16(buf, 14, order);
        const w = r16(buf, 16, order);
        const h = r16(buf, 18, order);
        const cls = r16(buf, 22, order);
        const vlist = decodeValueList(buf, 28, order, CW_BITS);
        summary =
          `wid=${xid(wid)} parent=${xid(parent)} ${w}×${h}+${x}+${y}` +
          (vlist.maskStr !== 'none' ? ` {${vlist.maskStr}}` : '');
        fields.push({ name: 'wid', value: xid(wid), span: { off: 4, len: 4 }, type: 'WINDOW' });
        fields.push({ name: 'parent', value: xid(parent), span: { off: 8, len: 4 }, type: 'WINDOW' });
        fields.push({ name: 'class', value: WINDOW_CLASS[cls] ?? String(cls), span: { off: 22, len: 2 } });
        fields.push(...vlist.fields);
        break;
      }
      case 2: {
        // ChangeWindowAttributes
        const win = r32(buf, 4, order);
        const vlist = decodeValueList(buf, 8, order, CW_BITS);
        summary = `window=${xid(win)} {${vlist.maskStr}}`;
        fields.push({ name: 'window', value: xid(win), span: { off: 4, len: 4 }, type: 'WINDOW' });
        fields.push(...vlist.fields);
        break;
      }
      case 8:
      case 4:
      case 10: {
        // Map/Destroy/UnmapWindow
        const win = r32(buf, 4, order);
        summary = `window=${xid(win)}`;
        fields.push({ name: 'window', value: xid(win), span: { off: 4, len: 4 }, type: 'WINDOW' });
        break;
      }
      case 16: {
        // InternAtom
        atomNameArg = readString(4, 8);
        summary = `"${atomNameArg}"${buf[1] ? ' (only-if-exists)' : ''}`;
        break;
      }
      case 98: {
        // QueryExtension
        extNameArg = readString(4, 8);
        summary = `"${extNameArg}"`;
        break;
      }
      case 18: {
        // ChangeProperty
        const win = r32(buf, 4, order);
        const prop = r32(buf, 8, order);
        const type = r32(buf, 12, order);
        summary = `window=${xid(win)} ${this.atomName(prop)}: ${this.atomName(type)}`;
        fields.push({ name: 'window', value: xid(win), span: { off: 4, len: 4 }, type: 'WINDOW' });
        break;
      }
      case 20: {
        // GetProperty
        const win = r32(buf, 4, order);
        const prop = r32(buf, 8, order);
        summary = `window=${xid(win)} ${this.atomName(prop)}`;
        break;
      }
      case 53: {
        // CreatePixmap
        const depth = buf[1]!;
        const pid = r32(buf, 4, order);
        const drawable = r32(buf, 8, order);
        const w = r16(buf, 12, order);
        const h = r16(buf, 14, order);
        summary = `pid=${xid(pid)} ${w}×${h} depth=${depth}`;
        fields.push({ name: 'pid', value: xid(pid), span: { off: 4, len: 4 }, type: 'PIXMAP' });
        fields.push({ name: 'drawable', value: xid(drawable), span: { off: 8, len: 4 }, type: 'DRAWABLE' });
        break;
      }
      case 55: {
        // CreateGC
        const cid = r32(buf, 4, order);
        const drawable = r32(buf, 8, order);
        const vlist = decodeValueList(buf, 12, order, GC_BITS);
        summary =
          `cid=${xid(cid)} drawable=${xid(drawable)}` +
          (vlist.maskStr !== 'none' ? ` {${vlist.maskStr}}` : '');
        fields.push({ name: 'cid', value: xid(cid), span: { off: 4, len: 4 }, type: 'GCONTEXT' });
        fields.push({ name: 'drawable', value: xid(drawable), span: { off: 8, len: 4 }, type: 'DRAWABLE' });
        fields.push(...vlist.fields);
        break;
      }
      case 56: {
        // ChangeGC
        const gc = r32(buf, 4, order);
        const vlist = decodeValueList(buf, 8, order, GC_BITS);
        summary = `gc=${xid(gc)} {${vlist.maskStr}}`;
        fields.push({ name: 'gc', value: xid(gc), span: { off: 4, len: 4 }, type: 'GCONTEXT' });
        fields.push(...vlist.fields);
        break;
      }
      case 93: {
        // CreateCursor — the bitmaps live in the source/mask pixmaps, so the
        // preview is resolved through whatever PutImage last filled them.
        const cid = r32(buf, 4, order);
        const src = r32(buf, 8, order);
        const msk = r32(buf, 12, order);
        const c8 = (v: number) => v >> 8;
        cursor = {
          sourceImageId: this.lastImageFor.get(src),
          maskImageId: this.lastImageFor.get(msk),
          fore: [c8(r16(buf, 16, order)), c8(r16(buf, 18, order)), c8(r16(buf, 20, order))],
          back: [c8(r16(buf, 22, order)), c8(r16(buf, 24, order)), c8(r16(buf, 26, order))],
          hotX: r16(buf, 28, order),
          hotY: r16(buf, 30, order),
        };
        summary = `cursor=${xid(cid)} source=${xid(src)} mask=${msk ? xid(msk) : 'None'} hot=(${cursor.hotX},${cursor.hotY})`;
        fields.push(
          { name: 'cid', value: xid(cid), span: { off: 4, len: 4 }, type: 'CURSOR' },
          { name: 'source', value: xid(src), span: { off: 8, len: 4 }, type: 'PIXMAP' },
          { name: 'mask', value: msk ? xid(msk) : 'None', span: { off: 12, len: 4 }, type: 'PIXMAP' },
          { name: 'fore', value: `rgb(${cursor.fore.join(',')})`, span: { off: 16, len: 6 }, color: `#${cursor.fore.map((v) => v.toString(16).padStart(2, '0')).join('')}` },
          { name: 'back', value: `rgb(${cursor.back.join(',')})`, span: { off: 22, len: 6 }, color: `#${cursor.back.map((v) => v.toString(16).padStart(2, '0')).join('')}` },
        );
        break;
      }
      case 72: {
        // PutImage — the payload is raw pixels; attach a spec for lazy preview.
        const fmt = buf[1]!;
        const drawable = r32(buf, 4, order);
        const gc = r32(buf, 8, order);
        const w = r16(buf, 12, order);
        const h = r16(buf, 14, order);
        const dstX = s16(buf, 16, order);
        const dstY = s16(buf, 18, order);
        const leftPad = buf[20]!;
        const depth = buf[21]!;
        const dataLen = Math.max(0, buf.length - 24);
        const fmtName = IMAGE_FORMAT[fmt] ?? String(fmt);
        summary = `drawable=${xid(drawable)} ${w}×${h}+${dstX}+${dstY} depth=${depth} ${fmtName} [${dataLen} bytes]`;
        fields.push(
          { name: 'format', value: fmtName, span: { off: 1, len: 1 } },
          { name: 'drawable', value: xid(drawable), span: { off: 4, len: 4 }, type: 'DRAWABLE' },
          { name: 'gc', value: xid(gc), span: { off: 8, len: 4 }, type: 'GCONTEXT' },
          { name: 'width', value: String(w), span: { off: 12, len: 2 } },
          { name: 'height', value: String(h), span: { off: 14, len: 2 } },
          { name: 'depth', value: String(depth), span: { off: 21, len: 1 } },
          { name: 'data', value: `[Buffer ${dataLen} bytes]`, span: { off: 24, len: dataLen } },
        );
        image = { format: fmt, depth, width: w, height: h, leftPad, dataOff: 24, display: this.display };
        break;
      }
      case 70: {
        // PolyFillRectangle
        const drawable = r32(buf, 4, order);
        const gc = r32(buf, 8, order);
        const rects = Math.max(0, (buf.length - 12) / 8);
        summary = `drawable=${xid(drawable)} gc=${xid(gc)} rects=${rects}`;
        fields.push({ name: 'drawable', value: xid(drawable), span: { off: 4, len: 4 }, type: 'DRAWABLE' });
        fields.push({ name: 'gc', value: xid(gc), span: { off: 8, len: 4 }, type: 'GCONTEXT' });
        break;
      }
      default:
        break;
    }

    // Fill in any parameter the hand-written decoder above did not name. This
    // runs even when a summary was produced: several decoders build a good
    // summary and push no fields at all, which used to leave the detail pane
    // showing nothing but the opcode.
    {
      const genMsg = generatedCore()?.requests?.[code];
      if (genMsg) {
        try {
          const g = decodeGenerated(genMsg, buf, order, generatedCore(), (a) => this.atomName(a));
          mergeFields(fields, g.fields);
          if (!summary) summary = g.summary;
        } catch {
          /* ignore */
        }
      }
    }

    // Note a resource this request releases (lifecycle lints, docs §6.2).
    const freeOff = CORE_RESOURCE_FREERS[code];
    const frees = freeOff !== undefined ? r32(buf, freeOff, order) : undefined;

    // Note a resource this request creates (jump-to-creator, docs §6).
    const creator = CORE_RESOURCE_CREATORS[code];
    let created: { xid: number; type: string } | undefined;
    if (creator) {
      const id = r32(buf, creator.xidOffset, order);
      created = { xid: id, type: creator.type };
      if (!fields.some((f) => f.type)) {
        fields.push({ name: 'xid', value: xid(id), span: { off: creator.xidOffset, len: 4 }, type: creator.type });
      }
    }

    return {
      name, ext, summary, fields, extNameArg, atomNameArg, created, frees, image, cursor,
      expectsReply: !!generatedCore()?.requests?.[code]?.reply,
    };
  }

  private describeSetupReply(buf: Buffer, order: Order): string {
    if (buf[0] !== 1) return buf[0] === 0 ? 'setup failed' : 'authenticate';
    // Success reply: resource-id-base @12, resource-id-mask @16 — the values
    // that let us later classify client- vs server-allocated XIDs (docs §3.1).
    try {
      const base = r32(buf, 12, order);
      const mask = r32(buf, 16, order);
      return `resource-id base=${xid(base)} mask=${xid(mask)}`;
    } catch {
      return 'success';
    }
  }

  private emitSimple(
    dir: Direction,
    category: Category,
    buf: Buffer,
    name: string,
    extra: { summary?: string } = {},
  ): CapturedMessage {
    const msg: CapturedMessage = {
      id: this.sink.nextId(),
      connId: this.connId,
      dir,
      category,
      ts: this.clock.wall(),
      mono: this.clock.mono(),
      bytes: Buffer.from(buf),
      name,
      summary: extra.summary ?? '',
    };
    this.sink.onMessage(msg);
    return msg;
  }

  /**
   * Pre-seed server-owned resources declared in the connection setup reply —
   * each screen's root window and default colormap — so references to them
   * (e.g. CreateWindow parent=root) link to the setup handshake instead of
   * dangling. Best-effort: never breaks framing (docs §6.2).
   */
  private seedSetupResources(buf: Buffer, order: Order, creatorId: number): void {
    try {
      if (buf[0] !== 1) return; // success replies only
      const pad4 = (n: number) => (n + 3) & ~3;
      const vendorLen = r16(buf, 24, order);
      const numScreens = buf[28]!;
      const numFormats = buf[29]!;

      // Image-decoding facts (docs §9): byte/bit order, scanline geometry, and
      // the per-depth pixmap formats.
      this.display.imageByteOrder = buf[30]!;
      this.display.bitmapBitOrder = buf[31]!;
      this.display.scanlineUnit = buf[32]!;
      this.display.scanlinePad = buf[33]!;
      const formatsOff = 40 + pad4(vendorLen);
      for (let i = 0; i < numFormats; i++) {
        const fo = formatsOff + i * 8;
        if (fo + 8 > buf.length) break;
        this.display.formats[buf[fo]!] = { bpp: buf[fo + 1]!, pad: buf[fo + 2]! };
      }

      let off = formatsOff + numFormats * 8; // first SCREEN
      for (let s = 0; s < numScreens; s++) {
        if (off + 40 > buf.length) break;
        const root = r32(buf, off, order);
        const cmap = r32(buf, off + 4, order);
        const w = r16(buf, off + 20, order);
        const h = r16(buf, off + 22, order);
        if (s === 0) this.display.rootVisual = r32(buf, off + 32, order);
        if (root) {
          this.resources.set(root, { type: 'Window', creatorId, summary: `root window ${w}×${h} (screen ${s})` });
        }
        if (cmap) {
          this.resources.set(cmap, { type: 'Colormap', creatorId, summary: `default colormap (screen ${s})` });
        }
        // Walk this SCREEN's allowed-depths list, recording each visual's
        // colour masks (needed to map pixel bits → RGB) and skipping past it.
        const numDepths = buf[off + 39]!;
        let d = off + 40;
        for (let i = 0; i < numDepths && d + 8 <= buf.length; i++) {
          const numVisuals = r16(buf, d + 2, order);
          for (let v = 0; v < numVisuals; v++) {
            const vo = d + 8 + v * 24;
            if (vo + 24 > buf.length) break;
            this.display.visuals[r32(buf, vo, order)] = {
              redMask: r32(buf, vo + 8, order),
              greenMask: r32(buf, vo + 12, order),
              blueMask: r32(buf, vo + 16, order),
            };
          }
          d += 8 + numVisuals * 24;
        }
        off = d;
      }
    } catch {
      /* best effort */
    }
  }
}
