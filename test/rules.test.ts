import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, evaluateRule, numericOf, describeRule, type Rule } from '../src/core/rules.ts';
import { buildCatalog, findEntry, searchCatalog } from '../src/core/catalog.ts';
import type { CapturedMessage, Field } from '../src/core/protocol/types.ts';

const mk = (over: Partial<CapturedMessage> & { fields?: Field[] } = {}): CapturedMessage => ({
  id: 1, connId: 1, dir: 'c2s', category: 'request', ts: 0, mono: 0,
  bytes: Buffer.alloc(32), name: 'CreateWindow', summary: '', ...over,
});
const f = (name: string, value: string): Field => ({ name, value, span: { off: 0, len: 4 } });

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 1, enabled: true, action: 'break', hits: 0, ...over,
});

// --- value parsing ---------------------------------------------------------

test('field values parse to numbers across the shapes the decoder renders', () => {
  assert.equal(numericOf('800'), 800);
  assert.equal(numericOf('0x00a00001'), 0xa00001);
  assert.equal(numericOf('InputOnly (2)'), 2);
  assert.equal(numericOf('0x600 (poly-edge | poly-mode)'), 0x600);
  assert.ok(Number.isNaN(numericOf('"WM_NAME"')));
});

// --- structured predicates -------------------------------------------------

test('a numeric predicate compares a decoded parameter', () => {
  const ctx = buildContext(mk({ fields: [f('width', '800'), f('height', '600')] }));
  const r = rule({ name: 'CreateWindow', predicates: [{ source: 'msg', field: 'width', op: 'gt', value: 500 }] });
  assert.equal(evaluateRule(r, ctx), true);
  r.predicates = [{ source: 'msg', field: 'width', op: 'gt', value: 900 }];
  assert.equal(evaluateRule(r, ctx), false);
});

test('predicates are ANDed', () => {
  const ctx = buildContext(mk({ fields: [f('width', '800'), f('height', '600')] }));
  const r = rule({
    predicates: [
      { source: 'msg', field: 'width', op: 'gt', value: 500 },
      { source: 'msg', field: 'height', op: 'lt', value: 100 },
    ],
  });
  assert.equal(evaluateRule(r, ctx), false, 'one failing condition fails the rule');
});

test('hyphen and underscore spellings of a field both resolve', () => {
  const ctx = buildContext(mk({ fields: [f('value-len', '19')] }));
  for (const field of ['value-len', 'value_len']) {
    assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field, op: 'eq', value: 19 }] }), ctx), true, field);
  }
});

test('resource predicates compare hex xids', () => {
  const ctx = buildContext(mk({ fields: [f('wid', '0x00a00001')] }));
  const r = rule({ predicates: [{ source: 'msg', field: 'wid', op: 'eq', value: '0x00a00001', valueKind: 'resource' }] });
  assert.equal(evaluateRule(r, ctx), true);
});

test('string predicates match on the rendered text', () => {
  const ctx = buildContext(mk({ name: 'RENDER:CreatePicture' }));
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'name', op: 'contains', value: 'Picture', valueKind: 'string' }] }), ctx), true);
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'name', op: 'startsWith', value: 'RENDER', valueKind: 'string' }] }), ctx), true);
});

test('atom predicates match the atom name, and its id as a fallback', () => {
  const ctx = buildContext(mk({ fields: [f('property', 'WM_NAME')] }), undefined, new Map([['WM_NAME', 39]]));
  const byName = rule({ predicates: [{ source: 'msg', field: 'property', op: 'eq', value: 'WM_NAME', valueKind: 'atom' }] });
  assert.equal(evaluateRule(byName, ctx), true);

  // A capture that never saw the InternAtom renders the number instead.
  const numeric = buildContext(mk({ fields: [f('property', '39')] }), undefined, new Map([['WM_NAME', 39]]));
  assert.equal(evaluateRule(byName, numeric), true, 'falls back to the id');
});

test('exists / absent test for the presence of a parameter', () => {
  const ctx = buildContext(mk({ fields: [f('width', '800')] }));
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'width', op: 'exists' }] }), ctx), true);
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'height', op: 'absent' }] }), ctx), true);
});

test('pseudo-parameters size and seq are matchable', () => {
  const ctx = buildContext(mk({ bytes: Buffer.alloc(120), seq: 42 }));
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'size', op: 'gt', value: 100 }] }), ctx), true);
  assert.equal(evaluateRule(rule({ predicates: [{ source: 'msg', field: 'seq', op: 'eq', value: 42 }] }), ctx), true);
});

// --- the linked-object case ------------------------------------------------

