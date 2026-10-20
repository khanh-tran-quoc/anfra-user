<p align="center"><img src="docs/logo.svg" width="72" height="72" alt=""></p>

<h1 align="center">anfra-user</h1>

<p align="center"><b>Serving the right data.</b><br>
Row-based access for <a href="https://anfra.ai">Anfra</a> repos, set up by your AI agent.<br>
<i>A demo built for fun.</i></p>

<p align="center"><img src="docs/serving.webp" width="360" alt="A server rack with eyelashes, glossy lips and long nails, captioned: this server is serving."></p>

<p align="center">
  <a href="https://khanh-tran-quoc.github.io/anfra-user/">Website</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#reference">Reference</a>
</p>

---

```
you    › Sales reps should log in and see only their own countries' orders.
agent  › Scoping sales by customers.country from each user's country.
         No country: they see nothing. Wrote anfra-user.yml and 4 test users.
$ anfra-user verify
OK: 48 checks, 4 users, 12 queries.
```

## What it does

anfra-user is a small gateway in front of `anfra serve`. It signs people in, works out what each
one may see, and adds that filter to every query **on the server**, where nobody can take it off.

```
browser ──► anfra-user (sign-in, scopes, page queries) ──► anfra serve (127.0.0.1) ──► your database
               └──► users database (Docker): logins, attributes
```

You set up two things:

| | What | Where |
|---|---|---|
| 1 | **Access rules**: a scope says which field limits a user's rows, and which user attribute holds their values | `anfra-user.yml` |
| 2 | **Users**: an email, a password, and the values each person may see | `anfra-user users add` |

Your pages and Anfra Data Apps keep working as they are: anfra-user serves them behind sign-in and
adds each user's scope to their queries.

**Same page, different numbers.** One sales dashboard, one scope on `customers.country`:

| Signed in as | `country` | Sees |
|---|---|---|
| ana@acme.com | `Brazil` | Brazil's orders only |
| ben@acme.com | `USA`, `Canada` | the USA and Canada |
| maria@acme.com | `__ALL__` | every country |
| new@acme.com | not set | "No country assigned to your account yet" |

## Get started

### With your AI agent (recommended)

anfra-user ships a skill that teaches your agent the setup, the safety rules and how to check its
work. In Claude Code:

```
/plugin marketplace add khanh-tran-quoc/anfra-user
/plugin install anfra-user@anfra-user
```

