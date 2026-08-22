/**
 * Breakpoints and fault injection (docs/PRD.md §9 "Stretch").
 *
 * A MITM proxy that can already see every message can also *hold* one:
 *
 *   - `break` — hold the message until the user steps or continues. The client
 *     is genuinely blocked, exactly as it would be by a slow server, which is
 *     what makes it useful for reproducing races.
 *   - `drop`  — never forward it. For testing how a client handles loss.
 *   - `delay` — forward it late, on top of any network profile.
 *
 * **Ordering is the whole game.** X11 is an ordered byte stream per direction,
 * so holding message N must also hold N+1, N+2 … behind it. Anything else
 * reorders the stream — wrong on the wire, and useless as a debugger, since the
 * client sails on past the breakpoint. That is what `MessageGate` is: a FIFO
 * per direction that only ever releases from the head.
 *
 * Everything here is opt-in: with no rules the relay path is untouched and
 * forwarding stays a synchronous pass-through.
 */

import { EventEmitter } from 'node:events';
import type { CapturedMessage } from './protocol/types.js';
import { buildContext, evaluateRule, matchesCoarse, type Rule } from './rules.js';

export type InterceptAction = 'break' | 'drop' | 'delay';

/**
 * A rule is the shared model from `rules.ts` — coarse matchers plus optional
 * predicates or a script.
 */
export type InterceptRule = Rule;

/** A message currently held at the head of a gate, awaiting a decision. */
export interface HeldMessage {
  msg: CapturedMessage;
  rule: InterceptRule;
  /** Release it onward, then drain whatever queued behind it. */
  resume: () => void;
  /** Discard it, then drain whatever queued behind it. */
  drop: () => void;
}

/** Coarse-only match, for callers with no context to hand. */
export const matches = matchesCoarse;

export class Interceptor extends EventEmitter {
  private rules: InterceptRule[] = [];
  private held: HeldMessage[] = [];
  private gates = new Set<MessageGate>();
  private nextId = 1;
  /** True while at least one rule could fire — the relay's fast-path check. */
  active = false;

  addRule(r: Omit<InterceptRule, 'id' | 'hits'>): InterceptRule {
    const rule: InterceptRule = { ...r, id: this.nextId++, hits: 0 };
    this.rules.push(rule);
    this.refresh();
    return rule;
  }

  removeRule(id: number): void {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.refresh();
  }

  setEnabled(id: number, enabled: boolean): void {
    const r = this.rules.find((x) => x.id === id);
    if (r) r.enabled = enabled;
    this.refresh();
  }

  updateRule(id: number, patch: Partial<InterceptRule>): void {
    const r = this.rules.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    this.refresh();
  }

  clear(): void {
    this.rules = [];
    this.resumeAll();
    this.refresh();
  }

  list(): readonly InterceptRule[] {
    return this.rules;
  }
  heldMessages(): readonly HeldMessage[] {
    return this.held;
  }
  /** How many messages are stacked up behind the held ones. */
  queuedCount(): number {
    let n = 0;
    for (const g of this.gates) n += g.queuedCount();
    return n;
  }

  registerGate(g: MessageGate): () => void {
    this.gates.add(g);
    return () => this.gates.delete(g);
  }

  private refresh(): void {
    this.active = this.rules.some((r) => r.enabled);
    this.emit('change');
  }

  /**
   * Which rule, if any, fires for this message. Pure: it neither forwards nor
   * holds — that is the gate's job, because only the gate knows the ordering.
   */
  decide(
    msg: CapturedMessage,
    lookup?: (id: number) => CapturedMessage | undefined,
    atomIds?: Map<string, number>,
  ): InterceptRule | undefined {
    if (!this.active) return undefined;
    let ctx: ReturnType<typeof buildContext> | undefined;
    const rule = this.rules.find((r) => {
      if (!matchesCoarse(r, msg)) return false;
      if (!r.script && !(r.predicates && r.predicates.length)) return true;
      // Built once, and only when a coarse match makes it necessary.
      ctx ??= buildContext(msg, lookup, atomIds);
      return evaluateRule(r, ctx);
    });
    if (!rule) return undefined;
    rule.hits++;
    if (rule.once) rule.enabled = false;
    this.refresh();
    return rule;
  }

