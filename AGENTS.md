# AGENTS.md — working notes for x11vis

Orientation for anyone (human or agent) picking this project up. Read this
first, then [`docs/PRD.md`](docs/PRD.md) for the product spec and
[`docs/decoder-and-state.md`](docs/decoder-and-state.md) for the decoder design.

## What this is

**x11vis** is a man-in-the-middle X11 proxy with a live protocol inspector. It
sits between an X11 client and the X server, forwards bytes faithfully, and
renders every message (request / reply / event / error) as a decoded,
navigable, color-coded view — Wireshark for the X11 wire protocol.

Its own UI is a native X11 application built with `react-x11` +
`@react-x11/components`, so the X11 visualizer is itself an X11 client.

## Scope and goals

**Primary — understand and debug the X11 wire protocol.** Decode traffic
faithfully, link replies/errors to their requests, track resources, and make
semi-encoded values (bitmasks, enums, formats, raw pixels) human-readable.

**Primary — protocol efficiency profiling for `react-x11` clients.** This is a
first-class use case, not a side effect: point x11vis at a react-x11 app and
find its *hotspots* — blocking round trips, repeated identical queries,
per-frame resource churn, bandwidth-heavy requests. The Statistics tab
(`src/core/stats.ts`) exists for this. When adding analysis, prefer findings a
client author can act on over counters nobody reads.

*Real findings from the first profiling run, as a flavour of what "useful"
means here:* a react-x11 client issued `QueryExtension("RANDR")` three times
and `RANDR:QueryVersion` three times with identical bytes (six avoidable round
trips), and recreated a 300×180 depth-8 mask pixmap + picture **every frame**
(115 create/free cycles in 14 s) instead of reusing one buffer.

**Check merged upstream PRs before working around anything.** react-x11 moves
fast: four of the six gaps filed on 2026-08-22 were fixed the same day, and the
workarounds built for them are now deleted. `gh pr list --repo sidorares/react-x11
--state merged` is worth a look at the start of a session.

**Secondary — improve `react-x11` and `@react-x11/components` themselves.**
x11vis is a demanding consumer (dense, virtualized, pixel-level drawing) and
surfaces friction a demo app never would. When you hit a gap or design flaw,
**say so and name the upstream fix** rather than silently working around it.
Filed so far: react-x11 #366 (putImageData/DrawInfo), #367 (`<image>` source
variants), #368 (Tooltip self-sizing), #369 (Button variants/size/children
colour), #370 (Dialog double title), #371 (`.Xauthority` noise), and
react-x11-components #37 (Table seams).

## Non-goals

A browser/web UI (the native X11 UI is the point), a general pcap analyzer,
Wayland, or a security tool.

## Architecture

```
src/core/                 pure Node + TypeScript, no react-x11 — fully tested
  proxy.ts                TCP listener → upstream; byte-exact relay + throttle
  connection.ts           per-connection framing + state engine (the heart)
  store.ts                in-process observable the UI reads
  throttle.ts             network emulation (latency + throughput)
  stats.ts                statistics + hotspot analysis
  lints.ts                resource lifecycle lints + find-usages (pure pass)
  intercept.ts            breakpoints / fault injection (opt-in). `MessageGate`
                          is a per-direction FIFO — see invariant 9
  rules.ts                the rule engine (predicates + scripts, one context)
  catalog.ts              the browsable protocol catalog for "Break on…"
  diff.ts                 compare two captures
  protocol/generated.ts   GENERATED from xcbproto — do not edit
scripts/gen-protocol.ts   the generator (npm run gen:protocol)
  capture-file.ts         .x11cap save/load (replay-based)
  display.ts              $DISPLAY parsing
  protocol/
    tables.ts             core opcode/event/error names
    enums.ts, valuelist.ts  bitmask/enum/value-list decoding
    replies.ts            reply bodies, keyed by the request's opcode
    image.ts              PutImage/GetImage/glyph → RGBA (lazy)
    extensions/           one file per extension + registry
src/ui/                   react-x11 app (excluded from the core typecheck)
src/cli.ts                entry: proxy + UI-or-headless
fixtures/demo-session.ts  a synthesized session, decoded by the real decoder —
                          shared by the screenshot script and the stories
stories/*.story.tsx       @react-x11/workbench stories for the UI's components
workbench.config.ts       where the workshop looks for them
```

**Load-bearing invariants — do not break these:**

1. **Forwarding never depends on decoding.** Framing uses only length fields; a
   decode failure degrades one row, never the stream. Decode errors are caught.
2. **Every decoded field carries a byte span** `{off, len}`. This powers
   field↔hex highlighting. A decoder that returns values without spans is a
   rewrite later.
