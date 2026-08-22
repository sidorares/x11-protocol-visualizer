/**
 * The rule engine behind breakpoints and fault injection.
 *
 * One model serves two front ends: the structured editor (a message picked from
 * the catalog plus predicates on its parameters) and free-form JavaScript. Both
 * are evaluated against the same **match context**, so a rule built in the UI
 * and a rule typed as script see exactly the same world:
 *
 *   kind      'request' | 'reply' | 'event' | 'error'
 *   msg       the message being considered
 *   request   for a reply or error, the request it answers (else undefined) —
 *             this is what lets a rule say "break on this *response* when the
 *             *request* that asked for it had glyphset > 100"
 *   atom(n)   resolve an atom name to its id
 *
 * A message view exposes fields two ways, because rules want both:
 *   msg.f.width      → 800          (numeric, for comparisons)
 *   msg.text.width   → "800"        (as rendered, for string matching)
 *
 * Field names are normalised to the decoder's own spelling (hyphens), with an
 * underscore alias, so `msg.f['value-len']` and `msg.f.value_len` both work.
 */

import type { CapturedMessage, Field } from './protocol/types.js';

export type MessageKind = 'request' | 'reply' | 'event' | 'error';

/** How a message looks to a rule. */
export interface MessageView {
  kind: MessageKind;
  name: string;
  ext?: string;
  size: number;
  seq?: number;
  /** Numeric field values, NaN where a field is not numeric. */
  f: Record<string, number>;
  /** Field values as rendered for display. */
  text: Record<string, string>;
  /** The underlying message, for scripts that want more. */
  raw: CapturedMessage;
}

export interface MatchContext {
  kind: MessageKind;
  msg: MessageView;
  /** The request a reply/error answers, when it is known. */
  request?: MessageView;
  atom: (name: string) => number | undefined;
}

// --- structured predicates -------------------------------------------------

/** Which message a predicate reads from. */
export type PredicateSource = 'msg' | 'request';

export type PredicateOp =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'startsWith' | 'exists' | 'absent';

/**
 * How to interpret the comparison value. Kept open deliberately — `resource`
 * and `atom` are the first two "is a" types, and adding (say) `keycode` later
 * means one more case here and one more editor widget, nothing else.
 */
export type ValueKind = 'number' | 'string' | 'atom' | 'resource';

export interface Predicate {
  source: PredicateSource;
  /** A decoded field name, or a pseudo-field: name, size, seq, kind, ext. */
  field: string;
  op: PredicateOp;
  value?: string | number;
  valueKind?: ValueKind;
}

export interface Rule {
  id: number;
  enabled: boolean;
  action: 'break' | 'drop' | 'delay';
  delayMs?: number;
  once?: boolean;
  hits: number;

  // Coarse matchers — cheap, and on their own they are the "simple rule".
  /** Message name; substring, case-insensitive. */
  name?: string;
  dir?: 'c2s' | 's2c';
  /** Message kind. (`category` on the wire model.) */
  category?: string;

  /** Fine matchers, ANDed together. */
  predicates?: Predicate[];
  /** A JavaScript expression; when present it replaces the predicates. */
  script?: string;
  /** Set when a script threw, so the UI can show why it stopped matching. */
  error?: string;
  /** A human label, for rules built from the catalog. */
  label?: string;
}

const PSEUDO = new Set(['name', 'size', 'seq', 'kind', 'ext']);

