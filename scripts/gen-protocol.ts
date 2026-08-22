/**
 * Generate protocol tables from the xcbproto XML corpus.
 *
 *   npm run gen:protocol            # reads /opt/X11/share/xcb
 *   npm run gen:protocol -- <dir>
 *
 * What it generates, and what it deliberately does not:
 *
 *   ✓ every request / event / error **name**, for every extension — this is
 *     what removes the `ext139:req4` long tail
 *   ✓ **enums** (so a numeric class/mode/style renders as a name)
 *   ✓ **value-mask bit tables** (CW, GC, CP, …) for value-list expansion
 *   ✓ the **fixed-length field prefix** of each request, with byte offsets, so
 *     generated decoders carry real spans
 *   ✓ the **variable-length tail** after it — `<list>`s whose length is a
 *     field, a literal, an arithmetic expression over earlier fields
 *     (`data_len * format / 8`), or unstated, which xcbproto means as "the
 *     rest of the message". Offsets past the first list are not known until
 *     decode time, so the tail is emitted as a *sequence* the decoder walks.
 *     Struct element sizes are computed too (RECTANGLE, POINT, FP3232, …),
 *     without which the walk stopped at every drawing request.
 *
 *   ✗ `<switch>` bitcases, `<union>`s, and lengths needing `popcount` or
 *     `sumof`. Generation stops there and marks the message `partial` — 62 of
 *     652 requests, down from 156. The hand-written specs in `extensions/`
 *     remain the way to cover one of those richly.
 *
 * Nothing here guesses. A length that cannot be evaluated marks the message
 * partial rather than falling back to "the rest of the message", which would
 * be the same guess wearing a different hat.
 *
 * Hand-written specs always win over generated data (see extensions/index.ts),
 * so this only ever fills gaps.
 */

import fs from 'node:fs';
import path from 'node:path';

// ---- a small tolerant XML reader ------------------------------------------
// xcbproto files are machine-generated and regular, so a full parser would be
// more machinery than the job needs.

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

function parseXml(src: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, close, open, attrStr, selfClose, text] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
    } else if (open) {
      const attrs: Record<string, string> = {};
      for (const a of attrStr?.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g) ?? []) attrs[a[1]!] = a[2]!;
      const node: Node = { tag: open, attrs, children: [], text: '' };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClose) stack.push(node);
    } else if (text && text.trim()) {
      stack[stack.length - 1]!.text += text.trim();
    }
  }
  return root;
}

const kids = (n: Node, tag: string) => n.children.filter((c) => c.tag === tag);
const kid = (n: Node, tag: string) => n.children.find((c) => c.tag === tag);

// ---- type sizes -----------------------------------------------------------

const BASE_SIZES: Record<string, number> = {
  BOOL: 1, BYTE: 1, CARD8: 1, INT8: 1, char: 1, void: 1,
  CARD16: 2, INT16: 2,
  CARD32: 4, INT32: 4, float: 4,
  CARD64: 8, INT64: 8, double: 8,
};

/**
 * Which types name a resource is not a curated list — it is exactly what the
 * XML declares as `<xidtype>` / `<xidunion>` (plus typedefs of those). Deriving
 * it means new extensions get clickable resource links for free; hardcoding it
 * meant SHM's `SEG` rendered as a bare integer.
 */
const XID_TYPES = new Set<string>();

interface Ext {
  file: string;
  /** The name QueryExtension returns (absent for core xproto). */
  xname?: string;
  header: string;
  requests: Record<number, GenMessage>;
  events: Record<number, GenMessage>;
  errors: Record<number, string>;
  enums: Record<string, Record<number, string>>;
  masks: Record<string, { bit: number; name: string }[]>;
}

interface GenField {
  name: string;
  type: string;
  off: number;
  len: number;
  enum?: string;
  mask?: string;
  resource?: boolean;
}

