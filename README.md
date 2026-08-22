# x11vis — X11 protocol visualizer

[![CI](https://github.com/sidorares/x11-protocol-visualizer/actions/workflows/ci.yml/badge.svg)](https://github.com/sidorares/x11-protocol-visualizer/actions/workflows/ci.yml)

A man-in-the-middle X11 proxy with a live protocol inspector. It sits between an
X11 client and the X server, forwards the byte stream faithfully both ways, and
renders every message (request, reply, event, error) as a color-coded,
navigable table with per-field byte mapping.

Fittingly, its own UI is a native X11 application built with
[`react-x11`](https://github.com/sidorares/react-x11) +
[`react-x11-components`](https://github.com/sidorares/react-x11-components) — the
X11 visualizer is itself an X11 client.

![x11vis inspecting a session: the message table on the left, the decoded
request on the right, and the selected field's bytes marked in the hex
dump](docs/img/x11vis.png)

Above: a `GetProperty` is selected, so the right pane shows it as a call with
its arguments, a link to the reply that answered it, and every decoded field.
Picking the `property` field marks the four bytes that carry it — `17000000`,
atom 23, `RESOURCE_MANAGER` — in the hex. That picture is rendered by
`npm run screenshot`, headlessly, by the real UI: see
[Screenshots](#screenshots).

See [`docs/PRD.md`](docs/PRD.md) for the product spec and
[`docs/decoder-and-state.md`](docs/decoder-and-state.md) for the decoder/state
design.

## Status — M0–M4 built

Working and tested against live XQuartz:

- **Transparent TCP proxy** on a configurable port → upstream `$DISPLAY`
  (Unix-socket or TCP target, incl. the XQuartz launchd socket). Byte-exact relay.
- **Per-direction framing**: connection setup handshake, then requests /
  replies+events+errors. Handles byte order, `BIG-REQUESTS` extended length,
  `GenericEvent` (XGE), and `KeymapNotify`.
- **Sequence linking**: replies/errors matched to their request (16→32-bit
  sequence widening), with round-trip time.
- **Request decoding** for common requests (CreateWindow, InternAtom,
  QueryExtension, GetProperty, CreateGC, …) with per-field byte spans.
- **Reply decoding** — a reply carries no opcode, so it is decoded using the
  opcode of the request it answers: GetGeometry, QueryTree, GetProperty (typed
  by its atom, incl. ATOM lists and text), GetWindowAttributes, GetInputFocus,
  QueryPointer, TranslateCoordinates, ListExtensions, ListProperties, ListFonts,
  AllocColor, QueryBestSize, GetImage, GetKeyboardMapping, and more.
- **Extension registry**: learns extension major opcodes from `QueryExtension`
  replies and names subsequent extension traffic.
- **Network emulation** (PRD FR-39…42): per-direction added latency + throughput
  cap with Chrome-style presets, changeable live from the UI or `--network`.
  Verified: the same 22-message `xdpyinfo` session takes ~5 ms unthrottled and
  ~2.9 s on Slow 3G, while remaining byte-exact.
- **Resource tracking** (M2): resource-creating requests (CreateWindow,
  CreatePixmap, CreateGC, RENDER CreatePicture/GlyphSet, …) are recorded, and
  any later field that references that XID links back to its creator —
  **jump-to-creator** in the UI. Server-owned resources (each screen's **root
  window** and **default colormap**) are pre-seeded from the setup reply, so
  references to the root link to the handshake instead of dangling.
- **Image & glyph previews** (PRD FR-37) — `PutImage` and `GetImage` payloads
  are decoded to real pixels and drawn in the detail pane, honouring the
  connection's `image-byte-order`, `bitmap-bit-order`, scanline padding, the
  depth's `bits-per-pixel`, and the visual's colour masks. RENDER `AddGlyphs`
  renders each glyph from its A1/A4/A8/ARGB32 coverage. Decoding is **lazy**
  (only when a message is selected) and size-capped, so a 4 MB PutImage costs
  nothing until you look at it. Previews also appear in creator tooltips.
- **Parameter decoding** — semi-encoded values are made human-readable:
  value-masks expand to named bits (`value-mask=0x800 (event-mask)`), enums to
  names (`class=InputOnly`, `line-style=OnOffDash`), event-masks to their event
  set, pixel and RENDER color values preview as **color swatches**, and RENDER
  `PICTFORMAT` ids resolve to `Direct depth24 R8G8B8` (harvested from
  QueryPictFormats). Applies to CreateWindow/ChangeWindowAttributes,
  CreateGC/ChangeGC, and RENDER CreatePicture/ChangePicture.
- **Extensions** (a data-driven registry — add one per file, see below):
  - **RENDER**: ~30 requests with resource links, color swatches, and a
    QueryVersion reply; RENDER errors.
  - **XInputExtension** (XInput 2): the full XI2 event set (Motion, Button,
    Key, Enter/Leave, Focus, Raw*, Touch*, Gesture*, Hierarchy, Property).
  - **XFIXES, SHAPE, DAMAGE, RANDR, Composite, SYNC, Present, XTEST, XC-MISC,
    DPMS, MIT-SCREEN-SAVER, BIG-REQUESTS**: request/event/error names, with
    field decoders for the resource-creating requests (CreateRegion,
    DAMAGE Create, NameWindowPixmap, …). Full per-field decode of the long tail
    is the `xcbproto`-codegen path noted in the PRD.
- **Filtering**: mute whole categories (click the toolbar chips), mute an
  individual message type (right-click a row, or *Filter → Hide type*), *solo*
  one type, or narrow by a name/summary substring. Active filters show as
  removable chips.
- **react-x11 UI**: menu bar (Capture / View / Filter), draggable split panes,
  network preset dropdown, filter box, virtualized `Table` packet list, `Tree`
  fields + `Code` call view, a synchronized hex view (select a field to
  highlight its bytes; double-click a `→` link to jump to the creator), and a
  console pane for proxy diagnostics. Falls back to a headless console renderer
  with no display.
- **Capture save/load** (`.x11cap`): record a session and reopen it offline.
  The file stores **raw bytes** and replays them through the current decoder, so
  an old capture gains every decoding improvement made since — and doubles as a
  regression corpus. `--record out.x11cap` / `--open out.x11cap`, or
  *Capture → Save capture…* (Ctrl+S) in the UI.
- **Statistics & hotspots** (Statistics tab): traffic and byte totals, round
  trips, **blocking** round trips (the client waited), RTT mean/p50/max, and
  ranked request/event/extension breakdowns — plus **hotspot analysis** aimed at
  protocol efficiency: blocking stalls priced at the observed RTT, repeated
  identical *queries* (cacheable), and per-frame *resource churn*
  (create/destroy cycles that could reuse a buffer).

- **Resource lints** (Statistics → Resources, and badges on the message):
  **use-after-free**, **double-free**, freeing an id never created, and
  resources still live at the end of the capture. Severity is deliberate: a
  running app legitimately holds windows and buffers open, so a live resource is
  *info* — only an accumulation of one type is raised to a suspected leak.
  XID recycling (free then re-create the same id) is understood and not
  mis-reported.
- **Find usages** (FR-34): every message that creates, references or frees a
  resource id. Double-click a resource field, or *Filter → Find usages*, and the
  table filters to that resource's whole lifetime.

- **Cursor previews**: `CreateCursor` composes its source and mask bitmaps —
  which live in pixmaps, not in the request — by resolving the `PutImage`
  messages that filled them, then colouring by the fore/back values.
- **Colormap-aware rendering**: `AllocColor` / `AllocNamedColor` replies are
  paired with their request's colormap to build a palette, so indexed
  (PseudoColor) images render in real colour instead of as intensity.
- **Unix-socket listener** (`--unix N`): also listen on `/tmp/.X11-unix/XN` so a
  client attaches with a plain `DISPLAY=:N`. Stale sockets are cleaned up.
- **Breakpoints & fault injection** (`--intercept`): rules match on name,
  direction or category and `break` (hold the message — the client really
  blocks), `drop`, or `delay` it. **Opt-in**, because it switches forwarding
  from raw chunks to whole framed messages. Holding a message holds everything
  behind it in that direction — a breakpoint stops the client, it does not just
  delay one packet. Drive it from the **Intercept menu** (break/drop/delay the selected type, Step `Ctrl+N`, Continue `Ctrl+G`,
  toggle or remove rules), or seed rules from the CLI with `--break <name>` /
  `--drop <name>`, or build one in **Break on…** (`Ctrl+B`): a tree of the whole
  protocol catalog — every request, response, event and error — with per-parameter
  conditions (numbers, strings, resource ids, and an **atom picker**), or a
  **Script** tab for a JavaScript expression. Both forms evaluate against the
  same match context: `kind`, `msg`, `request` and `atom(name)`. `request` is
  what lets a rule on a *response* reach the request that asked for it, e.g.
  `kind === 'reply' && msg.name.includes('AddGlyphs') && request.f['num-glyphs'] > 100`.
  A debugger toolbar shows Paused/Running with **Step / Continue / Skip**, the
  held message, and how many are queued behind it.
- **Diff two captures** (`--diff a.x11cap b.x11cap`): what changed between two
  runs, compared over aggregates that survive differing XIDs and timing.
- **Generated protocol tables** (`npm run gen:protocol`): names, enums,
  value-mask bits and fixed-prefix field layouts generated from the **xcbproto
  XML corpus** (32 files → 652 requests, 102 events, 67 errors, 230 enums).
  Used as a fallback wherever a hand-written spec doesn't cover a message, which
  removes the `ext139:req4` long tail entirely. Variable-length tails (lists,
  `<switch>`) are not generated — such a message decodes up to that point and is
  marked `partial`.

Not yet built: full variable-length decode for the generated long tail (the
remaining half of the codegen — lists, `<switch>` bitcases and xcbproto's
expression language).

### UI layout

- **Menu bar** — *Capture* (pause/resume `Ctrl+P`, clear log `Ctrl+K`, save
  `Ctrl+S`, quit), *View* (console, columns, jump to newest), *Filter*, and a
  *Network* preset picker in the toolbar.
- **Right pane tabs** — *Detail* (per-message decode) and *Statistics*
  (traffic, round trips, hotspots).
- **Intercept bar** — appears only when rules exist or a message is held; the
  held state is prominent because the client is blocked while it shows.
- **Packet table** — one row per message, color-coded by kind.
- **Detail pane** (right of the drag handle) — pretty-printed call, field list,
  and hex; selecting a field highlights exactly the bytes it came from.
- **Console pane** (below the table) — proxy diagnostics only: connections
  opening and closing, decode failures, network-profile changes. It is
  deliberately *not* a second copy of the packet table; hide it from *View*
  (hidden, the table fills the whole left column).
- **Filtering** — toolbar chips mute categories; the filter box narrows by
  substring; right-click a row to hide that type; *Filter* menu has Hide
  (`Ctrl+H`), Solo, per-category toggles, Find usages, and Clear all. Active
  filters appear as removable chips under the toolbar.

## Requirements

- Node.js ≥ 22 (developed on 26).
- For the UI: a running X server (Linux, or XQuartz on macOS). Without one, use
  `--no-ui` / `--record`.

## Install

```bash
npm install
```

The **proxy/decoder core has no runtime dependencies** and always installs. The
UI stack (`react-x11`, `@react-x11/components`) is in `optionalDependencies`,
pulled from GitHub (neither is on npm yet). Two known wrinkles, both handled:

- `.npmrc` sets `legacy-peer-deps=true` because `@react-x11/components@0.1.0`
  declares peer `react-x11@^2` while `react-x11` is at `1.2.0` (a pre-release
  version-number mismatch between the two co-developed repos).
- `@react-x11/components` currently ships without a prebuilt `dist/` on install;
  if the UI reports the components missing, build them once:
  `cd node_modules/@react-x11/components && npm i --ignore-scripts && npx tsc -p tsconfig.build.json`
  (or check out the repo and `npm run build`).

If the UI can't load, `x11vis` runs headless automatically.

## Usage

Start the proxy (and UI, if a display is available):

```bash
npm start -- --port 6001
```

Then point a client at it over TCP (`localhost:1` → TCP port 6001):

```bash
DISPLAY=127.0.0.1:1 xdpyinfo
```

The proxy forwards to your real `$DISPLAY`; the UI renders to that same real
display, so its own drawing traffic is **not** self-captured.

### Options

```
-p, --port <n>        TCP port to listen on (default 6001)
-d, --display <s>     Upstream X server DISPLAY (default: $DISPLAY)
    --record <file>   Record the session to <file> (.x11cap)
    --no-ui           Headless: log to console, don't open the UI
    --ui-display <s>  DISPLAY for the UI window (default: $DISPLAY)
-o, --open <file>     Open a saved .x11cap for offline inspection
-u, --unix <n>        Also listen on /tmp/.X11-unix/X<n> (DISPLAY=:<n>)
    --intercept       Enable breakpoints / fault injection
    --break <name>    Hold matching messages (implies --intercept)
    --drop <name>     Never forward matching messages
    --diff <a> <b>    Compare two captures and print what changed
-n, --network <id>    Network emulation preset (also changeable live in the UI):
                      none, local, lan, wifi, fast4g, slow4g, fast3g, slow3g,
                      ssh, transatlantic
-q, --quiet           Suppress per-message console output
-h, --help
```

Feel how chatty a client is over a WAN link — same traffic, ~600× the wall clock:

```bash
npm start -- --network ssh
```

Headless capture (no X needed), e.g. over SSH:

```bash
npm start -- --no-ui --record capture.jsonl
```

## Development

```bash
npm install            # core + dev deps; the react-x11 UI stack is optional
npm test               # decoder, framing, rules, capture tests — no X server needed
npm run typecheck
npm run gen:protocol   # regenerate protocol tables from an xcbproto XML corpus
npm run check:generated
npm run screenshot     # regenerate docs/img/*.png headlessly (no X server)
```

The core (`src/core`) is pure Node + TypeScript with **no runtime dependencies**
and is tested independently of the UI (`src/ui`), which is excluded from the
core typecheck because it depends on the optional react-x11 stack. CI installs
with `--omit=optional` and never needs a display.

`src/core/protocol/generated.ts` is generated from the
[xcbproto](https://gitlab.freedesktop.org/xorg/proto/xcbproto) XML corpus and
committed, so nothing needs xcbproto installed in order to run. Regenerate with
`npm run gen:protocol` — it reads `/opt/X11/share/xcb` by default (XQuartz ships
the corpus there) or takes a directory argument.

See [AGENTS.md](AGENTS.md) for scope, architecture and the invariants worth not
breaking.

## Screenshots

`npm run screenshot` regenerates `docs/img/*.png` with **no `$DISPLAY`, no
xvfb and no XQuartz**. `scripts/screenshot.tsx` mounts the real UI through
[`react-x11/test`](https://github.com/sidorares/react-x11) against node-x11's
in-process pure-JS X server, clicks through it with the real event pipeline,
and reads the pixels back off the window's own 2d context. The approach is
react-x11's (its `npm run screenshots`), adopted wholesale; it replaces an
`xwd` recipe that needed a live server and broke on a multi-monitor desktop,
where `GetImage` cannot read a root window that is mostly off-screen.

The traffic in the picture is **synthesized, not recorded**: hand-built X11
bytes fed through the shipping `ConnectionCapture`, so every field, span, link
and resource shown was decoded by the real decoder. A recording would have been
both non-deterministic and unpublishable — captures carry window titles,
clipboard contents and keystrokes, which is why `*.x11cap` is gitignored.

Because the PNGs are committed, everything that would otherwise vary per run is
pinned: the wall clock, the animation clock (react-x11 transitions the
row-selection colour — read the pixels too early and you photograph a fade),
the fonts (family resolution otherwise shells out to `fc-match`), and
react-x11's palette, which follows the desktop unless told not to. Run it on
a machine with Arial (macOS) or Liberation/DejaVu (Linux) installed.

## Layout

```
src/core/                proxy, framing, state machines, protocol tables (tested core)
src/core/protocol/       core request/reply decoders + tables
src/core/protocol/extensions/   one file per extension (render.ts, xinput.ts, …)
src/ui/                  react-x11 application (Table / Tree / Code / hex)
src/cli.ts               entry point: proxy + UI-or-headless
test/                    unit tests
docs/                    PRD + decoder/state design
```

## Adding an extension

Extensions are data-driven, resolved at runtime from the `QueryExtension`
negotiation. To add one:

1. Write `src/core/protocol/extensions/<name>.ts` exporting an `ExtensionSpec`
   — `requests` keyed by minor opcode, `xgeEvents` by XI-style evtype, `events`
   by offset from the extension's first-event, `errors` by offset from its
   first-error. Each decoder returns `{ summary, fields, created? }`, where
   every field carries a byte span and `created` records a resource for
   jump-to-creator.
2. Register it in `extensions/index.ts` under the exact name `QueryExtension`
   returns (e.g. `RENDER`, `XInputExtension`).

Nothing in the connection engine changes; `RENDER` and `XInputExtension` are
the worked examples.

## License

ISC