3. **The UI's own X11 connection bypasses the proxy** (it renders to the real
   `$DISPLAY`), or it would capture itself into a feedback loop.
4. **Heavy decoding is lazy.** Images/glyphs attach a *spec* (offsets + setup
   facts); pixels are decoded only when a message is selected.
5. **Unthrottled forwarding is a true synchronous pass-through** — no queue, no
   cost — so leaving x11vis in the path is free.
6. **Replies have no opcode of their own**; they are decoded using the opcode of
   the request they answer, found via the sequence table.
7. **Interception is opt-in.** `--intercept` switches forwarding from raw chunks
   to whole framed messages so a message can be held/dropped. Without it,
   invariant 1 holds untouched. Do not make gating the default.
9. **A held message holds everything behind it.** `MessageGate` is a FIFO per
   direction and only ever releases from the head. Letting later messages
   overtake a held one reorders the stream and lets the client run straight
   through the breakpoint — that was a real bug, and `test/intercept.test.ts`
   pins it.
8. **Generated tables never override hand-written ones.** `protocol/generated.ts`
   is a fallback: it fills names and fixed-prefix fields wherever
   `extensions/*.ts` has nothing to say.

## Environment (this machine)

- **XQuartz is installed and running.** `$DISPLAY` is the launchd form
  (`/private/tmp/com.apple.launchd.*/org.xquartz:0`) — the *whole string
  including `:0`* is the socket path. `/tmp/.X11-unix/X0` exists but refuses
  connections.
- Drive traffic through the proxy with `DISPLAY=127.0.0.1:1 <client>`
  (`xdpyinfo`, `xprop`, `xlogo`, or a react-x11 app).
- **Screenshotting the UI:** `npm run screenshot` — headless, no display
  needed. See "Screenshots" below. (`screencapture` cannot see XQuartz windows
  at all, and the `xwd` recipe this file used to give is dead — see below.)
