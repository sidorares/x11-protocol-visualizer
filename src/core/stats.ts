/**
 * Capture statistics (docs/PRD.md FR-41, FR-45).
 *
 * The number this exists for is **round trips**: X11 over a network is slow
 * because of synchronous request→reply stalls, not bandwidth. A "stall" here is
 * a request whose reply arrived before the client sent anything else — i.e. the
 * client was waiting on it. Counting those, and pricing them at the current
 * added latency, is the most actionable figure the tool can show.
 */

import type { CapturedMessage } from './protocol/types.js';

export interface NameStat {
  name: string;
  count: number;
  bytes: number;
}

export interface CaptureStats {
  total: number;
  byCategory: Record<string, number>;
  bytesC2S: number;
  bytesS2C: number;
  /** Requests that received a reply. */
  roundTrips: number;
  /** Round trips the client appears to have blocked on (see module note). */
  stalls: number;
  rttMeanMs: number;
  rttP50Ms: number;
  rttMaxMs: number;
  slowest: { id: number; name: string; rttMs: number } | undefined;
  topRequests: NameStat[];
  topEvents: NameStat[];
  byExtension: NameStat[];
  errors: NameStat[];
  /** Total wall time spanned by the capture. */
  durationMs: number;
  /** Requests ranked by bytes sent, not count — the bandwidth hotspots. */
  heaviestRequests: NameStat[];
  /** Protocol-efficiency observations worth a client author's attention. */
  hotspots: Hotspot[];
}

/**
 * A hotspot is a pattern that costs more than it should. These are advisory —
 * a client may have a good reason — but each one is a question worth asking of
 * a react-x11 (or any) client's rendering path.
 */
export interface Hotspot {
  severity: 'high' | 'medium' | 'info';
  title: string;
  detail: string;
}

/** A request that blocks the client is far more expensive than one that doesn't. */
const REPLY_HEAVY_HINT =
  'Each of these blocks the client until the server answers; over a WAN link that is one full round trip each.';

/**
 * Requests whose repeats are not a cache miss, and so are not waste.
 *
 * Two kinds. **GetInputFocus** is the protocol's sync primitive: clients use
 * it as a fence, and node-x11 injects one to give a void request's callback
 * something to fire on — its repeats are flow control, already priced as
 * blocking round trips above. **GetProperty with delete=1** consumes what it
 * reads, so identical request bytes answer differently every time; ntk's
 * shared-glyph directory polls a property mailbox exactly this way. Counting
 * either as "cache it client-side" reports waste that is not there.
 */
function isConsumingQuery(name: string, bytes: Buffer): boolean {
  if (name === 'GetInputFocus') return true;
  // GetProperty: opcode 20, the delete flag in the byte after it
  return name === 'GetProperty' && bytes.length > 1 && bytes[0] === 20 && bytes[1] === 1;
}

