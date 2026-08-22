/**
 * Compare two captures (docs/PRD.md §9 "Stretch": diff two captures).
 *
 * The question this answers is "what changed between these two runs?" — after a
 * refactor, between two versions of a client, or before and after a fix. Raw
 * message-by-message alignment is the wrong tool for that: two runs of the same
 * app differ in XIDs, sequence numbers and timing while being *behaviourally*
 * identical. So the comparison is over aggregates that survive those
 * differences, plus a sequence alignment on message *names* for the shape of
 * the traffic.
 */

import type { CapturedMessage } from './protocol/types.js';
import { computeStats, type CaptureStats } from './stats.js';

export interface CountDelta {
  name: string;
  before: number;
  after: number;
  delta: number;
}

export interface CaptureDiff {
  before: CaptureStats;
  after: CaptureStats;
  /** Per message-name counts, most-changed first. */
  changed: CountDelta[];
  /** Names present only in one side. */
  onlyBefore: string[];
  onlyAfter: string[];
  /** Headline numeric movements. */
  totals: {
    messages: CountDelta;
    bytesC2S: CountDelta;
    bytesS2C: CountDelta;
    roundTrips: CountDelta;
    stalls: CountDelta;
  };
  /** A one-line human verdict. */
  summary: string;
}

const nameCounts = (messages: readonly CapturedMessage[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const msg of messages) {
    if (msg.category === 'setup-request' || msg.category === 'setup-reply') continue;
    m.set(msg.name, (m.get(msg.name) ?? 0) + 1);
  }
  return m;
};

const d = (name: string, before: number, after: number): CountDelta => ({
  name,
  before,
  after,
  delta: after - before,
});

export function diffCaptures(
  beforeMsgs: readonly CapturedMessage[],
  afterMsgs: readonly CapturedMessage[],
): CaptureDiff {
  const before = computeStats(beforeMsgs);
  const after = computeStats(afterMsgs);
  const bc = nameCounts(beforeMsgs);
  const ac = nameCounts(afterMsgs);

  const names = new Set([...bc.keys(), ...ac.keys()]);
  const changed: CountDelta[] = [];
  const onlyBefore: string[] = [];
  const onlyAfter: string[] = [];
  for (const n of names) {
    const b = bc.get(n) ?? 0;
    const a = ac.get(n) ?? 0;
    if (b === 0) onlyAfter.push(n);
    else if (a === 0) onlyBefore.push(n);
    if (a !== b) changed.push(d(n, b, a));
  }
  changed.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const totals = {
    messages: d('messages', before.total, after.total),
    bytesC2S: d('bytes ↑', before.bytesC2S, after.bytesC2S),
    bytesS2C: d('bytes ↓', before.bytesS2C, after.bytesS2C),
    roundTrips: d('round trips', before.roundTrips, after.roundTrips),
    stalls: d('blocking round trips', before.stalls, after.stalls),
  };

  const pct = (x: CountDelta) => (x.before === 0 ? (x.after ? '+∞' : '0%') : `${((x.delta / x.before) * 100).toFixed(0)}%`);
  const dir = totals.messages.delta === 0 ? 'unchanged' : totals.messages.delta < 0 ? 'fewer' : 'more';
  const summary =
    totals.messages.delta === 0 && totals.roundTrips.delta === 0
      ? 'No change in message or round-trip counts.'
      : `${Math.abs(totals.messages.delta)} ${dir} messages (${pct(totals.messages)}), ` +
        `${totals.roundTrips.delta >= 0 ? '+' : ''}${totals.roundTrips.delta} round trips, ` +
        `${totals.stalls.delta >= 0 ? '+' : ''}${totals.stalls.delta} blocking.`;

  return { before, after, changed, onlyBefore, onlyAfter, totals, summary };
}

/** Render a diff as plain text, for the CLI. */
export function formatDiff(diff: CaptureDiff, limit = 15): string {
  const lines: string[] = [];
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  lines.push(diff.summary, '');
  lines.push('  metric                     before      after      delta');
  for (const t of Object.values(diff.totals)) {
    lines.push(`  ${t.name.padEnd(24)} ${String(t.before).padStart(8)} ${String(t.after).padStart(10)} ${sign(t.delta).padStart(10)}`);
  }
  if (diff.changed.length) {
    lines.push('', `  changed message counts (top ${Math.min(limit, diff.changed.length)}):`);
    for (const c of diff.changed.slice(0, limit)) {
      lines.push(`  ${c.name.padEnd(32)} ${String(c.before).padStart(6)} → ${String(c.after).padStart(6)}  ${sign(c.delta).padStart(7)}`);
    }
  }
  if (diff.onlyAfter.length) lines.push('', `  new in "after": ${diff.onlyAfter.slice(0, 10).join(', ')}`);
  if (diff.onlyBefore.length) lines.push(`  gone from "before": ${diff.onlyBefore.slice(0, 10).join(', ')}`);
  return lines.join('\n');
}
