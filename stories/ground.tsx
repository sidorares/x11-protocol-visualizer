// @jsxRuntime automatic
// @jsxImportSource react
/**
 * Shared scaffolding for the stories. Not a story file — the workbench only
 * discovers `*.story.tsx`, so this is a plain module they import.
 *
 * x11vis paints its own ground (`T.bg`) on the window and never inherits the
 * desktop's, so a panel previewed on the workshop's ground is a panel on a
 * colour it will never actually sit on. `<Ground>` restores it, which is what
 * makes a story an honest picture of the panel rather than of the workshop.
 */

import type { ReactNode } from 'react';
import { T } from '../src/ui/controls.js';

/** The app's window ground, with the app's ink. */
export function Ground({ children, padding = 10, gap = 10, width }: {
  children: ReactNode;
  padding?: number;
  gap?: number;
  /** Fixed width, for a panel that fills a pane in the real window. */
  width?: number;
}) {
  return (
    <box style={{ flexDirection: 'column', gap, padding, width, backgroundColor: T.bg, color: T.text }}>
      {children}
    </box>
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
      <text style={{ color: T.dim }}>{label}</text>
      <box style={{ flexDirection: row ? 'row' : 'column', alignItems: row ? 'center' : undefined, gap: 8 }}>
        {children}
      </box>
    </box>
  );
}
