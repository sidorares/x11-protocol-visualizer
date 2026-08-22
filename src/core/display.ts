/**
 * Resolve an X11 `$DISPLAY` string to a concrete connection target.
 *
 * Handles the three forms that matter here:
 *   - `:N` / `unix:N`            → Unix socket /tmp/.X11-unix/XN
 *   - `/path/to/sock:N`          → Unix socket at that path (XQuartz launchd form)
 *   - `host:N` / `host:N.S`      → TCP host:(6000+N)
 *
 * The XQuartz launchd case is important on macOS: DISPLAY looks like
 * `/private/tmp/com.apple.launchd.XXX/org.xquartz:0`, and the socket is the
 * entire string (the `:0` is part of the path), not /tmp/.X11-unix/X0 (which
 * exists but refuses connections).
 */

export type DisplayTarget =
  | { kind: 'unix'; path: string; display: number; screen: number }
  | { kind: 'tcp'; host: string; port: number; display: number; screen: number };

export class DisplayParseError extends Error {}

export function resolveDisplay(display: string | undefined): DisplayTarget {
  const raw = (display ?? '').trim();
  if (!raw) {
    throw new DisplayParseError(
      'No DISPLAY set and no --display given; cannot resolve upstream X server',
    );
  }

  const colon = raw.lastIndexOf(':');
  if (colon < 0) {
    throw new DisplayParseError(`Malformed DISPLAY (no ':'): ${raw}`);
  }

  const host = raw.slice(0, colon);
  const tail = raw.slice(colon + 1);
  const dot = tail.indexOf('.');
  const displayStr = dot >= 0 ? tail.slice(0, dot) : tail;
  const screenStr = dot >= 0 ? tail.slice(dot + 1) : '0';

  const displayNum = Number(displayStr);
  const screenNum = Number(screenStr || '0');
  if (!Number.isInteger(displayNum) || displayNum < 0) {
    throw new DisplayParseError(`Malformed DISPLAY (bad display number): ${raw}`);
  }
  if (!Number.isInteger(screenNum) || screenNum < 0) {
    throw new DisplayParseError(`Malformed DISPLAY (bad screen number): ${raw}`);
  }

  // Absolute-path host → the launchd/unix socket is `${host}:${displayNum}`.
  if (host.startsWith('/')) {
    return {
      kind: 'unix',
      path: `${host}:${displayNum}`,
      display: displayNum,
      screen: screenNum,
    };
  }

  // Empty or explicit "unix" host → classic abstract/filesystem socket.
  if (host === '' || host === 'unix') {
    return {
      kind: 'unix',
      path: `/tmp/.X11-unix/X${displayNum}`,
      display: displayNum,
      screen: screenNum,
    };
  }

  // Otherwise TCP.
  return {
    kind: 'tcp',
    host,
    port: 6000 + displayNum,
    display: displayNum,
    screen: screenNum,
  };
}

/** Human-readable form of a resolved target, for logs. */
export function describeTarget(t: DisplayTarget): string {
  return t.kind === 'unix' ? `unix:${t.path}` : `tcp:${t.host}:${t.port}`;
}