/**
 * What follows the fixed prefix, in wire order.
 *
 * Once a list appears, nothing after it has a compile-time offset — the list's
 * length is a field read at runtime — so the tail is a *sequence* the decoder
 * walks, accumulating offsets from `tailOff`, rather than more absolute-offset
 * fields. A list whose length is an `<op>` expression, a `<switch>` or a
 * `<union>` still stops generation and marks the message partial.
 */
/**
 * An xcbproto length expression, reduced to what a decoder can evaluate:
 * arithmetic over earlier fields and literals. `popcount`, `sumof`, `enumref`
 * and unary operators are not represented — a list needing one of those marks
 * the message partial instead of guessing.
 */
type GenExpr =
  | { op: '+' | '-' | '*' | '/' | '&' | '<<' | '>>'; l: GenExpr; r: GenExpr }
  | { field: string }
  | { value: number };

type GenTailItem =
  | { kind: 'field'; name: string; type: string; len: number; enum?: string; mask?: string; resource?: boolean }
  | { kind: 'pad'; len: number }
  /** `<pad align="4">`: skip to the next multiple of `to`. */
  | { kind: 'align'; to: number }
  | {
      kind: 'list';
      name: string;
      type: string;
      /** Element size in bytes. */
      elem: number;
      /** Field whose value is the element count… */
      lenFrom?: string;
      /** …or a literal count. */
      lenConst?: number;
      /** …or an arithmetic expression over earlier fields. */
      lenExpr?: GenExpr;
      /** …or "everything left in the message", xcbproto's unstated default. */
      lenRest?: boolean;
      resource?: boolean;
    };

interface GenMessage {
  name: string;
  fields: GenField[];
  /** True when a variable-length construct stopped generation early. */
  partial: boolean;
  /** The variable-length tail, walked from `tailOff`. */
  tail?: GenTailItem[];
  /** Absolute offset where `tail` starts. */
  tailOff?: number;
  /** For a request: the layout of the reply it generates, if it has one. */
  reply?: GenMessage;
}

function collectTypeSizes(docs: Node[]): Record<string, number> {
  const sizes: Record<string, number> = { ...BASE_SIZES };
  for (const doc of docs) {
    const x = kid(doc, 'xcb');
    if (!x) continue;
    for (const t of kids(x, 'xidtype')) { sizes[t.attrs.name!] = 4; XID_TYPES.add(t.attrs.name!); }
    for (const t of kids(x, 'xidunion')) { sizes[t.attrs.name!] = 4; XID_TYPES.add(t.attrs.name!); }
    for (const t of kids(x, 'typedef')) {
      const old = t.attrs.oldname!;
      if (sizes[old] !== undefined) sizes[t.attrs.newname!] = sizes[old]!;
      if (XID_TYPES.has(old)) XID_TYPES.add(t.attrs.newname!);
    }
  }
  // A few well-known aliases xcbproto expects the reader to know.
  Object.assign(sizes, { VISUALID: 4, ATOM: 4, TIMESTAMP: 4, KEYSYM: 4, KEYCODE: 1, KEYCODE32: 4, BUTTON: 1 });

  // Structs of fixed-size fields have a fixed size too, and lists of them —
  // RECTANGLE, POINT, ARC, FP3232, ModeInfo — are common enough that without
  // this the tail walker stops at most drawing and RANDR requests. A struct
  // holding a list (STR, with its length prefix) has no fixed size and is
  // deliberately left unsized. Iterated to a fix-point because structs nest
  // and the corpus does not declare them in dependency order.
  const structs: Node[] = [];
  for (const doc of docs) {
    const x = kid(doc, 'xcb');
    if (x) structs.push(...kids(x, 'struct'));
  }
  for (let pass = 0; pass < 8; pass++) {
    let learned = 0;
    for (const s of structs) {
      const name = s.attrs.name!;
      if (sizes[name] !== undefined) continue;
      let total = 0;
      let known = true;
      for (const c of s.children) {
        if (c.tag === 'pad') {
          // An alignment pad inside a struct has no fixed contribution.
          if (c.attrs.align) { known = false; break; }
          total += Number(c.attrs.bytes ?? 0) || 0;
        } else if (c.tag === 'field') {
          const sz = sizes[c.attrs.type!];
          if (sz === undefined) { known = false; break; }
          total += sz;
        } else if (c.tag === 'list') {
          // A fixed-count list of a known type still has a fixed size.
          const count = listCount(c);
          const sz = sizes[c.attrs.type!];
          if (sz === undefined || !count || count === 'none' || !('lenConst' in count)) { known = false; break; }
          total += sz * count.lenConst;
        } else if (c.tag === 'doc') {
          continue;
        } else {
          known = false;
          break;
        }
      }
      if (known && total > 0) { sizes[name] = total; learned++; }
    }
    if (!learned) break;
  }
  return sizes;
}

