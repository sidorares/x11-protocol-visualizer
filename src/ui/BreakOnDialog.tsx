// @jsxRuntime automatic
// @jsxImportSource react
/**
 * "Break on…" — pick a message from the protocol catalog, then say when.
 *
 * Two tabs, because there are two kinds of user here and one model underneath:
 *
 *   Conditions — pick parameters and compare them. Covers the common cases
 *                without anyone learning an API, and the parameter list comes
 *                from the catalog so it is always the real fields.
 *   Script     — a JavaScript expression over the same match context, for the
 *                things a form cannot say. `kind`, `msg`, `request` and `atom`
 *                are in scope; `request` is how a rule on a *response* reaches
 *                the request that asked for it.
 */

import { useMemo, useState } from 'react';
import { Dialog, Select, Tabs } from 'react-x11';
import { Tree } from '@react-x11/components/tree';
import { CodeEditor } from '@react-x11/components/code-editor';
import { javascript } from '@react-x11/components/code-language';
import { Icon } from './icons.js';
import { Button, Pill, T, TextField } from './controls.js';
import { buildCatalog, PSEUDO_PARAMS, type CatalogEntry, type CatalogNode, type CatalogParam } from '../core/catalog.js';
import { OPS, type Predicate, type PredicateOp, type PredicateSource, type Rule } from '../core/rules.js';

const C = T;

const SCRIPT_PLACEHOLDER =
  "// A JavaScript expression — its result is the match.\n" +
  "// e.g. break on a response whose request asked for a lot:\n" +
  "kind === 'reply' && request.f['num-glyphs'] > 100";

export interface BreakOnDialogProps {
  open: boolean;
  /** Known atom names, for the atom picker. */
  atoms: string[];
  onClose: () => void;
  onCreate: (rule: Omit<Rule, 'id' | 'hits'>) => void;
}

export function BreakOnDialog({ open, atoms, onClose, onCreate }: BreakOnDialogProps) {
  const catalog = useMemo(() => buildCatalog(), []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entry, setEntry] = useState<CatalogEntry | null>(null);
  const [tab, setTab] = useState('conditions');
  const [action, setAction] = useState<'break' | 'drop' | 'delay'>('break');
  const [predicates, setPredicates] = useState<Predicate[]>([]);
  const [script, setScript] = useState('');
  const [once, setOnce] = useState(false);

  if (!open) return null;

  const params: CatalogParam[] = entry ? [...entry.params, ...PSEUDO_PARAMS] : PSEUDO_PARAMS;

  const create = () => {
    const usingScript = tab === 'script' && script.trim().length > 0;
    onCreate({
      enabled: true,
      action,
      delayMs: action === 'delay' ? 250 : undefined,
      once,
      // The catalog name is exact; the matcher is substring, which is what we
      // want — a reply is `<Request>·reply`, so the request name matches both
      // unless the kind pins it down, and the kind always does here.
      name: entry?.shortName,
      category: entry?.kind,
      predicates: usingScript ? undefined : predicates.filter((p) => p.field),
      script: usingScript ? script : undefined,
      label: entry
        ? `${action} ${entry.name}${usingScript ? ' · script' : predicates.length ? ` · ${predicates.length} cond` : ''}`
        : undefined,
    });
    onClose();
  };

  const addPredicate = () =>
    setPredicates((p) => [...p, { source: 'msg', field: params[0]?.name ?? 'size', op: 'eq', value: '', valueKind: params[0]?.valueKind ?? 'number' }]);
  const setPred = (i: number, patch: Partial<Predicate>) =>
    setPredicates((p) => p.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const delPredicate = (i: number) => setPredicates((p) => p.filter((_, j) => j !== i));

  // The panels are built here and handed to `Tabs` as item content. Rendering
  // them *below* a Tabs strip instead left the component's own (empty) panel
  // holding the space, which is what pushed the editor down the dialog.
  const conditionsPanel = entry ? (
    <box style={{
      flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'stretch',
      gap: 5, flexGrow: 1, minHeight: 0, paddingTop: 6,
    }}>
      {predicates.length === 0 && (
        <text style={{ color: C.dim }}>
          {`No conditions — the rule fires on every ${entry.shortName}. Add one to narrow it.`}
        </text>
      )}
      {predicates.map((p, i) => (
        <PredicateRow
          key={i}
          p={p}
          params={params}
          atoms={atoms}
          hasRequest={entry.kind === 'reply' || entry.kind === 'error'}
          onChange={(patch) => setPred(i, patch)}
          onDelete={() => delPredicate(i)}
        />
      ))}
      <box style={{ flexDirection: 'row', flexShrink: 0 }}>
        <Button label="Add condition" icon="plus" onClick={addPredicate} />
      </box>
      {/* Soak up the rest so the rows stay at the top of the panel. */}
      <box style={{ flexGrow: 1 }} />
    </box>
  ) : null;

  const scriptPanel = (
    <box style={{ flexDirection: 'column', gap: 4, flexGrow: 1, minHeight: 0, paddingTop: 6 }}>
      <box style={{
        flexGrow: 1, minHeight: 0, borderColor: C.border, borderWidth: 1,
        borderRadius: T.radius, backgroundColor: C.panelAlt,
      }}>
        <CodeEditor
          value={script}
          language={javascript()}
          onChange={(ev: { value: string }) => setScript(ev.value)}
          placeholder={SCRIPT_PLACEHOLDER}
          lineNumbers
          style={{ flexGrow: 1, minHeight: 0 }}
        />
      </box>
      <text style={{ color: C.dim, textWrap: 'nowrap' }}>
        {'kind · msg.name · msg.f.<param> · msg.text.<param> · request.f.<param> · atom(name)'}
      </text>
    </box>
  );

  return (
    <Dialog
      open
      title="Break on…"
      width={900}
      height={620}
      onClose={onClose}
      actions={
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button label="Cancel" onClick={onClose} />
          <Button label={`Add ${action} rule`} variant="solid" onClick={create} disabled={!entry} />
        </box>
      }
      style={{ backgroundColor: C.bg }}
    >
      <box style={{ flexDirection: 'row', gap: 10, flexGrow: 1 }}>
        {/* Catalog */}
        <box style={{ flexDirection: 'column', width: 320, gap: 4 }}>
          <text style={{ color: C.dim }}>Protocol catalog</text>
          <box style={{ flexGrow: 1, borderColor: C.border, borderWidth: 1, backgroundColor: C.panelAlt }}>
            <Tree
              items={catalog}
              onSelect={(id: string, item: CatalogNode) => {
                setSelectedId(id);
                if (item.entry) {
                  setEntry(item.entry);
                  setPredicates([]);
                }
              }}
              selected={selectedId}
            />
          </box>
        </box>

        {/* Editor */}
        <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, gap: 6 }}>
          {!entry ? (
            <text style={{ color: C.dim }}>Pick a request, response, event or error on the left.</text>
          ) : (
            <>
              <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <text style={{ color: C.text, fontWeight: 'bold' }}>{entry.name}</text>
                <text style={{ color: C.dim }}>{entry.kind}</text>
                {entry.partial && <text style={{ color: C.warn }}>· variable-length tail not decoded</text>}
              </box>

              <box style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <text style={{ color: C.dim }}>Action</text>
                <Select
                  value={action}
                  options={[
                    { value: 'break', label: 'break — hold it' },
                    { value: 'drop', label: 'drop — never forward' },
                    { value: 'delay', label: 'delay 250ms' },
                  ]}
                  onChange={(ev: { value: string }) => setAction(ev.value as 'break' | 'drop' | 'delay')}
                  style={{ width: 190 }}
                />
                <Button
                  icon={once ? 'square-check' : 'square'}
                  label="once"
                  variant={once ? 'outline' : 'ghost'}
                  accent={once ? C.link : C.dim}
                  small
                  onClick={() => setOnce((v) => !v)}
                />
              </box>

              <Tabs
                items={[
                  { id: 'conditions', label: 'Conditions', content: conditionsPanel },
                  { id: 'script', label: 'Script', content: scriptPanel },
                ]}
                value={tab}
                onChange={setTab}
                style={{ flexGrow: 1, minHeight: 0 }}
              />
            </>
          )}
        </box>
      </box>
    </Dialog>
  );
}

