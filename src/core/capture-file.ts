/**
 * Capture files (`.x11cap`) — save a session and reopen it offline.
 *
 * The file stores the **raw bytes** of every message plus its connection,
 * direction and timing; loading replays those bytes through a fresh
 * `ConnectionCapture` per connection. Decoding is therefore never serialized:
 * a reopened capture is decoded by the current decoder, so it gains every
 * improvement made since it was recorded, and there is no second format to
 * keep in step with the protocol tables (docs/PRD.md FR-46/47).
 *
 * Line-oriented JSON so a capture can be appended to as it runs and truncated
 * safely: line 1 is the header, every later line is one message.
 */

import { ConnectionCapture } from './connection.js';
import type { CaptureStore, ConnectionInfo } from './store.js';
import type { Direction } from './protocol/types.js';

export const CAPTURE_VERSION = 1;

interface Header {
  x11cap: number;
  savedAt: number;
  target?: string;
  connections: ConnectionInfo[];
}

interface Record_ {
  /** connection id */
  c: number;
  /** direction */
  d: Direction;
  /** monotonic ms at capture */
  m: number;
  /** wall-clock ms at capture */
  w: number;
  /** raw bytes, hex */
  b: string;
}

/** Serialize a store to `.x11cap` text. */
export function serializeCapture(store: CaptureStore, target?: string): string {
  const header: Header = {
    x11cap: CAPTURE_VERSION,
    savedAt: Date.now(),
    target,
    connections: store.connections.map((c) => ({ ...c })),
  };
  const lines = [JSON.stringify(header)];
  for (const m of store.messages) {
    const rec: Record_ = { c: m.connId, d: m.dir, m: m.mono, w: m.ts, b: m.bytes.toString('hex') };
    lines.push(JSON.stringify(rec));
  }
  return lines.join('\n') + '\n';
}

export class CaptureFileError extends Error {}

/**
 * Replay a `.x11cap` into a store, replacing its contents. Returns what was
 * loaded. Messages are fed in recorded order across connections, so
 * interleaving — and therefore sequence linking and RTTs — is reproduced.
 */
export function loadCapture(text: string, store: CaptureStore): { messages: number; connections: number } {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) throw new CaptureFileError('empty capture file');

  let header: Header;
  try {
    header = JSON.parse(lines[0]!) as Header;
  } catch {
    throw new CaptureFileError('bad capture header (not JSON)');
  }
  if (header.x11cap !== CAPTURE_VERSION) {
    throw new CaptureFileError(`unsupported capture version ${header.x11cap} (expected ${CAPTURE_VERSION})`);
  }

  store.clear();
  store.clearConsole();

  // One decoder per connection, each reading the recorded clock so replay
  // reproduces the original timings rather than stamping "now".
  let mono = 0;
  let wall = 0;
  const clock = { mono: () => mono, wall: () => wall };
  const caps = new Map<number, ConnectionCapture>();
  const seen = new Set<number>();

  let count = 0;
  for (let i = 1; i < lines.length; i++) {
    let rec: Record_;
    try {
      rec = JSON.parse(lines[i]!) as Record_;
    } catch {
      continue; // tolerate a truncated final line
    }
    if (typeof rec.b !== 'string' || (rec.d !== 'c2s' && rec.d !== 's2c')) continue;

    if (!seen.has(rec.c)) {
      seen.add(rec.c);
      const info = header.connections.find((c) => c.id === rec.c);
      store.openConnection(
        info ?? { id: rec.c, peer: '(replayed)', target: header.target ?? '(unknown)', openedAt: rec.w },
      );
    }
    let cap = caps.get(rec.c);
    if (!cap) {
      cap = new ConnectionCapture(rec.c, store, clock);
      caps.set(rec.c, cap);
    }
    mono = rec.m;
    wall = rec.w;
    try {
      cap.feed(rec.d, Buffer.from(rec.b, 'hex'));
      count++;
    } catch {
      /* a corrupt record degrades one message, not the load */
    }
  }

  store.log('info', `loaded ${count} messages from capture (${seen.size} connections)`);
  return { messages: count, connections: seen.size };
}
