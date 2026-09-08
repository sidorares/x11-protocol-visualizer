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

/**
 * Which display system the UI window itself is drawn by.
 *
 * `'auto'` is react-x11's own rule: the native Cocoa backend on macOS, X11
 * via `$DISPLAY` everywhere else, and X11 on a mac with no `@windowkit/appkit`
 * bridge installed so an XQuartz setup keeps working. `'cocoa'` by name makes
 * the bridge a requirement instead, and says so if it is missing.
 *
 * Naming a `--ui-display` is choosing X11 — react-x11 resolves an explicit
 * `display` to the X11 backend, because a display any other backend would
 * ignore is worse than either answer.
 */
export type UIBackend = 'auto' | 'x11' | 'cocoa';

export interface UIOptions {
  display?: string;
  backend?: UIBackend;
  network: NetworkEmulator;
  /** Present only when the CLI was started with `--intercept`. */
  interceptor?: Interceptor;
  onQuit?: () => void;
  onSave?: () => string;
}

/** What actually came up, for the startup line — `auto` resolves to one of these. */
export interface UIHandle {
  root: Awaited<ReturnType<typeof createRoot>>;
  backend: 'x11' | 'cocoa';
  /** The X display in use, or `undefined` under cocoa (which has none). */
  display?: string;
}

export async function startUI(store: CaptureStore, opts: UIOptions): Promise<UIHandle> {
  // Render to the real display (bypassing the proxy). If a display is given,
  // hand it to react-x11 explicitly; otherwise it uses $DISPLAY — or, under
  // `auto` on macOS, no X server at all.
  // One line so a missing icon set is obvious rather than a UI full of blanks.
  process.stderr.write(
    iconsAvailable
      ? `[x11vis] icons: ${iconDirectory}\n`
      : '[x11vis] icons: lucide-static not found — buttons will show labels only\n',
  );
  const backend = opts.backend ?? 'auto';
  const root = await createRoot({
    ...(opts.display ? { display: opts.display } : {}),
    ...(backend === 'auto' ? {} : { backend }),
  });
  root.render(
    <App
      store={store}
      network={opts.network}
      interceptor={opts.interceptor}
      onQuit={opts.onQuit}
      onSave={opts.onSave}
    />,
  );
  // What we asked for is not always what we got: `auto` on a mac without the
  // bridge falls back to X11. Ask the connection instead of re-deriving the
  // rule — only the Cocoa app owns a global-menu transport of its own, which
  // is the same thing `useGlobalMenu` discriminates on.
  const app = (root as { app?: { createGlobalMenuExport?: unknown } }).app;
  const resolved = typeof app?.createGlobalMenuExport === 'function' ? 'cocoa' : 'x11';
  return {
    root,
    backend: resolved,
    display: resolved === 'x11' ? (opts.display ?? process.env.DISPLAY) : undefined,
  };
}