  /** Called by a gate when it parks a message at its head. */
  addHeld(entry: HeldMessage): void {
    this.held.push(entry);
    this.emit('break', entry);
    this.emit('change');
  }
  /** Called by a gate when that message is finally settled. */
  removeHeld(entry: HeldMessage): void {
    this.held = this.held.filter((h) => h !== entry);
    this.emit('change');
  }

  /** Release the oldest held message (a "step"). */
  step(): boolean {
    const first = this.held[0];
    if (!first) return false;
    first.resume();
    return true;
  }

  /** Release everything currently held, and anything that queues up behind. */
  resumeAll(): void {
    // Releasing one head can immediately park the next message behind it, so
    // keep going until nothing is held — with a bound, in case a rule matches
    // every single queued message.
    for (let guard = 0; guard < 10_000 && this.held.length; guard++) {
      this.held[0]!.resume();
    }
  }

  /** Drop the oldest held message. */
  dropHead(): boolean {
    const first = this.held[0];
    if (!first) return false;
    first.drop();
    return true;
  }
}

/**
 * One direction of one connection: an in-order queue in front of the socket.
 *
 * A message is only ever considered when it reaches the head, so a rule that
 * fires on message N leaves N+1… untouched and queued rather than letting them
 * overtake it.
 */
export class MessageGate {
  private queue: { msg: CapturedMessage; bytes: Buffer }[] = [];
  /** Set while the head is held or delayed; nothing may pass until it clears. */
  private blocked = false;
  private closed = false;
  private unregister: () => void;
  /** The entry currently parked at the head, so a dying socket can clear it. */
  private heldEntry: HeldMessage | undefined;

  constructor(
    private readonly send: (bytes: Buffer) => void,
    private readonly interceptor: Interceptor,
    private readonly lookup?: (id: number) => CapturedMessage | undefined,
  ) {
    this.unregister = interceptor.registerGate(this);
  }

  queuedCount(): number {
    // The head is reported separately as "held", so it does not count here.
    return this.blocked ? Math.max(0, this.queue.length - 1) : this.queue.length;
  }

  /** Offer a framed message for forwarding. */
  offer(msg: CapturedMessage, bytes: Buffer): void {
    if (this.closed) return;
    this.queue.push({ msg, bytes });
    this.pump();
  }

  private pump(): void {
    while (!this.closed && !this.blocked && this.queue.length) {
      const head = this.queue[0]!;
      const rule = this.interceptor.decide(head.msg, this.lookup);

      if (!rule) {
        this.queue.shift();
        this.send(head.bytes);
        continue;
      }

      if (rule.action === 'drop') {
        this.queue.shift();
        continue; // never sent; the stream simply loses it
      }

      if (rule.action === 'delay') {
        this.blocked = true;
        setTimeout(() => {
          if (this.closed) return;
          this.queue.shift();
          this.send(head.bytes);
          this.blocked = false;
          this.pump();
        }, Math.max(0, rule.delayMs ?? 100));
        return;
      }

      // break — park the head; everything behind it waits in the queue.
      this.blocked = true;
      let settled = false;
      const finish = (deliver: boolean) => {
        if (settled) return;
        settled = true;
        // Always deregister, even on a closed gate: otherwise a client that
        // dies while its message is held leaves the entry stranded, and the UI
        // sits on "Paused" with a Continue button that does nothing.
        this.interceptor.removeHeld(entry);
        this.heldEntry = undefined;
        if (this.closed) return;
        this.queue.shift();
        if (deliver) this.send(head.bytes);
        this.blocked = false;
        this.pump();
      };
      const entry: HeldMessage = {
        msg: head.msg,
        rule,
        resume: () => finish(true),
        drop: () => finish(false),
      };
      this.heldEntry = entry;
      this.interceptor.addHeld(entry);
      return;
    }
  }

  /**
   * The socket is going away: forget everything queued, and release any message
   * this gate had parked so the debugger does not stay stuck on a dead client.
   */
  close(): void {
    this.closed = true;
    this.queue = [];
    this.heldEntry?.drop();
    this.heldEntry = undefined;
    this.unregister();
  }
}
