# PRD — X11 Protocol Visualizer (`x11vis`)

**Status:** Draft v0.2
**Owner:** @sidorares
**Last updated:** 2026-08-21
**Companion doc:** [decoder-and-state.md](./decoder-and-state.md) — span-aware decoding & state-tracking design

> **v0.2 changes:** the UI is now specified as a native X11 application built on `react-x11` + `react-x11-components` (§6.12, §7.1, §10) rather than a browser SPA; `node-x11` is adopted for wire (de)serialization; the proxy and UI collapse into a single process (§5).

---

## 1. Summary

`x11vis` is a **man-in-the-middle X11 proxy with a live protocol inspector**. It sits between an X11 client and the X server, forwards the byte stream faithfully in both directions, and renders every message (request, reply, event, error) as a structured, navigable, color-coded view — think *"Chrome DevTools Network tab / Wireshark, but purpose-built for the X11 wire protocol."*

Two things make it more than a packet dumper:

1. **Byte-accurate, bidirectional field mapping.** Every decoded field knows the exact byte span in the raw buffer that produced it. Hovering an argument highlights its bytes and vice-versa. Requests link to their replies/errors; resource IDs link to the request that created them.
2. **A tunable network layer.** The proxy can emulate latency and throughput (Chrome-style presets), so you can *see and feel* how chatty an app is over a WAN/SSH link — where X11's round-trips, not its bandwidth, are what hurt.

Primary platform: **Node.js + TypeScript**. The proxy/capture uses **[`node-x11`](https://github.com/sidorares/node-x11)** for wire (de)serialization, and — fittingly — the tool's **own UI is a native X11 application built with [`react-x11`](https://github.com/sidorares/react-x11) + [`react-x11-components`](https://github.com/sidorares/react-x11-components)**, so the X11 visualizer is itself an X11 client (and can inspect itself). See [§10 Tech stack](#10-tech-stack--key-implementation-notes).

---

## 2. Goals & non-goals

### Goals
- Transparent, byte-exact X11 proxy (pass-through when no throttling/injection is active).
- Live, low-latency inspection of both directions with structured decode of core protocol **and** extensions.
- Precise argument ↔ hex byte-span mapping, in both hover directions.
- Strong linkage model: request↔reply, request↔error, XID↔creator, atom↔name.
- Resource-lifecycle awareness (allocated → used → freed), surfaced in tooltips and navigation.
- Content-aware rendering of binary payloads (images, glyphs, cursors, property values).
- Network emulation with latency + throughput presets and custom profiles.
- Save/load captures for offline analysis and bug reports.

### Non-goals (v1)
- Being a general TCP/pcap analyzer. It is X11-specific.
- Editing/replaying arbitrary traffic as a fuzzing framework (basic fault injection is a *stretch*, §9).
- Windows/Wayland client support. (Wayland is a different protocol; out of scope. XWayland traffic *is* X11 and is in scope.)
- A web/browser UI. The UI is a native X11 app by design (FR-49) — see §10 for why the browser option was rejected.
- Acting as a security auditing tool. It will *see* secrets (auth cookies, keystrokes, clipboard); it is a local-dev tool, not a hardened product.

---

## 3. Users & use cases

**Primary user:** developers working on X11 clients, toolkits, window managers, or the protocol itself (e.g. someone building/maintaining an X11 library, debugging a rendering glitch, or reducing round-trips).

Representative use cases:
- *"Why is my app slow over SSH X-forwarding?"* → throttle to WAN latency, watch the round-trip (request→reply) chain light up, find synchronous stalls.
- *"What exactly did my toolkit send for this `CreateWindow`?"* → inspect fields, value-mask, and the exact bytes.
- *"Which request created this window/pixmap/GC/Picture, and is it still alive?"* → click the XID, jump to creator, read lifecycle in the tooltip.
- *"Is my `PutImage` byte order / padding correct?"* → render the image payload as an actual picture from its declared format.
- *"Did the server send the error I think it did, and to which request?"* → error row links back to the originating request.
- *"Share a repro."* → save the capture, attach to a bug report, reopen offline.

---

## 4. Background: the protocol facts that shape this design

(Terminology only; the [companion doc](./decoder-and-state.md) has the full mechanics.)

- **Framing differs per direction.** Client→server = **requests** (1-byte major opcode, 1 data byte, 2-byte length in 4-byte units, body). Server→client = **replies / events / errors**, disambiguated by the first byte (`0`=error, `1`=reply, `2..34`=core event, `35`=`GenericEvent`/XGE, `128+`=extension events). Errors and 32-byte events are fixed-size; replies and XGE events carry their own length.
- **Everything is asynchronous and pipelined.** Requests are matched to replies/errors by a **16-bit sequence number** that both sides track as a wrapping 32-bit counter. The proxy must reconstruct it to link messages.
- **Opcodes for extensions are negotiated at runtime.** `QueryExtension` maps an extension name → major opcode, base event number, base error number. Without tracking these, extension messages can't be decoded. (`major opcode ≥ 128` = extension; the *minor* opcode usually lives in the request's data byte.)
- **XIDs are client-allocated and typed.** The setup reply gives `resource-id-base`/`resource-id-mask`; the client mints Window/Pixmap/GContext/Font/Colormap/Cursor/Picture/Glyphset/… IDs from that range. Resource-creating requests are the anchors for the "jump to creator" feature.
- **Value-lists are bitmask-driven.** `CreateWindow`, `ChangeWindowAttributes`, `CreateGC`, `ChangeGC`, `ConfigureWindow`, RENDER's `CreatePicture`, etc. carry a `value-mask` (a bitmask) followed by exactly the set bits' values, in bit order. Decoding requires expanding the mask.
- **Byte order is per-connection**, declared in the first byte of the setup request (`B`/`l`). All multi-byte fields follow it.
- **`BIG-REQUESTS`** lets a 0 length field signal a following 4-byte extended length. **XGE** lets events exceed 32 bytes. **`KeymapNotify`** is the one event with no sequence number.
- **Large binary payloads exist**: `PutImage`/`GetImage` (raw pixels), `AddGlyphs` (glyph bitmaps), font queries, `ChangeProperty` values, keymaps.