/**
 * Where a message's fields begin, which differs by message kind — xcbproto
 * leaves this implicit and expects the reader to know it:
 *
 *   core request     0=opcode, 1=the first 1-byte field (or pad), 2-3=length,
 *                    then fields from 4
 *   extension request 0=major, **1=minor opcode**, 2-3=length, fields from 4 —
 *                    so byte 1 is never a field, and no pad is written for it
 *   classic event    0=code, 1=detail (or pad), 2-3=sequence, fields from 4
 *   XGE event        0=35, 1=extension, 2-3=sequence, 4-7=length, 8-9=evtype,
 *                    fields from 10
 */
type Kind = 'core-request' | 'ext-request' | 'event' | 'xge-event' | 'reply';

function layout(node: Node, sizes: Record<string, number>, kind: Kind): GenMessage {
  const fields: GenField[] = [];
  // Extension requests and XGE events have no first-byte field slot.
  const usesFirstSlot = kind === 'core-request' || kind === 'event' || kind === 'reply';
  let off = kind === 'ext-request' ? 4 : kind === 'xge-event' ? 10 : 1;
  // A reply is 0=1, 1=data byte, 2-3=sequence, 4-7=length, fields from 8.
  const afterFirstSlot = kind === 'reply' ? 8 : 4;
  let firstSlotUsed = !usesFirstSlot;
  let partial = false;

  // Everything from the first list onwards, in wire order.
  const tail: GenTailItem[] = [];
  let tailOff: number | undefined;
  /** Once a list has been seen, later items join the tail instead. */
  const inTail = () => tailOff !== undefined;

  for (const c of node.children) {
    // A switch/union is where xcbproto's expression language really starts;
    // stop there and say so rather than guessing.
    if (c.tag === 'switch' || c.tag === 'valueparam' || c.tag === 'union') {
      partial = true;
      break;
    }

    if (c.tag === 'list') {
      const elem = sizes[c.attrs.type!];
      const declared = listCount(c);
      const count =
        declared === 'none'
          ? isLastChild(node, c)
            ? { lenRest: true as const }
            : undefined
          : declared;
      if (elem === undefined || !count) {
        // An element type of unknown size, a length this generator cannot
        // evaluate, or an unbounded list with something after it.
        partial = true;
        break;
      }
      if (!inTail()) tailOff = off;
      tail.push({
        kind: 'list',
        name: c.attrs.name!,
        type: c.attrs.type!,
        elem,
        ...count,
        resource: XID_TYPES.has(c.attrs.type!),
      });
      continue;
    }

    if (c.tag === 'reply' || c.tag === 'doc' || c.tag === 'exprfield') continue;

    if (inTail()) {
      // Past the first list: sizes are still known, offsets are not.
      if (c.tag === 'pad') {
        const align = Number(c.attrs.align ?? 0);
        if (align > 0) tail.push({ kind: 'align', to: align });
        else tail.push({ kind: 'pad', len: Number(c.attrs.bytes ?? 0) || 0 });
      } else if (c.tag === 'field') {
        const size = sizes[c.attrs.type!];
        if (size === undefined) {
          partial = true;
          break;
        }
        tail.push({
          kind: 'field',
          name: c.attrs.name!,
          type: c.attrs.type!,
          len: size,
          enum: c.attrs.enum ?? c.attrs.altenum,
          mask: c.attrs.mask,
          resource: XID_TYPES.has(c.attrs.type!),
        });
      }
      continue;
    }

    if (c.tag === 'pad') {
      off += Number(c.attrs.bytes ?? 0) || 0;
    } else if (c.tag === 'field') {
      const size = sizes[c.attrs.type!];
      if (size === undefined) {
        partial = true;
        break;
      }
      fields.push({
        name: c.attrs.name!,
        type: c.attrs.type!,
        off,
        len: size,
        enum: c.attrs.enum ?? c.attrs.altenum,
        mask: c.attrs.mask,
        resource: XID_TYPES.has(c.attrs.type!),
      });
      off += size;
    } else {
      continue;
    }

    // Once the single byte after the code has been consumed (by a field or a
    // pad), skip the 2-byte length/sequence and continue at offset 4.
    if (!firstSlotUsed && off >= 2) {
      firstSlotUsed = true;
      off = afterFirstSlot;
    }
  }
  return {
    name: node.attrs.name!,
    fields,
    partial,
    ...(tail.length && tailOff !== undefined ? { tail, tailOff } : {}),
  };
}

