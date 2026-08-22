// @jsxRuntime automatic
// @jsxImportSource react
/**
 * The x11vis window.
 *
 * react-x11 core widgets (MenuBar, SplitPane, Select, Tooltip, textinput) and
 * react-x11-components (Table, Tree, Code) plus a custom hex grid.
 * Excluded from the core tsconfig (optional react-x11 stack); loaded lazily by
 * the CLI, which falls back to headless if unavailable.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MenuBar, SplitPane, Select, Tabs, Tooltip, type MenuItem } from 'react-x11';
import { Table } from '@react-x11/components/table';
import { Tree } from '@react-x11/components/tree';
import { Code } from '@react-x11/components/code';
import type { CaptureStore } from '../core/store.js';
import type { CapturedMessage, Category, Field, Span } from '../core/protocol/types.js';
import { NETWORK_PROFILES, type NetworkEmulator } from '../core/throttle.js';
import { decodeImage, decodeGlyph, composeCursor, AUTO_PREVIEW_PIXEL_CAP, type RGBAImage } from '../core/protocol/image.js';
import { computeStats, fmtBytes, type CaptureStats } from '../core/stats.js';
import { computeLints, touchesXid, type Lint } from '../core/lints.js';
import type { HeldMessage, InterceptRule, Interceptor } from '../core/intercept.js';
import { describeRule, type Rule } from '../core/rules.js';
import { BreakOnDialog } from './BreakOnDialog.js';
import { Icon } from './icons.js';
import { Button, Divider, IconButton, Pill, T, TextField } from './controls.js';

// The shared design tokens; `C` is kept as the local alias so the many
// existing colour references keep reading naturally.
const C = T;
const CAT_COLOR: Record<Category, string> = {
  request: '#4aa3ff', reply: '#3ecf8e', error: '#ff5c5c', event: '#e3b341',
  'setup-request': '#8a94a6', 'setup-reply': '#8a94a6',
};
const catColor = (c: Category) => CAT_COLOR[c] ?? C.dim;

// One glyph per kind — encodes category *and* direction (▸ out, others in), so
// the row needs no separate direction column and no redundant colour badges.
const KIND_GLYPH: Record<string, string> = {
  request: '▸', reply: '◂', event: '◆', error: '✕', setup: '·',
};

const MAX_ROWS = 5000;
/** Bytes shown in the hex block; the rest is summarised as a trailing count. */
const HEX_MAX_BYTES = 256;
/** …which is this many 16-byte rows, and so a known natural height. */
export const HEX_MAX_ROWS = HEX_MAX_BYTES / 16;
const FILTER_CATS: Category[] = ['request', 'reply', 'event', 'error'];
// Kind is always shown (it is the classifier); the rest are toggleable.
const TOGGLE_COLS = [
  { id: 'seq', label: 'Seq' }, { id: 'name', label: 'Name' },
  { id: 'size', label: 'Size' }, { id: 'rtt', label: 'RTT' }, { id: 'summary', label: 'Summary' },
];

interface RowData {
  id: number; arrow: string; cat: Category; kind: string; color: string;
  seq: string; seqNum: number; name: string; size: string; sizeNum: number;
  rtt: string; rttNum: number; summary: string;
}

export interface AppProps {
  store: CaptureStore;
  network: NetworkEmulator;
  onQuit?: () => void;
  /** Save the capture; returns the file written. */
  onSave?: () => string;
  /** Present only when started with `--intercept`. */
  interceptor?: Interceptor;
}

