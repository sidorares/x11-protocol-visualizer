// @jsxRuntime automatic
// @jsxImportSource react
/**
 * Lucide icons, rendered through react-x11's `<svg source>` element.
 *
 * `lucide-static` ships each icon as an SVG file. This is a Node process, so
 * they are read from disk once and cached — no bundler step, no icon font.
 *
 * **Colour comes from `style.color`, not from rewriting the source.** Lucide
 * draws with `stroke="currentColor"`, and react-x11 resolves `currentColor`
 * against the node's own `color` (then what it inherits, then the palette) —
 * `SvgView.draw` calls that "how an icon takes its colour from the UI around
 * it". Substituting a literal colour into the markup bypasses that resolution
 * and leaves the icon at whatever the document says, which on a dark panel
 * reads as an unclickable smudge. Leave `currentColor` alone and set `color`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

let iconDir: string | undefined;
try {
  iconDir = path.join(path.dirname(require_.resolve('lucide-static/package.json')), 'icons');
} catch {
  iconDir = undefined;
}

const cache = new Map<string, string | null>();
const missing = new Set<string>();

function load(name: string): string | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let svg: string | null = null;
  if (iconDir) {
    try {
      // Strip only the licence comment; the drawing is left exactly as shipped
      // so `currentColor` survives.
      svg = fs.readFileSync(path.join(iconDir, `${name}.svg`), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    } catch {
      svg = null;
    }
  }
  if (!svg && !missing.has(name)) {
    missing.add(name);
    process.stderr.write(`[x11vis] icon not found: ${name}\n`);
  }
  cache.set(name, svg);
  return svg;
}

export interface IconProps {
  /** A lucide icon name, e.g. `play`, `pause`, `step-forward`. */
  name: string;
  size?: number;
  color?: string;
}

/**
 * One icon. Renders nothing if lucide is unavailable, so a missing optional
 * dependency never breaks a toolbar.
 */
export function Icon({ name, size = 14, color }: IconProps) {
  const src = load(name);
  if (!src) return <box style={{ width: size, height: size }} />;
  // No `color` means inherit: `currentColor` then resolves against whatever the
  // surrounding control set — which is how an icon inside a <Button> now picks
  // up the button's own ink, including in the disabled state.
  return (
    <svg
      source={src}
      viewBox="0 0 24 24"
      style={color ? { width: size, height: size, color } : { width: size, height: size }}
    />
  );
}

/** True when the icon set is actually available. */
export const iconsAvailable = !!iconDir;

/** Where the icons were found, for a one-line startup diagnostic. */
export const iconDirectory = iconDir;
