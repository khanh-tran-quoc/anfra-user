# anfra-user.yml reference

Lives in the anfra repo's root. Unknown keys are errors: a typo stops the server instead of being
ignored. Paths are relative to the file.

```yaml
version: 1                       # required

auth:
  provider: builtin              # email and password: the only provider
  session_ttl: 8h                # 30m, 8h, 7d…

anfra:
  url: http://127.0.0.1:7878     # $ANFRA_URL overrides; a non-loopback address is a warning
database:
  url: postgres://anfra_user:anfra_user@127.0.0.1:5433/anfra_user   # $DATABASE_URL overrides
server:
  port: 8080                     # $PORT overrides; always binds 127.0.0.1

pages: pages                     # served behind sign-in at /       (/x → pages/x.html)
apps: apps                       # served behind sign-in at /apps/  (anfra Data Apps)

scopes:
  - dataset: sales               # dataset fqn, as `anfra show` lists it
    field: customers.country     # model.field the filter goes on
    attribute: country           # user attribute with the allowed values
    default_values: []           # values for users without the attribute (default [])

public: []                       # datasets queried unscoped by anyone signed in

queries:                         # named queries, for anfra-user.js pages
  - name: by_product             # letters, digits, _ and -
    dataset: sales
    aql: |                       # an explore { }, every column aliased
      explore {
        dimensions { product: products.category }
        measures { revenue: revenue }
        sorts { revenue desc }
      }
    params:
      filters: [orders.created_at]      # model.field the reader may filter on
      sorts: [product, revenue]         # result columns the reader may sort by
      max_page_size: 100                # 1–10000, default 500
```

## Scope resolution

For each scope on the queried dataset, the user's values are their attribute if set (even to an
empty list), otherwise `default_values`:

| Values | Effect |
|---|---|
| `['USA', 'Canada']` | filter `field is ['USA', 'Canada']` |
| contain `__ALL__` | this scope adds no filter (others still apply) |
| `[]` | no rows: anfra isn't called |

- Several scopes on one dataset are ANDed; one empty scope empties the dataset.
- A dataset with no scope is refused unless listed in `public`; a dataset can't be both.
- Values are sent as strings; anfra compares them with the field's type.
- Attributes are read on every request: changes apply at once.
- `__ALL__` is reserved. `check` warns when a `default_values` contains it.

## Reader input

What a page may send with a query: `filters` (`{ field, operator, values, modifier?, aggregation? }`),
`sorts` (`{ field, direction }`), `page`, `page_size`, `date_drills` (`{ field, grain }`, page
queries only), `timezone`. Operators can only narrow: `is`, `is_not`, `contains`,
`does_not_contain`, `starts_with`, `ends_with`, `greater_than`, `less_than`, `between`, `before`,
`after`, `last`, `next`, `is_null`, `not_null`, `is_true`, `is_false`. Values are strings. The
user's scope filters are added after the reader's.

Named queries accept only the `params` fields and sorts; page queries accept any `model.field` or
metric name (names only, never expressions) and any result column.
