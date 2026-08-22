# Decoder & State Engine — Technical Design

**Companion to:** [PRD.md](./PRD.md)
**Status:** Draft v0.2
**Scope:** the span-aware decoder and the per-connection state machines (sequence, extension, XID, atom). This is the technical heart the PRD's features depend on.

---

## 1. The one requirement that drives everything: spans

Every decoded value must carry the byte range that produced it:

```ts
interface Span { off: number; len: number }          // offset & length within the message buffer

type Node =
  | { kind: 'field';  name: string; type: TypeRef; value: Value; span: Span }
  | { kind: 'struct'; name: string; span: Span; children: Node[] }
  | { kind: 'list';   name: string; span: Span; elemType: TypeRef;
      count: number; element(i: number): Node }       // lazy element materialization
  | { kind: 'switch'; name: string; span: Span; selected: string[]; children: Node[] } // value-mask expansion
  | { kind: 'blob';   name: string; span: Span; preview?: PreviewHint }               // large binary
  | { kind: 'raw';    name: string; span: Span }        // undecoded / unknown
```

This single contract powers: hover ⇄ hex highlighting (§PRD 6.6), the tree and code views (§PRD 6.5), resource links (leaves whose `type` is a resource), and blob previews. **A decoder that returns plain values but not spans is a rewrite later — build spans in from line one.**

Design consequences:
- Decoders are written as **cursor consumers**: a `Reader` tracks the current offset; each `read*` call returns `{value, span}` and advances. Spans compose upward (a struct's span = min offset … max end of children; a list's span = its whole extent).
- **Lazy lists.** Large `LISTof…` don't materialize all elements. The list node stores the base offset, element stride (or an index of variable-length element offsets), and a `count`; `element(i)` decodes on demand. This is what keeps a 100k-point `PolyLine` cheap.
- **Lazy full decode.** On the hot path the backend only needs framing + a summary; the full tree is produced when a message is selected (§7).

---

## 2. Where the protocol description comes from

Writing a decoder per message by hand is the trap. Two viable sources:

1. **`xcbproto` XML (recommended).** The X.Org `xcbproto` package ships machine-readable XML for the core protocol and ~50 extensions: requests, replies, events, errors, structs, unions, enums, `<list>` with expressions, `<switch>`/`<bitcase>` for value-masks, `<pad>`, alignment, and reply/event field layouts. A **build-time codegen** consumes these and emits span-aware TS decoders + summary formatters + type metadata (which fields are resources, which are atoms). This gives near-complete coverage for the cost of one code generator.
   - Handle xcbproto's `<expression>` (fields whose count/size is computed from other fields), `align`, `<pad align="…">`, and `<required_start_align>`.
   - Emit, per message: a decoder (buffer → `Node`), a one-line summary formatter, and metadata (opcode, minor-opcode, is-void vs has-reply, resource fields, atom fields).