export function App({ store, network, onQuit, onSave, interceptor }: AppProps) {
  const [rightTab, setRightTab] = useState<'detail' | 'stats'>('detail');
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [activeSpan, setActiveSpan] = useState<Span | null>(null);
  const [showConsole, setShowConsole] = useState(true);
  const [profileId, setProfileId] = useState(network.current.id);
  const [paused, setPaused] = useState(store.paused);
  const [cols, setCols] = useState<ReadonlySet<string>>(new Set(TOGGLE_COLS.map((c) => c.id)));

  const [query, setQuery] = useState('');
  const [mutedCats, setMutedCats] = useState<ReadonlySet<Category>>(new Set());
  const [mutedNames, setMutedNames] = useState<ReadonlySet<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  // Find-usages: when set, only messages touching this resource id are shown.
  const [xidFilter, setXidFilter] = useState<number | null>(null);
  const [pickedField, setPickedField] = useState<{ value: string; type?: string } | null>(null);

  // The interceptor is an EventEmitter rather than the store, so it gets its
  // own subscription; `break` fires when a message is actually being held.
  const [breakDialog, setBreakDialog] = useState(false);
  const [icTick, setIcTick] = useState(0);
  useEffect(() => {
    if (!interceptor) return;
    const bump = () => setIcTick((v) => v + 1);
    interceptor.on('change', bump);
    interceptor.on('break', bump);
    return () => {
      interceptor.off('change', bump);
      interceptor.off('break', bump);
    };
  }, [interceptor]);
  const rules: readonly InterceptRule[] = interceptor ? interceptor.list() : [];
  const held: readonly HeldMessage[] = interceptor ? interceptor.heldMessages() : [];
  const queued = interceptor ? interceptor.queuedCount() : 0;
  void icTick; // re-render trigger

  const tableRef = useRef<{ scrollToRow?: (id: number) => boolean } | null>(null);
  // Tail-follow: stick to the bottom while the user is at the bottom; freeze
  // the view (don't let arriving rows steal position) once they scroll up.
  const followRef = useRef(true);

  const all = store.messages;
  const base = all.length > MAX_ROWS ? all.slice(all.length - MAX_ROWS) : all;
  const lintReport = useMemo(() => computeLints(all), [all.length, all]);
  // Atom names this capture has actually seen — a far more useful picker list
  // than every predefined atom, because these are the ones in play.
  const knownAtoms = useMemo(() => {
    const set = new Set<string>();
    for (const m of all) {
      for (const f of m.fields ?? []) {
        if (f.type === 'ATOM' && /^[A-Za-z_][\w-]*$/.test(f.value)) set.add(f.value);
      }
    }
    return [...set].sort();
  }, [all.length]);

  const q = query.trim().toLowerCase();
  const visible = useCallback(
    (m: CapturedMessage) => {
      if (solo) return m.name === solo;
      if (mutedCats.has(m.category)) return false;
      if (mutedNames.has(m.name)) return false;
      if (q && !`${m.name} ${m.summary}`.toLowerCase().includes(q)) return false;
      if (xidFilter != null && !touchesXid(m, xidFilter)) return false;
      return true;
    },
    [solo, mutedCats, mutedNames, q, xidFilter],
  );

  const rows: RowData[] = [];
  for (const m of base) {
    if (!visible(m)) continue;
    rows.push({
      id: m.id, arrow: m.dir === 'c2s' ? '▸' : '◂', cat: m.category,
      kind: m.category.startsWith('setup') ? 'setup' : m.category, color: catColor(m.category),
      seq: m.seq != null ? `#${m.seq}` : '', seqNum: m.seq ?? -1, name: m.name,
      size: `${m.bytes.length}B`, sizeNum: m.bytes.length,
      rtt: m.rttMs != null ? `${m.rttMs.toFixed(1)}ms` : '', rttNum: m.rttMs ?? -1, summary: m.summary,
    });
  }

  const selected =
    (selectedId != null ? store.getMessage(selectedId) : undefined) ?? base.filter(visible).at(-1);
  const counts = { request: 0, reply: 0, error: 0, event: 0 } as Record<string, number>;
  for (const m of all) counts[m.category] = (counts[m.category] ?? 0) + 1;
  const filtersActive =
    !!solo || mutedCats.size > 0 || mutedNames.size > 0 || q.length > 0 || xidFilter != null;

  // When following, keep the newest row in view as messages arrive.
  const lastId = rows.length ? rows[rows.length - 1]!.id : -1;
  useEffect(() => {
    if (followRef.current && lastId >= 0) tableRef.current?.scrollToRow?.(lastId);
  }, [lastId, all.length]);

  const setProfile = useCallback((id: string) => {
    const p = network.set(id);
    setProfileId(p.id);
    store.log('info', p.id === 'none' ? 'network: no throttling'
      : `network: ${p.label} — ${p.downKbps || '∞'}↓/${p.upKbps || '∞'}↑ kbit/s, +${p.rttMs}ms RTT`);
  }, [network, store]);

  const togglePause = useCallback(() => {
    store.paused = !store.paused;
    setPaused(store.paused);
    store.log('info', store.paused ? 'capture paused' : 'capture resumed');
  }, [store]);

  const jumpTo = useCallback((id: number) => {
    setSelectedId(id);
    setActiveSpan(null);
    tableRef.current?.scrollToRow?.(id);
  }, []);

  const toggleCat = useCallback((cat: Category) => {
    setSolo(null);
    setMutedCats((s) => { const n = new Set(s); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  }, []);
  const toggleName = useCallback((name: string) => {
    setSolo(null);
    setMutedNames((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  }, []);
  const toggleCol = useCallback((id: string) => {
    setCols((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const clearFilters = useCallback(() => {
    setSolo(null); setMutedCats(new Set()); setMutedNames(new Set()); setQuery(''); setXidFilter(null);
  }, []);
  const addRule = useCallback(
    (action: 'break' | 'drop' | 'delay', name: string) => {
      interceptor?.addRule({ enabled: true, action, name, delayMs: action === 'delay' ? 250 : undefined });
    },
    [interceptor],
  );

  const findUsagesOf = useCallback((v: string) => {
    setXidFilter(parseInt(v, 16));
    setSolo(null);
  }, []);

  const menus = useMemo(() => [
    {
      label: 'Capture',
      items: [
        { key: 'pause', label: paused ? 'Resume capture' : 'Pause capture', shortcut: [['Control', 'P']], onSelect: togglePause },
        { key: 'clear', label: 'Clear log', shortcut: [['Control', 'K']], onSelect: () => { store.clear(); setSelectedId(null); setActiveSpan(null); } },
        { type: 'separator' as const, key: 's0' },
        {
          key: 'save', label: 'Save capture…', shortcut: [['Control', 'S']],
          enabled: !!onSave && store.messages.length > 0,
          onSelect: () => onSave?.(),
        },
        { type: 'separator' as const, key: 's1' },
        { key: 'quit', label: 'Quit', shortcut: [['Control', 'Q']], onSelect: () => onQuit?.() },
      ] as MenuItem[],
    },
    {
      label: 'View',
      items: [
        { key: 'console', label: 'Show console', toggleType: 'checkmark' as const, toggleState: (showConsole ? 1 : 0) as 0 | 1, onSelect: () => setShowConsole((v) => !v) },
        { key: 'clearconsole', label: 'Clear console', onSelect: () => store.clearConsole() },
        { type: 'separator' as const, key: 's2' },
        {
          key: 'cols', label: 'Columns',
          items: TOGGLE_COLS.map((c) => ({
            key: `col-${c.id}`, label: c.label, toggleType: 'checkmark' as const,
            toggleState: (cols.has(c.id) ? 1 : 0) as 0 | 1, onSelect: () => toggleCol(c.id),
          })),
        },
        { key: 'bottom', label: 'Jump to newest', onSelect: () => setSelectedId(null) },
      ] as MenuItem[],
    },
    {
      label: 'Filter',
      items: [
        { key: 'hide', label: selected ? `Hide type “${selected.name}”` : 'Hide selected type', shortcut: [['Control', 'H']], enabled: !!selected, onSelect: () => selected && toggleName(selected.name) },
        { key: 'solo', label: selected ? `Solo type “${selected.name}”` : 'Solo selected type', enabled: !!selected, onSelect: () => selected && setSolo(selected.name) },
        {
          key: 'usages',
          label: pickedField && /^0x[0-9a-f]+$/i.test(pickedField.value)
            ? `Find usages of ${pickedField.value}`
            : 'Find usages (select a resource field)',
          enabled: !!pickedField && /^0x[0-9a-f]+$/i.test(pickedField.value),
          onSelect: () => pickedField && findUsagesOf(pickedField.value),
        },
        { type: 'separator' as const, key: 's3' },
        ...FILTER_CATS.map((cat) => ({ key: `cat-${cat}`, label: `Show ${cat}s`, toggleType: 'checkmark' as const, toggleState: (mutedCats.has(cat) ? 0 : 1) as 0 | 1, onSelect: () => toggleCat(cat) })),
        { type: 'separator' as const, key: 's4' },
        { key: 'clearf', label: 'Clear all filters', enabled: filtersActive, onSelect: clearFilters },
      ] as MenuItem[],
    },
    {
      label: 'Intercept',
      items: (interceptor
        ? [
            {
              key: 'breakon',
              label: 'Break on…',
              shortcut: [['Control', 'B']],
              onSelect: () => setBreakDialog(true),
            },
            {
              key: 'break',
              label: selected ? `Quick break on “${selected.name}”` : 'Quick break on selected',
              enabled: !!selected,
              onSelect: () => selected && addRule('break', selected.name),
            },
            {
              key: 'drop',
              label: selected ? `Drop “${selected.name}”` : 'Drop selected type',
              enabled: !!selected,
              onSelect: () => selected && addRule('drop', selected.name),
            },
            {
              key: 'delay',
              label: selected ? `Delay “${selected.name}” 250ms` : 'Delay selected type',
              enabled: !!selected,
              onSelect: () => selected && addRule('delay', selected.name),
            },
            { type: 'separator' as const, key: 'i1' },
            {
              key: 'step',
              label: held.length ? `Step (${held.length} held)` : 'Step',
              shortcut: [['Control', 'N']],
              enabled: held.length > 0,
              onSelect: () => interceptor.step(),
            },
            {
              key: 'continue',
              label: 'Continue all',
              shortcut: [['Control', 'G']],
              enabled: held.length > 0,
              onSelect: () => interceptor.resumeAll(),
            },
            { type: 'separator' as const, key: 'i2' },
            // The rules themselves: a checkmark per rule, selecting toggles it.
            ...rules.map((r) => ({
              key: `rule-${r.id}`,
              label: `${r.action} ${r.name ?? r.category ?? r.dir ?? 'any'}${r.hits ? `  ·  ${r.hits} hit${r.hits === 1 ? '' : 's'}` : ''}`,
              toggleType: 'checkmark' as const,
              toggleState: (r.enabled ? 1 : 0) as 0 | 1,
              onSelect: () => interceptor.setEnabled(r.id, !r.enabled),
            })),
            {
              key: 'clearrules',
              label: 'Remove all rules',
              enabled: rules.length > 0,
              onSelect: () => interceptor.clear(),
            },
          ]
        : [
            {
              key: 'off',
              label: 'Interception is off — restart with --intercept',
              enabled: false,
              onSelect: () => {},
            },
          ]) as MenuItem[],
    },
  ], [paused, showConsole, cols, selected, mutedCats, filtersActive, store, togglePause, toggleName, toggleCat, toggleCol, clearFilters, onQuit]);

  const columns = useMemo(() => {
    const all = [
      { id: 'kind', label: 'Kind', width: 104, value: (r: RowData) => r.kind, render: (r: RowData) => <text style={{ color: r.color, textWrap: 'nowrap', textOverflow: 'ellipsis' }}>{`${KIND_GLYPH[r.kind] ?? '·'} ${r.kind}`}</text> },
      { id: 'seq', label: 'Seq', width: 60, align: 'right' as const, value: (r: RowData) => r.seq, compare: (a: RowData, b: RowData) => a.seqNum - b.seqNum },
      { id: 'name', label: 'Name', flex: 2, value: (r: RowData) => r.name },
      { id: 'size', label: 'Size', width: 60, align: 'right' as const, value: (r: RowData) => r.size, compare: (a: RowData, b: RowData) => a.sizeNum - b.sizeNum },
      { id: 'rtt', label: 'RTT', width: 64, align: 'right' as const, value: (r: RowData) => r.rtt, compare: (a: RowData, b: RowData) => a.rttNum - b.rttNum },
      { id: 'summary', label: 'Summary', flex: 3, value: (r: RowData) => r.summary },
    ];
    return all.filter((c) => c.id === 'kind' || cols.has(c.id));
  }, [cols]);

  const table = (
    <Table
      ref={tableRef} columns={columns} rows={rows} selectionMode="single"
      selected={selected?.id ?? null}
      onSelect={(id: number) => { setSelectedId(id); setActiveSpan(null); }}
      onRowContextMenu={(_id: number, row: RowData) => toggleName(row.name)}
      onScroll={(ev: { scrollY: number; viewportHeight: number; contentHeight: number }) => {
        followRef.current = ev.scrollY + ev.viewportHeight >= ev.contentHeight - 6;
      }}
      styles={{ cell: { textWrap: 'nowrap', textOverflow: 'ellipsis' } }}
      renderEmpty={() => <text style={{ color: C.dim, padding: 12 }}>{filtersActive ? 'No messages match the current filter.' : 'Waiting for traffic…'}</text>}
      rowHeight={22} virtual="auto" style={{ flexGrow: 1 }}
    />
  );

  return (
    <window title="x11vis — X11 protocol visualizer" width={1240} height={780}
      style={{ flexDirection: 'column', backgroundColor: C.bg, color: C.text, fontFamily: 'monospace' }}>
      <MenuBar menus={menus} globalMenu={false} style={{ backgroundColor: C.panel }} />
      <Toolbar total={all.length} shown={rows.length} counts={counts} conns={store.connections.length}
        paused={paused} mutedCats={mutedCats} onToggleCat={toggleCat} query={query} onQuery={setQuery}
        profileId={profileId} onProfile={setProfile} />
      {interceptor && (
        <BreakOnDialog
          open={breakDialog}
          atoms={knownAtoms}
          onClose={() => setBreakDialog(false)}
          onCreate={(r: Omit<Rule, 'id' | 'hits'>) => interceptor.addRule(r)}
        />
      )}
      {interceptor && (rules.length > 0 || held.length > 0) && (
        <InterceptBar
          rules={rules}
          held={held}
          queued={queued}
          onDropHead={() => interceptor.dropHead()}
          onToggle={(id, on) => interceptor.setEnabled(id, on)}
          onRemove={(id) => interceptor.removeRule(id)}
          onStep={() => interceptor.step()}
          onContinue={() => interceptor.resumeAll()}
          onInspect={(id) => jumpTo(id)}
          onAdd={() => setBreakDialog(true)}
        />
      )}
      {filtersActive && (
        <FilterBar solo={solo} mutedCats={mutedCats} mutedNames={mutedNames} query={q}
          xidFilter={xidFilter}
          onClearSolo={() => setSolo(null)} onToggleCat={toggleCat} onToggleName={toggleName}
          onClearQuery={() => setQuery('')} onClearXid={() => setXidFilter(null)} onClearAll={clearFilters} />
      )}
      <SplitPane direction="row" defaultSize={780} min={360} minSecond={340} style={{ flexGrow: 1 }}>
        {showConsole ? (
          <SplitPane direction="column" defaultSize={540} min={160} minSecond={72}>
            {table}
            <ConsolePane store={store} />
          </SplitPane>
        ) : table}
        <box style={{ flexDirection: 'column', flexGrow: 1, backgroundColor: C.panel, borderColor: C.border, borderWidth: 1 }}>
          <box style={{ paddingLeft: 6, paddingTop: 4, paddingRight: 6 }}>
            <Tabs
              items={[{ id: 'detail', label: 'Detail' }, { id: 'stats', label: 'Statistics' }]}
              value={rightTab}
              onChange={(id: string) => setRightTab(id as 'detail' | 'stats')}
            />
          </box>
          {rightTab === 'detail' ? (
            <Detail message={selected} activeSpan={activeSpan} onPickSpan={setActiveSpan} onJump={jumpTo}
              getMessage={(id) => store.getMessage(id)} onPickField={setPickedField}
              onFindUsages={findUsagesOf}
              lints={selected ? lintReport.byMessage.get(selected.id) : undefined} />
          ) : (
            <StatsPanel messages={all} onJump={jumpTo} lints={lintReport} onFindUsages={(x) => setXidFilter(x)} />
          )}
        </box>
      </SplitPane>
    </window>
  );
}

function Toolbar(props: {
  total: number; shown: number; counts: Record<string, number>; conns: number; paused: boolean;
  mutedCats: ReadonlySet<Category>; onToggleCat: (c: Category) => void;
  query: string; onQuery: (s: string) => void; profileId: string; onProfile: (id: string) => void;
}) {
  const options = useMemo(() => NETWORK_PROFILES.map((p) => ({ value: p.id, label: p.label })), []);
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 10, paddingRight: 10, paddingTop: 6, paddingBottom: 6, backgroundColor: C.panel, borderColor: C.border, borderWidth: 1 }}>
      <text style={{ fontWeight: 'bold', color: C.text }}>x11vis</text>
      <text style={{ color: props.paused ? C.warn : C.dim }}>{`${props.shown === props.total ? props.total : `${props.shown}/${props.total}`} msgs · ${props.conns} conns${props.paused ? ' · PAUSED' : ''}`}</text>
      <Divider />
      {FILTER_CATS.map((cat) => (
        <Pill
          key={cat}
          label={`${cat} ${props.counts[cat] ?? 0}`}
          color={catColor(cat)}
          muted={props.mutedCats.has(cat)}
          icon={props.mutedCats.has(cat) ? 'eye-off' : undefined}
          onClick={() => props.onToggleCat(cat)}
        />
      ))}
      <box style={{ flexGrow: 1 }} />
      <Icon name="search" size={13} color={C.dim} />
      <TextField value={props.query} placeholder="Filter name/summary…" width={220} onChange={props.onQuery} />
      <Divider />
      <text style={{ color: C.dim }}>Network</text>
      <Select value={props.profileId} options={options} onChange={(ev: { value: string }) => props.onProfile(ev.value)} style={{ width: 180 }} />
    </box>
  );
}

/**
 * Capture statistics, oriented at the question the tool exists to answer for a
 * react-x11 client: where is this app spending the protocol? Hotspots first,
 * because a count nobody acts on is just a number.
 */
function StatsPanel({ messages, onJump, lints, onFindUsages }: {
  messages: readonly CapturedMessage[]; onJump: (id: number) => void;
  lints: ReturnType<typeof computeLints>; onFindUsages: (xid: number) => void;
}) {
  const s: CaptureStats = useMemo(() => computeStats(messages), [messages.length, messages]);
  if (!s.total) return <box style={{ padding: 10 }}><text style={{ color: C.dim }}>No traffic captured yet.</text></box>;

  const sevColor = (v: string) => (v === 'high' ? C.err : v === 'medium' ? C.warn : C.dim);
  const Row = ({ k, v }: { k: string; v: string }) => (
    <box style={{ flexDirection: 'row', gap: 8 }}>
      <text style={{ color: C.dim, width: 168, textWrap: 'nowrap' }}>{k}</text>
      <text style={{ color: C.text }}>{v}</text>
    </box>
  );
  const Bars = ({ title, list }: { title: string; list: { name: string; count: number; bytes: number }[] }) => {
    if (!list.length) return null;
    const max = Math.max(...list.map((e) => e.count));
    return (
      <box style={{ flexDirection: 'column', gap: 2, marginTop: 8 }}>
        <text style={{ color: C.dim }}>{title}</text>
        {list.map((e) => (
          <box key={e.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <text style={{ color: C.text, width: 210, textWrap: 'nowrap', textOverflow: 'ellipsis' }}>{e.name}</text>
            <box style={{ width: Math.max(2, Math.round((e.count / max) * 90)), height: 9, backgroundColor: C.link, borderRadius: 2 }} />
            <text style={{ color: C.dim }}>{`${e.count} · ${fmtBytes(e.bytes)}`}</text>
          </box>
        ))}
      </box>
    );
  };

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 10, gap: 3, overflow: 'scroll' }}>
      {s.hotspots.length > 0 && (
        <box style={{ flexDirection: 'column', gap: 6, marginBottom: 6 }}>
          <text style={{ color: C.text, fontWeight: 'bold' }}>Hotspots</text>
          {s.hotspots.map((h, i) => (
            <box key={i} style={{
              flexDirection: 'column', gap: 2, padding: 6, borderRadius: 4,
              backgroundColor: C.panelAlt, borderColor: sevColor(h.severity), borderWidth: 1,
            }}>
              <text style={{ color: sevColor(h.severity), fontWeight: 'bold' }}>{h.title}</text>
              <text style={{ color: C.dim }}>{h.detail}</text>
            </box>
          ))}
        </box>
      )}

      <text style={{ color: C.text, fontWeight: 'bold', marginTop: 4 }}>Traffic</text>
      <Row k="messages" v={`${s.total} over ${(s.durationMs / 1000).toFixed(1)}s`} />
      <Row k="client → server" v={fmtBytes(s.bytesC2S)} />
      <Row k="server → client" v={fmtBytes(s.bytesS2C)} />
      <Row k="requests·replies" v={`${s.byCategory.request ?? 0} / ${s.byCategory.reply ?? 0}`} />
      <Row k="events·errors" v={`${s.byCategory.event ?? 0} / ${s.byCategory.error ?? 0}`} />

      <text style={{ color: C.text, fontWeight: 'bold', marginTop: 8 }}>Round trips</text>
      <Row k="round trips" v={String(s.roundTrips)} />
      <Row k="blocking (waited)" v={String(s.stalls)} />
      <Row k="RTT mean·p50·max" v={`${s.rttMeanMs.toFixed(1)} / ${s.rttP50Ms.toFixed(1)} / ${s.rttMaxMs.toFixed(1)} ms`} />
      {s.slowest && (
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <text style={{ color: C.dim, width: 168, textWrap: 'nowrap' }}>slowest</text>
          <Button
            label={`${s.slowest.name} — ${s.slowest.rttMs.toFixed(1)} ms`}
            icon="arrow-right"
            variant="ghost"
            accent={C.link}
            small
            onClick={() => onJump(s.slowest!.id)}
          />
        </box>
      )}

      <text style={{ color: C.text, fontWeight: 'bold', marginTop: 8 }}>Resources</text>
      <Row k="live at end of capture" v={String(lints.liveResources)} />
      <Row k="use-after-free" v={String(lints.counts['use-after-free'])} />
      <Row k="double-free" v={String(lints.counts['double-free'])} />
      <Row k="never freed (leaks)" v={String(lints.counts.leak)} />
      {lints.lints.slice(0, 6).map((l, i) => (
        <box key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <text style={{ color: l.severity === 'high' ? C.err : l.severity === 'medium' ? C.warn : C.dim }}>⚠</text>
          <box onClick={() => onJump(l.messageId)} style={{ cursor: 'pointer', flexGrow: 1 }}>
            <text style={{ color: C.text, textWrap: 'nowrap', textOverflow: 'ellipsis' }}>{l.text}</text>
          </box>
          <Button label="uses" icon="search" variant="ghost" accent={C.link} small onClick={() => onFindUsages(l.xid)} />
        </box>
      ))}

      <Bars title="Most frequent requests" list={s.topRequests} />
      <Bars title="Heaviest requests (bytes)" list={s.heaviestRequests} />
      <Bars title="Events" list={s.topEvents} />
      <Bars title="By extension" list={s.byExtension} />
      {s.errors.length > 0 && <Bars title="Errors" list={s.errors} />}
    </box>
  );
}

function FilterBar(props: {
  solo: string | null; mutedCats: ReadonlySet<Category>; mutedNames: ReadonlySet<string>; query: string;
  xidFilter: number | null;
  onClearSolo: () => void; onToggleCat: (c: Category) => void; onToggleName: (n: string) => void;
  onClearQuery: () => void; onClearXid: () => void; onClearAll: () => void;
}) {
  const chip = (key: string, label: string, color: string, onRemove: () => void) => (
    <Pill key={key} label={label} color={color} onRemove={onRemove} />
  );
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, backgroundColor: C.panelAlt, borderColor: C.border, borderWidth: 1 }}>
      <Icon name="filter" size={12} color={C.dim} />
      {props.solo && chip('solo', `solo: ${props.solo}`, C.hot, props.onClearSolo)}
      {[...props.mutedCats].map((c) => chip(`c-${c}`, `hide ${c}`, catColor(c), () => props.onToggleCat(c)))}
      {[...props.mutedNames].map((n) => chip(`n-${n}`, `hide ${n}`, C.text, () => props.onToggleName(n)))}
      {props.query && chip('q', `“${props.query}”`, C.text, props.onClearQuery)}
      {props.xidFilter != null &&
        chip('xid', `uses 0x${props.xidFilter.toString(16).padStart(8, '0')}`, C.link, props.onClearXid)}
      <box style={{ flexGrow: 1 }} />
      <Button label="Clear all" icon="filter-x" variant="ghost" accent={C.link} small onClick={props.onClearAll} />
    </box>
  );
}

