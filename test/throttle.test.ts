import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DirectionThrottle,
  NetworkEmulator,
  NETWORK_PROFILES,
  profileById,
  isPassthrough,
} from '../src/core/throttle.ts';

const noThrottle = profileById('none');
const slow3g = profileById('slow3g');

test('unthrottled profile writes synchronously (true pass-through)', () => {
  const out: Buffer[] = [];
  const t = new DirectionThrottle((c) => out.push(c), noThrottle, (p) => p.downKbps);
  t.send(Buffer.from('abc'));
  assert.equal(out.length, 1, 'written without waiting for a timer');
  assert.equal(out[0]!.toString(), 'abc');
});

test('a throttled profile defers delivery', async () => {
  const out: Buffer[] = [];
  const t = new DirectionThrottle((c) => out.push(c), slow3g, (p) => p.downKbps);
  t.send(Buffer.from('abc'));
  assert.equal(out.length, 0, 'not delivered synchronously');
  await new Promise((r) => setTimeout(r, slow3g.rttMs / 2 + 60));
  assert.equal(out.length, 1);
  t.close();
});

test('chunks are delivered in order, never reordered', async () => {
  const out: string[] = [];
  // A big chunk followed by a tiny one: serialization must still keep order.
  const t = new DirectionThrottle(
    (c) => out.push(c.toString()),
    { id: 'x', label: 'x', downKbps: 64, upKbps: 64, rttMs: 10 },
    (p) => p.downKbps,
  );
  t.send(Buffer.alloc(200, 0x41)); // 'A'*200 — slow to serialize
  t.send(Buffer.from('B'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(out.length, 2);
  assert.equal(out[0]![0], 'A');
  assert.equal(out[1], 'B');
  t.close();
});

test('throughput cap makes a larger payload take longer', async () => {
  const mk = (bytes: number) =>
    new Promise<number>((resolve) => {
      const start = Date.now();
      const t = new DirectionThrottle(
        () => resolve(Date.now() - start),
        { id: 'x', label: 'x', downKbps: 64, upKbps: 64, rttMs: 0 },
        (p) => p.downKbps,
      );
      t.send(Buffer.alloc(bytes));
    });
  const [small, large] = await Promise.all([mk(64), mk(640)]);
  assert.ok(large > small, `expected ${large}ms > ${small}ms for a 10× payload`);
});

test('close() drops queued chunks', async () => {
  const out: Buffer[] = [];
  const t = new DirectionThrottle((c) => out.push(c), slow3g, (p) => p.downKbps);
  t.send(Buffer.from('abc'));
  t.close();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(out.length, 0);
});

test('profile changes apply live to an open direction', async () => {
  const out: Buffer[] = [];
  const t = new DirectionThrottle((c) => out.push(c), noThrottle, (p) => p.downKbps);
  t.send(Buffer.from('1'));
  assert.equal(out.length, 1, 'passthrough while unthrottled');
  t.setProfile(slow3g);
  t.send(Buffer.from('2'));
  assert.equal(out.length, 1, 'now deferred');
  await new Promise((r) => setTimeout(r, slow3g.rttMs / 2 + 60));
  assert.equal(out.length, 2);
  t.close();
});

test('NetworkEmulator notifies listeners and falls back for unknown ids', () => {
  const em = new NetworkEmulator();
  const seen: string[] = [];
  em.onChange((p) => seen.push(p.id));
  em.set('slow3g');
  assert.equal(em.current.id, 'slow3g');
  em.set('nope');
  assert.equal(em.current.id, 'none', 'unknown id falls back to no throttling');
  assert.deepEqual(seen, ['slow3g', 'none']);
});

test('every preset is well formed and ids are unique', () => {
  const ids = new Set<string>();
  for (const p of NETWORK_PROFILES) {
    assert.ok(p.label.length > 0, `${p.id} needs a label`);
    assert.ok(p.rttMs >= 0 && p.downKbps >= 0 && p.upKbps >= 0);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
  }
  assert.ok(isPassthrough(profileById('none'), 0));
  assert.ok(!isPassthrough(slow3g, slow3g.downKbps));
});
