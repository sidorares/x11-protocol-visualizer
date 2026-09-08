// @jsxRuntime automatic
// @jsxImportSource react
/**
 * Shared scaffolding for the stories. Not a story file — the workbench only
 * discovers `*.story.tsx`, so this is a plain module they import.
 *
 * x11vis paints its own ground (`T.background`) on the window and never inherits the
 * desktop's, so a panel previewed on the workshop's ground is a panel on a
 * colour it will never actually sit on. `<Ground>` restores it, which is what
 * makes a story an honest picture of the panel rather than of the workshop.
 *
 * It carries the app's `<ThemeProvider>` too, for the same reason and the
 * other half of it: a `<Button>` or a `<Select>` inside a story otherwise
 * resolves against the *workshop's* palette, so a control would be previewed
 * in colours it never wears in the app. Worse now than it used to be — the
 * app's own boxes paint `'$token'`s, and a token with no provider above it
 * resolves against the workshop instead, or (for the five names only x11vis
 * has — `panelAlt`, `hot`, `hotInk`, `held`, `imageMat`) drops out of the
 * style entirely. This is the same provider `App.tsx`
 * puts around the window, with the same two halves and no pinned scheme — one
 * palette, mounted twice, following the workshop's light/dark either way.
 */

import type { ReactNode } from 'react';
import { ThemeProvider } from 'react-x11';
import { DARK, PALETTE, T } from '../src/ui/controls.js';

/** The app's window ground, with the app's ink. */
export function Ground({ children, padding = 10, gap = 10, width }: {
  children: ReactNode;
  padding?: number;
  gap?: number;
  /** Fixed width, for a panel that fills a pane in the real window. */
  width?: number;
}) {
  return (
    <ThemeProvider value={PALETTE} dark={DARK}>
      <box style={{ flexDirection: 'column', gap, padding, width, backgroundColor: T.background, color: T.text }}>
        {children}
      </box>
    </ThemeProvider>
  );
}

/** A labelled specimen — the caption every variant grid wants. */
export function Specimen({ label, children, row = true }: {
  label: string;
  children: ReactNode;
  /** Lay the specimen out in a row (the default) or a column. */
  row?: boolean;
}) {
  return (
    <box style={{ flexDirection: 'column', gap: 4 }}>
      <text style={{ color: T.textMuted }}>{label}</text>
      <box style={{ flexDirection: row ? 'row' : 'column', alignItems: row ? 'center' : undefined, gap: 8 }}>
        {children}
      </box>
    </box>
  );
}
