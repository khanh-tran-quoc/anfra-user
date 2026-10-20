# Pages behind sign-in

The gateway serves `pages/` at `/` and `apps/` at `/apps/`, only to signed-in users, and injects
two scripts at the top of every HTML page: the user's context and `/anfra-user-sdk.js`.

## Anfra SDK pages (preferred)

Write the page as an anfra Data App (follow the `build-data-app` skill: its API, states, design).
The injected SDK provides `Anfra.createApp()` with the same app, query, filter, date drill and
cross-filter API. What differs:

**Queries are read from the file.** The gateway parses each `<script>` and registers every
`app.createQuery(name, { dataset, aql, pageSize })`. At runtime the browser sends only the page and
query name plus the reader's input; the gateway runs the registered AQL with the scope added.
For a query to register:

- `name`, `dataset` and `aql` are fixed text: string literals, template literals without `${...}`,
  or a `const X = '...'` in the same script.
- Options are written in place: no spread, no computed keys, only `dataset`, `aql`, `pageSize`.
- Names are unique per page.

A query that doesn't register fails at runtime with a QueryError saying so, and `check` lists it
with its file and line. Queries built at runtime (a query builder) aren't supported: use one fixed
query per shape.

**Context the page gets:**

- `Anfra.user`: `{ id, name, email, role: 'viewer', timezone, permissions }` (no SQL view, no export).
- `Anfra.scopes`: the user's resolved values, e.g. `{ country: ['Brazil'] }` or `{ country: '__ALL__' }`.
- `Anfra.datasets`: descriptors of the scoped and public datasets.
- `Anfra.plugins.has(name)`: `false` for `export`, `render`, `lineage`. Hide what they'd offer.

**Filters**: `createFilter({ dataset, field })` then `loadOptions(search?)` returns only values within
the user's scope. Numbers in conditions go as strings.

**Cross-filtering**: a selection becomes filters on the selected dimension columns' fields. One row,
or one column: exact. Several rows on several columns: one `is` list per column (a superset), with a
console warning; avoid it, or select with `{ fields: ['one_column'] }`. A date column needs a date
drill mapped on its field to be cross-filtered.

**Results**: `{ columns, rows, meta }` like the SDK; numbers arrive as strings. `columns[i].field` is
a dimension's `model.field`. There is no `debug.executedAql` (the browser doesn't see the AQL run).

**Editing**: the gateway re-reads a page when its file changes and re-checks it; a failing query is
blocked (403, with the reason) until fixed. No restart needed.

## Named-query pages

```html
<script src="/anfra-user.js"></script>
<script>
  const au = AnfraUser.connect();
  const me = await au.me();                        // { email, name, scopes }
  const res = await au.query('by_product', {       // { columns, rows, hasMore, page }
    filters: [{ field: 'orders.created_at', operator: 'between', values: ['2024-01-01', '2024-12-31'] }],
    sorts: [{ field: 'revenue', direction: 'desc' }],
  });
</script>
```

A 401 redirects to `/login`. Sign out with `au.logout()` (SDK pages: `POST /auth/logout` with a JSON body).

## Both

- Render the four states: loading, error (`error.message`), no rows ("No orders for these filters"),
  success; and the no-access state for a user whose scope is empty.
- Say on the page what the user is scoped to ("Signed in as Ana · Brazil").
- Put the definitions a reader needs on the page: what revenue counts, which date is used.