/** Parse a decoded field's rendered value into a number where we can. */
export function numericOf(value: string): number {
  const v = value.trim();
  if (/^0x[0-9a-f]+$/i.test(v)) return parseInt(v, 16);
  if (/^-?\d+$/.test(v)) return Number(v);
  // Values rendered as `Name (7)` or `0x600 (a | b)` carry the number inline.
  const m = /\((-?\d+)\)\s*$/.exec(v) ?? /^0x([0-9a-f]+)\s*\(/i.exec(v);
  if (m) return m[0]!.startsWith('0x') ? parseInt(m[1]!, 16) : Number(m[1]);
  return NaN;
}

function viewOf(msg: CapturedMessage): MessageView {
  const f: Record<string, number> = Object.create(null);
  const text: Record<string, string> = Object.create(null);
  for (const fld of msg.fields ?? []) {
    const alias = fld.name.replace(/-/g, '_');
    const n = numericOf(fld.value);
    f[fld.name] = n;
    f[alias] = n;
    text[fld.name] = fld.value;
    text[alias] = fld.value;
  }
  return {
    kind: msg.category as MessageKind,
    name: msg.name,
    ext: msg.ext,
    size: msg.bytes.length,
    seq: msg.seq,
    f,
    text,
    raw: msg,
  };
}

/** Build the context a rule is evaluated against. */
export function buildContext(
  msg: CapturedMessage,
  lookup?: (id: number) => CapturedMessage | undefined,
  atomIds?: Map<string, number>,
): MatchContext {
  const req = msg.requestId != null && lookup ? lookup(msg.requestId) : undefined;
  return {
    kind: msg.category as MessageKind,
    msg: viewOf(msg),
    request: req ? viewOf(req) : undefined,
    atom: (name) => atomIds?.get(name),
  };
}

/** Read a predicate's operand out of the context. */
function operand(p: Predicate, ctx: MatchContext): { num: number; str: string; present: boolean } {
  const view = p.source === 'request' ? ctx.request : ctx.msg;
  if (!view) return { num: NaN, str: '', present: false };

  if (PSEUDO.has(p.field)) {
    const str =
      p.field === 'name' ? view.name
      : p.field === 'kind' ? view.kind
      : p.field === 'ext' ? (view.ext ?? '')
      : p.field === 'size' ? String(view.size)
      : view.seq != null ? String(view.seq) : '';
    return { num: p.field === 'size' ? view.size : p.field === 'seq' ? (view.seq ?? NaN) : NaN, str, present: str !== '' };
  }

  const str = view.text[p.field];
  return { num: view.f[p.field] ?? NaN, str: str ?? '', present: str !== undefined };
}

function compare(op: PredicateOp, got: { num: number; str: string; present: boolean }, want: Predicate, ctx: MatchContext): boolean {
  if (op === 'exists') return got.present;
  if (op === 'absent') return !got.present;
  if (!got.present) return false;

  const kind = want.valueKind ?? 'number';
  const raw = want.value;

  if (kind === 'atom') {
    // Atoms render as their name, so match the name first and fall back to the
    // numeric id for a capture that never saw the InternAtom.
    const wantName = String(raw ?? '');
    const byName = got.str.toLowerCase() === wantName.toLowerCase();
    const id = ctx.atom(wantName);
    const byId = id !== undefined && got.num === id;
    return op === 'ne' ? !(byName || byId) : byName || byId;
  }

  if (kind === 'string' || op === 'contains' || op === 'startsWith') {
    const a = got.str.toLowerCase();
    const b = String(raw ?? '').toLowerCase();
    switch (op) {
      case 'contains': return a.includes(b);
      case 'startsWith': return a.startsWith(b);
      case 'eq': return a === b;
      case 'ne': return a !== b;
      default: return false;
    }
  }

  // number / resource
  const want2 = typeof raw === 'number' ? raw : numericOf(String(raw ?? ''));
  if (Number.isNaN(got.num) || Number.isNaN(want2)) return false;
  switch (op) {
    case 'eq': return got.num === want2;
    case 'ne': return got.num !== want2;
    case 'gt': return got.num > want2;
    case 'gte': return got.num >= want2;
    case 'lt': return got.num < want2;
    case 'lte': return got.num <= want2;
    default: return false;
  }
}

// --- scripts ---------------------------------------------------------------

const scriptCache = new Map<string, ((ctx: MatchContext) => unknown) | Error>();

/**
 * Compile a rule script. The script is a JavaScript *expression* evaluated with
 * `kind`, `msg`, `request` and `atom` in scope. This runs the user's own code
 * on their own machine — the same trust model as a devtools snippet — so it is
 * compiled, not sandboxed; what it must never do is take the proxy down, hence
 * every call site catches.
 */
export function compileScript(src: string): ((ctx: MatchContext) => unknown) | Error {
  const hit = scriptCache.get(src);
  if (hit) return hit;
  let out: ((ctx: MatchContext) => unknown) | Error;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('kind', 'msg', 'request', 'atom', `"use strict"; return (${src});`) as (
      k: string, m: MessageView, r: MessageView | undefined, a: MatchContext['atom'],
    ) => unknown;
    out = (ctx: MatchContext) => fn(ctx.kind, ctx.msg, ctx.request, ctx.atom);
  } catch (err) {
    out = err as Error;
  }
  scriptCache.set(src, out);
  return out;
}

// --- evaluation ------------------------------------------------------------

/** The coarse matchers only — cheap, and all a "simple" rule needs. */
export function matchesCoarse(rule: Rule, msg: CapturedMessage): boolean {
  if (!rule.enabled) return false;
  if (rule.dir && msg.dir !== rule.dir) return false;
  if (rule.category && msg.category !== rule.category) return false;
  if (rule.name && !msg.name.toLowerCase().includes(rule.name.toLowerCase())) return false;
  return true;
}

/**
 * Full evaluation: coarse matchers, then either the script or the predicates.
 * Never throws — a broken script records its error on the rule and stops
 * matching rather than taking the relay with it.
 */
export function evaluateRule(rule: Rule, ctx: MatchContext): boolean {
  if (!matchesCoarse(rule, ctx.msg.raw)) return false;

  if (rule.script && rule.script.trim()) {
    const fn = compileScript(rule.script);
    if (fn instanceof Error) {
      rule.error = fn.message;
      return false;
    }
    try {
      const ok = !!fn(ctx);
      rule.error = undefined;
      return ok;
    } catch (err) {
      rule.error = (err as Error).message;
      return false;
    }
  }

  for (const p of rule.predicates ?? []) {
    if (!compare(p.op, operand(p, ctx), p, ctx)) return false;
  }
  return true;
}

/** A one-line description of a rule, for chips and menus. */
export function describeRule(rule: Rule): string {
  if (rule.label) return rule.label;
  const target = rule.name ?? rule.category ?? rule.dir ?? 'any';
  if (rule.script?.trim()) return `${rule.action} ${target} · script`;
  const n = rule.predicates?.length ?? 0;
  return `${rule.action} ${target}${n ? ` · ${n} condition${n === 1 ? '' : 's'}` : ''}`;
}

export const OPS: { id: PredicateOp; label: string; needsValue: boolean }[] = [
  { id: 'eq', label: '=', needsValue: true },
  { id: 'ne', label: '≠', needsValue: true },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'gte', label: '≥', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
  { id: 'lte', label: '≤', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'startsWith', label: 'starts with', needsValue: true },
  { id: 'exists', label: 'is present', needsValue: false },
  { id: 'absent', label: 'is absent', needsValue: false },
];
