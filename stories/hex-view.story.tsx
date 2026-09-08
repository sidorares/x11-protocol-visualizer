// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The hex block at the foot of the detail pane — the message's exact bytes,
 * with the selected field's span marked.
 *
 * Small enough to hold in your head and fiddly enough to get wrong: the rows
 * always emit sixteen cells so a short final row still pads (or the ASCII
 * gutter drifts left and stops lining up), and past 256 bytes the rest is
 * summarised as a count rather than scrolled through.
 */

import { story } from '@react-x11/workbench/story';
import { HexView } from '../src/ui/App.js';
import { T } from '../src/ui/controls.js';
import { buildDemoStore, demoMessage } from '../fixtures/demo-session.js';
import { Ground } from './ground.js';

export default { title: 'Hex view', theme: 'dark', size: { width: 620, height: 420 } };

const store = buildDemoStore();

/** GetProperty: 24 bytes, an exact row and a half. */
const short = demoMessage(store, 'GetProperty').bytes;
/** The setup reply: 140 bytes with the vendor string in the ASCII gutter. */
const long = demoMessage(store, 'ConnectionSetupReply').bytes;

/** A message past the cap, so the trailing summary shows. */
const huge = Buffer.concat([long, Buffer.alloc(400, 0x41)]);

export const bytes = () => (
  <Ground>
    <HexView bytes={short} activeSpan={null} />
  </Ground>
);

/**
 * A field selected: `property = RESOURCE_MANAGER` is the four bytes at
 * offset 8, marked in the hot colour. This is the span contract made visible.
 */
export const highlighted = () => (
  <Ground>
    <HexView bytes={short} activeSpan={{ off: 8, len: 4 }} />
  </Ground>
);

/** A short final row still pads to sixteen cells, so the gutter stays square. */
export const shortFinalRow = () => (
  <Ground>
    <HexView bytes={long} activeSpan={{ off: 40, len: 20 }} />
  </Ground>
);

/** Past 256 bytes the block stops and says how much it did not draw. */
export const truncated = () => (
  <Ground>
    <text style={{ color: T.dim }}>{`${huge.length} bytes on the wire`}</text>
    <HexView bytes={huge} activeSpan={null} />
  </Ground>
);

/** Drag the span across the block. */
export const hexView = story(
  (args: { offset: number; length: number }) => (
    <Ground>
      <HexView bytes={long} activeSpan={{ off: args.offset, len: args.length }} />
    </Ground>
  ),
  {
    args: { offset: 8, length: 4 },
    controls: {
      offset: { type: 'number', min: 0, max: 139 },
      length: { type: 'number', min: 1, max: 32 },
    },
  },
);