/**
 * Is `c` the last thing in `node` that occupies wire space? A list with no
 * declared length means "the rest of the message" — xcbproto leaves it
 * unstated for PolyFillRectangle, PolyLine, SetClipRectangles and most of the
 * drawing requests. That is only unambiguous when nothing follows it.
 */
function isLastChild(node: Node, c: Node): boolean {
  const wire = node.children.filter((k) => k.tag !== 'doc' && k.tag !== 'reply');
  return wire[wire.length - 1] === c;
}

/**
 * A list's element count.
 *
 * `'none'` means the list declares no length at all — xcbproto's way of
 * saying "the rest of the message", which every drawing request relies on.
 * `undefined` means it declares one this generator cannot evaluate
 * (`popcount`, `sumof`, a unary op), which marks the message partial rather
 * than producing a length that is quietly wrong. Falling back to
 * "rest of the message" in *that* case would be the same guess wearing a
 * different hat, and would silently swallow the padding.
 */
function listCount(
  list: Node,
): { lenFrom: string } | { lenConst: number } | { lenExpr: GenExpr } | 'none' | undefined {
  const child = list.children.find((c) => c.tag !== 'doc');
  if (!child) return 'none';
  if (child.tag === 'fieldref') return { lenFrom: child.text.trim() };
  if (child.tag === 'value') {
    const n = Number(child.text.trim());
    return Number.isFinite(n) ? { lenConst: n } : undefined;
  }
  const expr = parseExpr(child);
  return expr ? { lenExpr: expr } : undefined;
}

const EXPR_OPS = new Set(['+', '-', '*', '/', '&', '<<', '>>']);

/** `<op>` / `<fieldref>` / `<value>` — the evaluable part of the grammar. */
function parseExpr(node: Node): GenExpr | undefined {
  if (node.tag === 'fieldref') return { field: node.text.trim() };
  if (node.tag === 'value') {
    const n = Number(node.text.trim());
    return Number.isFinite(n) ? { value: n } : undefined;
  }
  if (node.tag !== 'op') return undefined;
  const op = node.attrs.op ?? '';
  if (!EXPR_OPS.has(op)) return undefined; // popcount, and anything new
  const args = node.children.filter((c) => c.tag !== 'doc');
  if (args.length !== 2) return undefined;
  const l = parseExpr(args[0]!);
  const r = parseExpr(args[1]!);
  return l && r ? ({ op, l, r } as GenExpr) : undefined;
}

