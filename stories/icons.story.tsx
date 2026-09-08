// @jsxRuntime automatic
// @jsxImportSource react
/**
 * Icons — `src/ui/icons.tsx`, lucide SVGs through react-x11's `<svg source>`.
 *
 * Worth having a story of its own because the path from an SVG file to a
 * stroke on a dark panel has two ways to fail silently, and both look like
 * "the button has no icon": a name lucide does not ship (the loader logs once
 * and renders an empty box), and colour, which comes from `style.color`
 * resolving `currentColor` — never from rewriting the markup.
 */

import { story } from '@react-x11/workbench/story';
import { Icon, iconsAvailable } from '../src/ui/icons.js';
import { T } from '../src/ui/controls.js';
import { Ground, Specimen } from './ground.js';

export default { title: 'Icons', theme: 'dark' };

/** Every icon the app actually uses, at the size it uses them. */
const VOCABULARY = [
  'play', 'pause', 'step-forward', 'skip-forward', 'loader',
  'search', 'filter', 'filter-x', 'eye-off', 'x', 'plus', 'circle-plus',
  'arrow-right', 'corner-up-left', 'corner-down-right',
  'square', 'square-check', 'triangle-alert',
];

export const gallery = () => (
  <Ground>
    {!iconsAvailable && (
      <text style={{ color: T.err }}>lucide-static is not installed — every icon below is an empty box.</text>
    )}
    <box style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 8, width: 520 }}>
      {VOCABULARY.map((name) => (
        <box key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, width: 160 }}>
          <Icon name={name} size={14} color={T.text} />
          <text style={{ color: T.dim, textWrap: 'nowrap' }}>{name}</text>
        </box>
      ))}
    </box>
  </Ground>
);

/** The colours the app tints icons with, and what an untinted one inherits. */
export const inks = () => (
  <Ground>
    <Specimen label="tinted with a token">
      <Icon name="triangle-alert" size={16} color={T.err} />
      <Icon name="triangle-alert" size={16} color={T.warn} />
      <Icon name="triangle-alert" size={16} color={T.ok} />
      <Icon name="triangle-alert" size={16} color={T.link} />
      <Icon name="triangle-alert" size={16} color={T.dim} />
    </Specimen>
    <Specimen label="no colour — inherits, which is how an icon in a button takes the button's ink">
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8, color: T.ok }}>
        <Icon name="play" size={16} />
        <text style={{ color: T.ok }}>inside a green box</text>
      </box>
    </Specimen>
    <Specimen label="sizes — 11 in a pill, 12–14 in a button or a bar">
      {[11, 12, 13, 14, 16, 24, 40].map((size) => (
        <Icon key={size} name="search" size={size} color={T.text} />
      ))}
    </Specimen>
  </Ground>
);

/** One icon, by name — the fastest way to check a name lucide ships. */
export const icon = story(
  (args: { name: string; size: number; color: string }) => (
    <Ground>
      <Icon name={args.name} size={args.size} color={args.color} />
    </Ground>
  ),
  {
    args: { name: 'circle-plus', size: 40, color: T.text },
    controls: {
      size: { type: 'number', min: 8, max: 96 },
      color: [T.text, T.dim, T.link, T.ok, T.warn, T.err],
    },
  },
);
