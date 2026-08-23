/**
 * x11vis CLI — starts the MITM proxy and either renders the react-x11 UI
 * (default, when a display is available) or logs captured messages to the
 * console (headless, always available — docs/PRD.md FR-54).
 */

import net from 'node:net';
import fs from 'node:fs';
import { startProxy } from './core/proxy.js';
import { CaptureStore } from './core/store.js';
import { resolveDisplay, describeTarget } from './core/display.js';
import type { CapturedMessage, Category } from './core/protocol/types.js';
import { toHex } from './core/util/hex.js';
import { NetworkEmulator, NETWORK_PROFILES } from './core/throttle.js';
import { CAPTURE_VERSION, loadCapture, serializeCapture } from './core/capture-file.js';
import { Interceptor } from './core/intercept.js';
import { diffCaptures, formatDiff } from './core/diff.js';
import { computeStats, formatStats } from './core/stats.js';

interface Args {
  port: number;
  display: string | undefined;
  record: string | undefined;
  open: string | undefined;
  diff: [string, string] | undefined;
  stats: string | undefined;
  json: boolean;
  ui: boolean;
  uiDisplay: string | undefined;
  network: string;
  unixDisplay: number | undefined;
  intercept: boolean;
  breakOn: string[];
  dropOn: string[];
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    port: 6001,
    display: process.env.DISPLAY,
    record: undefined,
    open: undefined,
    diff: undefined,
    stats: undefined,
    json: false,
    ui: true,
    uiDisplay: process.env.DISPLAY,
    network: 'none',
    unixDisplay: undefined,
    intercept: false,
    breakOn: [],
    dropOn: [],
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    switch (arg) {
      case '-p':
      case '--port':
        a.port = Number(next());
        break;
      case '-d':
      case '--display':
        a.display = next();
        break;
      case '--record':
        a.record = next();
        break;
      case '--diff': {
        const a1 = next();
        const b1 = next();
        if (a1 && b1) a.diff = [a1, b1];
        break;
      }
      case '--stats':
        a.stats = next();
        break;
      case '--json':
        a.json = true;
        break;
      case '-o':
      case '--open':
        a.open = next();
        break;
      case '--no-ui':
        a.ui = false;
        break;
      case '--ui-display':
        a.uiDisplay = next();
        break;
      case '--intercept':
        a.intercept = true;
        break;
      case '--break': {
        const n = next();
        if (n) { a.breakOn.push(n); a.intercept = true; }
        break;
      }
      case '--drop': {
        const n = next();
        if (n) { a.dropOn.push(n); a.intercept = true; }
        break;
      }
      case '-u':
      case '--unix':
        a.unixDisplay = Number(next());
        break;
      case '-n':
      case '--network':
        a.network = next() ?? 'none';
        break;
      case '-q':
      case '--quiet':
        a.quiet = true;
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        a.help = true;
    }
  }
  return a;
}

const HELP = `x11vis — X11 MITM proxy + protocol visualizer

Usage: x11vis [options]

Options:
  -p, --port <n>        TCP port to listen on (default 6001 = X display :1 over TCP)
  -d, --display <s>     Upstream X server DISPLAY (default: $DISPLAY)
      --record <file>   Record the session to <file> (.x11cap)
  -o, --open <file>     Open a saved .x11cap for offline inspection
      --diff <a> <b>    Compare two .x11cap captures and print what changed
      --stats <file>    Print protocol statistics and hotspots for a .x11cap
      --json            Machine-readable output for --stats and --diff
      --no-ui           Headless: log to console, do not open the react-x11 UI
      --ui-display <s>  DISPLAY for the UI window (default: $DISPLAY, bypassing the proxy)
      --intercept       Enable breakpoints / fault injection (forwards whole
                        messages instead of raw chunks; off by default)
      --break <name>    Hold messages whose name contains <name> (implies
                        --intercept); release them from the UI
      --drop <name>     Never forward messages whose name contains <name>
  -u, --unix <n>        Also listen on /tmp/.X11-unix/X<n> so DISPLAY=:<n> attaches
  -n, --network <id>    Network emulation preset (changeable live in the UI):
                        ${NETWORK_PROFILES.map((p) => p.id).join(', ')}
  -q, --quiet           Suppress per-message console output
  -h, --help            Show this help

Point a client at the proxy, e.g.:  DISPLAY=127.0.0.1:1 xdpyinfo
`;

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  request: '\x1b[34m', // blue
  reply: '\x1b[32m', // green
  error: '\x1b[31m', // red
  event: '\x1b[33m', // yellow
  setup: '\x1b[90m', // gray
};

