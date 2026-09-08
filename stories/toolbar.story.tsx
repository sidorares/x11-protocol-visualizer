// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The toolbar — the top bar of the window: what has been captured, the
 * category pills that mute a whole kind of message, the name/summary filter,
 * and the network profile.
 *
 * A group story, not a component one: this is the real `<Toolbar>` from
 * `src/ui/App.tsx`, mounted on its own with the counts it would get from a
 * store. It is a controlled component, so each story owns the state the app
 * would own — which is also what makes the pills clickable here.
 */

import { useState } from 'react';
import { story } from '@react-x11/workbench/story';
import { Toolbar } from '../src/ui/App.js';
import type { Category } from '../src/core/protocol/types.js';
import { buildDemoStore } from '../fixtures/demo-session.js';
import { Ground } from './ground.js';

export default { title: 'Toolbar', theme: 'both', size: { width: 1180, height: 60 } };

/** The demo session's real counts, so the numbers are not invented. */
const store = buildDemoStore();
const counts = store.messages.reduce<Record<string, number>>((acc, m) => {
  acc[m.category] = (acc[m.category] ?? 0) + 1;
  return acc;
}, {});

function Bar(props: {
  total?: number;
  shown?: number;
  paused?: boolean;
  muted?: Category[];
  query?: string;
  profileId?: string;
}) {
  const [mutedCats, setMutedCats] = useState<ReadonlySet<Category>>(new Set(props.muted ?? []));
  const [query, setQuery] = useState(props.query ?? '');
  const [profileId, setProfileId] = useState(props.profileId ?? 'none');
  const total = props.total ?? store.messages.length;
  return (
    <Ground padding={0}>
      <Toolbar
        total={total}
        shown={props.shown ?? total}
        counts={counts}
        conns={store.connections.length}
        paused={props.paused ?? false}
        mutedCats={mutedCats}
        onToggleCat={(c) =>
          setMutedCats((prev) => {
            const next = new Set(prev);
            if (!next.delete(c)) next.add(c);
            return next;
          })
        }
        query={query}
        onQuery={setQuery}
        profileId={profileId}
        onProfile={setProfileId}
      />
    </Ground>
  );
}

/** Capturing, nothing filtered — what the window opens as. */
export const idle = () => <Bar />;

/** Paused: the count goes warm and says so, because the table stops growing. */
export const paused = () => <Bar paused />;

/**
 * Filtered: two categories muted (their pills go dim and grow an eye-off) and
 * a query, so the count reads shown/total rather than a single number.
 */
export const filtered = () => <Bar shown={9} muted={['event', 'error']} query="RENDER" />;

/** Throttled — the profile that makes every round trip cost 300 ms. */
export const throttled = () => <Bar profileId="slow3g" />;

/** The knob-driven one: drive the states from the controls panel. */
export const toolbar = story(
  (args: { total: number; shown: number; paused: boolean }) => (
    <Bar total={args.total} shown={args.shown} paused={args.paused} />
  ),
  {
    args: { total: 25, shown: 25, paused: false },
    controls: {
      total: { type: 'number', min: 0, max: 5000, step: 25 },
      shown: { type: 'number', min: 0, max: 5000, step: 25 },
    },
  },
);
