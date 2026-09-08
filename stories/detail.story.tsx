// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The detail pane — one message, decoded: the call as source, the links to
 * whatever answered it (or asked for it), every field with the bytes it came
 * from, and the hex those bytes live in.
 *
 * The real `<Detail>` from `src/ui/App.tsx` over the demo session, so every
 * field, span, link and colour swatch below was produced by the shipping
 * decoder rather than written into a fixture. Click a field row: the pane
 * marks its bytes in the hex block underneath, which is the contract the whole
 * decoder is built on (every decoded field carries a byte span).
 */

import { useState } from 'react';
import { story } from '@react-x11/workbench/story';
import { Detail } from '../src/ui/App.js';
import { T } from '../src/ui/controls.js';
import { Ground } from './ground.js';
import type { Span } from '../src/core/protocol/types.js';
import { computeLints } from '../src/core/lints.js';
import { buildDemoStore, demoMessage } from '../fixtures/demo-session.js';

export default { title: 'Detail', theme: 'both', size: { width: 480, height: 700 } };

const store = buildDemoStore();
const lints = computeLints(store.messages);

/** The app's own detail pane: a panel on the right of the split. */
function Pane({ name }: { name?: string }) {
  const [span, setSpan] = useState<Span | null>(null);
  const message = name ? demoMessage(store, name) : undefined;
  return (
    // `<Ground>` for the provider, not for the ground: the pane paints its own
    // `surface`. This story went without one for a long time, and what that
    // cost was the whole point of having a palette — `<Tree>`, `<Code>` and
    // `<Button>` resolved against the *workshop's* theme, so the field list
    // came up in an ink the panel behind it had never heard of and read as
    // disabled. Now it would cost more: the panel's own `'$token'`s resolve
    // against the workshop too, and the five names only x11vis has
    // (`panelAlt`, `hot`, `hotInk`, `held`, `imageMat`) are not in it, so
    // those styles drop out rather than resolving wrong.
    <Ground padding={0} gap={0}>
      <box style={{
        flexDirection: 'column', width: 460, height: 660,
        backgroundColor: T.surface, borderColor: T.border, borderWidth: 1,
      }}>
        <Detail
          message={message}
          activeSpan={span}
          onPickSpan={setSpan}
          onJump={() => {}}
          getMessage={(id) => store.getMessage(id)}
          onPickField={() => {}}
          onFindUsages={() => {}}
          lints={message ? lints.byMessage.get(message.id) : undefined}
        />
      </box>
    </Ground>
  );
}

/** Nothing selected — the pane the window opens with. */
export const empty = () => <Pane />;

/**
 * A request, with the forward link to the reply that answered it. `replyId` is
 * written onto the request when the answer arrives, so the link is a field
 * read, never a search.
 */
export const request = () => <Pane name="GetProperty" />;

/** The reply, linking back to the request whose opcode decoded it. */
export const reply = () => <Pane name="GetProperty·reply" />;

/** An error — red, and pointing back at the request that caused it. */
export const error = () => <Pane name="WindowError" />;

/**
 * A creating request: fifteen fields including an expanded value list, a
 * colour swatch beside the pixel value, and the resource lint the capture
 * reports on it (the window is never freed — `info`, because a running app
 * holding its window open is not a leak).
 */
export const createWindow = () => <Pane name="CreateWindow" />;

/** An extension request, decoded through the RENDER tables. */
export const extension = () => <Pane name="RENDER:Composite" />;

/** Any message in the session, by name — the sheet for a decoder change. */
export const detail = story((args: { message: string }) => <Pane name={args.message} />, {
  args: { message: 'GetProperty' },
  controls: { message: [...new Set(store.messages.map((m) => m.name))] },
});