function parseExtension(file: string, doc: Node, sizes: Record<string, number>): Ext | undefined {
  const x = kid(doc, 'xcb');
  if (!x) return undefined;
  const ext: Ext = {
    file: path.basename(file),
    xname: x.attrs['extension-xname'],
    header: x.attrs.header!,
    requests: {},
    events: {},
    errors: {},
    enums: {},
    masks: {},
  };

  const reqKind: Kind = ext.xname ? 'ext-request' : 'core-request';
  for (const r of kids(x, 'request')) {
    const m = layout(r, sizes, reqKind);
    // A `<reply>` child means this request round-trips; its layout is what a
    // rule needs to put a condition on a *response* field.
    const rep = kid(r, 'reply');
    if (rep) {
      // `<reply>` carries no name of its own; it belongs to its request.
      m.reply = { ...layout(rep, sizes, 'reply'), name: m.name };
    }
    ext.requests[Number(r.attrs.opcode)] = m;
  }
  // Events, remembered by name so `<eventcopy>` can borrow their layout.
  const byName = new Map<string, GenMessage>();
  for (const e of kids(x, 'event')) {
    const m = layout(e, sizes, e.attrs.xge === 'true' ? 'xge-event' : 'event');
    ext.events[Number(e.attrs.number)] = m;
    byName.set(e.attrs.name!, m);
  }
  // `<eventcopy name="Motion" ref="ButtonPress"/>` is the same wire layout
  // under another name — XI2 declares most of its events this way, so without
  // resolving the ref they would generate no fields at all.
  for (const e of kids(x, 'eventcopy')) {
    const src = byName.get(e.attrs.ref!);
    ext.events[Number(e.attrs.number)] = src
      ? { name: e.attrs.name!, fields: src.fields, partial: src.partial }
      : { name: e.attrs.name!, fields: [], partial: true };
  }
  for (const e of kids(x, 'error')) ext.errors[Number(e.attrs.number)] = e.attrs.name!;
  for (const e of kids(x, 'errorcopy')) ext.errors[Number(e.attrs.number)] = e.attrs.name!;

  for (const en of kids(x, 'enum')) {
    const values: Record<number, string> = {};
    const bits: { bit: number; name: string }[] = [];
    for (const item of kids(en, 'item')) {
      const v = kid(item, 'value');
      const b = kid(item, 'bit');
      if (v) values[Number(v.text)] = item.attrs.name!;
      else if (b) {
        const bitNo = Number(b.text);
        bits.push({ bit: 1 << bitNo, name: item.attrs.name! });
        values[1 << bitNo] = item.attrs.name!;
      }
    }
    if (Object.keys(values).length) ext.enums[en.attrs.name!] = values;
    if (bits.length) ext.masks[en.attrs.name!] = bits;
  }
  return ext;
}

// ---- emit -----------------------------------------------------------------

