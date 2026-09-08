// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The two panels that read the whole capture rather than one message: the
 * statistics tab and the console.
 *
 * `<StatsPanel>` is the profiling half of the tool — the question it answers
 * is "where is this client spending the protocol?", so hotspots come first and
 * the counters follow. `<ConsolePane>` is proxy-level diagnostics only:
 * connections opening and closing, capture files, breakpoints. Per-message
 * traffic belongs in the table, never here.
 *
 * Both are the real components from `src/ui/App.tsx`, over the demo session.
 */

import type { ReactNode } from 'react';
import { StatsPanel, ConsolePane } from '../src/ui/App.js';
import { T } from '../src/ui/controls.js';
import { computeLints } from '../src/core/lints.js';
import { CaptureStore } from '../src/core/store.js';
import { buildDemoStore } from '../fixtures/demo-session.js';

export default { title: 'Panels', theme: 'dark', size: { width: 480, height: 700 } };

const store = buildDemoStore();
const lints = computeLints(store.messages);
const empty = new CaptureStore();

function Pane({ children, height = 660 }: { children: ReactNode; height?: number }) {
  return (
    <box style={{
      flexDirection: 'column', width: 460, height,
      backgroundColor: T.surface, borderColor: T.border, borderWidth: 1,
    }}>
      {children}
    </box>
  );
}

/**
 * Statistics over the demo session: the hotspot it finds (five blocking round
 * trips — the client sent nothing else while waiting), then traffic, round
 * trips, the resources still live at the end, and the frequency bars. The two
 * live resources are reported as `info`: a running app holding its window open
 * is not a leak, and a linter that cries wolf gets muted.
 */
export const stats = () => (
  <Pane>
    <StatsPanel messages={store.messages} onJump={() => {}} lints={lints} onFindUsages={() => {}} />
  </Pane>
);

/** Before any traffic arrives. */
export const statsEmpty = () => (
  <Pane height={120}>
    <StatsPanel messages={[]} onJump={() => {}} lints={computeLints([])} onFindUsages={() => {}} />
  </Pane>
);

// Logged once, at module scope: a story is a component, and appending to the
// store from inside one would grow the log on every re-render.
const logged = buildDemoStore();
logged.log('info', 'saved 25 messages → session.x11cap');
logged.log('warn', 'breakpoint: holding RENDER:Composite — step or continue to release');
logged.log('error', 'unhandled rejection: Error: EPIPE');
logged.closeConnection(1);

/**
 * The console, with the lines the proxy actually writes: a connection opening
 * and closing, a capture saved, a breakpoint holding a message, and a
 * rejection that never got near the stream — forwarding does not depend on
 * decoding, so nothing here can break the relay.
 */
export const consoleLog = () => (
  <Pane height={200}>
    <ConsolePane store={logged} />
  </Pane>
);

/** Nothing has happened yet. */
export const consoleEmpty = () => (
  <Pane height={120}>
    <ConsolePane store={empty} />
  </Pane>
);
