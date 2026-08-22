import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Interceptor, MessageGate, matches } from '../src/core/intercept.ts';
import { CaptureStore } from '../src/core/store.ts';
import { startProxy } from '../src/core/proxy.ts';
import type { CapturedMessage } from '../src/core/protocol/types.ts';

let nextId = 0;
const msg = (over: Partial<CapturedMessage> = {}): CapturedMessage => ({
  id: ++nextId, connId: 1, dir: 'c2s', category: 'request', ts: 0, mono: 0,
  bytes: Buffer.from([nextId]), name: 'MapWindow', summary: '', ...over,
});

/** A gate writing into an array, so ordering is observable. */
function gate(i: Interceptor) {
  const out: number[] = [];
  const g = new MessageGate((b) => out.push(b[0]!), i);
  return { g, out };
}

test('rules match on name, direction and category', () => {
  const i = new Interceptor();
  const r = i.addRule({ enabled: true, action: 'break', name: 'map' });
  assert.ok(matches(r, msg({ name: 'MapWindow' })), 'substring, case-insensitive');
  assert.ok(!matches(r, msg({ name: 'CreateGC' })));

  const dirRule = i.addRule({ enabled: true, action: 'drop', dir: 's2c' });
  assert.ok(!matches(dirRule, msg({ dir: 'c2s' })));
  assert.ok(matches(dirRule, msg({ dir: 's2c' })));
});

test('with no rules everything passes straight through', () => {
  const i = new Interceptor();
  const { g, out } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  assert.deepEqual(out, [m.bytes[0]]);
});

test('a disabled rule does not fire', () => {
  const i = new Interceptor();
  const r = i.addRule({ enabled: true, action: 'drop', name: 'MapWindow' });
  i.setEnabled(r.id, false);
  const { g, out } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  assert.equal(out.length, 1, 'forwarded');
});

test('drop discards the message but lets the rest flow', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'drop', name: 'MapWindow' });
  const { g, out } = gate(i);
  const a = msg({ name: 'MapWindow' });
  const b = msg({ name: 'CreateGC' });
  g.offer(a, a.bytes);
  g.offer(b, b.bytes);
  assert.deepEqual(out, [b.bytes[0]], 'only the unmatched one went through');
});

test('break holds the message until it is stepped, then forwards it', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g, out } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  assert.equal(i.heldMessages().length, 1);
  assert.equal(out.length, 0, 'genuinely blocked');

  assert.equal(i.step(), true);
  assert.deepEqual(out, [m.bytes[0]], 'released on step');
  assert.equal(i.heldMessages().length, 0);
});

test('a held message blocks everything behind it in that direction', () => {
  // The bug this exists to prevent: holding one message while later ones sail
  // past reorders the stream and lets the client run on through a breakpoint.
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g, out } = gate(i);

  const held = msg({ name: 'MapWindow' });
  const behind1 = msg({ name: 'CreateGC' });
  const behind2 = msg({ name: 'PolyFillRectangle' });
  g.offer(held, held.bytes);
  g.offer(behind1, behind1.bytes);
  g.offer(behind2, behind2.bytes);

  assert.equal(out.length, 0, 'nothing flows while the head is held');
  assert.equal(i.heldMessages().length, 1, 'exactly one is held — the head');
  assert.equal(i.queuedCount(), 2, 'the others are queued behind it');

  i.step();
  assert.deepEqual(
    out,
    [held.bytes[0], behind1.bytes[0], behind2.bytes[0]],
    'released in arrival order',
  );
});

test('dropping the held head still releases the queue behind it', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g, out } = gate(i);
  const a = msg({ name: 'MapWindow' });
  const b = msg({ name: 'CreateGC' });
  g.offer(a, a.bytes);
  g.offer(b, b.bytes);
  i.dropHead();
  assert.deepEqual(out, [b.bytes[0]], 'the head was discarded, the rest flowed');
});

test('resumeAll drains a queue even when every message matches', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g, out } = gate(i);
  const ms = [msg(), msg(), msg()];
  for (const m of ms) g.offer(m, m.bytes);
  assert.equal(i.heldMessages().length, 1, 'one at a time reaches the head');
  i.resumeAll();
  assert.deepEqual(out, ms.map((m) => m.bytes[0]), 'all released, in order');
  assert.equal(i.heldMessages().length, 0);
});

test('a `once` rule disables itself after firing', () => {
  const i = new Interceptor();
  const r = i.addRule({ enabled: true, action: 'drop', name: 'MapWindow', once: true });
  const { g, out } = gate(i);
  const a = msg();
  const b = msg();
  g.offer(a, a.bytes);
  assert.equal(r.hits, 1);
  g.offer(b, b.bytes);
  assert.deepEqual(out, [b.bytes[0]], 'second time through it is inert');
});

test('delay forwards late rather than never, and holds order meanwhile', async () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'delay', name: 'MapWindow', delayMs: 40 });
  const { g, out } = gate(i);
  const a = msg({ name: 'MapWindow' });
  const b = msg({ name: 'CreateGC' });
  g.offer(a, a.bytes);
  g.offer(b, b.bytes);
  assert.equal(out.length, 0);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(out, [a.bytes[0], b.bytes[0]]);
});

