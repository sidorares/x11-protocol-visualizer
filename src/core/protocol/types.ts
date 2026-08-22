import { XID_TYPE_NAMES } from './generated.js';

/**
 * Core protocol/value types shared across the capture engine and the UI.
 *
 * The central design contract (see docs/decoder-and-state.md §1) is that every
 * decoded field carries the byte range that produced it, so the UI can map an
 * argument to its bytes and back.
 */

/** Direction of a message on the wire. */
export type Direction = 'c2s' | 's2c';

/** High-level classification, used for color coding and framing. */
export type Category =
  | 'setup-request'
  | 'setup-reply'
  | 'request'
  | 'reply'
  | 'event'
  | 'error';

/** A byte range within a message buffer. */
export interface Span {
  off: number;
  len: number;
}

/** A single decoded field with the bytes it came from. */
export interface Field {
  name: string;
  /** Human-readable rendered value (e.g. `0x04800001`, `InputOutput`). */
  value: string;
  span: Span;
  /** Optional richer type hint, e.g. `WINDOW`, `ATOM`, used later for links. */
  type?: string;
  /** If this field references a resource, the id of the message that created it. */
  ref?: number;
  /** A CSS hex color (`#rrggbb`) to preview as a swatch, if this is a color value. */
  color?: string;
}

/** Interpret a 24-bit TrueColor pixel value as a CSS hex color. */
export function pixelToHex(v: number): string {
  return '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/** Interpret a RENDER COLOR (16-bit channels) as a CSS hex color. */
export function renderColorToHex(r16: number, g16: number, b16: number): string {
  const c = (n: number) => (n >> 8).toString(16).padStart(2, '0');
  return '#' + c(r16) + c(g16) + c(b16);
}

/**
 * Resource types whose XIDs we track and cross-link (jump-to-creator, lints).
 *
 * Derived from every type the xcbproto corpus declares as an XID, so a new
 * extension's resources link without anyone maintaining a list — minus `ATOM`,
 * which is an id but not a lifecycle-managed resource: atoms are interned for
 * the life of the server, are rendered by name from the atom table, and would
 * otherwise show up as thousands of "never freed" lints.
 */
export const RESOURCE_TYPES = new Set(
  XID_TYPE_NAMES.filter((t) => t !== 'ATOM'),
);

/**
 * A captured, framed message. `bytes` is the exact on-wire slice (byte-for-byte
 * as forwarded). Full field decoding is lazy; `fields` may be populated on demand.
 */
export interface CapturedMessage {
  /** Monotonic id, unique within a capture session. */
  id: number;
  /** Which client connection this belongs to. */
  connId: number;
  dir: Direction;
  category: Category;
  /** Wall-clock ms (display only). */
  ts: number;
  /** Monotonic ms (ordering / RTT). */
  mono: number;
  /** Exact bytes of this message. */
  bytes: Buffer;

  /** Major opcode (requests) or message code (events/errors/replies). */
  code?: number;
  /** Minor opcode for extension requests. */
  minor?: number;
  /** Reconstructed 32-bit sequence number (requests/replies/errors). */
  seq?: number;
  /** Resolved name, e.g. `CreateWindow`, `RENDER:CreatePicture`, `Expose`. */
  name: string;
  /** Extension name if this is an extension request/event/error. */
  ext?: string;
  /** One-line summary for the list row. */
  summary: string;

  /** For a request: id of the matching reply/error, once seen. Set by
   *  `CaptureStore.onLink` when the answer arrives — never searched for. */
  replyId?: number;
  /** For a request: whether the protocol says this request generates a reply.
   *  Lets the UI say "no response yet" only where one is actually coming. */
  expectsReply?: boolean;
  /** For a reply/error: id of the originating request. */
  requestId?: number;
  /** Round-trip time in ms, set on the request when its reply/error arrives. */
  rttMs?: number;

  /** Lazily-filled decoded header fields (with spans). */
  fields?: Field[];
  /** True if decoding failed and only a best-effort header is available. */
  undecoded?: boolean;
  /**
   * If this message carries an image payload (PutImage / GetImage reply), the
   * spec needed to decode it. Decoding is deferred to the UI — see
   * protocol/image.ts.
   */
  image?: import('./image.js').ImageSpec;
  /** If this message carries RENDER glyph bitmaps (AddGlyphs), their specs. */
  glyphs?: import('./image.js').GlyphSpec[];
  /** The resource this message allocates, if any (jump-to-creator, lints). */
  creates?: { xid: number; type: string };
  /** The resource id this message frees/destroys, if any (lints). */
  frees?: number;
  /** If this message creates a cursor, how to compose its preview. */
  cursor?: import('./image.js').CursorSpec;
}