function findHotspots(
  messages: readonly CapturedMessage[],
  requests: Map<string, NameStat>,
  stalls: number,
  roundTrips: number,
  rttMeanMs: number,
): Hotspot[] {
  const out: Hotspot[] = [];
  const total = messages.length || 1;

  // 1. Synchronous stalls — the headline X11-over-network cost.
  if (stalls > 0) {
    const cost = stalls * rttMeanMs;
    out.push({
      severity: stalls > 20 ? 'high' : 'medium',
      title: `${stalls} blocking round trip${stalls === 1 ? '' : 's'}`,
      detail:
        `The client sent nothing else while waiting. At the observed mean RTT ` +
        `(${rttMeanMs.toFixed(1)} ms) that is ~${cost.toFixed(0)} ms of pure waiting. ${REPLY_HEAVY_HINT}`,
    });
  }

  // 2. Repeated byte-identical requests. These mean different things depending
  //    on what the request does, so classify rather than give one glib answer:
  //    a repeated *query* is cacheable, whereas a repeated *create* is usually
  //    a resource being torn down and rebuilt every frame.
  const identical = new Map<string, { n: number; name: string; hadReply: boolean; bytes: Buffer }>();
  for (const m of messages) {
    if (m.category !== 'request') continue;
    const key = `${m.name}:${m.bytes.toString('base64')}`;
    const e = identical.get(key);
    if (e) {
      e.n++;
      e.hadReply ||= m.replyId != null;
    } else {
      identical.set(key, { n: 1, name: m.name, hadReply: m.replyId != null, bytes: m.bytes });
    }
  }
  const dupes = [...identical.values()].filter((e) => e.n > 2).sort((a, b) => b.n - a.n);
  const isCreate = (n: string) => /(^|:)(Create|Alloc|Open)/.test(n);

  const queries = dupes.filter((d) => d.hadReply && !isConsumingQuery(d.name, d.bytes));
  if (queries.length) {
    const wasted = queries.reduce((a, d) => a + d.n - 1, 0);
    out.push({
      severity: wasted > 20 ? 'high' : 'medium',
      title: `${wasted} repeated identical quer${wasted === 1 ? 'y' : 'ies'}`,
      detail:
        `Same request, same bytes, and it round-trips: ${queries.slice(0, 3).map((d) => `${d.name}×${d.n}`).join(', ')}. ` +
        `The answer cannot have changed for identical arguments — cache it client-side and the round trip disappears.`,
    });
  }

  const churn = dupes.filter((d) => !d.hadReply && isCreate(d.name));
  if (churn.length) {
    const cycles = Math.max(...churn.map((d) => d.n));
    out.push({
      severity: cycles > 60 ? 'high' : 'medium',
      title: `Resource churn: ${churn.slice(0, 3).map((d) => `${d.name}×${d.n}`).join(', ')}`,
      detail:
        `The same resources are created with identical arguments ${cycles} times — a create/destroy cycle ` +
        `rather than a reused buffer. If the size and format are unchanged between frames, allocating once ` +
        `and reusing it removes these requests entirely.`,
    });
  }

  const other = dupes.filter((d) => !d.hadReply && !isCreate(d.name));
  if (other.length) {
    const wasted = other.reduce((a, d) => a + d.n - 1, 0);
    if (wasted > 20) {
      out.push({
        severity: 'info',
        title: `${wasted} repeated identical request${wasted === 1 ? '' : 's'}`,
        detail:
          `Byte-for-byte repeats: ${other.slice(0, 3).map((d) => `${d.name}×${d.n}`).join(', ')}. ` +
          `Expected for per-frame drawing; worth a look if the output did not change.`,
      });
    }
  }

  // 3. Chatty single request type dominating the stream.
  const busiest = [...requests.values()].sort((a, b) => b.count - a.count)[0];
  if (busiest && busiest.count / total > 0.3 && busiest.count > 20) {
    out.push({
      severity: 'medium',
      title: `${busiest.name} is ${Math.round((busiest.count / total) * 100)}% of all traffic`,
      detail: `${busiest.count} calls, ${fmtBytes(busiest.bytes)}. Worth checking whether these can be batched or coalesced.`,
    });
  }

  // 4. Reply-generating requests in general (round trips even when pipelined).
  if (roundTrips > 100) {
    out.push({
      severity: roundTrips > 500 ? 'high' : 'info',
      title: `${roundTrips} request/reply round trips`,
      detail:
        'X11 is fast locally and slow remotely mainly because of these. Where a value can be cached ' +
        'or derived client-side, the round trip disappears entirely.',
    });
  }

  return out;
}

const bump = (map: Map<string, NameStat>, name: string, bytes: number) => {
  const e = map.get(name);
  if (e) {
    e.count++;
    e.bytes += bytes;
  } else {
    map.set(name, { name, count: 1, bytes });
  }
};
const top = (map: Map<string, NameStat>, n: number): NameStat[] =>
  [...map.values()].sort((a, b) => b.count - a.count).slice(0, n);

