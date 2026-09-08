// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The filter bar — the strip that appears under the toolbar once anything is
 * filtered, one removable chip per active filter. It is the only way to lift
 * a filter, which is why the `many` story below matters: on a single
 * non-wrapping row every chip past the right edge became *unreachable* (no
 * horizontal scroll, and the row clipped silently), so the middle wraps.
 *
 * The real `<FilterBar>` from `src/ui/App.tsx`, with the app's state held
 * here instead — removing a chip really removes it.
 */

import { useState } from 'react';
import { FilterBar } from '../src/ui/App.js';
import type { Category } from '../src/core/protocol/types.js';
import { Ground } from './ground.js';

export default { title: 'Filter bar', theme: 'dark', size: { width: 1180, height: 120 } };

function Bar(props: {
  solo?: string | null;
  cats?: Category[];
  names?: string[];
  query?: string;
  xid?: number | null;
}) {
  const [solo, setSolo] = useState<string | null>(props.solo ?? null);
  const [mutedCats, setMutedCats] = useState<ReadonlySet<Category>>(new Set(props.cats ?? []));
  const [mutedNames, setMutedNames] = useState<ReadonlySet<string>>(new Set(props.names ?? []));
  const [query, setQuery] = useState(props.query ?? '');
  const [xid, setXid] = useState<number | null>(props.xid ?? null);
  const drop = <T,>(set: ReadonlySet<T>, v: T) => {
    const next = new Set(set);
    next.delete(v);
    return next;
  };
  return (
    <Ground padding={0}>
      <FilterBar
        solo={solo}
        mutedCats={mutedCats}
        mutedNames={mutedNames}
        query={query}
        xidFilter={xid}
        onClearSolo={() => setSolo(null)}
        onToggleCat={(c) => setMutedCats((prev) => drop(prev, c))}
        onToggleName={(n) => setMutedNames((prev) => drop(prev, n))}
        onClearQuery={() => setQuery('')}
        onClearXid={() => setXid(null)}
        onClearAll={() => {
          setSolo(null);
          setMutedCats(new Set());
          setMutedNames(new Set());
          setQuery('');
          setXid(null);
        }}
      />
    </Ground>
  );
}

/** The ordinary case: a query and one muted category. */
export const filtering = () => <Bar cats={['event']} query="RENDER" />;

/** Solo — everything but one message name is hidden. */
export const solo = () => <Bar solo="RENDER:Composite" />;

/** Find-usages: only messages touching one resource id are shown. */
export const findUsages = () => <Bar xid={0x04800001} />;

/**
 * A dozen hidden names — the wrapping case. Every ✕ has to stay reachable,
 * because a chip's ✕ is the only way to lift the filter it stands for.
 */
export const many = () => (
  <Bar
    cats={['event', 'error']}
    names={[
      'CreateWindow', 'ChangeProperty', 'GetProperty', 'CreatePixmap', 'CreateGC',
      'ChangeGC', 'PolyFillRectangle', 'CopyArea', 'FreePixmap', 'MapWindow',
      'RENDER:CreatePicture', 'RENDER:Composite', 'RENDER:FreePicture',
    ]}
    query="0x048"
    xid={0x04800002}
  />
);
