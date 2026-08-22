/**
 * The MITM proxy: a TCP listener that forwards each client connection to the
 * upstream X server byte-for-byte, tapping the stream into a ConnectionCapture.
 *
 * Forwarding is never blocked by decoding — bytes are relayed immediately and
 * the tap runs alongside. Nothing here mutates the stream (throttling/injection
 * is a later milestone and would slot in as a transform on the relay path).
 */

import net from 'node:net';
import fs from 'node:fs';
import { ConnectionCapture } from './connection.js';
import { describeTarget, resolveDisplay, type DisplayTarget } from './display.js';
import type { CaptureStore } from './store.js';
import { DirectionThrottle, NetworkEmulator } from './throttle.js';
import { MessageGate, type Interceptor } from './intercept.js';
import type { CaptureSink } from './connection.js';

export interface ProxyOptions {
  port: number;
  host?: string;
  /**
   * Also listen on a Unix socket (PRD FR-3), so a client can attach with a
   * plain `DISPLAY=:N` instead of going over TCP. Give the display number.
   */
  unixDisplay?: number;
  /** DISPLAY string of the upstream X server. */
  display?: string;
  /** Explicit target override (wins over `display`). */
  target?: DisplayTarget;
  store: CaptureStore;
  /** Shared, live-updatable network emulation (PRD FR-42). */
  network?: NetworkEmulator;
  /**
   * Breakpoints / fault injection. **Opt-in**: supplying an interceptor
   * switches forwarding from raw chunks to whole framed messages, which is what
   * makes per-message gating possible. Without it the relay is untouched and
   * stays a byte-for-byte chunk pass-through (invariant 1 in AGENTS.md).
   */
  interceptor?: Interceptor;
  onListening?: (addr: net.AddressInfo) => void;
  log?: (msg: string) => void;
}

export interface ProxyHandle {
  server: net.Server;
  interceptor?: Interceptor;
  /** The Unix-socket listener, when `unixDisplay` was given. */
  unixServer?: net.Server;
  unixPath?: string;
  target: DisplayTarget;
  network: NetworkEmulator;
  close: () => Promise<void>;
}

