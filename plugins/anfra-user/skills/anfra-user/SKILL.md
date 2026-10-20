---
name: anfra-user
description: Put an Anfra repo behind sign-in with per-user data scopes using the anfra-user gateway, so each user sees only their own rows (their country, their vendor, their accounts). Use when the user wants logins, "users only see their data", row-level access, multi-tenant pages or a customer-facing portal over an Anfra repo; to add a scope, a user or a page behind sign-in; or to run anfra-user check or verify.
---

# Sign-in and per-user scopes with anfra-user

anfra-user is a gateway in front of `anfra serve`. Users sign in with email and password; each has
**attributes** (`country = Brazil`, `vendor_id = 42`). A **scope** turns one attribute into a filter
on one field, and the gateway adds it to every query that user runs, on the server.

```
browser ─► anfra-user :8080 (sign-in, scopes) ─► anfra serve 127.0.0.1:7878 ─► database
               └─► users database (Docker, 127.0.0.1:5433)
```

References, read when a step needs them:

- [references/config.md](references/config.md): every key of `anfra-user.yml`, and scope resolution.
- [references/pages.md](references/pages.md): pages behind sign-in, with the Anfra SDK or `anfra-user.js`.
- [references/troubleshooting.md](references/troubleshooting.md): what `check` and `verify` report, and fixes.

This skill builds on the anfra skills: model with `aml`, write queries with `write-aql`, build pages
with `build-data-app`. Use them for those parts.

## Rules that keep data from leaking

Follow these every time. Each one closes a real leak.

1. **The browser never chooses AQL.** Queries are fixed text in `anfra-user.yml` or in a page's
   `createQuery(...)`. Never build AQL from user input, never `${...}` inside a page query's `aql`,
   never proxy anfra's `/api` to the browser.
2. **No context-changing functions in a scoped dataset**: `of_all`, `exclude`/`exclude_grains`,
   `keep`/`keep_grains`, `dimensionalize`, `percent_of_total`, `running_total_all`,
   `with_relationships`. They drop the scope filter (`revenue | of_all(customers)` returns every
   country's revenue to every user). `check` refuses them; don't work around it.
3. **Measure at the scope's grain.** A scope filters rows; it can't fix a measure that sums a table
   above the scope field. In a marketplace scoped by vendor, an order can hold several vendors'
   items: summing `orders.total` still adds the other vendors' items. Sum the line table
   (`order_items.price * order_items.quantity`) and
   leave the coarser totals out of scoped datasets.
4. **anfra stays unreachable.** `anfra serve` has no sign-in. Keep it on 127.0.0.1 (the default);
   never pass `--addr 0.0.0.0` on a shared host.
5. **Empty means nothing.** A user without the attribute gets `default_values` (default `[]`), and
   `[]` returns no rows. Only set `default_values: ['__ALL__']` if the user explicitly wants every
   unassigned user to see everything, and say what that means.
6. **Only verified changes ship.** After any change to a scope, query, page or dataset, run
   `check` and `verify` and read the output before saying it works.

## 1. Learn the repo and the request

```sh
anfra status                     # is anfra serve running for this repo?
anfra show                       # datasets, fields, metrics
ls anfra-user.yml pages apps 2>/dev/null
```

Restate the request as an access rule: "a sales rep sees orders from their own customers' countries;
managers see everything". Then decide, for each dataset users will query:

- **The scope field**: the `model.field` that identifies a user's rows (`customer.country`,
  `vendors.id`, `accounts.id`). It must be reachable from every model the pages use (a relationship path).
- **The attribute** holding the allowed values, and what a user without it sees (`default_values`).
- **Which measures are safe at that grain** (rule 3). Check the dataset's metrics with `anfra show`
  and the `*.dataset.aml`; propose line-level metrics with the `aml` skill where needed.

Ask only what changes the numbers or who sees them, with your recommended answer. Get a yes on the
scopes before writing them.

## 2. Install the gateway (once per machine)

anfra-user needs Node 23.6+ and Docker. If there's no checkout yet:

```sh
git clone https://github.com/khanh-tran-quoc/anfra-user ../anfra-user
cd ../anfra-user && npm install && docker compose up -d     # users database on 127.0.0.1:5433
```

From the anfra repo, the CLI is `node ../anfra-user/src/cli.ts <command>` (below: `anfra-user`).
Set `ANFRA_USER_DIR` if it lives elsewhere.

## 3. Write anfra-user.yml

In the anfra repo's root. Minimal:

```yaml
version: 1
auth: { provider: builtin, session_ttl: 8h }
pages: pages            # your pages, served behind sign-in at /
apps: apps              # the repo's Data Apps, behind sign-in at /apps/...
scopes:
  - dataset: sales
    field: customer.country
    attribute: country
    default_values: []
public: []              # datasets anyone signed in may query unscoped: rarely needed
queries: []             # named queries; pages can declare their own instead (step 4)
```

Every dataset a page queries must have a scope or be listed in `public`. Full reference:
[references/config.md](references/config.md).

## 4. Pages

Two ways, both behind sign-in. Prefer the first.

- **Anfra SDK pages**: write the page exactly like a Data App (`Anfra.createApp()`,
  `app.createQuery(...)`, filters, `mapControl`, cross-filters, date drills). The gateway reads each
  `createQuery` from the file and runs that AQL with the scope added. Existing Data Apps in `apps/`
  work unchanged when their queries are fixed text. Follow the `build-data-app` skill for the page
  itself; then read [references/pages.md](references/pages.md) for what differs.
- **Named queries**: list queries in `anfra-user.yml` and call them with `anfra-user.js`
  (`au.query('name', { filters })`). Use when a page shouldn't hold AQL.

Show who is signed in and what they're scoped to (`Anfra.user`, `Anfra.scopes`), and give a user
with no access a clear empty state ("No country assigned to your account yet"), never a bare zero.

## 5. Users

```sh
anfra-user users add ana@acme.com --password '<pw>' --name "Ana" --attr country=Brazil --attr country=Chile
anfra-user users add boss@acme.com --password '<pw>' --attr country=__ALL__
anfra-user users set ana@acme.com --attr country=Peru      # replaces that attribute's values
anfra-user users list
```

Never invent real people's passwords or put real passwords in files. For a demo, create clearly fake
accounts (`*@demo.local`) in a seed script and say they are demo-only. Always create test users that
cover: one value, several values, `__ALL__`, and no attribute.

## 6. Check, verify, serve

```sh
anfra-user check     # config vs repo: scope fields, unsafe AQL, each query validated and probed
anfra-user verify    # every query as every user, against the unscoped and out-of-scope results
anfra-user serve     # refuses to start while check has errors; http://127.0.0.1:8080
```

`verify` must end with `OK`. A `FAIL` that says a measure is "unchanged by the scope on rows that
include others' data" is a leak (rules 2 and 3): fix the query or the model, don't silence it.
Explanations: [references/troubleshooting.md](references/troubleshooting.md).

Then sign in as at least two different test users in a browser and compare: the same page must show
each user only their own numbers. Check one number per user against a direct SQL query on the source.
If you can't drive a browser, say so and ask the user to do it.

## 7. Hand over

Tell the user: the URL, the test accounts and what each should see, the scopes in plain words
("a user sees orders from their countries only; no country, nothing"), what you verified, and the
limits: demo-grade sign-in (no rate limiting, lockout or reset), served on 127.0.0.1, anfra must stay
unreachable.
