import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionCapture, type CaptureSink } from '../src/core/connection.ts';
import { computeLints, findUsages, touchesXid } from '../src/core/lints.ts';
import { CaptureStore } from '../src/core/store.ts';

function session(): { store: CaptureStore; cap: ConnectionCapture } {
  const store = new CaptureStore();
  const cap = new ConnectionCapture(1, store);
  const cs = Buffer.alloc(12);
  cs[0] = 0x6c;
  cap.feed('c2s', cs);
  const sr = Buffer.alloc(40);
  sr[0] = 1;
  sr.writeUInt16LE(8, 6);
  cap.feed('s2c', sr);
  return { store, cap };
}

const createPixmap = (pid: number, drawable = 0xc0) => {
  const b = Buffer.alloc(16);
  b[0] = 53;
  b[1] = 24;
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(pid, 4);
  b.writeUInt32LE(drawable, 8);
  b.writeUInt16LE(64, 12);
  b.writeUInt16LE(64, 14);
  return b;
};
const freePixmap = (pid: number) => {
  const b = Buffer.alloc(8);
  b[0] = 54;
  b.writeUInt16LE(2, 2);
  b.writeUInt32LE(pid, 4);
  return b;
};
const createGC = (cid: number, drawable: number) => {
  const b = Buffer.alloc(16);
  b[0] = 55;
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(cid, 4);
  b.writeUInt32LE(drawable, 8);
  return b;
};

test('a clean create/use/free cycle produces no lints', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', createGC(0x200002, 0x200001)); // uses the pixmap
  cap.feed('c2s', freePixmap(0x200001));
  const r = computeLints(store.messages);
  assert.equal(r.counts['use-after-free'], 0);
  assert.equal(r.counts['double-free'], 0);
  // The GC is never freed, so it is the only leak.
  assert.equal(r.counts.leak, 1);
  assert.equal(r.lints.find((l) => l.kind === 'leak')!.resourceType, 'GContext');
});

test('use-after-free is detected and points at both the creator and the free', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  const creator = store.messages.at(-1)!;
  cap.feed('c2s', freePixmap(0x200001));
  const freer = store.messages.at(-1)!;
  cap.feed('c2s', createGC(0x200002, 0x200001)); // uses the freed pixmap

  const r = computeLints(store.messages);
  assert.equal(r.counts['use-after-free'], 1);
  const l = r.lints.find((x) => x.kind === 'use-after-free')!;
  assert.equal(l.xid, 0x200001);
  assert.equal(l.resourceType, 'Pixmap');
  assert.equal(l.createdBy, creator.id);
  assert.equal(l.freedBy, freer.id);
  assert.equal(l.severity, 'high');
  assert.match(l.text, /after it was freed/);
});

test('double-free is detected', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', freePixmap(0x200001));
  cap.feed('c2s', freePixmap(0x200001));
  const r = computeLints(store.messages);
  assert.equal(r.counts['double-free'], 1);
  assert.match(r.lints.find((l) => l.kind === 'double-free')!.text, /again/);
});

test('freeing an id we never saw created is reported, but only as info', () => {
  const { store, cap } = session();
  cap.feed('c2s', freePixmap(0xdead01));
  const r = computeLints(store.messages);
  assert.equal(r.counts['free-unknown'], 1);
  assert.equal(r.lints[0]!.severity, 'info', 'a mid-session capture legitimately does this');
});

test('recreating a freed id resets its lifecycle (XID recycling is legal)', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', freePixmap(0x200001));
  cap.feed('c2s', createPixmap(0x200001)); // same id, reused
  cap.feed('c2s', createGC(0x200002, 0x200001)); // legitimate use of the new one
  const r = computeLints(store.messages);
  assert.equal(r.counts['use-after-free'], 0, 'the reuse is not a use-after-free');
  assert.equal(r.counts['double-free'], 0);
});

test('a handful of live resources is reported as info, not accused of leaking', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  const r = computeLints(store.messages);
  const l = r.lints.find((x) => x.kind === 'leak')!;
  assert.equal(l.severity, 'info', 'a running app legitimately holds resources open');
  assert.match(l.text, /still live at the end/);
});

test('an accumulation of one resource type is raised to a real suspicion', () => {
  const { store, cap } = session();
  for (let i = 0; i < 25; i++) cap.feed('c2s', createPixmap(0x300000 + i));
  const r = computeLints(store.messages);
  const l = r.lints.find((x) => x.kind === 'leak')!;
  assert.equal(l.severity, 'medium');
  assert.match(l.text, /possible leak/);
  assert.equal(r.counts.leak, 25);
});

test('leaks count live resources at end of capture', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', createPixmap(0x200002));
  cap.feed('c2s', freePixmap(0x200001));
  const r = computeLints(store.messages);
  assert.equal(r.liveResources, 1);
  assert.equal(r.counts.leak, 1);
  assert.equal(r.lints.find((l) => l.kind === 'leak')!.xid, 0x200002);
});

test('lints are indexed by message so rows can be badged', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', freePixmap(0x200001));
  cap.feed('c2s', createGC(0x200002, 0x200001));
  const offender = store.messages.at(-1)!;
  const r = computeLints(store.messages);
  assert.ok(r.byMessage.get(offender.id)?.some((l) => l.kind === 'use-after-free'));
});

// --- find usages -----------------------------------------------------------

test('find-usages returns creations, references and frees of an xid', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', createGC(0x200002, 0x200001)); // references it
  cap.feed('c2s', createPixmap(0x200009)); // unrelated
  cap.feed('c2s', freePixmap(0x200001));

  const uses = findUsages(store.messages, 0x200001);
  const names = uses.map((m) => m.name);
  assert.deepEqual(names, ['CreatePixmap', 'CreateGC', 'FreePixmap']);
  assert.ok(!uses.some((m) => m.name === 'CreatePixmap' && m.creates?.xid === 0x200009));
});

test('touchesXid is the row-level predicate behind the filter', () => {
  const { store, cap } = session();
  cap.feed('c2s', createPixmap(0x200001));
  cap.feed('c2s', createPixmap(0x200009));
  const [a, b] = store.messages.filter((m) => m.name === 'CreatePixmap');
  assert.equal(touchesXid(a!, 0x200001), true);
  assert.equal(touchesXid(b!, 0x200001), false);
});