2. **Reuse `node-x11` (faster to bootstrap, and a project requirement).** [`node-x11`](https://github.com/sidorares/node-x11) already encodes core opcodes, event/error codes, and (un)pack templates, plus extension modules under `lib/ext/` covering XRender, Damage, Composite, BIG-REQUESTS, DPMS, Screensaver, XFixes, Shape, XTest, XC-MISC, GLX, DRI3, Present, and Apple-WM, with additional definitions under `autogen/`. Good for M0/M1 core and a solid slice of extensions.

**Recommendation:** seed the core from `node-x11` to get moving in M1, but invest in the `xcbproto` codegen for M2 coverage. Keep the emitted decoder shape identical so both feed the same `Node` model.

### 2.1 What exactly to reuse from `node-x11`

The critical caveat: **`node-x11`'s unpack path returns decoded values, not byte spans.** Its readers consume a buffer and produce JS objects; the offset bookkeeping that §1 requires is not threaded through and cannot be recovered after the fact. So:

- **Reuse the *definitions*, not the *readers*.** The durable value is the machine-readable knowledge: major/minor opcodes, event and error codes, extension registration (name → opcode/first-event/first-error), field orders, type widths, enum names, and the value-mask bit orders. These are exactly what a span-aware reader needs as input.
- **Reuse the *transport* wholesale.** `node-x11`'s connection setup, byte-order handling, and socket plumbing are directly useful — and are already a dependency via `react-x11`, so the UI and the decoder share one copy.
- **Write the reader fresh** against those definitions, as a cursor consumer emitting `{value, span}` (§1). This is a small amount of code precisely *because* the definitions come from elsewhere.
- **Cross-check the two.** A good test oracle: decode a message with both `node-x11`'s unpack and the span-aware reader, and assert the *values* agree. This catches reader bugs cheaply and continuously (see §10).

Where `node-x11` and `xcbproto` disagree on a definition, prefer `xcbproto` (it is the upstream source of truth) and file the discrepancy — it may be a real `node-x11` bug worth fixing upstream.

*Note:* xcbproto describes wire layout but a few things need hand augmentation — semantic hints (which atom types render as text, EWMH property meanings), image-format wiring for previews, and human-friendly summaries. Keep a small **overlay** file keyed by `(extension, message)` for these.

---

## 3. Framing (splitting the byte stream into messages)

Framing is per-connection and **direction-specific**. It must be resilient to TCP segmentation (accumulate until a full message is available) and must never desync.

### 3.1 Connection setup (both directions, once)
- **Client setup request:** first byte is byte order (`0x42 'B'` = MSB-first, `0x6c 'l'` = LSB-first). Then `protocol-major(2)`, `protocol-minor(2)`, `auth-name-len(2)`, `auth-data-len(2)`, pad(2), auth-name (padded to 4), auth-data (padded to 4). **Latch the byte order here — it governs every subsequent multi-byte read on this connection.**
- **Server setup reply:** first byte `0`=Failed, `1`=Success, `2`=Authenticate. On Success, parse the fixed header then `vendor`, `pixmap-formats[]`, and `screens[]` (roots). **Extract and store:** `resource-id-base`, `resource-id-mask`, `image-byte-order`, `bitmap-bit-order`, `scanline-unit`, `scanline-pad`, `min/max-keycode`, and per-screen roots/visuals/default-colormaps/depths. Downstream XID classification and image previews need all of this.

### 3.2 Requests (client → server)
```
byte 0: major opcode
byte 1: minor-opcode / data (extension minor opcode, or request-specific)
bytes 2-3: length in 4-byte units  (0 ⇒ BIG-REQUESTS: real length is next CARD32)
body: (length*4 - 4) bytes  [ + BIG-REQUESTS 4-byte length word when active ]
```
- `length == 0` only after the client has enabled **BIG-REQUESTS**; then a 4-byte extended length (in 4-byte units) follows the header and the total size uses it. Track "big-requests enabled" per connection (set when its `Enable` reply is seen).
- Assign a **sequence number** to every request as it is framed (see §4).

### 3.3 Replies / events / errors (server → client)
Disambiguate on the first byte:
```
0             → Error   (fixed 32 bytes)
1             → Reply   (32 + reply.length*4 bytes; length is CARD32 at bytes 4-7)
2 .. 34       → Event   (fixed 32 bytes)   — code & 0x7f; bit 7 (0x80) = came from SendEvent
35            → GenericEvent (XGE): 32 + length*4 bytes (length = CARD32 at bytes 4-7)
128 .. 255    → Extension event; still 32 bytes unless delivered as XGE(35)
```
- **Reply length** lives at bytes 4-7 (CARD32, in 4-byte units *beyond* the fixed 32) — must be read to frame variable replies (`GetProperty`, `QueryTree`, `ListFonts`, `GetImage`, …).
- **`KeymapNotify` (code 11)** has **no** sequence number; bytes 1-31 are the keymap. Special-case it.
- **XGE (code 35):** `extension(1)` at byte 1 is the owning extension's major opcode; `evtype(2)`, `length(4)`; total = `32 + length*4`. Needed for XI2 and Present events.

### 3.4 Anti-desync rules
- Never advance the relay based on decode success; frame using only lengths, forward raw. A **decode** exception marks the message `undecoded` but framing already knows the boundary from the length fields.
- If a length is implausible (e.g. exceeds `max-request-length` before BIG-REQUESTS, or a reply claims more than buffered), wait for more bytes; only flag an error if the stream truly violates framing.

---

## 4. Sequence tracking & linkage

- The client's sequence counter starts at **1** and increments **once per request** (every request, reply-generating or not). It's a wrapping 16-bit value on the wire but a monotonic 32-bit value conceptually.
- The proxy maintains its own `nextSeq` per connection, assigning as it frames requests. It reconstructs the full 32-bit sequence and records `seq → messageId`.
- **Replies & errors** carry the low 16 bits of the sequence at bytes 2-3. To recover the full value: take the last assigned sequence, and pick the 32-bit value with those low 16 bits that is `≤` the highest-sent and closest to it (standard Xlib "widen with wrap" logic). Then `seq → request` gives the link and the **RTT**.
- **Matching rules:**
  - Reply → the request with that sequence (strong; also sanity-check the request was reply-generating).
  - Error → the request with that sequence; corroborate with the error's `major-opcode`/`minor-opcode` fields.
  - Event → **not** a strong link. Its sequence field is "sequence of the last request processed by the server," a hint only; show it as context, don't draw a hard creator edge. (`SendEvent`-sourced events set bit 7 of the code.)
- **Anomalies to surface:** reply/error with no matching outstanding request; request that never gets its expected reply by session end; sequence gaps.

State shape:
```ts
interface ConnState {
  byteOrder: 'LE' | 'BE';
  nextSeq: number;                       // 32-bit reconstructed
  bigRequests: boolean;
  pending: Map<number, MessageId>;       // seq → request awaiting reply/error
  ext: ExtensionRegistry;                // §5
  xids: ResourceTable;                   // §6
  atoms: AtomTable;                      // §6.4
  setup: ServerSetup;                    // resource-id-base/mask, formats, screens
}
```

---

## 5. Extension registry

Extensions get their major opcode (and event/error bases) at runtime, so decoding depends on watching the negotiation.

- Watch **`QueryExtension`** request/reply pairs: on the reply, record `name → { major, firstEvent, firstError, present }`. The request carries the name; pair them by sequence.
- Also honor extensions surfaced by **`ListExtensions`** for names, and note that **BIG-REQUESTS `Enable`** flips `bigRequests` on.
- Decoding dispatch:
  - **Request:** `major ≥ 128` ⇒ look up extension by major opcode; the **minor opcode is byte 1**; dispatch to `(ext, minor)`.
  - **Event:** `code` in `[firstEvent, firstEvent+N)` ⇒ that extension's event; XGE (35) dispatches via the `extension` byte + `evtype`.
  - **Error:** `code` in `[firstError, firstError+N)` ⇒ that extension's error.
- Until a `QueryExtension` reply is seen, extension messages decode as `raw` with a best-effort header. (On a *loaded* capture that starts mid-session, the registry may be incomplete — degrade gracefully, and allow a user-supplied opcode map.)

```ts
interface ExtensionRegistry {
  byMajor: Map<number, ExtInfo>;
  eventRanges: Array<{ first: number; count: number; ext: ExtInfo }>;
  errorRanges: Array<{ first: number; count: number; ext: ExtInfo }>;
  resolveRequest(major: number, minor: number): MsgDef | undefined;
  resolveEvent(code: number, xge?: { extMajor: number; evtype: number }): MsgDef | undefined;
  resolveError(code: number): MsgDef | undefined;
}
```

---

## 6. Resource (XID) & atom tracking

### 6.1 What creates a resource
Anchor the "jump to creator" feature on resource-creating messages. Core: `CreateWindow`, `CreatePixmap`, `CreateGC`, `CreateColormap`, `CreateCursor`, `CreateGlyphCursor`, `OpenFont`, `AllocColor`-family (returns pixels, not XIDs — track separately), `GetInputFocus`… Extensions: RENDER `CreatePicture`/`CreateGlyphSet`/`CreateLinearGradient`…, XFIXES `CreateRegion*`, DAMAGE `Create`, SYNC `CreateCounter`/`CreateFence`, Present, GLX contexts/drawables, etc.

The **codegen** (§2) marks fields as resources from xcbproto types (`WINDOW`, `PIXMAP`, `DRAWABLE`, `GCONTEXT`, `FONT`, `FONTABLE`, `COLORMAP`, `CURSOR`, `PICTURE`, `GLYPHSET`, `PICTFORMAT`, `DAMAGE`, `REGION`, `SyncCOUNTER`, `SyncFENCE`, …). The **destination** XID of a create request is the created resource; other resource-typed fields are *references*.

### 6.2 The resource table
```ts
type XID = number;
interface ResourceRec {
  xid: XID;
  type: ResourceType;              // Window | Pixmap | GContext | ...
  origin: 'client' | 'server';     // via resource-id-base/mask test
  creatorMessageId?: MessageId;    // the create request (undefined for server/seeded)
  summary: string;                 // "800×600 InputOutput child of root", "512×512 depth24", ...
  freedByMessageId?: MessageId;    // Free/Destroy/... request
  refs: MessageId[];               // every message that references this xid (find-usages)
}
class ResourceTable {
  onCreate(rec: ResourceRec): void;
  onReference(xid: XID, at: MessageId): void;
  onFree(xid: XID, at: MessageId): void;
  get(xid: XID): ResourceRec | undefined;
  classifyOrigin(xid: XID): 'client' | 'server';   // (xid & ~mask) === base ? client : server
}
```
- **Seed** from the setup reply: each screen's `root` (Window), `default-colormap` (Colormap), `root-visual` (VisualID), plus predefined `Font`/`Cursor` where applicable.
- **Origin test:** `(xid & ~resource-id-mask) === resource-id-base` ⇒ client-allocated; else server-owned (e.g. roots). Surface this in the tooltip.
- **Lifecycle** (PRD FR-33/35): `alive`, `freed at #N`, `server-owned`, `referenced-but-never-created` (possible bug / mid-session capture). Lints: **use-after-free** (reference with `at` after `freedBy`), **double-free**, **leak** (client-origin, created, never freed at session end).
- **Find-usages** (FR-34) is just `refs`.

### 6.3 Reference resolution & the "jump" edge
When decoding produces a leaf whose type is a resource:
- attach the `ResourceRec` (or a placeholder if unknown) → the UI renders it as a link with the tooltip;
- append the current `MessageId` to `refs`;
- if this message is a create, register the record with `creatorMessageId = self`;
- if this message is a free/destroy, set `freedByMessageId`.

Ordering caveat on **loaded/partial captures**: a reference may be seen before its creator isn't (mid-session start) — resolve lazily and reconcile; never assume creation precedes use.

### 6.4 Atoms & properties
- **`InternAtom`** request (name) ↔ reply (atom) — pair by sequence, store `atom → name` and `name → atom`. **`GetAtomName`** is the inverse. **Seed** the 68 predefined atoms (`PRIMARY`, `SECONDARY`, `WM_NAME`, `STRING`, `ATOM`, …).
- Render atoms as **names** inline with the numeric value on hover (FR-18).
- **Property awareness** (FR-19): for `ChangeProperty`/`GetProperty`, interpret the value using `(type-atom, format)`:
  - `STRING`/`UTF8_STRING` → text; `ATOM` → atom-name list (`WM_PROTOCOLS`); `CARDINAL`/`INTEGER` arrays → numbers; `WINDOW`/`PIXMAP` → resource links; known EWMH `_NET_*` keys via a small overlay table. Fallback to typed hex.

---

## 7. Process model & the UI/decoder split

The UI is a `react-x11` application running **in the same Node process** as the proxy (PRD §5). There is no WebSocket, no IPC, and no serialization boundary — which removes a whole class of design problems a browser UI would have imposed.

- **Capture hot path (per message):** frame it, assign sequence, update state machines (§4–6), compute a **compact summary** (category, name incl. extension, key args as text, size, RTT once matched, linkage ids, lint flags). Retain the raw bytes in the ring buffer. Push the summary into the store.
- **On selection (per message):** run the span-aware decoder over the retained buffer to build the full `Node` tree, feeding the tree view, code view, and hex highlighting. **List rows only ever read the summary**, so scrolling never decodes.
- **Store:** a small observable consumed via `useSyncExternalStore`. The capture engine owns the authoritative state machines (it sees the ordered stream); React components are pure readers. **No message object is ever copied across a boundary** — the UI holds references into the same buffers.
- **Timestamps:** monotonic clock at capture; never `Date.now()` for ordering. Wall-clock only for display, stamped once.
- **Buffer retention:** since UI and capture share memory, "retain by reference" is literal — the ring buffer holds slices, and eviction must account for a message currently selected/pinned in the UI (pin it or copy on select).

### 7.1 UI performance notes (react-x11 specific)

The UI renders over the X11 wire, so *its own* draw calls are the cost to manage. Three consequences shape the implementation:

1. **Coalesce ingest → repaint.** A busy capture can deliver thousands of messages/sec; React must not render per message. Batch store notifications into **at most one repaint per frame** (accumulate into an array, flush on a timer/rAF-equivalent). This is PRD FR-53 and NFR-7, and it's the difference between a smooth UI and a self-inflicted traffic storm.
2. **Virtualize everything long.** `Table` and `Tree` from `react-x11-components` are already virtualized — use them rather than rendering full lists. Large protocol lists stay lazy at the decoder level too (§1).
3. **The hex view is the real risk.** A 512-byte message shown as one `<text>` node per byte is ~1000 nodes with independent layout and per-byte highlight state, re-rendered on every hover — plausibly thousands of XRender ops per mouse move. Options, cheapest first:
   - **Per-row pre-shaped text** (one `<text>` per 16-byte row, hex and ASCII) with a **rectangle underlay** for highlights: highlight changes then repaint a few `<box>`es, not the glyphs. Text is shaped once per row and reused. *Preferred starting point.*
   - **`<canvas>` with manual glyph placement** — maximum control, highest effort; a good fallback if per-row text still costs too much.
   - **Per-byte `<text>` nodes** — simplest to write, almost certainly too slow; acceptable only as a throwaway M1 spike.

   Because hover highlighting is *the* signature interaction (FR-30), prototype this early (PRD open question 10). Keep the hover-span state in **one shared store** so tree/code/hex all read the same `{off, len}` and only the affected rows repaint.
4. **Glyph reuse:** `react-x11` uploads shaped glyphs once and then references them by index. Monospace hex/code views benefit enormously — stable character set, stable metrics. Prefer a single monospace face and avoid per-cell font/style churn, which would defeat the glyph cache.
5. **Dogfooding loop:** all of the above is directly observable *by this tool* (PRD FR-52). Point one instance at another and the hex view's draw cost becomes visible as real `RenderCompositeGlyphs`/`PolyFillRectangle` traffic — the most credible test of whether the chosen strategy works.

---

## 8. Byte order, alignment, padding — the sharp edges

- **Byte order** is latched at setup (§3.1) and passed into every `read16/read32`. Loaded captures store it in the header.
- **4-byte alignment:** requests, replies, and most lists pad to 4-byte boundaries. The decoder emits explicit **pad nodes** with spans so the hex view can shade them (FR-32) and so `struct.span` covers the padding.
- **String lengths vs. padded extent:** `STRING8`/`STRING16` have a logical length and a padded on-wire extent; the field span covers the logical bytes, a sibling pad node covers the padding.
- **`<switch>`/value-mask:** expand the bitmask, then read exactly the present values in **bit order**; each present value is a child with its own span; the mask field itself is a leaf whose value renders as `A|B|C`.
- **Computed lengths:** honor xcbproto `<expression>` (e.g. list length = `(request.length*4 - fixed)/elem_size`, or a named field). Validate against the framed message length; mismatch ⇒ mark `undecoded` rather than read out of bounds.
- **XGE length units** are 4-byte words *beyond* the initial 32; **reply length** likewise beyond 32; **request length** counts the whole request. Don't mix these up — they're a classic off-by-one source.

---

## 9. Image / glyph preview wiring (for FR-37)

To render `PutImage`/`GetImage` payloads as real images, combine:
- from the **message:** `format` (Bitmap/XYPixmap/ZPixmap), `depth`, `width`, `height`, target drawable (→ its visual, via resource table when known);
- from the **setup:** `image-byte-order`, `bitmap-bit-order`, `scanline-unit`, `scanline-pad`, and the matching **pixmap-format** for the depth (bits-per-pixel, scanline-pad);
- from the **visual** (for TrueColor/DirectColor): red/green/blue masks to map pixel bits → RGB; for PseudoColor, the colormap (best-effort; may be unknown).

Compute the scanline stride with the right pad, walk rows, map pixels per visual, paint to `<canvas>`. This preview *is* a byte-order/padding debugger: if it looks garbled/sheared, the format wiring (or the client's) is wrong. Guard by size; render on demand.

Glyphs (RENDER `AddGlyphs`, core font glyphs) and cursors follow the same "decode metrics + bitmap → canvas" pattern at smaller scale.

---

## 10. Testing strategy (correctness is the product here)

- **Golden captures:** record real sessions (`xterm`, a GTK app, a Qt app, a compositor) and snapshot the decoded trees + spans; diff on change.
- **Round-trip property:** for messages the tool can also *encode*, assert `decode(bytes).span` covers the buffer with no gaps/overlaps except declared pads (span-coverage invariant).
- **Byte-order matrix:** decode the same logical messages in LE and BE.
- **Fuzz framing:** random TCP segmentation boundaries must not change framing results; truncated tails must degrade to "need more bytes," never crash.
- **State machines:** unit-test sequence widening across wrap, extension range resolution, XID origin classification, use-after-free/leak detection, atom seeding.
- **Differential test against `node-x11`:** decode the same buffer with `node-x11`'s unpack and with the span-aware reader; assert the decoded **values** match (§2.1). Cheap, continuous, and catches reader regressions immediately.
- **Span-coverage invariant** (restated as a property test): the union of leaf spans plus declared pad nodes must exactly tile the message buffer — no gaps, no overlaps, nothing past the end.
- **`react-x11` as a traffic generator:** the UI is itself an X11 client, so it produces rich, realistic traffic (XRender glyphs, gradients, clipping) on demand. Use a scripted UI session as a reproducible capture fixture — and as the self-inspection smoke test (PRD FR-52).
- **Cross-check** decoded opcodes/names against `xcbproto` and, where possible, `xtrace`/`x11trace` output on the same session.

---

## 11. References
- `xcbproto` — machine-readable X11 protocol descriptions (core + extensions); primary source for the codegen.
- [`node-x11`](https://github.com/sidorares/node-x11) — opcode/type tables, `autogen/` definitions, `lib/ext/*` extension modules, and the connection/transport layer. Source of definitions (§2.1) and a differential-test oracle (§10).
- [`react-x11`](https://github.com/sidorares/react-x11) — React reconciler targeting the X server; the UI platform (PRD FR-49). Built on `node-x11` + yoga-layout + fontkit; draws via XRender.
- [`react-x11-components`](https://github.com/sidorares/react-x11-components) — widget library (`Table`, `Tree`, `Code`, `Timeline`, `Flow`, charts); see the component mapping in PRD §7.1. Neither UI package is published to npm yet — consume from the GitHub default branch (PRD §10).
- X11 core protocol spec; X.Org extension specs (RENDER, XFIXES, RANDR, XInput 2.x, SHM, DAMAGE, SYNC, Present, XKB, BIG-REQUESTS, XGE).
- `xtrace` / `x11trace` — prior-art protocol tracers for cross-checking.