The single most important architectural consequence: **the decoder must be span-aware** — every field carries `(offset, length)` into the raw buffer. That one requirement drives the whole design (§6.2, and the companion doc).

---

## 5. Architecture

**`x11vis` is a single Node.js process** containing both the proxy and the UI. The UI is not a web app — it is a **native X11 client rendered by `react-x11`**, which itself speaks X11 through `node-x11`. The same `node-x11` (de)serialization layer therefore serves both halves of the tool.

```
  X11 client(s)                    x11vis  (one Node process)                Real X server
 ┌────────────┐   TCP :6001   ┌────────────────────────────────────┐        $DISPLAY
 │ app under  │◄─────────────►│  Proxy / capture engine             │◄──────►│ :0
 │ inspection │  (or unix     │   • per-conn framing                │  unix   │ (/tmp/.X11-unix/X0
 │ DISPLAY=   │   socket)     │   • seq / ext / xid / atom state    │  socket │  or host:port)
 │ localhost:1│               │   • network emulator (delay+bucket) │  or TCP │
 └────────────┘               │   • span-aware decoder (node-x11)   │        ▲
                              └──────────────┬──────────────────────┘        │
                                             │ in-process (EventEmitter /    │
                                             │ shared ring buffer — no IPC)  │
                              ┌──────────────▼──────────────────────┐        │
                              │  UI — react-x11 application         │────────┘
                              │   • <Table> packet list (virtualized)│   the UI's OWN X11
                              │   • <Tree> + <Code> detail views     │   traffic connects
                              │   • hex view (<box>/<text> grid)     │   DIRECTLY to $DISPLAY,
                              │   • <canvas> image/glyph previews    │   bypassing the proxy
                              └─────────────────────────────────────┘   (see FR-51)
```