export function computeStats(messages: readonly CapturedMessage[]): CaptureStats {
  const byCategory: Record<string, number> = {};
  const requests = new Map<string, NameStat>();
  const events = new Map<string, NameStat>();
  const exts = new Map<string, NameStat>();
  const errors = new Map<string, NameStat>();
  const rtts: number[] = [];

  let bytesC2S = 0;
  let bytesS2C = 0;
  let roundTrips = 0;
  let stalls = 0;
  let slowest: CaptureStats['slowest'];
  let tMin = Infinity;
  let tMax = -Infinity;

  // Index requests by id so a reply can find whether its request was the last
  // thing the client sent (i.e. the client then waited).
  const lastRequestIdPerConn = new Map<number, number>();
  const wasLastWhenAnswered = new Set<number>();
  for (const m of messages) {
    if (m.category === 'request') lastRequestIdPerConn.set(m.connId, m.id);
    else if ((m.category === 'reply' || m.category === 'error') && m.requestId != null) {
      if (lastRequestIdPerConn.get(m.connId) === m.requestId) wasLastWhenAnswered.add(m.requestId);
    }
  }

  for (const m of messages) {
    byCategory[m.category] = (byCategory[m.category] ?? 0) + 1;
    if (m.dir === 'c2s') bytesC2S += m.bytes.length;
    else bytesS2C += m.bytes.length;
    if (m.ts < tMin) tMin = m.ts;
    if (m.ts > tMax) tMax = m.ts;

    if (m.ext) bump(exts, m.ext, m.bytes.length);

    if (m.category === 'request') {
      bump(requests, m.name, m.bytes.length);
      if (m.rttMs != null) {
        roundTrips++;
        rtts.push(m.rttMs);
        if (!slowest || m.rttMs > slowest.rttMs) slowest = { id: m.id, name: m.name, rttMs: m.rttMs };
        if (wasLastWhenAnswered.has(m.id)) stalls++;
      }
    } else if (m.category === 'event') {
      bump(events, m.name, m.bytes.length);
    } else if (m.category === 'error') {
      bump(errors, m.name, m.bytes.length);
    }
  }

  rtts.sort((a, b) => a - b);
  const sum = rtts.reduce((a, b) => a + b, 0);
  const rttMeanMs = rtts.length ? sum / rtts.length : 0;

  return {
    total: messages.length,
    byCategory,
    bytesC2S,
    bytesS2C,
    roundTrips,
    stalls,
    rttMeanMs,
    rttP50Ms: rtts.length ? rtts[Math.floor(rtts.length / 2)]! : 0,
    rttMaxMs: rtts.length ? rtts[rtts.length - 1]! : 0,
    slowest,
    topRequests: top(requests, 8),
    topEvents: top(events, 6),
    byExtension: top(exts, 8),
    errors: top(errors, 6),
    durationMs: messages.length ? Math.max(0, tMax - tMin) : 0,
    heaviestRequests: [...requests.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 6),
    hotspots: findHotspots(messages, requests, stalls, roundTrips, rttMeanMs),
  };
}

/** Human-readable byte count. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render stats as plain text, for the CLI — the Statistics tab's numbers for
 * anyone who is looking at a capture from a script or a CI log rather than
 * from the UI. Kept beside `computeStats` for the same reason `formatDiff`
 * sits beside `diffCaptures`: the shape and its rendering drift apart when
 * they live in different files.
 */
export function formatStats(stats: CaptureStats): string {
  const lines: string[] = [];
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  lines.push(
    `${stats.total} messages over ${(stats.durationMs / 1000).toFixed(1)}s — ` +
      `${kb(stats.bytesC2S)} up, ${kb(stats.bytesS2C)} down`,
  );
  lines.push(
    `${stats.roundTrips} round trips, ${stats.stalls} blocking — ` +
      `RTT mean ${stats.rttMeanMs.toFixed(1)} ms, p50 ${stats.rttP50Ms.toFixed(1)} ms, ` +
      `max ${stats.rttMaxMs.toFixed(1)} ms`,
  );
  if (stats.slowest) {
    lines.push(
      `  slowest: ${stats.slowest.name} #${stats.slowest.id} at ${stats.slowest.rttMs.toFixed(1)} ms`,
    );
  }

  const table = (title: string, rows: readonly NameStat[]) => {
    if (!rows.length) return;
    lines.push('', `  ${title}`);
    for (const r of rows.slice(0, 10)) {
      lines.push(
        `    ${r.name.padEnd(34)} ${String(r.count).padStart(6)}  ${kb(r.bytes).padStart(10)}`,
      );
    }
  };
  table('top requests', stats.topRequests);
  table('heaviest requests (by bytes)', stats.heaviestRequests);
  table('top events', stats.topEvents);
  table('by extension', stats.byExtension);
  if (stats.errors.length) table('errors', stats.errors);

  if (stats.hotspots.length) {
    lines.push('', '  hotspots');
    for (const h of stats.hotspots) {
      lines.push(`    [${h.severity}] ${h.title}`);
      lines.push(`      ${h.detail}`);
    }
  }
  return lines.join('\n');
}