function connectUpstream(target: DisplayTarget): net.Socket {
  return target.kind === 'unix'
    ? net.connect({ path: target.path })
    : net.connect({ host: target.host, port: target.port });
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const target = opts.target ?? resolveDisplay(opts.display);
  const log = opts.log ?? (() => {});
  const network = opts.network ?? new NetworkEmulator();
  let connId = 0;

  const gated = !!opts.interceptor;

  const onClient = (client: net.Socket) => {
    const id = ++connId;
    // A Unix-socket client has no address/port; say so rather than "?:?".
    const peer = client.remoteAddress
      ? `${client.remoteAddress}:${client.remotePort ?? '?'}`
      : 'unix socket';

    // When gating, forwarding rides on the framer: each complete message is
    // offered to the interceptor and only then sent on. Partial bytes wait for
    // the rest of their message, which is safe — neither an X server nor a
    // client acts on half a message.
    // One gate per direction. A gate is a FIFO in front of the socket: holding
    // a message holds everything behind it, which is the only way a breakpoint
    // can actually stop the client rather than just delaying one packet.
    let gateToServer: MessageGate | undefined;
    let gateToClient: MessageGate | undefined;
    const sink: CaptureSink = {
      nextId: () => opts.store.nextId(),
      onMessage: (m) => {
        opts.store.onMessage(m);
        if (!gated) return;
        const gate = m.dir === 'c2s' ? gateToServer : gateToClient;
        gate?.offer(m, m.bytes);
      },
      onLink: (reqId, repId, rtt) => opts.store.onLink(reqId, repId, rtt),
    };
    const capture = new ConnectionCapture(id, sink);
    opts.store.openConnection({
      id,
      peer,
      target: describeTarget(target),
      openedAt: Date.now(),
    });
    log(`conn #${id} open from ${peer} → ${describeTarget(target)}`);

    const upstream = connectUpstream(target);
    // Attach the error handler immediately: a failed connect (ECONNREFUSED,
    // ENOENT on a unix path) emits on the next tick, and an unhandled 'error'
    // on a socket is fatal to the process.
    upstream.on('error', (e) => {
      log(`conn #${id} upstream error: ${e.message}`);
      client.destroy();
    });
    client.on('error', (e) => log(`conn #${id} client error: ${e.message}`));
    // Buffer client bytes that arrive before the upstream socket connects.
    client.pause();
    upstream.on('connect', () => client.resume());

    // Network emulation sits on the forwarding path only; capture always sees
    // bytes at true arrival time, so decoding is unaffected by throttling.
    const toServer = new DirectionThrottle(
      (c) => upstream.write(c),
      network.current,
      (p) => p.upKbps,
    );
    const toClient = new DirectionThrottle(
      (c) => client.write(c),
      network.current,
      (p) => p.downKbps,
    );
    const unsubscribe = network.onChange((p) => {
      toServer.setProfile(p);
      toClient.setProfile(p);
    });
    if (gated) {
      const lookup = (mid: number) => opts.store.getMessage(mid);
      gateToServer = new MessageGate((b) => toServer.send(b), opts.interceptor!, lookup);
      gateToClient = new MessageGate((b) => toClient.send(b), opts.interceptor!, lookup);
    }

    client.on('data', (chunk: Buffer) => {
      try {
        capture.feed('c2s', chunk);
      } catch (err) {
        log(`conn #${id} c2s decode error: ${(err as Error).message}`);
      }
      if (!gated) toServer.send(chunk); // byte-exact forward, regardless of decode outcome
    });
    upstream.on('data', (chunk: Buffer) => {
      try {
        capture.feed('s2c', chunk);
      } catch (err) {
        log(`conn #${id} s2c decode error: ${(err as Error).message}`);
      }
      if (!gated) toClient.send(chunk);
    });

    let torn = false;
    const teardown = (why: string) => {
      if (torn) return;
      torn = true;
      unsubscribe();
      gateToServer?.close();
      gateToClient?.close();
      toServer.close();
      toClient.close();
      opts.store.closeConnection(id);
      log(`conn #${id} closed (${why})`);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', () => teardown('client closed'));
    upstream.on('close', () => teardown('upstream closed'));
  };

  const server = net.createServer(onClient);

  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') opts.onListening?.(addr);
  });

  // Resolve only once the socket is actually bound, so the returned handle is
  // usable immediately (`server.address()` is null until then) and a bind
  // failure surfaces as a rejection instead of an uncaught error.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListen);
      reject(err);
    };
    const onListen = () => {
      server.off('error', onError);
      // A listening socket can still error later (EMFILE on accept, for
      // instance). Without a listener that is an unhandled 'error' event, which
      // takes the whole process down — the proxy must outlive its clients.
      server.on('error', (e) => log(`listener error: ${e.message}`));
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(opts.port, opts.host ?? '127.0.0.1');
  });

  // Optional Unix-socket listener: lets a client attach with `DISPLAY=:N`.
  let unixServer: net.Server | undefined;
  let unixPath: string | undefined;
  if (opts.unixDisplay !== undefined) {
    unixPath = `/tmp/.X11-unix/X${opts.unixDisplay}`;
    try {
      fs.mkdirSync('/tmp/.X11-unix', { recursive: true });
      // A stale socket from a crashed run would block bind; only remove one
      // that nothing is listening on.
      if (fs.existsSync(unixPath)) {
        const stale = await new Promise<boolean>((resolve) => {
          const probe = net.connect({ path: unixPath! });
          probe.on('connect', () => { probe.destroy(); resolve(false); });
          probe.on('error', () => resolve(true));
        });
        if (stale) fs.unlinkSync(unixPath);
        else throw new Error(`${unixPath} is already in use by another server`);
      }
      unixServer = net.createServer(onClient);
      unixServer.on('error', (e) => log(`unix listener error: ${e.message}`));
      unixServer.listen(unixPath, () => log(`also listening on ${unixPath} (DISPLAY=:${opts.unixDisplay})`));
    } catch (err) {
      log(`unix listener unavailable: ${(err as Error).message}`);
      unixPath = undefined;
    }
  }

  return {
    server,
    interceptor: opts.interceptor,
    unixServer,
    unixPath,
    target,
    network,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (unixServer) await new Promise<void>((resolve) => unixServer!.close(() => resolve()));
      if (unixPath) { try { fs.unlinkSync(unixPath); } catch { /* already gone */ } }
    },
  };
}