**Data-flow decision:** because the UI runs **in the same process** as the proxy, there is no serialization boundary and no WebSocket. The capture engine frames messages, updates state, and computes a compact **row summary** on the hot path; the **full span-aware decode is lazy**, run only when a message is selected, directly against the retained raw buffer. The UI reads both through an in-process store. This is strictly simpler and faster than the client/server split a browser UI would have forced. See [decoder-and-state.md §7](./decoder-and-state.md#7-process-model--the-uidecoder-split).

**Process/packaging:** one command (`x11vis`) starts the proxy and opens the UI window on `$DISPLAY`. A headless mode (`--record`) runs the proxy with no UI for capture-to-file.

---

## 6. Functional requirements

### 6.1 Proxy / capture engine
- **FR-1** Listen on TCP port **6001 by default, configurable** (`--port`, `--listen host:port`; default bind `127.0.0.1`).
- **FR-2** Resolve the upstream target from **`$DISPLAY`** by default, overridable (`--display`, `--target`). Support both **Unix-domain socket** targets (`:N`, `/tmp/.X11-unix/XN`, abstract `@/tmp/.X11-unix/XN`) and **TCP** targets (`host:N` → port `6000+N`).
- **FR-3** *(Enhancement)* Optionally listen on a **Unix socket** `/tmp/.X11-unix/X<n>` too, so clients using `DISPLAY=:<n>` attach transparently. TCP remains the default per the requirement.
- **FR-4** Accept **multiple concurrent client connections**; treat each as an independent, separately-stated session (own byte order, sequence counter, extension/XID/atom tables).
- **FR-5** **Byte-exact pass-through** whenever no throttle/injection is active. Never alter or reorder bytes; preserve in-order delivery per direction.
- **FR-6** **Auth pass-through.** Forward the client's connection-setup (incl. `MIT-MAGIC-COOKIE-1` auth data) to the upstream verbatim. Document the `XAUTHORITY`/`DISPLAY` setup needed so the client's cookie is valid for the real display. Never log auth data by default.
- **FR-7** **Decode failures must never break forwarding.** Framing and decoding run in isolation from the relay; on any parse error, forward bytes untouched and mark the message `undecoded` with raw hex.
- **FR-8** Bounded memory: a **configurable ring buffer** of retained messages (default N, e.g. 100k) with oldest-eviction; raw payloads above a threshold are retained by reference/offset, not duplicated. Backpressure from throttling must not OOM.

### 6.2 Protocol decoding (span-aware)
- **FR-9** Decode **core protocol** requests, replies, events, errors, and the **connection setup handshake** (client setup + server setup reply, including screens/visuals/pixmap-formats — everything downstream depends on it).
- **FR-10** Decode **extensions** via runtime opcode negotiation. Ship with a broad, data-driven extension set (see FR-13). Minimum bar for v1: BIG-REQUESTS, XC-MISC, RENDER, SHAPE, XFIXES, RANDR, XINPUT/XI2, SHM, DAMAGE, SYNC, GLX (framing/opcodes at least), Present, XKB *(XKB decode is large — see roadmap)*.
- **FR-11** Every decoded field carries a **byte span** `(offset, length)` and a typed value. Structures and lists are nested nodes with their own spans; list elements are individually addressable (and lazily materialized).
- **FR-12** Respect **per-connection byte order**; handle **`BIG-REQUESTS`** extended length and **XGE** long events; handle **`KeymapNotify`** (no sequence number) and other special cases.
- **FR-13** **Protocol definitions are data-driven**, ideally generated from `xcbproto` XML (core + ~50 extensions) into span-aware decoders, rather than hand-written per message. This is the key leverage point for coverage. See [decoder-and-state.md §2](./decoder-and-state.md#2-where-the-protocol-description-comes-from).
- **FR-14** Unknown opcode / unknown extension / truncated message degrades gracefully: show category, raw hex, and a best-effort header decode.

### 6.3 Stateful tracking & linkage
- **FR-15** **Sequence linking.** Reconstruct the 32-bit sequence counter; link each **reply** and **error** to its originating **request**; compute round-trip time. Surface unmatched replies/errors as anomalies.
- **FR-16** **Extension registry.** Track `QueryExtension` → {major opcode, first-event, first-error, name}; use it to name and decode extension requests/events/errors.
- **FR-17** **Resource (XID) tracking.** Record every resource-creating request → `{xid, type, creatorMessageId, creationSummary}`; seed server-provided XIDs from the setup reply (roots, default colormaps, root visuals). Mark resources **freed/destroyed** on the corresponding requests; keep history (enables *use-after-free* / *double-free* lints). Distinguish client-allocated vs server XIDs via `resource-id-base/mask`.
- **FR-18** **Atom tracking.** Track `InternAtom` (name→atom) and `GetAtomName` (atom→name); seed predefined atoms; render atoms as names inline with the numeric value on hover.
- **FR-19** **Property awareness.** For `ChangeProperty`/`GetProperty`, interpret the value by its `type` atom and `format` (e.g. `WM_NAME`/`_NET_WM_NAME` as text, `WM_PROTOCOLS` as atom list, `_NET_WM_*` per EWMH where known).

### 6.4 UI — packet list (primary table)
- **FR-20** A **virtualized, sequential table**, one row per message, streaming live (with autoscroll + "pause"/"tail" toggle). Must stay smooth at tens of thousands of rows.
- **FR-21** Columns (default; user-reorderable/toggleable):
  - direction (▸ request / ◂ reply·event·error), **category badge** (color-coded, §7),
  - **name** including extension prefix (e.g. `RENDER:CreatePicture`, `XI2:XIQueryDevice`),
  - **summary** — a syntax-highlighted, one-line pretty-printed call with the key args (see §6.5),
  - sequence #, timestamp, size (bytes), **RTT** (for request rows with a reply),
  - linkage affordances (jump-to-reply/‑error/‑creator icons).
- **FR-22** **Color-coded rows** by category (request / reply / event / error) plus subtle secondary coding by extension or by request-that-allocates. Meets the "color coded rows" requirement; see [§7 legend](#7-ux--visual-design).
- **FR-23** Selecting a row opens the **detail pane** (§6.5–6.6) and cross-highlights its **linked partner(s)** in the list (reply/error/creator), per the "highlight matching linked side" requirement.
- **FR-24** **Filter & search** (§6.10) always available above the list.

### 6.5 UI — detail pane: decoded fields
The user asked whether to render requests as **static syntax-highlighted source** or an **AST-like tree**. **Recommendation: do both, layered — they serve different jobs and share the same span metadata.**

- **FR-25 (tree — primary).** A **collapsible AST/tree** of fields is the primary deep-inspection view. It's the natural fit for: nested structures, value-mask expansion, **folding long lists/binary** behind a single node, and hanging **resource links** and **atom names** off individual leaves. Each node shows name, type, decoded value, and (on demand) its raw bytes; each node maps to a hex span.
- **FR-26 (code view — secondary).** A **syntax-highlighted, pretty-printed call** renders the message as a function call, e.g.
  `CreateWindow(depth=24, wid=0x04800001→, parent=0x04800000→root, x=0, y=0, width=800, height=600, class=InputOutput, visual=0x21, value_mask=BackPixel|EventMask, background_pixel=0xffffff, event_mask=Exposure|KeyPress)`.
  This is the fast-scan representation and also feeds the list **summary** column. Every token carries a span, so hover-highlight works here too; resource args are clickable. Large args collapse to `[…]`/`[Buffer N bytes]` with expand-in-tree.
- **FR-27** Both views support **copy** (raw hex, decoded text, and *"copy as `node-x11` call"* for reproduction).
- **FR-28** The detail pane also shows message **metadata**: category, sequence #, extension, opcode(s), timing, linkage, and (for requests) reply/error status.

### 6.6 UI — hex view & synchronized highlighting
- **FR-29** A **hex + ASCII view** of the message's raw bytes (with offsets, 4-byte grouping to match X11 word alignment). For replies/events/errors, this is the **second column** the requirement calls for; for requests too.
- **FR-30** **Bidirectional hover highlighting.** Hovering a field (in tree *or* code view) highlights its exact byte span in the hex view; hovering/selecting bytes highlights the owning field. Nested selections highlight the enclosing struct faintly and the leaf strongly. Works identically for request args **and** event/error fields (explicit requirement).
- **FR-31** **Click-to-pin** a highlight so it persists while you read; multi-field highlight when a struct is selected.
- **FR-32** Padding bytes, unused bytes, and length/opcode header bytes are visually distinct (so it's obvious which bytes are "real" vs alignment).

### 6.7 Resource navigation (jump-to-creator)
- **FR-33** Any field typed as a resource (WINDOW, PIXMAP, DRAWABLE, GCONTEXT, FONT, FONTABLE, COLORMAP, CURSOR, PICTURE, GLYPHSET, PICTFORMAT, DAMAGE, REGION, XI device id where meaningful, GLX ids, SYNC counter/fence, …) is a **link**. Clicking **jumps to the creating request's row**; hovering shows a **tooltip**: resource **type**, the XID (hex), creator seq #, a one-line creation summary (e.g. window geometry, pixmap `w×h×depth`, picture's drawable+format), and **lifecycle state** (alive / freed at seq N / *server-owned* / *never created — possible bug*).
- **FR-34** Reverse navigation: from a resource-creating request, **list all messages that reference the XID** ("find usages"), and jump between them.
- **FR-35** Lints surfaced inline: **use-after-free**, **double-free**, **reference to unknown XID**, **leaked resource** (created, never freed by session end) — non-blocking, toggleable.

### 6.8 Binary & large-data visualization
The user asked how to visualize large arrays / binary input (`[Buffer 12345 bytes]`, image, glyph, …). **Recommendation: collapse by default, then offer a content-type-aware preview.**

- **FR-36** **Large lists** (points, rectangles, arcs, CARD32 arrays, char/glyph lists) render as a **folded node** `LISTofPOINT[2048] ▶` with count and byte size; expanding shows a **virtualized** sub-list (never render 100k DOM rows). A compact tabular/columnar view for uniform element types.
- **FR-37** **Binary blobs** show a header `[Buffer 12345 bytes]` with an on-demand hex mini-view, a **content-type-aware preview**, and a **"save blob"** action. Previews:
  - **Images** — `PutImage`/`GetImage`/`ShmPutImage`: render to `<canvas>` using the message's `depth`, `format` (XYPixmap/ZPixmap/Bitmap), the connection's `image-byte-order`, `bitmap-bit-order`, `scanline-pad`, and the visual's masks. This is the flagship "visualize binary as image" feature and doubles as a byte-order/padding debugging aid.
  - **Glyphs** — RENDER `AddGlyphs`, core font glyphs: render each glyph bitmap at its metrics.
  - **Cursors** — `CreateCursor`/RENDER cursors: render bitmap+mask.
  - **Text / properties** — decode `STRING8`/`STRING16`/`UTF8_STRING` and property values per atom type (§6.19).
  - **Keymaps / modifier maps** — tabular keycode→keysym rendering.
  - **Fallback** — hex+ASCII with offsets.
- **FR-38** Preview rendering is **lazy** and size-guarded (only decode/paint on expand; cap auto-preview above a size threshold with an explicit "render anyway").

### 6.9 Network emulation / throttling
- **FR-39** Per-direction **added latency** (ms) and **throughput cap** (kbit/s), implemented as a FIFO **delay queue + token-bucket** on each direction. **Never reorder** within a direction. Optionally model a fixed per-message overhead.
- **FR-40** **Presets modeled on Chrome DevTools** plus X11-relevant profiles; all values live in an **editable config** and can be tuned live. Suggested defaults (approximate; editable):

  | Preset | ↓ throughput | ↑ throughput | Added RTT | Notes |
  |---|---|---|---|---|
  | No throttling | ∞ | ∞ | 0 | pure pass-through |
  | Local / Unix socket | ∞ | ∞ | ~0 | realistic local baseline |
  | LAN | 100 Mbit/s | 100 Mbit/s | ~1 ms | |
  | Wi-Fi | 30 Mbit/s | 15 Mbit/s | ~5 ms | |
  | Fast 4G | 4 Mbit/s | 3 Mbit/s | ~20 ms | |
  | Slow 4G | 1.5 Mbit/s | 0.75 Mbit/s | ~50 ms | |
  | Fast 3G | 1.5 Mbit/s | 0.75 Mbit/s | ~150 ms | |
  | Slow 3G | 0.4 Mbit/s | 0.4 Mbit/s | ~300 ms | |
  | WAN / SSH X-forward | 5 Mbit/s | 5 Mbit/s | ~80 ms | the "why is X11 slow remotely" case |
  | Transatlantic | 20 Mbit/s | 20 Mbit/s | ~120 ms | |
  | Custom… | user | user | user | saved profiles |

- **FR-41** **Round-trip insight** ties throttling to analysis: visually flag request→reply **round-trips** and **synchronous stalls** (a request whose reply the client clearly waits on before its next request). Under added latency, surface an estimated wall-clock cost and a **"round-trip count"** stat — the single most useful number for X11-over-network performance work.
- **FR-42** Throttle state is per-proxy (optionally per-connection), toggleable live, and shown in the toolbar.

### 6.10 Filtering, search & statistics
- **FR-43** **Filter** by category, direction, extension, message name/opcode, sequence range, size, RTT threshold, and **by resource XID / atom** ("show everything touching `0x04800001`").
- **FR-44** **Free-text search** across decoded fields and hex.
- **FR-45** **Stats panel:** counts by category/extension/name, bytes per direction, top messages, round-trip count and total emulated latency cost, resource allocation tally (alive/freed/leaked).

### 6.11 Persistence
- **FR-46** **Save / load captures** to a self-contained file (raw bytes + framing/state + metadata) for offline inspection and bug-report sharing. Loading yields the identical decode/linkage without a live server.
- **FR-47** Support headless capture (`x11vis --record out.x11cap`) and later open in the UI.
- **FR-48** *(Nice-to-have)* import/export a subset or a single message; export decoded text/JSON.

### 6.12 UI platform (react-x11) — constraints & self-inspection
- **FR-49** The UI **must be built with `react-x11` and `react-x11-components`**, rendering as a native X11 application. No browser, Electron, or web view is involved. Both packages are **published on npm** (`react-x11@2.0.0`, `@react-x11/components@0.2.0`) — depend on them as ordinary **semver ranges** (see §10 for the dependency form).*(Superseded: they were tracked from their GitHub default branches until those releases landed.)*
- **FR-50** Reuse `react-x11-components` widgets rather than rebuilding them; see the component mapping in §7. Build custom only what the library lacks (principally the **hex view** and the **span-highlight overlay**).
- **FR-51** **The UI's own X11 connection must bypass the proxy.** `react-x11` connects to the real `$DISPLAY` directly, never to the tool's own listener, so the UI's rendering traffic is never captured as if it were the subject. This must hold even when the user sets `DISPLAY=localhost:1` in their shell: the UI resolves its target from the **original, pre-proxy display** captured at startup (`--ui-display` overrides).
- **FR-52** **Self-inspection is an explicit, supported mode** (and the best demo): pointing a *second* instance of the tool at the first — or launching the UI deliberately through the proxy via `--ui-through-proxy` — lets `x11vis` visualize `react-x11`'s own rendering. This makes it a development aid for `react-x11` itself (spot redundant `PolyFillRectangle`s, glyph re-uploads, round-trip stalls).
- **FR-53** **Guard against capture feedback loops.** If the UI's own traffic is ever captured (deliberately or by misconfiguration), rendering the captured rows must not itself generate unbounded new captured traffic. Mitigations: the mandatory bypass (FR-51), a self-connection detector that tags and can auto-filter the UI's own connection, and decoupling row ingestion from repaint (batched, coalesced updates).
- **FR-54** The tool must **degrade gracefully without a display**: `--record`/headless mode runs the proxy with no `react-x11` root, so captures work over SSH without X forwarding.

---

## 7. UX & visual design

**Layout** (three coordinated regions, Wireshark-informed but leaner):

```
┌ toolbar: start/stop · clear · throttle preset ▾ · filter ▢ · connection ▾ · stats ─┐
├───────────────────────────────────────────────────────────────────────────────────┤
│  PACKET LIST (virtualized)                                                          │
│  ▸ req  RENDER:CreatePicture   pict=0x048…→  drawable=0x048…→  #42   1.2ms  84B  ↩︎  │
│  ◂ rep  QueryExtension         present=yes major=140          #41   0.3ms  32B      │
│  ◂ err  Window (BadWindow)     bad=0x048…    →#39             #39          32B  ↩︎  │
│  ◂ evt  XI2:XI_Motion          dev=3 root=…                   (seq 44)     56B      │
├──────────────────────────────┬────────────────────────────────────────────────────┤
│ DETAIL — tree + code (§6.5)  │  HEX + ASCII (§6.6)                                  │
│  ▾ CreateWindow              │  0000  3d 0a 08 00  01 00 80 04  00 00 80 04  =.......│
│    depth: 24                 │  0010  00 00 00 00  20 03 58 02  21 00 00 00  .... .X.│
│    wid: 0x04800001 →         │  …  (hover a field ⇄ span lights up here)            │
│    ▸ value_mask: BackPixel|… │                                                       │
│    ▸ LISTofVALUE[2] ▶        │                                                       │
└──────────────────────────────┴────────────────────────────────────────────────────┘
```

**Color coding (category — the primary requirement).** Distinct, colorblind-safe hues with light/dark variants:
- **Request** — blue
- **Reply** — green
- **Error** — red
- **Event** — amber/violet (events are server-initiated, visually separated from replies)
- **Setup handshake** — neutral/gray
- **Secondary coding:** a thin left-border tint by extension; a small "⊕ allocates" marker on resource-creating requests; a "freed" strike affordance on free/destroy.

**Key interactions**
- Select row → detail + hex populate; **linked partner(s) highlighted** in the list (reply/error/creator), with jump icons.
- Hover field ⇄ hex span highlight (both directions); click to pin.
- Click a resource arg → jump to creator; hover → lifecycle tooltip.
- "Find usages" from any resource; filter chip appears.
- Toolbar throttle selector; live RTT/round-trip stats update as you throttle.
- Pause/tail toggle for live capture; clear; save/load.

**Accessibility & polish:** colorblind-safe palette with badges/icons not relying on color alone; keyboard navigation of the list and tree; monospace hex with stable column widths; light/dark themes.

### 7.1 Component mapping (`react-x11-components` → UI element)

The component library covers most of this UI off the shelf; the table below is the build-vs-reuse decision (FR-50).

| UI element | Component | Notes |
|---|---|---|
| Packet list (§6.4) | **`Table`** | Already sortable + **virtualized** with resizable columns — satisfies FR-20 directly. Cell seams render category badges and colored rows. |
| Field tree (§6.5, FR-25) | **`Tree`** | Virtualized disclosure tree with custom row rendering and type-ahead — exactly the AST view, incl. folding long lists (FR-36). |
| Pretty-printed call (§6.5, FR-26) | **`Code`** | Static, selectable, syntax-highlighted; tokens carry spans for hover-highlight. |
| Resource tooltips (FR-33) | **`Tooltip`** (core) | Lifecycle/type/creator tooltip. |
| Hex view (§6.6) | **custom** | Build on `<box>`/`<text>`; a fixed grid of monospace cells with per-cell highlight state. The main custom widget. |
| Span highlight overlay | **custom** | Background tint on tree rows / `Code` token ranges / hex cells, driven by one shared hover-span store. |
| Image, glyph, cursor previews (FR-37) | **`<canvas>`** (core) | XRender-backed 2D context; paint decoded pixels directly. |
| Stats panel (§6.10, FR-45) | **`BarChart` / `LineChart`** | Counts by type; bytes and round-trips over time. |
| Timing / round-trip view (FR-41) | **`Timeline`** | Request→reply spans; makes latency stalls visible under throttling. |
| Resource graph *(stretch)* | **`Flow`** | Window tree / resource parentage as a directed graph. |
| Toolbar, filters, throttle picker | core widgets | `Button`, `Select`, `TextInput`, `Checkbox`, `MenuBar`, `SplitPane` for the three-region layout. |
| Capture file open/save | `Dialog` + core | File chooser for `.x11cap`. |

**Layout:** `SplitPane` for the list/detail and detail/hex divisions; Yoga flexbox (`<box>` with `flexGrow`) throughout, consistent with `react-x11`'s style system.

---

## 8. Non-functional requirements

- **NFR-1 Fidelity:** pass-through is byte-exact; the tool must be safe to leave in the path of a real session.
- **NFR-2 Performance:** sustain thousands of messages/sec without UI jank; framing + summary on the hot path, full decode lazily; list virtualization; payloads retained by reference.
- **NFR-3 Robustness:** malformed/truncated/unknown traffic never crashes the proxy or the relay; decode is sandboxed from forwarding.
- **NFR-4 Correctness of state:** sequence/extension/XID/atom tracking must handle wraps, out-of-order edge cases, multiple connections, and partial captures.
- **NFR-5 Security/privacy:** bind localhost by default; never persist/log auth cookies or input events unless explicitly enabled; clear in-UI warning that captures may contain keystrokes/clipboard/secrets.
- **NFR-6 Portability:** Linux + macOS (XQuartz) hosts; Unix-socket and TCP targets; handle both byte orders. The UI inherits `react-x11`'s reach (Linux desktops + XQuartz).
- **NFR-7 UI responsiveness under self-load:** because the UI is itself an X11 client, its own rendering cost is on the same machine as the traffic under study. Repaints must be **coalesced and virtualized** so a busy capture doesn't turn into a UI-traffic storm (FR-53); the packet list must never repaint more than once per frame regardless of ingest rate.
- **NFR-8 Upstream volatility:** `react-x11`/`react-x11-components` are early-version packages (`2.0.0` / `0.2.0`) — published, but still moving fast, and `0.x` on the components means a minor bump may break. Isolate their surface behind thin local wrappers where practical so a breaking upstream change is a one-file fix, and rely on the committed lockfile for reproducible builds (§10). *(Superseded: this previously called for pinning git SHAs for releases, which the npm releases made unnecessary.)*

---

## 9. Roadmap / phasing

**M0 — Transparent proxy (walking skeleton)**
TCP :6001 → `$DISPLAY` (unix + TCP targets), multi-connection, byte-exact relay, message framing per direction, live row list with category + name + size, raw hex view. Auth pass-through. Save/load raw.
*Also in M0:* stand up the `react-x11` app shell (window + `SplitPane` + `Table`), the **UI-bypasses-proxy** wiring (FR-51), and the GitHub-branch dependency setup — these are foundational and cheap to get wrong later.

**M1 — Span-aware core decode + linkage**
Data-driven core decoder with spans; connection-setup decode; sequence linking (request↔reply↔error) + RTT; tree + code detail views; bidirectional hover highlight; color coding; filter/search.

**M2 — State & navigation**
Extension registry + core-extension decoders (RENDER, SHAPE, XFIXES, RANDR, XI2, SHM, DAMAGE, SYNC, Present, BIG-REQUESTS); XID tracking + jump-to-creator + tooltips + find-usages; atom + property awareness; resource lints.

**M3 — Network emulation**
Per-direction latency + throughput, presets + custom profiles, live toggling, round-trip insight & stats.

**M4 — Binary/rich visualization**
Image rendering (`PutImage`/`GetImage`), glyphs, cursors, property/type-aware values, virtualized large lists, blob save.

**Stretch / post-v1**
- **Breakpoints & stepping** (pause forwarding on matching messages; step) — a natural superpower of MITM+throttle.
- **Fault injection** (drop/delay/mutate specific messages) for client-robustness testing.
- Full **XKB** decode; broader extension coverage from `xcbproto`.
- **Unix-socket listener** mode; SSH/remote capture helper.
- Diff two captures; annotate/share.
- **Resource/window-tree graph** via `Flow`; **`Timeline`**-based latency waterfall as a first-class view.
- **`react-x11` profiling mode** — aggregate captured traffic by originating React component/commit, turning the tool into a renderer profiler (needs a cooperating hook in `react-x11`).

---

## 10. Tech stack & key implementation notes

- **Runtime:** Node.js + TypeScript, one process for proxy + UI. `net` for TCP + Unix sockets.
- **Wire (de)serialization: [`node-x11`](https://github.com/sidorares/node-x11)** — reuse its opcode/type tables, `autogen/` definitions, and `lib/ext/*` extension modules rather than re-deriving them. Its unpack path yields values but **not byte spans**, so `x11vis` wraps it in a span-aware reader layer; see [decoder-and-state.md §2](./decoder-and-state.md#2-where-the-protocol-description-comes-from). Published on npm, so a normal dependency.
- **UI: [`react-x11`](https://github.com/sidorares/react-x11) + [`react-x11-components`](https://github.com/sidorares/react-x11-components)** (FR-49). A React reconciler whose host environment is the X server: `<window>`, `<box>`, `<text>`, `<canvas>`, Yoga flexbox layout, fontkit text shaping, XRender drawing, and synthetic capture/bubble events (`onClick`, `onMouseEnter/Leave`, `onWheel`, `onKeyDown`) — the hover-highlight interactions in §6.6 map onto these directly.
- **Dependency form — both UI packages are published on npm.** Depend on **semver ranges**:
  ```json
  {
    "optionalDependencies": {
      "react-x11": "^2.0.0",
      "@react-x11/components": "^0.2.0",
      "react": "^19"
    }
  }
  ```
  `react-x11-components` takes `react-x11` as a **peer** dependency deliberately (to prevent a duplicate reconciler instance) — keep exactly one copy resolved; verify with `npm ls react-x11` in CI. `@react-x11/components@0.2.0` declares peer `react-x11@^2.0.0`, which `^2.0.0` satisfies, so the install needs no `legacy-peer-deps` escape hatch. **Pinning policy:** the committed lockfile provides reproducibility; treat a `@react-x11/components` **minor** bump as potentially breaking while it is `0.x`. *(Superseded: this previously specified `github:sidorares/...` branch deps and SHA pinning for releases.)*
- **Protocol definitions:** **generate span-aware decoders from `xcbproto` XML** (core + extensions) via a build-time codegen, seeded by `node-x11`'s existing tables for the core. This is the extension-coverage multiplier — see [decoder-and-state.md §2](./decoder-and-state.md#2-where-the-protocol-description-comes-from).
- **State/store:** plain in-process store (a small observable + React `useSyncExternalStore`); no IPC or network layer between capture and UI (§5). Updates are **batched/coalesced** per frame to satisfy FR-53.
- **Packaging:** single `x11vis` CLI that starts the proxy and opens the UI window; `--record` runs headless (no X connection needed, FR-54).
- **Alternatives considered & rejected:** browser SPA (would add a WebSocket boundary, a second toolchain, and — the deciding factor — would not dogfood `react-x11`); Electron (heavier still); terminal TUI (loses hex/image richness).
- **Why this stack is a good fit beyond the requirement:** the tool becomes a serious dogfooding vehicle for `react-x11` — a demanding, data-dense, virtualization-heavy app whose whole purpose is to expose exactly the protocol inefficiencies a renderer might have (FR-52). Bugs and perf issues found here feed straight back into the renderer.
- **Risks:** both UI packages are pre-npm and moving; `Table`/`Tree` virtualization must hold at 100k+ rows; the custom hex grid is thousands of small text cells per frame and needs a coarser drawing strategy (see [decoder-and-state.md §7.1](./decoder-and-state.md#71-ui-performance-notes-react-x11-specific)) rather than one `<text>` node per byte.

See the companion **[decoder-and-state.md](./decoder-and-state.md)** for the decoder, span model, and the sequence/extension/XID/atom state machines.

---

## 11. Open questions / decisions to confirm

1. **Protocol source of truth:** generate from `xcbproto` XML (max coverage, build complexity) vs. hand-port `node-x11` tables (faster start, narrower)? *Recommendation: xcbproto codegen, seeded by node-x11 for the core.*
2. **Listener transport:** TCP-only for v1 (per the requirement) vs. also a Unix-socket listener for transparent `DISPLAY=:n` attach? *Recommendation: TCP for v1, Unix socket as M-stretch.*
3. ~~**Decode locus:** backend-decodes-to-JSON vs. raw-bytes + isomorphic on-demand decode.~~ **Resolved** by the in-process react-x11 UI: no serialization boundary exists, so decode is simply **lazy and in-process** against the retained buffer (§5).
4. **Capture file format:** custom `.x11cap` (raw + state) vs. pcap-with-metadata? *Recommendation: custom, self-describing, versioned.*
5. **XKB depth in v1:** framing/opcodes only vs. full field decode (XKB is large)? *Recommendation: defer full XKB to post-v1.*
6. **Throttle scope:** per-proxy vs. per-connection granularity for v1? *Recommendation: per-proxy, with per-connection as a fast-follow.*
7. **Naming:** `x11vis`? (used throughout as a placeholder).
8. **`node-x11` reuse depth:** wrap its existing unpack functions in a span-aware reader, or use only its **tables/definitions** and write a fresh span-aware reader against them? *Recommendation: the latter — spans need offset bookkeeping at every read, which the existing unpack path doesn't thread through; the durable value in `node-x11` is the definitions, not the readers. See [decoder-and-state.md §2.1](./decoder-and-state.md#21-what-exactly-to-reuse-from-node-x11).*
9. **Upstream contributions:** if `x11vis` needs a widget or reconciler capability that `react-x11(-components)` lacks (e.g. a virtualized monospace text grid for the hex view, or a render-instrumentation hook for FR-52 profiling), does that land **upstream** in those repos or stay local to this project? *Recommendation: upstream anything generally useful — the hex grid is plausibly a reusable component; keep x11vis-specific glue local.*
10. **Hex-view drawing strategy:** per-byte `<text>` nodes (simple, likely too slow) vs. one `<canvas>` with manual glyph layout vs. per-row pre-shaped text with a highlight rectangle underlay. *Recommendation: prototype early in M1 — this is the highest-risk UI unknown. See [decoder-and-state.md §7.1](./decoder-and-state.md#71-ui-performance-notes-react-x11-specific).*
11. **Font/theme:** which monospace font to require for the hex/code views, and behavior when it's missing (fontkit fallback)?
