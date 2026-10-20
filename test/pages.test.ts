import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractQueries, normalizePagePath } from '../src/pages.ts';
import { parseReaderInput } from '../src/query.ts';

const page = (script: string, attrs = '') => `<!doctype html><html><head><title>t</title></head><body>
<!-- the last <script> wires the SDK -->
<script${attrs}>${script}</script></body></html>`;

test('reads createQuery calls with fixed text, const datasets and pageSize', () => {
  const { queries, errors } = extractQueries(page(`
    const DATASET = 'music_sales';
    const app = Anfra.createApp();
    const a = app.createQuery('kpis', { dataset: DATASET, aql: \`explore { measures { r: revenue } }\` });
    const b = app.createQuery("top", { dataset: 'music_sales', pageSize: 25, aql: 'explore { dimensions { t: track.name } }' });
  `), 'my-page');
  assert.deepEqual(errors, []);
  assert.deepEqual(queries.map((q) => [q.name, q.dataset, q.params.max_page_size, q.params.open]), [
    ['kpis', 'music_sales', 10000, true],
    ['top', 'music_sales', 25, true],
  ]);
  assert.equal(queries[0].aql, 'explore { measures { r: revenue } }');
  assert.equal(queries[0].line, 6);
});

test('refuses AQL the file does not fix', () => {
  const { queries, errors } = extractQueries(page(`
    const g = pick();
    app.createQuery('a', { dataset: 'd', aql: \`explore { dimensions { x: \${g} } }\` });
    app.createQuery('b', { dataset: 'd', aql: buildAql() });
    app.createQuery(someName, { dataset: 'd', aql: 'explore {}' });
    app.createQuery('c', { ...options });
    app.createQuery('e', { dataset: ds, aql: 'explore {}' });
    app.createQuery('f', { dataset: 'd', aql: 'explore {}', extra: 1 });
  `), 'p');
  assert.equal(queries.length, 0);
  assert.equal(errors.length, 6);
  assert.match(errors[0], /aql must be fixed text/);
  assert.match(errors[1], /aql must be fixed text/);
  assert.match(errors[2], /name must be fixed text/);
  assert.match(errors[3], /no spread/);
  assert.match(errors[4], /dataset must be fixed text/);
  assert.match(errors[5], /unsupported option extra/);
});

test('a duplicate name is an error', () => {
  const { errors } = extractQueries(page(`
    app.createQuery('a', { dataset: 'd', aql: 'explore {}' });
    app.createQuery('a', { dataset: 'd', aql: 'explore { measures { x: y } }' });
  `), 'p');
  assert.match(errors[0], /used twice/);
});

test('skips external, JSON and commented-out scripts', () => {
  const html = `<script src="/x.js"></script>
    <script type="application/json">{"createQuery": "app.createQuery('x', {})"}</script>
    <!-- <script>app.createQuery('y', { dataset: 'd', aql: 'explore {}' })</script> -->`;
  assert.deepEqual(extractQueries(html, 'p'), { queries: [], errors: [] });
});

test('page paths normalize to the registry key', () => {
  assert.equal(normalizePagePath('/my-sales'), 'my-sales');
  assert.equal(normalizePagePath('/apps/music/overview.html'), 'apps/music/overview');
  assert.equal(normalizePagePath('/apps/music/'), 'apps/music');
  assert.equal(normalizePagePath('/index'), '');
});

test('page queries take any field and column, but only names and narrowing operators', () => {
  const [q] = extractQueries(page(`app.createQuery('a', { dataset: 'd', aql: 'explore {}' })`), 'p').queries;
  const parsed = parseReaderInput(q, {
    filters: [
      { field: 'invoice.billing_country', operator: 'is', values: ['USA'] },
      { field: 'revenue', operator: 'greater_than', values: ['10'] },
      { field: 'invoice_line.quantity', operator: 'greater_than', values: ['1'], aggregation: 'sum' },
    ],
    sorts: [{ field: 'revenue', direction: 'desc' }],
    date_drills: [{ field: 'invoice.invoice_date', grain: 'quarter' }],
    timezone: 'Asia/Singapore',
  });
  assert.equal(parsed.filters.length, 3);
  assert.deepEqual(parsed.dateDrills, [{ field: 'invoice.invoice_date', grain: 'quarter' }]);
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'revenue | of_all(artist)', operator: 'is', values: ['1'] }] }), /Can't filter/);
  assert.throws(() => parseReaderInput(q, { sorts: [{ field: 'x desc, y', direction: 'asc' }] }), /Can't sort/);
  assert.throws(() => parseReaderInput(q, { date_drills: [{ field: 'a.b', grain: 'century' }] }), /isn't a grain/);
  assert.throws(() => parseReaderInput(q, { timezone: "UTC'; drop" }), /IANA/);
  assert.throws(() => parseReaderInput(q, { filters: [{ field: 'a.b', operator: 'is', values: ['1'], aggregation: 'of_all' }] }), /isn't supported/);
});
