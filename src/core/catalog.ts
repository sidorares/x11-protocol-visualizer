/**
 * The message catalog — every request, response, event and error the protocol
 * defines, with their parameters, for browsing in the "Break on…" dialog.
 *
 * Built from the generated xcbproto tables, so it covers the whole protocol
 * rather than only the messages someone hand-wrote a decoder for. Parameter
 * entries carry enough type information for the editor to offer the right
 * widget: a number box, a text box, or an atom dropdown.
 */

import { GENERATED, type GenExtension, type GenField, type GenMessage } from './protocol/generated.js';
import type { MessageKind, ValueKind } from './rules.js';

export interface CatalogParam {
  name: string;
  type: string;
  /** Which editor widget and comparison semantics this parameter wants. */
  valueKind: ValueKind;
  /** Enum members, when the parameter is an enumeration. */
  choices?: { value: number; label: string }[];
}

export interface CatalogEntry {
  /** Stable id for tree selection, e.g. `reply:RENDER:CreatePicture`. */
  id: string;
  kind: MessageKind;
  /** Extension name as QueryExtension returns it; undefined for core. */
  ext?: string;
  /** The name as it appears at runtime, e.g. `RENDER:CreatePicture`. */
  name: string;
  /** Bare name without the extension prefix. */
  shortName: string;
  params: CatalogParam[];
  /** True when the message has a variable-length tail we do not decode. */
  partial: boolean;
}

export interface CatalogNode {
  id: string;
  label: string;
  children?: CatalogNode[];
  /** Present on leaves. */
  entry?: CatalogEntry;
}

const ATOMISH = new Set(['ATOM']);

function paramOf(f: GenField, ext: GenExtension | undefined): CatalogParam {
  const enumName = f.enum;
  const table = enumName ? (ext?.enums[enumName] ?? GENERATED['xproto']?.enums[enumName]) : undefined;
  return {
    name: f.name.replace(/_/g, '-'),
    type: f.type,
    valueKind: ATOMISH.has(f.type) ? 'atom' : f.resource ? 'resource' : 'number',
    choices: table
      ? Object.entries(table).map(([v, label]) => ({ value: Number(v), label }))
      : undefined,
  };
}

/** Pseudo-parameters every message has, so rules can match on them too. */
export const PSEUDO_PARAMS: CatalogParam[] = [
  { name: 'name', type: 'string', valueKind: 'string' },
  { name: 'size', type: 'CARD32', valueKind: 'number' },
  { name: 'seq', type: 'CARD32', valueKind: 'number' },
];

function entry(
  kind: MessageKind,
  ext: GenExtension | undefined,
  extName: string | undefined,
  m: GenMessage,
  suffix = '',
): CatalogEntry {
  const name = extName ? `${extName}:${m.name}` : m.name;
  return {
    id: `${kind}:${name}`,
    kind,
    ext: extName,
    name: name + suffix,
    shortName: m.name,
    params: m.fields.map((f) => paramOf(f, ext)),
    partial: m.partial,
  };
}

let cached: CatalogNode[] | undefined;

/** The catalog as a tree: protocol → kind → message. */
export function buildCatalog(): CatalogNode[] {
  if (cached) return cached;
  const groups: CatalogNode[] = [];

  const files = Object.values(GENERATED).sort((a, b) => {
    // Core first, then extensions alphabetically — the order people look in.
    if (a.header === 'xproto') return -1;
    if (b.header === 'xproto') return 1;
    return (a.xname ?? a.header).localeCompare(b.xname ?? b.header);
  });

  for (const ext of files) {
    const extName = ext.xname; // undefined for core
    const label = extName ?? 'Core protocol';

    const requests: CatalogNode[] = [];
    const responses: CatalogNode[] = [];
    for (const m of Object.values(ext.requests)) {
      const e = entry('request', ext, extName, m);
      requests.push({ id: e.id, label: m.name, entry: e });
      if (m.reply) {
        // A response is identified at runtime as `<Request>·reply`.
        const r: CatalogEntry = {
          id: `reply:${extName ? `${extName}:` : ''}${m.name}`,
          kind: 'reply',
          ext: extName,
          name: `${extName ? `${extName}:` : ''}${m.name}·reply`,
          shortName: `${m.name}·reply`,
          params: m.reply.fields.map((f) => paramOf(f, ext)),
          partial: m.reply.partial,
        };
        responses.push({ id: r.id, label: `${m.name}·reply`, entry: r });
      }
    }

    const events: CatalogNode[] = Object.values(ext.events).map((m) => {
      const e = entry('event', ext, extName, m);
      return { id: e.id, label: m.name, entry: e };
    });

    const errors: CatalogNode[] = Object.values(ext.errors).map((n) => {
      const name = `${extName ? `${extName}:` : ''}${n}Error`;
      const e: CatalogEntry = {
        id: `error:${name}`, kind: 'error', ext: extName, name,
        shortName: `${n}Error`,
        params: [
          { name: 'error-code', type: 'CARD8', valueKind: 'number' },
          { name: 'bad-value', type: 'CARD32', valueKind: 'resource' },
          { name: 'major-opcode', type: 'CARD8', valueKind: 'number' },
          { name: 'minor-opcode', type: 'CARD16', valueKind: 'number' },
        ],
        partial: false,
      };
      return { id: e.id, label: `${n}Error`, entry: e };
    });

    const children: CatalogNode[] = [];
    const push = (id: string, label: string, list: CatalogNode[]) => {
      if (list.length) {
        list.sort((a, b) => a.label.localeCompare(b.label));
        children.push({ id: `${label}-${id}`, label: `${label} (${list.length})`, children: list });
      }
    };
    push(label, 'Requests', requests);
    push(label, 'Responses', responses);
    push(label, 'Events', events);
    push(label, 'Errors', errors);

    if (children.length) groups.push({ id: `ext-${label}`, label, children });
  }

  cached = groups;
  return groups;
}

/** Flat lookup by catalog id. */
export function findEntry(id: string): CatalogEntry | undefined {
  const walk = (nodes: CatalogNode[]): CatalogEntry | undefined => {
    for (const n of nodes) {
      if (n.entry?.id === id) return n.entry;
      if (n.children) {
        const hit = walk(n.children);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(buildCatalog());
}

/** Search the catalog by message name. */
export function searchCatalog(query: string, limit = 200): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: CatalogEntry[] = [];
  const walk = (nodes: CatalogNode[]) => {
    for (const n of nodes) {
      if (out.length >= limit) return;
      if (n.entry && n.entry.name.toLowerCase().includes(q)) out.push(n.entry);
      if (n.children) walk(n.children);
    }
  };
  walk(buildCatalog());
  return out;
}