/**
 * Interception status. A held message means the client is blocked *right now*,
 * so that state gets the prominent treatment and its controls sit inline —
 * hunting through a menu while an app hangs is the wrong experience. The rules
 * themselves render as chips underneath, like the filter chips.
 */
function InterceptBar({ rules, held, queued, onToggle, onRemove, onStep, onContinue, onDropHead, onInspect, onAdd }: {
  rules: readonly InterceptRule[];
  held: readonly HeldMessage[];
  queued: number;
  onToggle: (id: number, enabled: boolean) => void;
  onRemove: (id: number) => void;
  onStep: () => void;
  onContinue: () => void;
  onDropHead: () => void;
  onInspect: (messageId: number) => void;
  onAdd: () => void;
}) {
  const first = held[0];
  return (
    <box style={{
      flexDirection: 'column', gap: 4, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4,
      backgroundColor: first ? '#2a1f16' : C.panelAlt,
      borderColor: first ? C.warn : C.border, borderWidth: 1,
    }}>
      {/* Transport controls, always present so their position never moves. */}
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name={first ? 'pause' : 'play'} size={14} color={first ? C.warn : C.dim} />
        {first ? (
          <>
            <text style={{ color: C.warn, fontWeight: 'bold' }}>Paused</text>
            <box onClick={() => onInspect(first.msg.id)} style={{ cursor: 'pointer' }}>
              <text style={{ color: C.link }}>{`${first.msg.name} (#${first.msg.id})`}</text>
            </box>
            <text style={{ color: C.dim }}>
              {queued > 0
                ? `— client blocked · ${queued} message${queued === 1 ? '' : 's'} queued behind`
                : '— the client is blocked here'}
            </text>
          </>
        ) : (
          <text style={{ color: C.dim }}>Running — no message held</text>
        )}
        <box style={{ flexGrow: 1 }} />
        <Button icon="step-forward" label="Step" small onClick={onStep} disabled={!first} />
        <Button icon="play" label="Continue" variant="solid" accent={C.link} small onClick={onContinue} disabled={!first} />
        <Button icon="skip-forward" label="Skip" variant="outline" accent={C.err} small onClick={onDropHead} disabled={!first} />
        <Divider />
        <Button icon="circle-plus" label="Break on…" small onClick={onAdd} />
      </box>

      {rules.length > 0 && (
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="filter" size={12} color={C.dim} />
          {rules.map((r) => (
            <Pill
              key={r.id}
              label={`${describeRule(r)}${r.hits ? ` ·${r.hits}` : ''}`}
              color={r.error ? C.err : r.action === 'drop' ? C.err : C.warn}
              icon={r.error ? 'triangle-alert' : r.enabled ? undefined : 'eye-off'}
              muted={!r.enabled}
              onClick={() => onToggle(r.id, !r.enabled)}
              onRemove={() => onRemove(r.id)}
            />
          ))}
        </box>
      )}
      {rules.some((r) => r.error) && (
        <text style={{ color: C.err }}>
          {`script error: ${rules.find((r) => r.error)!.error}`}
        </text>
      )}
    </box>
  );
}