function emit(exts: Ext[]): string {
  const out: string[] = [];
  out.push('/* eslint-disable */');
  out.push('// GENERATED by scripts/gen-protocol.ts from the xcbproto XML corpus.');
  out.push('// Do not edit by hand — re-run `npm run gen:protocol`.');
  out.push('//');
  out.push('// Contains names, enums, value-mask bits, fixed-prefix field layouts, and');
  out.push('// the variable-length `tail` that follows them — lists whose length is a');
  out.push('// field, a literal, an arithmetic expression over earlier fields, or the');
  out.push('// rest of the message. A `<switch>`, `<union>` or a length needing popcount/');
  out.push('// sumof still marks the message `partial`. Hand-written specs in');
  out.push('// ../extensions/ take precedence over everything here.');
  out.push('');
  out.push('export interface GenField { name: string; type: string; off: number; len: number; enum?: string; mask?: string; resource?: boolean }');
  out.push('');
  out.push('/** An arithmetic length expression over earlier fields. */');
  out.push("export type GenExpr =");
  out.push("  | { op: '+' | '-' | '*' | '/' | '&' | '<<' | '>>'; l: GenExpr; r: GenExpr }");
  out.push('  | { field: string }');
  out.push('  | { value: number };');
  out.push('');
  out.push('/** One step of the variable-length tail, walked in wire order. */');
  out.push('export type GenTailItem =');
  out.push("  | { kind: 'field'; name: string; type: string; len: number; enum?: string; mask?: string; resource?: boolean }");
  out.push("  | { kind: 'pad'; len: number }");
  out.push("  | { kind: 'align'; to: number }");
  out.push("  | { kind: 'list'; name: string; type: string; elem: number; lenFrom?: string;");
  out.push('      lenConst?: number; lenExpr?: GenExpr; lenRest?: boolean; resource?: boolean };');
  out.push('');
  out.push('export interface GenMessage {');
  out.push('  name: string;');
  out.push('  fields: GenField[];');
  out.push('  partial: boolean;');
  out.push('  /** Walked from `tailOff`; offsets past the first list are dynamic. */');
  out.push('  tail?: GenTailItem[];');
  out.push('  tailOff?: number;');
  out.push('  reply?: GenMessage;');
  out.push('}');
  out.push('export interface GenExtension {');
  out.push('  xname?: string;');
  out.push('  header: string;');
  out.push('  requests: Record<number, GenMessage>;');
  out.push('  events: Record<number, GenMessage>;');
  out.push('  errors: Record<number, string>;');
  out.push('  enums: Record<string, Record<number, string>>;');
  out.push('  masks: Record<string, { bit: number; name: string }[]>;');
  out.push('}');
  out.push('');
  out.push('export const GENERATED: Record<string, GenExtension> = ' + JSON.stringify(
    Object.fromEntries(exts.map((e) => [e.header, {
      xname: e.xname,
      header: e.header,
      requests: e.requests,
      events: e.events,
      errors: e.errors,
      enums: e.enums,
      masks: e.masks,
    }])),
    null,
    1,
  ) + ';');
  out.push('');
  out.push('/** Every type the corpus declares as an XID — resource-typed fields. */');
  out.push('export const XID_TYPE_NAMES: readonly string[] = ' + JSON.stringify([...XID_TYPES].sort()) + ';');
  out.push('');
  out.push('/** Extension-name (what QueryExtension returns) → generated tables. */');
  out.push('export const GENERATED_BY_XNAME: Record<string, GenExtension> = Object.fromEntries(');
  out.push('  Object.values(GENERATED).filter((e) => e.xname).map((e) => [e.xname!, e]),');
  out.push(');');
  out.push('');
  return out.join('\n');
}

// ---- main -----------------------------------------------------------------

const dir = process.argv[2] ?? '/opt/X11/share/xcb';
if (!fs.existsSync(dir)) {
  console.error(`xcbproto XML not found at ${dir}\n` +
    `Install xcbproto (macOS: it ships with XQuartz at /opt/X11/share/xcb) or pass a directory.`);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.xml')).map((f) => path.join(dir, f));
const docs = files.map((f) => parseXml(fs.readFileSync(f, 'utf8')));
const sizes = collectTypeSizes(docs);

const exts: Ext[] = [];
for (let i = 0; i < files.length; i++) {
  const ext = parseExtension(files[i]!, docs[i]!, sizes);
  if (ext) exts.push(ext);
}

const outFile = path.join(process.cwd(), 'src/core/protocol/generated.ts');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, emit(exts));

const nReq = exts.reduce((a, e) => a + Object.keys(e.requests).length, 0);
const nEvt = exts.reduce((a, e) => a + Object.keys(e.events).length, 0);
const nErr = exts.reduce((a, e) => a + Object.keys(e.errors).length, 0);
const nEnum = exts.reduce((a, e) => a + Object.keys(e.enums).length, 0);
const partial = exts.reduce((a, e) => a + Object.values(e.requests).filter((r) => r.partial).length, 0);
console.log(
  `generated ${outFile}\n` +
    `  ${exts.length} protocol files · ${nReq} requests (${partial} with variable tails) · ` +
    `${nEvt} events · ${nErr} errors · ${nEnum} enums`,
);
