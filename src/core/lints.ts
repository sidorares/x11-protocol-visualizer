/**
 * Resource lifecycle lints (docs/PRD.md FR-35).
 *
 * A pure pass over captured messages, so it works identically on a live session
 * and on a reopened `.x11cap`. It walks the create/free markers each message
 * carries and the resource-typed fields each message references, and reports:
 *
 *   - **use-after-free** — a resource referenced after the client freed it
 *   - **double-free**    — freed twice with no create in between
 *   - **free-unknown**   — freed without ever having been created here
 *   - **leak**           — created and never freed by the end of the capture
 *
 * All of these are advisory. A capture that starts mid-session legitimately
 * references resources it never saw created, so `free-unknown` and unresolved
 * references are reported at low confidence — the point is to draw the eye, not
 * to accuse.
 */

import type { CapturedMessage } from './protocol/types.js';
import { RESOURCE_TYPES } from './protocol/types.js';
import { xid as fmtXid } from './util/hex.js';

export type LintKind = 'use-after-free' | 'double-free' | 'free-unknown' | 'leak';

export interface Lint {
  kind: LintKind;
  severity: 'high' | 'medium' | 'info';
  /** The message the problem is reported on. */
  messageId: number;
  xid: number;
  resourceType: string;
  text: string;
  /** The message that created the resource, when known. */
  createdBy?: number;
  /** The message that freed it, when relevant. */
  freedBy?: number;
}

export interface LintReport {
  lints: Lint[];
  /** messageId → lints reported on it, for badging rows. */
  byMessage: Map<number, Lint[]>;
  counts: Record<LintKind, number>;
  /** Resources created and still alive at the end of the capture. */
  liveResources: number;
}

interface Live {
  type: string;
  createdBy: number;
  freedBy?: number;
  freedName?: string;
}

const XID_RE = /^0x[0-9a-f]+$/i;

export function computeLints(messages: readonly CapturedMessage[]): LintReport {
  const state = new Map<number, Live>();
  const lints: Lint[] = [];

  for (const m of messages) {
    // A create (re)opens the resource — an id may legitimately be recycled
    // after a free, which is exactly why this clears `freedBy`.
    if (m.creates) {
      state.set(m.creates.xid, { type: m.creates.type, createdBy: m.id });
    }

    // References: anything resource-typed that is not this message's own
    // creation. Reported only when we know the resource was freed.
    for (const f of m.fields ?? []) {
      if (!f.type || !RESOURCE_TYPES.has(f.type) || !XID_RE.test(f.value)) continue;
      const id = parseInt(f.value, 16);
      if (m.creates?.xid === id) continue;
      const rec = state.get(id);
      if (rec?.freedBy != null && m.frees !== id) {
        lints.push({
          kind: 'use-after-free',
          severity: 'high',
          messageId: m.id,
          xid: id,
          resourceType: rec.type,
          createdBy: rec.createdBy,
          freedBy: rec.freedBy,
          text: `${m.name} uses ${rec.type} ${fmtXid(id)} after it was freed by #${rec.freedBy}`,
        });
      }
    }

    if (m.frees !== undefined) {
      const rec = state.get(m.frees);
      if (!rec) {
        lints.push({
          kind: 'free-unknown',
          severity: 'info',
          messageId: m.id,
          xid: m.frees,
          resourceType: 'resource',
          text: `${m.name} frees ${fmtXid(m.frees)}, which was never created in this capture`,
        });
      } else if (rec.freedBy != null) {
        lints.push({
          kind: 'double-free',
          severity: 'high',
          messageId: m.id,
          xid: m.frees,
          resourceType: rec.type,
          createdBy: rec.createdBy,
          freedBy: rec.freedBy,
          text: `${m.name} frees ${rec.type} ${fmtXid(m.frees)} again; already freed by #${rec.freedBy}`,
        });
      } else {
        rec.freedBy = m.id;
        rec.freedName = m.name;
      }
    }
  }

  // Resources still alive when the capture ended.
  //
  // This is NOT automatically a leak: a running app legitimately holds its
  // windows, GCs and buffers open, and a capture just stops at an arbitrary
  // moment. So each one is reported as `info`, and only an *accumulation* — many
  // unfreed resources of one type — is raised to a real suspicion. Crying leak
  // on every live window is how a linter gets muted.
  const liveByType = new Map<string, number>();
  let live = 0;
  for (const rec of state.values()) {
    if (rec.freedBy != null) continue;
    live++;
    liveByType.set(rec.type, (liveByType.get(rec.type) ?? 0) + 1);
  }
  const SUSPICIOUS = 20;
  for (const [id, rec] of state) {
    if (rec.freedBy != null) continue;
    const n = liveByType.get(rec.type) ?? 1;
    const suspicious = n >= SUSPICIOUS;
    lints.push({
      kind: 'leak',
      severity: suspicious ? 'medium' : 'info',
      messageId: rec.createdBy,
      xid: id,
      resourceType: rec.type,
      createdBy: rec.createdBy,
      text: suspicious
        ? `${n} ${rec.type} resources were created and never freed — possible leak (${fmtXid(id)})`
        : `${rec.type} ${fmtXid(id)} is still live at the end of the capture (never freed)`,
    });
  }

  const byMessage = new Map<number, Lint[]>();
  const counts: Record<LintKind, number> = {
    'use-after-free': 0,
    'double-free': 0,
    'free-unknown': 0,
    leak: 0,
  };
  for (const l of lints) {
    counts[l.kind]++;
    const arr = byMessage.get(l.messageId);
    if (arr) arr.push(l);
    else byMessage.set(l.messageId, [l]);
  }

  return { lints, byMessage, counts, liveResources: live };
}

/**
 * Every message that touches `xid` — creations, frees and references alike.
 * This is "find usages" (FR-34); the UI turns the result into a filter.
 */
export function findUsages(messages: readonly CapturedMessage[], xid: number): CapturedMessage[] {
  const hex = fmtXid(xid);
  return messages.filter((m) => {
    if (m.creates?.xid === xid || m.frees === xid) return true;
    return (m.fields ?? []).some((f) => f.type && RESOURCE_TYPES.has(f.type) && f.value.toLowerCase() === hex);
  });
}

/** Does this message touch `xid`? (The predicate behind the filter chip.) */
export function touchesXid(m: CapturedMessage, xid: number): boolean {
  if (m.creates?.xid === xid || m.frees === xid) return true;
  const hex = fmtXid(xid);
  return (m.fields ?? []).some((f) => f.type && RESOURCE_TYPES.has(f.type) && f.value.toLowerCase() === hex);
}