test('a response rule can put a condition on the request it answers', () => {
  const request = mk({ id: 7, name: 'RENDER:AddGlyphs', fields: [f('num-glyphs', '128')] });
  const reply = mk({ id: 8, category: 'reply', dir: 's2c', name: 'RENDER:AddGlyphs·reply', requestId: 7 });
  const ctx = buildContext(reply, (id) => (id === 7 ? request : undefined));

  const r = rule({
    category: 'reply',
    name: 'AddGlyphs',
    predicates: [{ source: 'request', field: 'num-glyphs', op: 'gt', value: 100 }],
  });
  assert.equal(evaluateRule(r, ctx), true, 'reads through to the originating request');

  r.predicates = [{ source: 'request', field: 'num-glyphs', op: 'gt', value: 500 }];
  assert.equal(evaluateRule(r, ctx), false);
});

test('a request-sourced predicate simply fails when there is no linked request', () => {
  const ctx = buildContext(mk({ category: 'event', name: 'Expose' }));
  const r = rule({ predicates: [{ source: 'request', field: 'width', op: 'gt', value: 1 }] });
  assert.equal(evaluateRule(r, ctx), false, 'no request in context → no match, no throw');
});

// --- scripts ---------------------------------------------------------------

test('a script rule sees kind, msg and request', () => {
  const request = mk({ id: 7, name: 'RENDER:AddGlyphs', fields: [f('num-glyphs', '128')] });
  const reply = mk({ id: 8, category: 'reply', dir: 's2c', name: 'RENDER:AddGlyphs·reply', requestId: 7 });
  const ctx = buildContext(reply, (id) => (id === 7 ? request : undefined));

  const r = rule({
    script: "kind === 'reply' && msg.name.includes('AddGlyphs') && request.f['num-glyphs'] > 100",
  });
  assert.equal(evaluateRule(r, ctx), true);
});

test('a script that throws records the error and stops matching, without escaping', () => {
  const ctx = buildContext(mk());
  const r = rule({ script: 'msg.nope.deeper' });
  assert.equal(evaluateRule(r, ctx), false);
  assert.match(r.error!, /undefined/);
});

test('a script that does not compile is reported rather than thrown', () => {
  const ctx = buildContext(mk());
  const r = rule({ script: 'this is ) not javascript' });
  assert.equal(evaluateRule(r, ctx), false);
  assert.ok(r.error, 'the compile error is surfaced on the rule');
});

test('a script wins over predicates when both are set', () => {
  const ctx = buildContext(mk({ fields: [f('width', '800')] }));
  const r = rule({
    script: 'false',
    predicates: [{ source: 'msg', field: 'width', op: 'eq', value: 800 }],
  });
  assert.equal(evaluateRule(r, ctx), false);
});

test('a disabled rule never evaluates', () => {
  const ctx = buildContext(mk());
  assert.equal(evaluateRule(rule({ enabled: false, script: 'true' }), ctx), false);
});

test('describeRule summarises each rule flavour', () => {
  assert.match(describeRule(rule({ name: 'MapWindow' })), /break MapWindow/);
  assert.match(describeRule(rule({ name: 'X', script: 'true' })), /script/);
  assert.match(describeRule(rule({ name: 'X', predicates: [{ source: 'msg', field: 'a', op: 'exists' }] })), /1 condition/);
});

// --- catalog ---------------------------------------------------------------

test('the catalog covers core and extensions, grouped by kind', () => {
  const tree = buildCatalog();
  const core = tree.find((n) => n.label === 'Core protocol')!;
  assert.ok(core, 'core protocol group exists');
  const groups = core.children!.map((c) => c.label.replace(/ \(\d+\)$/, ''));
  assert.deepEqual(groups, ['Requests', 'Responses', 'Events', 'Errors']);
  assert.ok(tree.some((n) => n.label === 'RENDER'));
  assert.ok(tree.some((n) => n.label === 'XInputExtension'));
});

test('a catalog entry carries its parameters with editor-ready types', () => {
  const e = findEntry('request:CreateWindow')!;
  assert.equal(e.kind, 'request');
  const wid = e.params.find((p) => p.name === 'wid')!;
  assert.equal(wid.valueKind, 'resource');
  const cls = e.params.find((p) => p.name === 'class')!;
  assert.ok(cls.choices?.some((c) => c.label === 'InputOnly'), 'enums become choices');
});

test('response entries exist and expose reply parameters', () => {
  const e = findEntry('reply:GetGeometry')!;
  assert.equal(e.kind, 'reply');
  assert.match(e.name, /GetGeometry·reply/);
  assert.ok(e.params.some((p) => p.name === 'width'));
});

test('atom-typed parameters are marked for the atom picker', () => {
  const e = findEntry('request:GetProperty')!;
  assert.equal(e.params.find((p) => p.name === 'property')?.valueKind, 'atom');
});

test('catalog search finds messages by name', () => {
  const hits = searchCatalog('CreateGlyphSet');
  assert.ok(hits.some((h) => h.name === 'RENDER:CreateGlyphSet'));
});