function ConsolePane({ store }: { store: CaptureStore }) {
  const entries = store.console.slice(-200);
  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, backgroundColor: C.panelAlt, borderColor: C.border, borderWidth: 1, padding: 6, overflow: 'scroll' }}>
      <text style={{ color: C.dim, marginBottom: 2 }}>Console — proxy events</text>
      {entries.map((e, i) => <text key={i} style={{ color: e.level === 'error' ? C.err : e.level === 'warn' ? C.warn : C.dim }}>{`${new Date(e.ts).toLocaleTimeString()}  ${e.text}`}</text>)}
    </box>
  );
}

interface FieldItem {
  id: string; label: string; span: Span; ref?: number; color?: string;
  /** The undecorated field value, so it can drive find-usages. */
  raw?: string; type?: string;
}

function Detail({ message, activeSpan, onPickSpan, onJump, getMessage, onPickField, onFindUsages, lints }: {
  message: CapturedMessage | undefined; activeSpan: Span | null;
  onPickSpan: (s: Span | null) => void; onJump: (id: number) => void;
  getMessage: (id: number) => CapturedMessage | undefined;
  onPickField: (f: { value: string; type?: string } | null) => void;
  onFindUsages: (v: string) => void;
  lints: Lint[] | undefined;
}) {
  const items: FieldItem[] = (message?.fields ?? []).map((f, i) => ({
    id: `f${i}`, label: `${f.name} = ${f.value}${f.ref != null ? `  →#${f.ref}` : ''}`,
    span: f.span, ref: f.ref, color: f.color, raw: f.value, type: f.type,
  }));

  const renderLabel = (state: { item: FieldItem; color: string }) => {
    const it = state.item;
    const content = (
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {it.color ? <box style={{ width: 11, height: 11, borderRadius: 2, borderWidth: 1, borderColor: '#000', backgroundColor: it.color }} /> : null}
        <text style={{ color: state.color }}>{it.label}</text>
      </box>
    );
    if (it.ref != null) {
      const creator = getMessage(it.ref);
      if (creator) return <Tooltip label={<CreatorPreview creator={creator} />} width={340} height={110} delay={250}>{content}</Tooltip>;
    }
    return content;
  };

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 8, gap: 6 }}>
      {!message ? <text style={{ color: C.dim }}>Select a packet…</text> : (
        <>
          <text style={{ color: catColor(message.category), fontWeight: 'bold' }}>{message.name}</text>
          <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <text style={{ color: C.dim }}>{`${message.category} · ${message.dir}` + (message.seq != null ? ` · seq #${message.seq}` : '') + (message.rttMs != null ? ` · ${message.rttMs.toFixed(2)}ms` : '')}</text>
            {/* Backward link: the request a reply or error answers. */}
            {message.requestId != null && (
              <Button
                icon="corner-up-left"
                label={`request #${message.requestId}`}
                variant="outline"
                accent={C.link}
                small
                onClick={() => onJump(message.requestId!)}
              />
            )}
            {/*
              Forward link: the answer to this request. `replyId` is written
              onto the request by the store when the answer arrives, so this is
              a field read plus one map lookup for the label — never a search.
              "no response yet" is only shown where the protocol says one is
              coming; most requests are void and get nothing here.
            */}
            {message.category === 'request' && message.replyId != null && (
              <Button
                icon="corner-down-right"
                label={`${getMessage(message.replyId)?.category === 'error' ? 'error' : 'response'} #${message.replyId}`}
                variant="outline"
                accent={getMessage(message.replyId)?.category === 'error' ? C.err : C.link}
                small
                onClick={() => onJump(message.replyId!)}
              />
            )}
            {message.category === 'request' && message.replyId == null && message.expectsReply && (
              <box style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="loader" size={12} color={C.dim} />
                <text style={{ color: C.dim }}>no response yet</text>
              </box>
            )}
          </box>
          {lints && lints.length > 0 && (
            <box style={{ flexDirection: 'column', gap: 3, marginTop: 2 }}>
              {lints.map((l, i) => (
                <box key={i} style={{
                  flexDirection: 'row', gap: 6, padding: 5, borderRadius: 3,
                  backgroundColor: C.panelAlt,
                  borderColor: l.severity === 'high' ? C.err : l.severity === 'medium' ? C.warn : C.dim,
                  borderWidth: 1,
                }}>
                  <text style={{ color: l.severity === 'high' ? C.err : l.severity === 'medium' ? C.warn : C.dim }}>⚠</text>
                  <text style={{ color: C.text, flexGrow: 1 }}>{l.text}</text>
                </box>
              ))}
            </box>
          )}
          <Code source={prettyCall(message)} lang="js" wrap selectable style={{ marginTop: 2 }} />
          {message.image && (
            <box style={{ flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <text style={{ color: C.dim }}>Image</text>
              <ImagePreview message={message} />
            </box>
          )}
          {message.cursor && (
            <box style={{ flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <text style={{ color: C.dim }}>Cursor</text>
              <CursorPreview message={message} getMessage={getMessage} />
            </box>
          )}
          {message.glyphs && message.glyphs.length > 0 && (
            <box style={{ flexDirection: 'column', gap: 4, marginTop: 4 }}>
              <text style={{ color: C.dim }}>Glyphs</text>
              <GlyphsPreview message={message} />
            </box>
          )}
          <text style={{ color: C.dim, marginTop: 4 }}>Fields — click a row to highlight its bytes · hover a → to preview, double-click to jump</text>
          <box style={{ flexGrow: 1, minHeight: 0 }}>
            <Tree items={items} renderLabel={renderLabel}
              onSelect={(_id: string, item: FieldItem) => {
                onPickSpan(item.span ?? null);
                onPickField(item.raw ? { value: item.raw, type: item.type } : null);
              }}
              onActivate={(_id: string, item: FieldItem) => {
                if (item.ref != null) onJump(item.ref);
                else if (item.raw && /^0x[0-9a-f]+$/i.test(item.raw) && item.type) onFindUsages(item.raw);
              }} />
          </box>
          <text style={{ color: C.dim }}>Hex</text>
          {/*
            Sized by its content, not by an arbitrary cap. The row count is
            already bounded (HEX_MAX_ROWS), so the block has a known natural
            height — capping it in pixels only guaranteed a scrollbar whenever
            the cap fell short of a whole number of rows. The Fields tree above
            is the flexible one; hex simply sits at the bottom.
          */}
          <box style={{ flexShrink: 0 }}>
            <HexView bytes={message.bytes} activeSpan={activeSpan} />
          </box>
        </>
      )}
    </box>
  );
}

/**
 * Paint decoded RGBA into a canvas, scaled to fit `boxW`×`boxH` with
 * nearest-neighbour so single glyph pixels stay legible. A checkerboard shows
 * through transparency (glyph coverage is mostly alpha).
 */
function Bitmap({ img, boxW, boxH, cacheKey }: {
  img: RGBAImage;
  boxW: number;
  boxH: number;
  /** Names the content, so re-deriving the buffer costs no re-upload. */
  cacheKey?: string;
}) {
  // Integer nearest-neighbour upscale for small images (a 6×9 glyph is
  // unreadable at 1:1); the renderer scales down large ones.
  const up = Math.max(1, Math.min(Math.floor(boxW / img.width), Math.floor(boxH / img.height)));
  const down = Math.min(1, boxW / img.width, boxH / img.height);
  const w = Math.max(1, Math.round(img.width * (up > 1 ? up : down)));
  const h = Math.max(1, Math.round(img.height * (up > 1 ? up : down)));

  // Upscaling happens here rather than in the renderer so a glyph stays crisp
  // instead of being interpolated into mush.
  const source = useMemo(() => {
    if (up <= 1) return { width: img.width, height: img.height, data: img.data };
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = Math.floor(y / up);
      for (let x = 0; x < w; x++) {
        const s = (sy * img.width + Math.floor(x / up)) * 4;
        const d = (y * w + x) * 4;
        out[d] = img.data[s]!; out[d + 1] = img.data[s + 1]!;
        out[d + 2] = img.data[s + 2]!; out[d + 3] = img.data[s + 3]!;
      }
    }
    return { width: w, height: h, data: out };
  }, [img, w, h, up]);

  // A backdrop so alpha (glyph coverage is mostly alpha) reads as transparency
  // rather than as black ink.
  return (
    <box style={{ width: w, height: h, backgroundColor: '#20262f', borderRadius: 2 }}>
      <image
        src={source}
        cacheKey={cacheKey ? `${cacheKey}:${w}x${h}` : undefined}
        style={{ width: w, height: h }}
      />
    </box>
  );
}

/** Image payload preview (PutImage / GetImage reply). */
function ImagePreview({ message }: { message: CapturedMessage }) {
  const spec = message.image!;
  const pixels = spec.width * spec.height;
  const [force, setForce] = useState(false);
  if (pixels > AUTO_PREVIEW_PIXEL_CAP && !force) {
    return (
      <box onClick={() => setForce(true)} style={{ cursor: 'pointer' }}>
        <text style={{ color: C.link }}>{`${spec.width}×${spec.height} — click to render`}</text>
      </box>
    );
  }
  let img: RGBAImage | undefined;
  try { img = decodeImage(message.bytes, spec); } catch { img = undefined; }
  if (!img) {
    return <text style={{ color: C.dim }}>{`${spec.width}×${spec.height} depth ${spec.depth} — no preview for this format`}</text>;
  }
  return (
    <box style={{ flexDirection: 'column', gap: 4 }}>
      <Bitmap img={img} boxW={380} boxH={220} cacheKey={`img:${message.id}`} />
      <text style={{ color: C.dim }}>{`${spec.width}×${spec.height} · depth ${spec.depth}`}</text>
    </box>
  );
}

/**
 * Cursor preview: the bitmaps live in the source/mask pixmaps, so this resolves
 * them through the PutImage messages that filled those pixmaps.
 */
function CursorPreview({ message, getMessage }: {
  message: CapturedMessage;
  getMessage: (id: number) => CapturedMessage | undefined;
}) {
  const spec = message.cursor!;
  const part = (id: number | undefined) => {
    if (id == null) return undefined;
    const m = getMessage(id);
    if (!m?.image) return undefined;
    try { return decodeImage(m.bytes, m.image); } catch { return undefined; }
  };
  const img = composeCursor(part(spec.sourceImageId), part(spec.maskImageId), spec);
  const swatch = (rgb: [number, number, number]) =>
    `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {img ? <Bitmap img={img} boxW={72} boxH={72} cacheKey={`cursor:${message.id}`} /> : (
        <text style={{ color: C.dim }}>
          {'source bitmap not seen in this capture'}
        </text>
      )}
      <box style={{ flexDirection: 'column', gap: 3 }}>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <box style={{ width: 11, height: 11, borderRadius: 2, borderWidth: 1, borderColor: '#000', backgroundColor: swatch(spec.fore) }} />
          <text style={{ color: C.dim }}>foreground</text>
        </box>
        <box style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <box style={{ width: 11, height: 11, borderRadius: 2, borderWidth: 1, borderColor: '#000', backgroundColor: swatch(spec.back) }} />
          <text style={{ color: C.dim }}>background</text>
        </box>
        <text style={{ color: C.dim }}>{`hotspot (${spec.hotX}, ${spec.hotY})`}</text>
      </box>
    </box>
  );
}

/** Glyph bitmaps preview (RENDER AddGlyphs). */
function GlyphsPreview({ message }: { message: CapturedMessage }) {
  const specs = message.glyphs!.filter((g) => g.width > 0 && g.height > 0).slice(0, 24);
  const imgs = specs.map((g) => { try { return decodeGlyph(message.bytes, g); } catch { return undefined; } });
  const shown = imgs.filter(Boolean) as RGBAImage[];
  if (!shown.length) return <text style={{ color: C.dim }}>No renderable glyphs</text>;
  return (
    <box style={{ flexDirection: 'column', gap: 4 }}>
      <box style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'flex-end' }}>
        {shown.map((g, i) => <Bitmap key={i} img={g} boxW={44} boxH={44} cacheKey={`glyph:${message.id}:${i}`} />)}
      </box>
      <text style={{ color: C.dim }}>{`${message.glyphs!.length} glyphs${message.glyphs!.length > shown.length ? ` (showing ${shown.length})` : ''}`}</text>
    </box>
  );
}

/** Preview of a resource's creating request — name, a color swatch if it has one, and its summary. */
function CreatorPreview({ creator }: { creator: CapturedMessage }) {
  const colorF: Field | undefined = creator.fields?.find((f) => f.color);
  // A picture/pixmap/glyphset is best explained by what it actually contains:
  // its colour, its pixels, or its glyphs.
  let thumb: RGBAImage | undefined;
  try {
    if (creator.image && creator.image.width * creator.image.height <= AUTO_PREVIEW_PIXEL_CAP) {
      thumb = decodeImage(creator.bytes, creator.image);
    } else if (creator.glyphs?.length) {
      const g = creator.glyphs.find((x) => x.width > 0 && x.height > 0);
      if (g) thumb = decodeGlyph(creator.bytes, g);
    }
  } catch { thumb = undefined; }

  return (
    <box style={{ flexDirection: 'column', gap: 5, padding: 6 }}>
      <text style={{ color: catColor(creator.category), fontWeight: 'bold' }}>{`${creator.name}  #${creator.id}`}</text>
      <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {colorF ? <box style={{ width: 28, height: 28, borderRadius: 4, borderWidth: 1, borderColor: '#000', backgroundColor: colorF.color }} /> : null}
        {thumb ? <Bitmap img={thumb} boxW={64} boxH={40} cacheKey={`thumb:${creator.id}`} /> : null}
        {colorF ? <text style={{ color: C.text }}>{colorF.value}</text> : null}
      </box>
      <text style={{ color: C.dim }}>{creator.summary || '(no details)'}</text>
    </box>
  );
}