- Throwaway probe clients must live **inside the project** (top-level `await`
  needs the project's `"type": "module"`; a file in `/tmp` fails to transform).
- No `xdotool`/`xinput`, and `CGEventPost` lacks Accessibility permission, so
  **synthetic pointer input is not possible** — verify XI2 event decoding with
  unit tests, not live capture.

## Working practice

- `npm test` — core tests, no X server needed. `npm run typecheck`.
- `npm run workbench` — the component workshop (needs a display);
  `npm run workbench:ls` says what it discovered without one. See "The
  workbench" below.
- The core is tested independently of the UI; `src/ui` is excluded from
  `tsconfig` because it depends on the optional react-x11 stack.
- **Verify on real traffic, not just tests.** Every feature here has been
  confirmed against live XQuartz; screenshots caught bugs unit tests could not
  (e.g. pixels painting at the wrong origin).
- Record a session with `--record out.x11cap`, reopen with `--open out.x11cap`.
  Captures store raw bytes and replay through the current decoder, so an old
  capture gains new decoding for free — a good regression corpus.

## UI conventions

`src/ui/controls.tsx` holds the control set. All four variants are react-x11's
own `<Button variant size>` — do not hand-draw a button; core owns hover, press,
focus and disabled, and an icon child inherits the button's ink.
Build new UI from `Button`, `IconButton`, `Pill`, `TextField` and `Tabs` rather
than hand-rolling boxes, or the interface drifts back to looking assembled.
Icons come from `lucide-static` through `src/ui/icons.tsx`, which renders them
via react-x11's `<svg source>`.

`App.tsx` exports its panels (`Toolbar`, `FilterBar`, `InterceptBar`, `Detail`,
`HexView`, `StatsPanel`, `ConsolePane`) so the workbench stories can mount the
real thing rather than a copy. Keep every export in that module a *component*:
a module whose exports are all components is a self-accepting Fast Refresh
boundary, and exporting a constant from it silently costs the hot-reload loop.

**Run the app with `PATH=/opt/X11/bin:$PATH`** so it picks up the right fonts.

## The workbench

`npm run workbench` (`x11-workbench dev`, needs a display) mounts the UI's
components in isolation — [@react-x11/workbench](https://github.com/sidorares/react-x11-workbench),
which is what Storybook is for a toolkit with no browser to put an iframe in.
`npm run workbench:ls` lists what it discovered and needs no display, which
makes it the cheap check after touching a story.

- **Stories mount the real components.** `stories/*.story.tsx` import from
  `src/ui`, over the same synthesized capture the screenshot uses
  (`fixtures/demo-session.ts`). A story that re-implements a panel is a second
  source of truth that will drift; if a panel cannot be mounted on its own,
  export it rather than copying it.
- **A story is a component, and a file is a group.** Named exports are stories;
  selecting the file previews all of them at once. `story(render, { args })`
  adds a knobs panel — reach for it when the state space is worth sweeping, not
  by default.
- **Wrap a story in `<Ground>`.** It carries both halves of the app's look: the
  window's own ground colour, and the `<ThemeProvider value={PALETTE}>` that
  `App.tsx` puts around the window. Without the provider a `<Button>` or a
  `<Select>` in a story resolves against the *workshop's* palette and is
  previewed in colours it never wears in the app. Declaring `theme: 'dark'` on
  the story file as well keeps the workshop's own chrome in the same scheme.
- **A whole-window story is out of scope by design** — the workshop previews
  components, and a story whose root is a `<window>` throws. `<BreakOnDialog>`
  is the edge case that works: core's `<Dialog>` is a managed popup, so it
  opens beside the workshop rather than inside the frame.
- Stories are excluded from the core typecheck, like `src/ui` itself. The
  fixture is not — it is core-only code, and `tsconfig` includes it.

## Screenshots

`npm run screenshot` regenerates `docs/img/*.png` **headlessly** —
`scripts/screenshot.tsx` mounts the real `<App>` through `react-x11/test`
against node-x11's in-process pure-JS X server, drives it with the real event
pipeline (`userEvent`), and reads pixels back with `toPNG`. No `$DISPLAY`, no
xvfb, no XQuartz. This is react-x11's own recipe (`npm run screenshots`
upstream, documented in its AGENTS.md), adopted here.

It replaced an `xwd`-based recipe that is **dead on this machine**: XQuartz's
root is a multi-display bounding box (5120×2533), and X11 `GetImage` requires
the target rectangle to be fully visible, so `xwd` fails even on the root
window. Don't reach for it again.

Four things are pinned, because the PNGs are committed and anything that varies
per run makes the diff useless as a signal that something visibly changed:

- **The wall clock** — `Date` is frozen, so the console's timestamps are stable.
- **The animation clock** — `withFrameClock()`, installed *before* the render.
  This one is easy to get wrong: the row-selection colour is transitioned, and
  freezing `Date` alone stalls transitions at t=0, so a clicked row either
  photographs mid-fade or never highlights at all. Advance the clock and `act()`
  after every interaction; `settle()` in the script does both.
- **The fonts** — passed explicitly, or family resolution shells out to
  `fc-match` and answers differently on every machine.
- **react-x11's palette** — `colorScheme: 'dark'`. `<App>` pins its own scheme
  now (see *Design tokens* below), so this only seeds the harness's appearance
  store; it is kept so a shot never depends on the developer's desktop.

The traffic is **synthesized, not recorded**: `fixtures/demo-session.ts` is
hand-built X11 bytes fed through the real `ConnectionCapture`, so the decoding
on show is genuine. Do not swap in a real capture — `*.x11cap` is gitignored for
privacy, and a recording would not be reproducible. When adding messages to the
session, note that reply/event/error sequence numbers are derived by the
`req()`/`seq()` counter rather than hand-written, so inserting a request in the
middle stays correct — and that the workbench stories read the same session, so
a message removed from it takes a story's `demoMessage()` lookup with it (which
throws, by design, naming what the session does contain).

## Design tokens

**Every colour in the UI is named once, in `PALETTE` (`src/ui/controls.tsx`),
and nowhere else.** A hex literal anywhere under `src/ui` or `stories/` is a
bug — `grep -n '#[0-9a-fA-F]\{3,8\}' src/ui/*.tsx stories/*.tsx` should only
ever hit that one object and a couple of prose comments.

`PALETTE` is not a private lookup table: it is a **react-x11 theme**, handed to
core by the `<ThemeProvider value={PALETTE} colorScheme="dark">` that wraps the
window. That matters because x11vis is two widget layers in one window — its
own `<box>`es, and core's `MenuBar`/`Select`/`Button`/`Dialog` plus every
`@react-x11/components` widget. Core's layer resolves against the **desktop's**
palette unless an app says otherwise, so before the provider existed the app
came up with light widgets inside a dark shell on any light desktop. The
screenshot script and the stories each pinned `colorScheme: 'dark'` to hide it;
the shipping app pinned nothing.

So:

- **Use core's token name where core has one** — `textMuted`, not `dim`;
  `danger`, not `err`; `background`/`surface`, not `bg`/`panel`. A colour under
  a private name is a colour core's widgets cannot see, which is how the two
  layers drift apart. The handful with no core equivalent (`panelAlt`, `hot`,
  `held`, `imageMat`, `control`, `padXsm`) are grouped at the bottom of the
  object and commented as such.
