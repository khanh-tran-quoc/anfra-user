import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';
import { describeScopes, resolveScopes } from '../src/scopes.ts';
import { RequestError, parseReaderInput } from '../src/query.ts';
import { escapingFunctionsIn } from '../src/check.ts';

const base = {
  version: 1,
  scopes: [
    { dataset: 'sales', field: 'artist.artist_id', attribute: 'artist_id' },
    { dataset: 'sales', field: 'invoice.billing_country', attribute: 'country', default_values: ['__ALL__'] },
    { dataset: 'catalog', field: 'artist.artist_id', attribute: 'artist_id', default_values: ['90'] },
  ],
  public: ['demo'],
  queries: [
    { name: 'kpis', dataset: 'sales', aql: 'explore { measures { revenue: revenue } }',
      params: { filters: ['invoice.billing_country'], sorts: ['revenue'], max_page_size: 50 } },
  ],
};
const config = parseConfig(base, '/tmp', {});
const attrs = (o: Record<string, string[]>) => new Map(Object.entries(o));

test('a user with the attribute gets a filter on its values', () => {
  const r = resolveScopes(config, 'sales', attrs({ artist_id: ['90', '22'] }));
  assert.deepEqual(r, {
    kind: 'filters',
    filters: [{ field: 'artist.artist_id', operator: 'is', values: ['90', '22'] }],
    lifted: ['country'],                                   // country defaults to __ALL__
  });
});

test('default_values defaults to [], and [] means no rows, not no filter', () => {
  assert.deepEqual(resolveScopes(config, 'sales', attrs({})), { kind: 'none' });
});

test('an attribute set to an empty list is set: the default does not apply', () => {
  assert.deepEqual(resolveScopes(config, 'catalog', attrs({ artist_id: [] })), { kind: 'none' });
  assert.deepEqual(resolveScopes(config, 'catalog', attrs({})), {
    kind: 'filters', filters: [{ field: 'artist.artist_id', operator: 'is', values: ['90'] }], lifted: [],
  });
});

test('__ALL__ lifts only its own scope, even mixed with other values', () => {
  const r = resolveScopes(config, 'sales', attrs({ artist_id: ['__ALL__', '90'], country: ['USA'] }));
  assert.deepEqual(r, {
    kind: 'filters',
    filters: [{ field: 'invoice.billing_country', operator: 'is', values: ['USA'] }],
    lifted: ['artist_id'],
  });
});

test('several scopes are all applied (anfra ANDs them)', () => {
  const r = resolveScopes(config, 'sales', attrs({ artist_id: ['90'], country: ['USA', 'Canada'] }));
  assert.equal(r.kind, 'filters');
  assert.equal(r.kind === 'filters' && r.filters.length, 2);
});

test('one empty scope empties the whole dataset', () => {
  assert.deepEqual(resolveScopes(config, 'sales', attrs({ artist_id: ['90'], country: [] })), { kind: 'none' });
});

test('a dataset with no scope is refused unless public', () => {
  assert.deepEqual(resolveScopes(config, 'other', attrs({ artist_id: ['__ALL__'] })), { kind: 'none' });
  assert.deepEqual(resolveScopes(config, 'demo', attrs({})), { kind: 'filters', filters: [], lifted: [] });
});

test('duplicate values are sent once', () => {
  const r = resolveScopes(config, 'catalog', attrs({ artist_id: ['90', '90'] }));
  assert.deepEqual(r.kind === 'filters' && r.filters[0].values, ['90']);
});

test('/me shows the caller\'s resolved values', () => {
  assert.deepEqual(describeScopes(config, attrs({ artist_id: ['90'] })), { artist_id: ['90'], country: '__ALL__' });
});

test('config: unknown keys, missing scopes and bad fields are errors', () => {
  assert.throws(() => parseConfig({ ...base, scope: [] }, '/tmp', {}), /unknown key "scope"/);
  assert.throws(() => parseConfig({ ...base, queries: [{ name: 'x', dataset: 'nowhere', aql: 'explore {}' }] }, '/tmp', {}), /no scope and is not listed in public/);
  assert.throws(() => parseConfig({ ...base, scopes: [{ dataset: 'sales', field: 'artist_id', attribute: 'a' }] }, '/tmp', {}), /must be model.field/);
  assert.throws(() => parseConfig({ ...base, public: ['sales'] }, '/tmp', {}), /either scoped or public/);
});

test('config: __ALL__ in default_values is a warning', () => {
  assert.ok(config.warnings.some((w) => w.includes('__ALL__')));
});

test('reader input: only allowed fields, operators and sorts', () => {
  const q = config.queries[0];
  assert.doesNotThrow(() => parseReaderInput(q, { filters: [{ field: 'invoice.billing_country', operator: 'is', values: ['USA'] }] }));
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'artist.artist_id', operator: 'is', values: ['1'] }] }), RequestError);
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'invoice.billing_country', operator: 'matches_user_attribute', values: ['x'] }] }), RequestError);
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'invoice.billing_country', operator: 'is', values: [] }] }), /no values/);
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'invoice.billing_country', operator: 'is', values: [1] }] }), /as a string/);
  assert.throws(() => parseReaderInput(q, { sorts: [{ field: 'nope', direction: 'asc' }] }), RequestError);
  assert.throws(() => parseReaderInput(q, { aql: 'explore {}' } as any), RequestError, 'no aql key accepted');
});

test('reader input: page size is capped', () => {
  assert.equal(parseReaderInput(config.queries[0], { page_size: 10000 }).pageSize, 50);
});

test('check: finds filter-escaping AQL', () => {
  assert.deepEqual(escapingFunctionsIn('revenue | of_all(artist)'), ['of_all']);
  assert.deepEqual(escapingFunctionsIn('sum(x) | keep_grains(a.b) | exclude(c.d)').sort(), ['exclude', 'keep_grains']);
  assert.deepEqual(escapingFunctionsIn('running_total!(x)'), ['running_total!']);
  assert.deepEqual(escapingFunctionsIn('sum(invoice_line.quantity) | where(genre.name == "Rock")'), []);
});
