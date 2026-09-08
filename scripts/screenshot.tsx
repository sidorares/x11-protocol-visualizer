// @jsxRuntime automatic
// @jsxImportSource react
/**
 * Regenerates `docs/img/*.png` headlessly — no $DISPLAY, no xvfb, no XQuartz.
 *
 *   npm run screenshot
 *
 * The recipe is react-x11's own (`scripts/screenshots.jsx` upstream, described
 * in its AGENTS.md): `react-x11/test` mounts the real UI against node-x11's
 * in-process pure-JS X server, drives it through the real event pipeline, and
 * reads the pixels back off the window's 2d context. It is the same code path
 * the app takes on a real server — the only thing missing is a display.
 *
 * That replaces the `xwd` recipe this repo used to carry, which needed a live
 * XQuartz and broke outright on a multi-monitor desktop: X11 `GetImage`
 * requires the target rectangle to be fully visible, and XQuartz's root is the
 * bounding box of every display, most of which is not.
 *
 * ## Determinism
 *
 * These PNGs are committed, so anything that varies between runs shows up as a
 * dirty tree after a regeneration and makes the diff useless as a signal that
 * something actually changed. Pinned here, for the same reasons upstream pins
 * them: the clock (the UI stamps arrival times), the fonts (family resolution
 * otherwise shells out to `fc-match`, which answers differently on every
 * machine and not at all in a container), and react-x11's palette, which
 * follows the desktop unless a test says otherwise.
 *
 * The traffic itself is *synthesized*, not recorded: `fixtures/demo-session.ts`
 * is hand-built X11 bytes fed through the real `ConnectionCapture`, so every
 * field, span, link and resource in the shot was decoded by the shipping
 * decoder, not staged. The workbench stories mount their panels over the same
 * session, so a change to it moves the screenshot and the stories together.
 */

process.env.TZ = 'UTC';

// Freezing `Date.now()` also freezes react-x11's transitions — `nodes.js`
// drives them off it, so anything animated stalls at t=0. Harmless here
// because every scene is captured at rest; a future scene that clicks
// something with a transitioned colour would need a real clock for the paint
// to be honest.
//
// The instant is the fixture's own, so the console's timestamps and the
// session's arrival times come from one constant — readable here even though
// the import sits below, since ESM initializes imports before the body runs.
const FROZEN_MS = DEMO_EPOCH_MS;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: ConstructorParameters<typeof Date>) {
    super(...(args.length ? args : [FROZEN_MS]));
  }
  static now() {
    return FROZEN_MS;
  }
} as DateConstructor;

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import React from 'react';
import { renderX11, userEvent, toPNG, cleanup, act, withFrameClock } from 'react-x11/test';

import { NetworkEmulator } from '../src/core/throttle.ts';
import { App } from '../src/ui/App.tsx';
import { buildDemoStore, DEMO_EPOCH_MS } from '../fixtures/demo-session.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'img');
const WIDTH = 1240;
const HEIGHT = 780;

// --- fonts -----------------------------------------------------------------

// Both faces the app's palette names (`fontFamily` / `monoFamily` in
// `controls.tsx`): proportional for the UI, monospace for the hex dump and the
// code blocks. Registered explicitly so family resolution is not an `fc-match`
// lottery that answers differently on every machine.
const MONO = [
  '/System/Library/Fonts/Supplemental/Courier New.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
];
const SANS = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

function pick(candidates: string[], what: string): string {
  const found = candidates.find((f) => existsSync(f));
  if (!found) {
    throw new Error(
      `no ${what} font found. Tried:\n  ${candidates.join('\n  ')}\n` +
        'Install one (Linux: fonts-liberation or fonts-dejavu-core) and re-run.',
    );
  }
  return found;
}

// --- the shot --------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const store = buildDemoStore(FROZEN_MS);
  const network = new NetworkEmulator();

  // Installed **before** the render, so every timestamp in the tree comes from
  // it. The row-selection colour is transitioned, and the frozen `Date` above
  // stalls transitions at t=0 — so without a clock to advance, a clicked row
  // photographs mid-fade, or never fades in at all.
  const clock = withFrameClock(0);

  const { ctx, getByText, unmount } = await renderX11(<App store={store} network={network} />, {
    // `<App>` renders its own `<window>`, so there is nothing to wrap it in.
    wrap: false,
    width: WIDTH,
    height: HEIGHT,
    screen: { width: WIDTH + 160, height: HEIGHT + 120 },
    fonts: {
      monospace: pick(MONO, 'monospace'),
      'sans-serif': pick(SANS, 'sans-serif'),
    },
    // Belt and braces: `<App>` now pins its own scheme through the
    // `<ThemeProvider>` it wraps the window in, so this only decides what the
    // *test harness* seeds the appearance store with. Kept so a shot never
    // depends on the developer's desktop even for the frame around the window.
    colorScheme: 'dark',
  } as Parameters<typeof renderX11>[1]);

  // Let every transition finish before the next step reads or clicks anything.
  const settle = async () => {
    clock.advance(1000);
    await act();
  };

  // Fold the console away. It is a real panel and a real menu — driven here
  // through the menu bar, popup and all — but with a full table behind it, one
  // line of proxy log is not what deserves the bottom fifth of the window.
  // Exact: the detail pane's hint text contains the word "view" too.
  await userEvent.click(getByText('View', { exact: true }));
  await settle();
  await userEvent.click(getByText('Show console'));
  await settle();

  // Select a request so the shot shows what the tool is actually for: the
  // decoded fields, the link to the reply that answered it, and — after
  // picking a field — that field's bytes marked in the hex.
  // Exact, or it also matches the "GetProperty·reply" row below it.
  await userEvent.click(getByText('GetProperty', { exact: true }));
  await settle();
  await userEvent.click(getByText('property = RESOURCE_MANAGER'));
  await settle();

  await toPNG(ctx, join(OUT_DIR, 'x11vis.png'), { width: WIDTH, height: HEIGHT });
  console.log(`wrote ${join(OUT_DIR, 'x11vis.png')} (${WIDTH}x${HEIGHT})`);

  unmount();
  await cleanup();
}

await main();