function colorFor(cat: Category): string {
  switch (cat) {
    case 'request':
      return ANSI.request;
    case 'reply':
      return ANSI.reply;
    case 'error':
      return ANSI.error;
    case 'event':
      return ANSI.event;
    default:
      return ANSI.setup;
  }
}

function fmtLine(m: CapturedMessage): string {
  const arrow = m.dir === 'c2s' ? '→' : '←';
  const color = colorFor(m.category);
  const cat = m.category.padEnd(7);
  const seq = m.seq !== undefined ? `#${m.seq}` : '';
  const rtt = m.rttMs !== undefined ? ` ${m.rttMs.toFixed(1)}ms` : '';
  const name = m.name.padEnd(26);
  const size = `${m.bytes.length}B`.padStart(6);
  const summary = m.summary ? `  ${m.summary}` : '';
  const hex = `${ANSI.dim}${toHex(m.bytes, 16)}${ANSI.reset}`;
  return `${color}${arrow} ${cat}${ANSI.reset} ${name} ${seq.padStart(6)}${rtt} ${size}${summary}\n    ${hex}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const store = new CaptureStore();

  // Diff mode: compare two captures and exit; no X server involved.
  // Statistics for a saved capture, without opening the UI. The core is pure
  // and dependency-free, so this is the same computation the Statistics tab
  // shows — which is the point: a number quoted in a PR should be the number
  // the tool reports, not a second implementation of it.
  if (args.stats) {
    try {
      const store = new CaptureStore();
      loadCapture(fs.readFileSync(args.stats, 'utf8'), store);
      const stats = computeStats(store.messages);
      process.stdout.write(
        args.json
          ? `${JSON.stringify(stats, null, 2)}\n`
          : `${args.stats}\n\n` + formatStats(stats) + '\n',
      );
      return;
    } catch (err) {
      process.stderr.write(`x11vis: cannot read stats: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  if (args.diff) {
    try {
      const [pa, pb] = args.diff;
      const sa = new CaptureStore();
      const sb = new CaptureStore();
      loadCapture(fs.readFileSync(pa, 'utf8'), sa);
      loadCapture(fs.readFileSync(pb, 'utf8'), sb);
      const diff = diffCaptures(sa.messages, sb.messages);
      process.stdout.write(
        args.json
          ? `${JSON.stringify(diff, null, 2)}\n`
          : `${pa} → ${pb}\n\n` + formatDiff(diff) + '\n',
      );
      return;
    } catch (err) {
      process.stderr.write(`x11vis: cannot diff: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  // Resolve upstream early so a bad DISPLAY fails loudly before we listen.
  let target;
  try {
    target = resolveDisplay(args.display);
  } catch (err) {
    process.stderr.write(`x11vis: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Recording writes the `.x11cap` format: a header line, then one raw-bytes
  // record per message. Reopening replays those bytes through the decoder, so
  // a capture is never stale relative to the protocol tables.
  let recordStream: fs.WriteStream | undefined;
  if (args.record) {
    recordStream = fs.createWriteStream(args.record, { flags: 'w' });
    recordStream.on('error', (err) => {
      process.stderr.write(`x11vis: recording disabled (${(err as Error).message})\n`);
      recordStream = undefined;
    });
    recordStream.write(
      JSON.stringify({ x11cap: CAPTURE_VERSION, savedAt: Date.now(), target: describeTarget(target), connections: [] }) + '\n',
    );
    store.on('message', (m: CapturedMessage) => {
      recordStream?.write(
        JSON.stringify({ c: m.connId, d: m.dir, m: m.mono, w: m.ts, b: m.bytes.toString('hex') }) + '\n',
      );
    });
  }

  // Offline mode: open a capture and inspect it without touching an X server.
  if (args.open) {
    try {
      const text = fs.readFileSync(args.open, 'utf8');
      const res = loadCapture(text, store);
      process.stderr.write(
        `${ANSI.dim}[x11vis]${ANSI.reset} opened ${args.open}: ${res.messages} messages, ${res.connections} connections\n`,
      );
    } catch (err) {
      process.stderr.write(`x11vis: cannot open capture: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  const network = new NetworkEmulator();
  if (args.network !== 'none') {
    const p = network.set(args.network);
    process.stderr.write(`${ANSI.dim}[x11vis]${ANSI.reset} network emulation: ${p.label}\n`);
  }

  const shutdown = async () => {
    process.stderr.write(
      `\n${ANSI.dim}[x11vis]${ANSI.reset} ${store.messages.length} messages captured. Bye.\n`,
    );
    recordStream?.end();
    await handle.close();
    process.exit(0);
  };

  const interceptor = args.intercept ? new Interceptor() : undefined;
  if (interceptor) {
    for (const n of args.breakOn) interceptor.addRule({ enabled: true, action: 'break', name: n });
    for (const n of args.dropOn) interceptor.addRule({ enabled: true, action: 'drop', name: n });
    interceptor.on('break', (h: { msg: { name: string } }) =>
      store.log('warn', `breakpoint: holding ${h.msg.name} — step or continue to release`));
    process.stderr.write(`${ANSI.dim}[x11vis]${ANSI.reset} interception enabled (message-granular forwarding)\n`);
  }

  const handle = await startProxy({
    port: args.port,
    interceptor,
    unixDisplay: args.unixDisplay,
    display: args.display,
    target,
    store,
    network,
    log: (msg) => !args.quiet && process.stderr.write(`${ANSI.dim}[x11vis] ${msg}${ANSI.reset}\n`),
    onListening: (addr: net.AddressInfo) => {
      process.stderr.write(
        `${ANSI.dim}[x11vis]${ANSI.reset} listening on ${addr.address}:${addr.port} → ${describeTarget(target)}\n` +
          `${ANSI.dim}[x11vis]${ANSI.reset} point a client here, e.g.  DISPLAY=127.0.0.1:${addr.port - 6000} xdpyinfo\n`,
      );
    },
  });

  // Try the react-x11 UI unless disabled; fall back to console on any failure.
  let uiActive = false;
  if (args.ui) {
    try {
      // Non-literal specifier so the core typecheck doesn't pull in the UI's
      // optional react-x11 dependency; the UI is loaded lazily at runtime.
      type UIModule = {
        startUI: (
          s: CaptureStore,
          o: {
            display?: string;
            network: NetworkEmulator;
            interceptor?: Interceptor;
            onQuit?: () => void;
            onSave?: () => string;
          },
        ) => Promise<unknown>;
      };
      const uiEntry = './ui/index.js';
      const mod = (await import(uiEntry)) as UIModule;
      await mod.startUI(store, {
        display: args.uiDisplay,
        network: handle.network,
        interceptor,
        onQuit: () => void shutdown(),
        onSave: () => {
          const file = `x11vis-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.x11cap`;
          fs.writeFileSync(file, serializeCapture(store, describeTarget(target)));
          store.log('info', `saved ${store.messages.length} messages → ${file}`);
          return file;
        },
      });
      uiActive = true;
      process.stderr.write(`${ANSI.dim}[x11vis]${ANSI.reset} react-x11 UI open on ${args.uiDisplay}\n`);
    } catch (err) {
      process.stderr.write(
        `${ANSI.dim}[x11vis]${ANSI.reset} UI unavailable (${(err as Error).message.split('\n')[0]}); running headless.\n`,
      );
    }
  }

  // Console renderer (headless, or alongside if UI failed).
  if (!uiActive && !args.quiet) {
    store.on('message', (m: CapturedMessage) => process.stdout.write(fmtLine(m) + '\n'));
  }

  // x11vis must outlive the clients it inspects: a dead client, a broken pipe
  // or a UI hiccup should never end the session — the capture in memory is the
  // whole value of the process. Anything unexpected is reported to the console
  // pane and to stderr, and the proxy keeps listening.
  process.on('uncaughtException', (err) => {
    const e = err as NodeJS.ErrnoException;
    // These are all "the peer went away" and are entirely routine here.
    const benign = e.code === 'EPIPE' || e.code === 'ECONNRESET' || e.code === 'ERR_STREAM_WRITE_AFTER_END';
    store.log(benign ? 'warn' : 'error', `${benign ? 'socket' : 'uncaught'}: ${e.message}`);
    if (!benign) {
      process.stderr.write(
        `${ANSI.dim}[x11vis]${ANSI.reset} uncaught error (continuing): ${e.stack ?? e.message}\n`,
      );
    }
  });
  process.on('unhandledRejection', (reason) => {
    store.log('error', `unhandled rejection: ${String(reason)}`);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`x11vis: fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
