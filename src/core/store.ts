/**
 * In-process capture store.
 *
 * Because the UI runs in the same process (docs/decoder-and-state.md §7), there
 * is no wire format: the store is a plain observable the proxy writes to and the
 * UI (or the console renderer) subscribes to. Provides a `useSyncExternalStore`
 * compatible interface.
 */

import { EventEmitter } from 'node:events';
import type { CaptureSink } from './connection.js';
import type { CapturedMessage } from './protocol/types.js';

export interface ConnectionInfo {
  id: number;
  peer: string;
  target: string;
  openedAt: number;
  closedAt?: number;
}

/**
 * A proxy-level diagnostic event — connections opening/closing, decode
 * failures, network-profile changes. Deliberately *not* per-message traffic:
 * that is what the packet table is for.
 */
export interface ConsoleEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

export class CaptureStore extends EventEmitter implements CaptureSink {
  private _messages: CapturedMessage[] = [];
  private byId = new Map<number, CapturedMessage>();
  private _connections: ConnectionInfo[] = [];
  private _console: ConsoleEntry[] = [];
  private idSeq = 0;
  /** When paused, incoming messages are still forwarded but not recorded. */
  paused = false;
  /** Bumped on any change so UI selectors can cheaply detect updates. */
  version = 0;

  private cap: number;
  constructor(opts: { cap?: number } = {}) {
    super();
    this.setMaxListeners(0);
    this.cap = opts.cap ?? 200_000;
  }

  nextId(): number {
    return ++this.idSeq;
  }

  onMessage(msg: CapturedMessage): void {
    if (this.paused) return;
    this._messages.push(msg);
    this.byId.set(msg.id, msg);
    if (this._messages.length > this.cap) {
      const evicted = this._messages.shift();
      if (evicted) this.byId.delete(evicted.id);
    }
    this.version++;
    this.emit('message', msg);
    this.emit('change');
  }

  onLink(requestId: number, replyId: number, rttMs: number): void {
    const req = this.byId.get(requestId);
    if (req) {
      req.replyId = replyId;
      req.rttMs = rttMs;
      this.version++;
      this.emit('link', req, replyId);
      this.emit('change');
    }
  }

  /** Append a diagnostic line to the console pane. */
  log(level: ConsoleEntry['level'], text: string): void {
    this._console.push({ ts: Date.now(), level, text });
    if (this._console.length > 2000) this._console.shift();
    this.version++;
    this.emit('console');
    this.emit('change');
  }

  openConnection(info: ConnectionInfo): void {
    this._connections.push(info);
    this.log('info', `connection #${info.id} opened from ${info.peer} → ${info.target}`);
  }

  closeConnection(id: number): void {
    const c = this._connections.find((c) => c.id === id);
    if (c) {
      c.closedAt = Date.now();
      this.log('info', `connection #${id} closed`);
    }
  }

  get messages(): readonly CapturedMessage[] {
    return this._messages;
  }
  get connections(): readonly ConnectionInfo[] {
    return this._connections;
  }
  get console(): readonly ConsoleEntry[] {
    return this._console;
  }
  getMessage(id: number): CapturedMessage | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    const n = this._messages.length;
    this._messages = [];
    this.byId.clear();
    this.log('info', `cleared ${n} messages`);
  }

  clearConsole(): void {
    this._console = [];
    this.version++;
    this.emit('change');
  }

  // useSyncExternalStore interface
  subscribe = (cb: () => void): (() => void) => {
    this.on('change', cb);
    return () => this.off('change', cb);
  };
  getSnapshot = (): number => this.version;
}
