// @jsxRuntime automatic
// @jsxImportSource react
/**
 * react-x11 UI entry point.
 *
 * The visualizer's own UI is a native X11 application (docs/PRD.md FR-49):
 * react-x11 is a React reconciler whose host is the X server. It renders
 * straight to `$DISPLAY` (or `--ui-display`), which is the *real* server, not
 * the proxy — so the UI's own drawing traffic is never self-captured (FR-51).
 *
 * This module is intentionally excluded from the core `tsconfig` typecheck: it
 * depends on `react-x11`, an optional (and currently unpublished) dependency.
 * It is loaded lazily by the CLI and falls back to headless if unavailable.
 */

import { createRoot } from 'react-x11';
import { App } from './App.js';
import { iconsAvailable, iconDirectory } from './icons.js';
import type { CaptureStore } from '../core/store.js';
import type { NetworkEmulator } from '../core/throttle.js';
import type { Interceptor } from '../core/intercept.js';

export interface UIOptions {
  display?: string;
  network: NetworkEmulator;
  /** Present only when the CLI was started with `--intercept`. */
  interceptor?: Interceptor;
  onQuit?: () => void;
  onSave?: () => string;
}

export async function startUI(store: CaptureStore, opts: UIOptions) {
  // Render to the real display (bypassing the proxy). If a display is given,
  // hand it to react-x11 explicitly; otherwise it uses $DISPLAY.
  // One line so a missing icon set is obvious rather than a UI full of blanks.
  process.stderr.write(
    iconsAvailable
      ? `[x11vis] icons: ${iconDirectory}\n`
      : '[x11vis] icons: lucide-static not found — buttons will show labels only\n',
  );
  const root = await createRoot(opts.display ? { display: opts.display } : undefined);
  root.render(
    <App
      store={store}
      network={opts.network}
      interceptor={opts.interceptor}
      onQuit={opts.onQuit}
      onSave={opts.onSave}
    />,
  );
  return root;
}
