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
 *
 * ## The `<g>` shim, and why it is not that
 *
 * `pushPaintAttrsDown` moves the *presentation* attributes off the root
 * `<svg>` onto a `<g>` wrapping its children, because **ntk's `SvgView` does
 * not inherit presentation attributes from the root element**. Measured, with
 * one stroke of `x.svg` drawn four ways: on the root, nothing paints at all —
 * with `currentColor` and with a literal colour alike; on a `<g>` or on the
 * `<path>` itself, it paints, in the right colour.
 *
 * Lucide (and feather, heroicons, tabler, …) put `fill="none"
 * stroke="currentColor"` on the root, so every one of those icons fell back to
 * SVG's initial values — `fill: #000`, `stroke: none`. Closed shapes came out
 * as **solid black silhouettes** (a magnifying glass became a disc, a funnel a
 * black triangle) and open ones — `x`, `plus`, `loader` — drew *nothing*,
 * which is how the filter pills ended up with no visible ✕ to click.
 *
 * This is not the "rewriting the source" the paragraph above warns against:
 * the attributes are moved, not rewritten, so `currentColor` still reaches
 * react-x11's resolution. Delete this shim once ntk inherits from the root.
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

/**
 * Attributes that paint rather than position. Structural ones (`viewBox`,
 * `width`, `height`, `xmlns`, `class`, `preserveAspectRatio`) have to stay on
 * the root — `viewBox` in particular is what sizes the node.
 */
const PAINT_ATTRS = new Set([
  'fill', 'fill-rule', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'color', 'opacity',
]);

/** Move the root's presentation attributes onto a `<g>` around its children. */
function pushPaintAttrsDown(svg: string): string {
  const open = /^<svg\b([^>]*)>/i.exec(svg);
  if (!open || !svg.trimEnd().toLowerCase().endsWith('</svg>')) return svg;

  const kept: string[] = [];
  const moved: string[] = [];
  const attr = /([:\w-]+)\s*=\s*("[^"]*"|'[^']*')/g;
  for (let m = attr.exec(open[1]!); m; m = attr.exec(open[1]!)) {
    (PAINT_ATTRS.has(m[1]!.toLowerCase()) ? moved : kept).push(`${m[1]}=${m[2]}`);
  }
  if (moved.length === 0) return svg;

  const inner = svg.slice(open[0].length, svg.trimEnd().length - '</svg>'.length);
  return `<svg ${kept.join(' ')}><g ${moved.join(' ')}>${inner}</g></svg>`;
}

function load(name: string): string | null {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let svg: string | null = null;
  if (iconDir) {
    try {
      // Strip the licence comment, then move the root's paint attributes onto a
      // <g>. The drawing itself is untouched, so `currentColor` survives.
      const raw = fs.readFileSync(path.join(iconDir, `${name}.svg`), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      svg = pushPaintAttrsDown(raw);
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