function PredicateRow({ p, params, atoms, hasRequest, onChange, onDelete }: {
  p: Predicate;
  params: CatalogParam[];
  atoms: string[];
  hasRequest: boolean;
  onChange: (patch: Partial<Predicate>) => void;
  onDelete: () => void;
}) {
  const param = params.find((x) => x.name === p.field);
  const needsValue = OPS.find((o) => o.id === p.op)?.needsValue ?? true;
  const kind = p.valueKind ?? param?.valueKind ?? 'number';

  return (
    <box style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {/* Which message: this one, or the request it answers. */}
      <Select
        value={p.source}
        options={
          hasRequest
            ? [{ value: 'msg', label: 'this' }, { value: 'request', label: 'its request' }]
            : [{ value: 'msg', label: 'this' }]
        }
        onChange={(ev: { value: string }) => onChange({ source: ev.value as PredicateSource })}
        style={{ width: 110 }}
      />
      <Select
        value={p.field}
        options={params.map((x) => ({ value: x.name, label: x.name }))}
        onChange={(ev: { value: string }) => {
          const np = params.find((x) => x.name === ev.value);
          onChange({ field: ev.value, valueKind: np?.valueKind ?? 'number', value: '' });
        }}
        style={{ width: 170 }}
      />
      <Select
        value={p.op}
        options={OPS.map((o) => ({ value: o.id, label: o.label }))}
        onChange={(ev: { value: string }) => onChange({ op: ev.value as PredicateOp })}
        style={{ width: 110 }}
      />
      {needsValue &&
        (kind === 'atom' ? (
          <Select
            value={String(p.value ?? '')}
            options={atoms.map((a) => ({ value: a, label: a }))}
            placeholder="atom…"
            onChange={(ev: { value: string }) => onChange({ value: ev.value, valueKind: 'atom' })}
            style={{ width: 200 }}
          />
        ) : param?.choices ? (
          <Select
            value={String(p.value ?? '')}
            options={param.choices.map((c) => ({ value: String(c.value), label: `${c.label} (${c.value})` }))}
            placeholder="value…"
            onChange={(ev: { value: string }) => onChange({ value: Number(ev.value), valueKind: 'number' })}
            style={{ width: 200 }}
          />
        ) : (
          <TextField
            value={String(p.value ?? '')}
            placeholder={kind === 'resource' ? '0x00a00001' : kind === 'string' ? 'text' : 'number'}
            width={200}
            onChange={(v: string) => onChange({ value: v })}
          />
        ))}
      <Button icon="trash-2" variant="ghost" accent={C.text} small onClick={onDelete} />
    </box>
  );
}