- **Don't name what core can derive.** Unnamed tokens fall back to core's
  `DarkTheme`, and the derived ones — the pressed step of each fill, the ink
  that goes on it — are better computed than typed (`resolveTheme` in
  react-x11's `palette.js`).
- **`'$token'` works in any style value**, resolved against the nearest theme:
  `fontFamily: '$monoFamily'`, `linear-gradient($accent, $accentActive)`. Reach
  for it in a style that is hoisted out of render, or where the value should
  follow the theme rather than this module's copy of it; `T.textMuted` reads
  the same object and is fine everywhere else.

## react-x11 gotchas (hard-won)

- `cursor` is a **style** prop: `<box style={{ cursor: 'pointer' }}>`.
- **Don't pass `globalMenu={false}` to `<MenuBar>`.** Where the desktop draws
  the menu bar — the macOS bar under the cocoa backend, a dbusmenu panel on
  Linux — it should, and `<MenuBar>` renders nothing in the window. The flag
  had pinned the bar in-window on every desktop, which is why the menus stayed
  in the frame on macOS. It degrades on its own: `useGlobalMenu` is false until
  a transport proves otherwise, so XQuartz, a bare startx and the headless
  screenshot all still get the in-window bar.
- **Trailing whitespace is trimmed out of a text run's advance** — `'ab '`
  measures exactly as wide as `'ab'`, and a no-break space is trimmed the same
  way (measured, both). A column of `<text>` cells that has to line up needs
  `paddingRight`, not a space; see `HEX_GAP` in `App.tsx`.
- Files excluded from `tsconfig` need `// @jsxRuntime automatic` +
  `// @jsxImportSource react`, or you get "React is not defined".
- `ctx.putImageData` **ignores the canvas transform** (spec-correct). `DrawInfo`
  now carries the node origin, so offset by it: `ctx.putImageData(d, info.x, info.y)`.
  For raw pixels prefer `<image src={{width,height,data}} cacheKey=…>` — it needs
  no canvas at all.
- Import ntk only via `react-x11/ntk`; a second `ntk` copy means two font caches.
  (x11vis no longer imports it — `<image>` covers the pixel case.)
- **SVG/icon colour comes from `style.color`, not from editing the markup.**
  react-x11 resolves `currentColor` against the node's own `color`; rewriting
  `stroke="currentColor"` to a literal in the source bypasses that and the icon
  ends up whatever the file said — a dark smudge on a dark panel.
- `Table`'s `value()` is both the sort key and the cell text — returning a
  formatted string silently disables numeric sort. Supply `compare`.
- Custom `Table` `render()` cells don't inherit `textWrap: 'nowrap'`; set it or
  they wrap into two-line rows.

## Status / what's next

Built: M0–M4 plus network emulation, resource jump-to-creator (roots
pre-seeded), filtering, image/glyph previews, capture save/load, statistics and
hotspots, resource lifecycle lints, and find-usages. See the README status
section for detail.

### Regenerating protocol tables

`npm run gen:protocol` reads the xcbproto XML corpus (macOS: XQuartz ships it at
`/opt/X11/share/xcb`; pass another directory as an argument) and writes
`src/core/protocol/generated.ts`. It generates names, enums, value-mask bits,
fixed-prefix field layouts, and the **variable-length tail** after them.

A tail is a *sequence* the decoder walks, not more absolute-offset fields:
once a list appears, nothing after it has a compile-time offset. Lists carry
their length as `lenFrom` (an earlier field), `lenConst`, `lenExpr` (an
arithmetic tree — `data_len * format / 8`) or `lenRest` ("the rest of the
message", which is what xcbproto means when a list declares no length at all).
Struct element sizes are computed to a fix-point, without which the walk
stopped at every drawing request.

**Nothing guesses.** A length that cannot be evaluated marks the message
`partial` rather than falling back to `lenRest` — that fallback would be the
same guess wearing a different hat, and would silently swallow the padding.
Still partial: `<switch>`, `<union>`, and `popcount`/`sumof` lengths — 62 of
652 requests, down from 156.

The layout rules are subtle and are the thing to re-check if offsets look wrong:
a **core request** puts its first 1-byte field in byte 1 then continues at 4; an
**extension request** has the minor opcode in byte 1 so fields start at 4; a
**classic event** mirrors the core request; an **XGE event** starts at byte 10.
`<eventcopy>` borrows the referenced event's layout — XI2 declares most of its
events that way.

Open: `<switch>` bitcases and `<union>`s in the generator. A switch is a
value-list keyed by a bitmask, which the hand-written value-list expansion in
`valuelist.ts` already does well for the masks that matter — so this is worth
doing for coverage, not because anything common is missing.

**On advisory output** (lints, hotspots): calibrate severity honestly. A running
app holding resources open is not a leak; repeated *creates* are not the same
problem as repeated *queries*. A linter that cries wolf gets muted, so prefer
`info` and say what was actually observed.