test('closing a gate forgets what was queued', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g, out } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  g.close();
  i.resumeAll();
  assert.equal(out.length, 0, 'a dead socket receives nothing');
});

test('a client that dies mid-breakpoint releases the debugger', () => {
  // Otherwise the held entry is stranded: the toolbar sits on "Paused" for a
  // connection that no longer exists, and Continue does nothing forever.
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  assert.equal(i.heldMessages().length, 1);

  g.close(); // the socket went away
  assert.equal(i.heldMessages().length, 0, 'the stranded hold is cleared');
  assert.equal(i.queuedCount(), 0);
});

test('resumeAll terminates when a gate is already closed', () => {
  const i = new Interceptor();
  i.addRule({ enabled: true, action: 'break', name: 'MapWindow' });
  const { g } = gate(i);
  const m = msg();
  g.offer(m, m.bytes);
  g.close();
  i.resumeAll(); // must not spin on an entry that can never settle
  assert.equal(i.heldMessages().length, 0);
});

// --- end to end through the real proxy -------------------------------------

/** A stand-in X server that echoes a canned setup reply and records requests. */
function fakeServer(onData: (b: Buffer) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const socks: net.Socket[] = [];
    const srv = net.createServer((sock) => {
      socks.push(sock);
      sock.on('data', (b) => {
        onData(b);
        if (b[0] === 0x6c) {
          const sr = Buffer.alloc(40);
          sr[0] = 1;
          sr.writeUInt16LE(8, 6);
          sock.write(sr);
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as net.AddressInfo;
      resolve({
        port: a.port,
        close: () => {
          for (const s of socks) s.destroy();
          srv.close();
        },
      });
    });
  });
}

test('a break rule blocks the client until it is released, then delivers', async () => {
  const seen: Buffer[] = [];
  const upstream = await fakeServer((b) => seen.push(Buffer.from(b)));
  const store = new CaptureStore();
  const interceptor = new Interceptor();
  interceptor.addRule({ enabled: true, action: 'break', name: 'MapWindow' });

  const proxy = await startProxy({
    port: 0,
    store,
    interceptor,
    target: { kind: 'tcp', host: '127.0.0.1', port: upstream.port, display: 0, screen: 0 },
  });
  const addr = proxy.server.address() as net.AddressInfo;
  const client = net.connect({ host: '127.0.0.1', port: addr.port });
  await new Promise((r) => client.on('connect', r));
  const setup = Buffer.alloc(12);
  setup[0] = 0x6c;
  client.write(setup);
  await new Promise((r) => setTimeout(r, 120));

  const mapWindow = Buffer.alloc(8);
  mapWindow[0] = 8;
  mapWindow.writeUInt16LE(2, 2);
  mapWindow.writeUInt32LE(0x123, 4);
  client.write(mapWindow);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(interceptor.heldMessages().length, 1, 'the message is being held');
  assert.ok(!Buffer.concat(seen).includes(mapWindow), 'and has not reached the server');

  // Releasing it — what the UI's Continue button does — delivers it onward.
  interceptor.resumeAll();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(interceptor.heldMessages().length, 0);
  assert.ok(Buffer.concat(seen).includes(mapWindow), 'released to the server');

  client.destroy();
  await proxy.close();
  upstream.close();
});

test('a drop rule stops the request from reaching the server', async () => {
  const seen: Buffer[] = [];
  const upstream = await fakeServer((b) => seen.push(Buffer.from(b)));
  const store = new CaptureStore();
  const interceptor = new Interceptor();
  interceptor.addRule({ enabled: true, action: 'drop', name: 'MapWindow' });

  const proxy = await startProxy({
    port: 0,
    store,
    interceptor,
    target: { kind: 'tcp', host: '127.0.0.1', port: upstream.port, display: 0, screen: 0 },
  });
  const addr = proxy.server.address() as net.AddressInfo;

  const client = net.connect({ host: '127.0.0.1', port: addr.port });
  await new Promise((r) => client.on('connect', r));
  const setup = Buffer.alloc(12);
  setup[0] = 0x6c;
  client.write(setup);
  await new Promise((r) => setTimeout(r, 120));

  // MapWindow — should be dropped; CreateGC — should get through.
  const mapWindow = Buffer.alloc(8);
  mapWindow[0] = 8;
  mapWindow.writeUInt16LE(2, 2);
  mapWindow.writeUInt32LE(0x123, 4);
  client.write(mapWindow);

  const createGC = Buffer.alloc(16);
  createGC[0] = 55;
  createGC.writeUInt16LE(4, 2);
  createGC.writeUInt32LE(0x456, 4);
  client.write(createGC);
  await new Promise((r) => setTimeout(r, 200));

  const forwarded = Buffer.concat(seen);
  assert.ok(store.messages.some((m) => m.name === 'MapWindow'), 'still captured for inspection');
  assert.ok(!forwarded.includes(mapWindow), 'MapWindow never reached the server');
  assert.ok(forwarded.includes(createGC), 'the unmatched request did reach it');

  client.destroy();
  await proxy.close();
  upstream.close();
});