function HexView({ bytes, activeSpan }: { bytes: Buffer; activeSpan: Span | null }) {
  const limit = Math.min(bytes.length, HEX_MAX_BYTES);
  const inSpan = (off: number) => activeSpan != null && off >= activeSpan.off && off < activeSpan.off + activeSpan.len;
  const rows = [];
  for (let bpos = 0; bpos < limit; bpos += 16) {
    const cells = [];
    let ascii = '';
    // Always emit 16 cells: a final short row must still pad, or the ASCII
    // gutter drifts left and stops lining up with the rows above it.
    for (let i = 0; i < 16; i++) {
      const off = bpos + i;
      if (off >= limit) {
        cells.push(<text key={i} style={{ color: C.dim }}>{'   '}</text>);
        ascii += ' ';
        continue;
      }
      const b = bytes[off]!; const hot = inSpan(off);
      ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      cells.push(<text key={i} style={{ color: hot ? C.bg : C.text, backgroundColor: hot ? C.hot : undefined }}>{b.toString(16).padStart(2, '0') + ' '}</text>);
    }
    rows.push(
      <box key={bpos} style={{ flexDirection: 'row' }}>
        <text style={{ color: C.dim, width: 42 }}>{bpos.toString(16).padStart(4, '0') + '  '}</text>
        {cells}<text style={{ color: C.dim, marginLeft: 8 }}>{ascii}</text>
      </box>,
    );
  }
  if (bytes.length > limit) rows.push(<text key="more" style={{ color: C.dim }}>{`… +${bytes.length - limit} more bytes`}</text>);
  return <box style={{ flexDirection: 'column' }}>{rows}</box>;
}

function prettyCall(m: CapturedMessage): string {
  const args = (m.fields ?? []).filter((f) => !['opcode', 'length', 'code', 'sequence', 'minor-opcode'].includes(f.name)).map((f) => `${f.name}=${f.value}`).join(', ');
  return `${m.name}(${args})`;
}
