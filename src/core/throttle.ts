/**
 * Network emulation — added latency + throughput cap, per direction.
 *
 * Model (docs/PRD.md FR-39): each chunk is queued and delivered at
 *
 *   startTx = max(arrival + latency, endOfPreviousChunk)
 *   deliverAt = startTx + bytes / bytesPerSecond
 *
 * which gives both a fixed one-way delay and a serialization delay, and can
 * never reorder within a direction. The unthrottled profile is a true
 * pass-through: the chunk is written synchronously with no queue, so leaving
 * x11vis in the path costs nothing (NFR-1).
 */

export interface NetworkProfile {
  id: string;
  label: string;
  /** Downstream (server→client) throughput in kbit/s; 0 = unlimited. */
  downKbps: number;
  /** Upstream (client→server) throughput in kbit/s; 0 = unlimited. */
  upKbps: number;
  /** Total added round-trip time in ms, split evenly across the two directions. */
  rttMs: number;
}

/** Chrome-DevTools-style presets plus X11-relevant profiles (PRD FR-40). */
export const NETWORK_PROFILES: NetworkProfile[] = [
  { id: 'none', label: 'No throttling', downKbps: 0, upKbps: 0, rttMs: 0 },
  { id: 'local', label: 'Local / Unix socket', downKbps: 0, upKbps: 0, rttMs: 0 },
  { id: 'lan', label: 'LAN', downKbps: 100_000, upKbps: 100_000, rttMs: 1 },
  { id: 'wifi', label: 'Wi-Fi', downKbps: 30_000, upKbps: 15_000, rttMs: 5 },
  { id: 'fast4g', label: 'Fast 4G', downKbps: 4_000, upKbps: 3_000, rttMs: 20 },
  { id: 'slow4g', label: 'Slow 4G', downKbps: 1_500, upKbps: 750, rttMs: 50 },
  { id: 'fast3g', label: 'Fast 3G', downKbps: 1_500, upKbps: 750, rttMs: 150 },
  { id: 'slow3g', label: 'Slow 3G', downKbps: 400, upKbps: 400, rttMs: 300 },
  { id: 'ssh', label: 'WAN / SSH X-forward', downKbps: 5_000, upKbps: 5_000, rttMs: 80 },
  { id: 'transatlantic', label: 'Transatlantic', downKbps: 20_000, upKbps: 20_000, rttMs: 120 },
];

export function profileById(id: string): NetworkProfile {
  return NETWORK_PROFILES.find((p) => p.id === id) ?? NETWORK_PROFILES[0]!;
}

export const isPassthrough = (p: NetworkProfile, dirKbps: number): boolean =>
  p.rttMs <= 0 && dirKbps <= 0;

type Timer = ReturnType<typeof setTimeout>;

/**
 * One direction's delay queue. `write` is the real socket write; chunks are
 * handed to it in arrival order, never merged or split.
 */
export class DirectionThrottle {
  private endOfLast = 0;
  private timers = new Set<Timer>();
  private closed = false;

  constructor(
    private write: (chunk: Buffer) => void,
    private profile: NetworkProfile,
    private kbpsOf: (p: NetworkProfile) => number,
    private now: () => number = () => performance.now(),
  ) {}

  setProfile(p: NetworkProfile): void {
    this.profile = p;
  }

  send(chunk: Buffer): void {
    if (this.closed) return;
    const kbps = this.kbpsOf(this.profile);
    // One-way delay is half the configured round trip.
    const latency = this.profile.rttMs / 2;

    if (isPassthrough(this.profile, kbps)) {
      this.write(chunk);
      return;
    }

    const now = this.now();
    const startTx = Math.max(now + latency, this.endOfLast);
    const txMs = kbps > 0 ? (chunk.length * 8) / kbps : 0; // bytes*8 / (kbit/s) = ms
    const deliverAt = startTx + txMs;
    this.endOfLast = deliverAt;

    const delay = Math.max(0, deliverAt - now);
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.closed) this.write(chunk);
    }, delay);
    this.timers.add(t);
  }

  /** Drop pending chunks (the socket is going away). */
  close(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

/** Shared, live-updatable network setting for the whole proxy. */
export class NetworkEmulator {
  private profile: NetworkProfile = NETWORK_PROFILES[0]!;
  private listeners = new Set<(p: NetworkProfile) => void>();

  get current(): NetworkProfile {
    return this.profile;
  }

  set(id: string): NetworkProfile {
    this.profile = profileById(id);
    for (const l of this.listeners) l(this.profile);
    return this.profile;
  }

  onChange(fn: (p: NetworkProfile) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
