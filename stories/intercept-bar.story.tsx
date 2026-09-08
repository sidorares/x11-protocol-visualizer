// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The intercept bar — visible only with `--intercept`, and the one panel in
 * the app that reports something happening *right now*: a held message means
 * the client is blocked, so the state gets the warm ground and its transport
 * controls sit inline rather than in a menu. Hunting through a menu while an
 * app hangs is the wrong experience.
 *
 * The real `<InterceptBar>` from `src/ui/App.tsx`, over hand-made rules and a
 * held message taken from the demo session.
 */

import { story } from '@react-x11/workbench/story';
import { InterceptBar } from '../src/ui/App.js';
import type { HeldMessage, InterceptRule } from '../src/core/intercept.js';
import { buildDemoStore, demoMessage } from '../fixtures/demo-session.js';
import { Ground } from './ground.js';

export default { title: 'Intercept bar', theme: 'both', size: { width: 1180, height: 110 } };

const store = buildDemoStore();

const RULES: InterceptRule[] = [
  { id: 1, enabled: true, action: 'break', hits: 3, name: 'RENDER:Composite', category: 'request' },
  { id: 2, enabled: false, action: 'drop', hits: 0, name: 'MapWindow' },
  {
    id: 3,
    enabled: true,
    action: 'delay',
    delayMs: 250,
    hits: 11,
    category: 'reply',
    label: 'delay every reply · 250ms',
  },
];

/** A rule whose script threw: the bar says why it stopped matching. */
const BROKEN: InterceptRule = {
  id: 4,
  enabled: true,
  action: 'break',
  hits: 0,
  category: 'reply',
  script: 'request.f["num-glyphs"] > 100',
  error: "Cannot read properties of undefined (reading 'num-glyphs')",
};

/** A message held at the head of the gate — everything behind it waits. */
function held(name: string, rule: InterceptRule): HeldMessage {
  return { msg: demoMessage(store, name), rule, resume: () => {}, drop: () => {} };
}

function Bar(props: { rules?: InterceptRule[]; held?: HeldMessage[]; queued?: number }) {
  return (
    <Ground padding={0}>
      <InterceptBar
        rules={props.rules ?? []}
        held={props.held ?? []}
        queued={props.queued ?? 0}
        onToggle={() => {}}
        onRemove={() => {}}
        onStep={() => {}}
        onContinue={() => {}}
        onDropHead={() => {}}
        onInspect={() => {}}
        onAdd={() => {}}
      />
    </Ground>
  );
}

/** Rules armed, nothing caught yet — the transport controls are disabled. */
export const running = () => <Bar rules={RULES} />;

/**
 * Held: the client is genuinely blocked at this message, and 14 more are
 * queued behind it, because a gate that let them past would reorder the
 * stream and let the client run straight through the breakpoint.
 */
export const paused = () => (
  <Bar rules={RULES} held={[held('RENDER:Composite', RULES[0]!)]} queued={14} />
);

/** Held with nothing behind it — the wording changes, the layout does not. */
export const heldAlone = () => <Bar rules={RULES} held={[held('MapWindow', RULES[1]!)]} />;

/** A script that threw. The rule stays listed, marked, and says what broke. */
export const scriptError = () => <Bar rules={[...RULES, BROKEN]} />;

/** No rules at all — the bar the app only renders once something is armed. */
export const empty = () => <Bar />;

/** The knob-driven one: how the bar reads as the queue behind it grows. */
export const interceptBar = story(
  (args: { queued: number; holding: boolean }) => (
    <Bar
      rules={RULES}
      held={args.holding ? [held('RENDER:Composite', RULES[0]!)] : []}
      queued={args.queued}
    />
  ),
  {
    args: { queued: 1, holding: true },
    controls: { queued: { type: 'number', min: 0, max: 500 } },
  },
);