Then ask in plain words: *"Put this repo behind sign-in. Each sales rep sees only their countries'
orders; managers see everything."* It pairs with the
[Anfra skills](https://github.com/holistics/anfra-skills) for modeling, queries and Data Apps.

### By hand

Needs Node 23.6 or later (it runs the TypeScript directly), Docker, and an Anfra repo whose
`anfra serve` works.

```sh
git clone https://github.com/khanh-tran-quoc/anfra-user && cd anfra-user
npm install
docker compose up -d          # the users database, on 127.0.0.1:5433
```

In your Anfra repo, with `anfra serve` running:

```sh
# write anfra-user.yml (see Reference), then:
node ../anfra-user/src/cli.ts check            # does the config hold up against the repo?
node ../anfra-user/src/cli.ts users add ana@acme.com --password 'change-me' --attr country=Brazil
node ../anfra-user/src/cli.ts verify           # the leak test
node ../anfra-user/src/cli.ts serve            # http://127.0.0.1:8080
```

## Safety

- **The browser never chooses AQL.** Named queries live in `anfra-user.yml`; page queries are parsed
  from the page *file* on the server. The browser sends a query's name, never its text.
- **Escapes are refused.** `of_all`, `exclude`, `keep`, `dimensionalize`, `percent_of_total`,
  `running_total_all` and `with_relationships` can drop a filter: `check` stops the server if a
  query, metric or field of a scoped dataset uses one.
- **Empty means nothing.** No attribute, no rows. A dataset without a scope is refused unless public.
- **Every query, every user.** `verify` compares each user's results with the unscoped data and with
  everything outside their scope, so a filter-ignoring metric shows up whatever AQL produced it.

> **Demo-grade sign-in.** Email and password only, no rate limiting, lockout, password reset or MFA.
> Serves on 127.0.0.1. Great for demos and internal tools; not for the internet as is. Details in
> [Security](#security).

---

# Reference

## anfra-user.yml

```yaml
version: 1

auth:
  provider: builtin            # email and password: the only provider for now
  session_ttl: 8h

anfra:
  url: http://127.0.0.1:7878   # or $ANFRA_URL
database:
  url: postgres://anfra_user:anfra_user@127.0.0.1:5433/anfra_user   # or $DATABASE_URL
server:
  port: 8080                   # or $PORT
pages: pages                   # your HTML pages, served behind sign-in

scopes:
  - dataset: sales
    field: customers.country   # the field the filter goes on
    attribute: country         # the user attribute with the allowed values
    default_values: []         # for users without the attribute (this is the default)

public: []                     # datasets anyone signed in may query unscoped

queries:
  - name: by_product
    dataset: sales
    aql: |
      explore {
        dimensions { product: products.category }
        measures { revenue: revenue }
        sorts { revenue desc }
      }
    params:
      filters: [orders.created_at]      # fields the reader may filter on
      sorts: [product, revenue]         # result columns the reader may sort by
      max_page_size: 100
```

Unknown keys are errors, so a typo stops the server instead of being ignored.

### Scopes

For each scope of the dataset a query uses, the gateway takes the user's values for the attribute:

| The user's values | What they see |
|---|---|
| Set, e.g. `90`, `22` | Rows where `field` is one of them |
| Contains `__ALL__` | Every row: this scope adds no filter |
| Set to nothing (`--attr country=`) | Nothing: an empty list is still set, so `default_values` does not apply |
| Not set at all | `default_values`, which is `[]` (nothing) unless you change it |

- Several scopes on one dataset are all applied (ANDed). `__ALL__` lifts only its own scope.
- An empty list never becomes a filter: the gateway answers with no rows and does not call anfra.
- A dataset with no scope is refused unless it is listed in `public`.
- `__ALL__` is reserved: a real value spelled `__ALL__` would mean "everything". `check` warns when
  a `default_values` contains it, since then every user without the attribute sees everything.
- Attributes are read on every request: a change takes effect at once, not at the next sign-in.

### Named queries

The browser never sends AQL. It names a query and may send only what that query's `params` allow:

- `filters`: on the listed fields, with operators that can only narrow (`is`, `is_not`, `between`,
  `contains`, `before`, `after`, `last`…), values as strings.
- `sorts`: by the listed result columns.
- `page` and `page_size`, capped at `max_page_size`.

The user's scope filters are added after the reader's, so a reader filter on the scope field can only
narrow it further. Write every query as an `explore { }` and alias every column.

## Pages written with the Anfra SDK

Instead of listing queries in `anfra-user.yml`, a page can declare them the way an anfra Data App
does. The gateway injects an SDK-compatible `Anfra` into every page it serves:

```html
<script>
  const app = Anfra.createApp();
  const byCountry = app.createQuery('byCountry', {
    dataset: 'sales',
    aql: `explore {
      dimensions { country: customers.country }
      measures { revenue: revenue }
    }`,
  });
  const year = app.createFilter('year', { dataset: 'sales', field: 'orders.created_at' });
  app.mapControl(year, byCountry, { field: 'orders.created_at' });
  app.subscribe(render);
  app.execute();
</script>
```

**How it stays safe.** The gateway reads each `createQuery(...)` from the page *file* (with a real
JavaScript parser) and registers its AQL. At runtime the browser sends only the page and query name,
plus the reader's choices (filter conditions, sorts, cross-filter selection, date grain), which can
only narrow. The AQL the browser holds is never used. So only AQL written in the repo runs, and
`check`/`verify` cover page queries like named ones.

- Serve `pages:` at `/` and, with `apps:`, an anfra repo's Data Apps at `/apps/...`: existing Data
  Apps run behind sign-in unchanged, as long as their queries are fixed text.
- A query's name, `dataset` and `aql` must be fixed text (a `const X = '...'` counts). A template with
  `${...}`, a computed name or spread options can't be registered: `check` names the file and line.
- Edit a page while serving: it is re-read and re-checked; a failing query answers 403 with the
  reason until the file is fixed.
- Supported: `createApp`, `createQuery` (with `pageSize`), `createFilter` (`loadOptions`,
  `setCondition`, `reset`), `createDateDrill`, `mapControl` (with `aggregation`), `mapCrossFilter`,
  `execute`, `refresh`, `subscribe`, `hasChanges`, `selection`, `clearSelection`, and on queries
  `state`, `result`, `error`, `setSort`, `fetchMore`, `select`, `selectedRows`, `abort`, `locate`.
  `Anfra.user`, `Anfra.datasets` and `Anfra.scopes` (the user's resolved scopes) are set.
- Not supported: plugins (`export`, `render`, `lineage`: `Anfra.plugins.has()` is false), queries
  whose AQL is built at runtime, and exact cross-filtering of several rows on several columns (sent
  as one list per column, a superset; the console warns).

Endpoints the SDK uses: `POST /pq` `{ path, name, filters?, sorts?, date_drills?, page?, page_size?, timezone? }`
and `POST /pq/options` `{ dataset, field, search? }` (a filter's values, within the user's scope).

## Commands

```
anfra-user serve      check the config, then serve. Refuses to start if check finds errors.
anfra-user check      the config against the repo (see below)
anfra-user verify     every named query as every user, compared with the unscoped result
anfra-user users list | add <email> --password <pw> [--name] [--attr k=v ...] | set <email> --attr k=v ... | remove <email>
```

All take `--config <path>` (default `./anfra-user.yml`, or `$ANFRA_USER_CONFIG`).

**`check`** fails when:

- a scope's field isn't in its dataset, or a query can't reach it (no relationship path);
- a query, or a metric or field of a scoped dataset, uses an AQL function that changes a metric's
  context and can drop the scope filter: `of_all`/`exclude`/`exclude_grains`, `keep`/`keep_grains`,
  `dimensionalize`, `percent_of_total`, `running_total_all`, `with_relationships`;
- a query doesn't validate, isn't an `explore { }`, or its `params` name fields or columns it doesn't have.

**`verify`** runs each query as each user through the same code as the server, and fails when:

- a user with no access gets rows;
- a scope field reaches values outside the user's;
- an `__ALL__` user's result differs from the unscoped one;
- a measure is unchanged by the scope on rows that also draw on others' data (rows the same query
  returns for everything outside the user's scope): what a filter-ignoring metric looks like,
  whatever AQL produced it. Rows made only of the user's own data, like their own country's row,
  are rightly unchanged and not compared.

Add a few test users covering each case (one value, several, `__ALL__`, none) and run `verify` in CI.

## HTTP API

| Endpoint | Does |
|---|---|
| `GET /login` | the sign-in page |
| `POST /auth/login` | `{ email, password }` → sets the `au_session` cookie (HttpOnly, SameSite=Lax) |
| `POST /auth/logout` | ends the session |
| `GET /me` | `{ email, name, scopes: { country: ['Brazil'] \| '__ALL__' } }`: the caller's own |
| `GET /queries` | the named queries and their `params` |
| `POST /q/<name>` | `{ filters?, sorts?, page?, page_size? }` → `{ columns, rows, hasMore, page }` |
| `GET /<path>` | your `pages/`, behind sign-in (`/my-sales` → `pages/my-sales.html`) |

POSTs take JSON only, which also blocks cross-site form posts. Numbers in `rows` arrive as strings
with every digit, as anfra sends them.

From a page, use the client:

```html
<script src="/anfra-user.js"></script>
<script>
  const au = AnfraUser.connect();
  const me = await au.me();
  const { rows } = await au.query('by_product', {
    filters: [{ field: 'orders.created_at', operator: 'between', values: ['2024-01-01', '2024-12-31'] }],
  });
</script>
```

## Security

What it does:

- Scopes are applied on the server, to queries written in `anfra-user.yml`. The browser can't send
  AQL, SQL, or filters outside a query's `params`.
- Passwords are bcrypt-hashed. Sessions are random 256-bit ids in an HttpOnly cookie, kept in the
  database, and expire (`session_ttl`). Set `SECURE_COOKIES=1` when served over HTTPS.
- Every sign-in and query is logged to stdout as JSON: who, which query, which scope.

What it doesn't, and what you must do:

- **Keep anfra unreachable.** `anfra serve` has no sign-in: anyone who can reach it bypasses this
  gateway, including its `/mcp` and `/apps`. Keep it on 127.0.0.1 or a private network.
- **Mind the grain.** A scope filters rows; it can't fix a measure that sums a table "above" the
  scope field. In a marketplace scoped by vendor, an order can hold several vendors' items:
  `sum(orders.total)` scoped to one vendor still adds the others' items. Compute measures at the
  scope's grain (order items),
  and leave the coarser totals out of scoped datasets. `verify` can't always catch this.
- **Only admins set attributes.** Whoever can write `user_attributes` can grant `__ALL__`.
- **Demo sign-in.** No rate limiting, lockout, password reset or MFA; served on 127.0.0.1.

## Gotcha: time zones

anfra casts datetime fields to `timestamptz`, which Postgres reads in the database session's time
zone. If your timestamps are stored without a zone and the server isn't on UTC, midnight dates move
to the day before and drop out of their year or month. Read such a column as UTC in its dimension:

```aml
definition: @sql ({{ #SOURCE.created_at }} AT TIME ZONE 'UTC');;
```

## Development

```sh
npm test        # scopes, config, reader input, check's AQL scan, page query extraction
```

`src/scopes.ts` is the security core: keep it small and pure, and test every change to it.

## License

MIT
