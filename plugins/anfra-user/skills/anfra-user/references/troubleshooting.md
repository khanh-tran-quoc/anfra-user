# What check and verify report, and what to do

## check

| Message | Means | Fix |
|---|---|---|
| `scope on X: field a.b isn't in the dataset` | typo, or the model isn't in the dataset | fix the field, or add the model and relationship (`aml` skill) |
| `… uses of_all, which can ignore the scope filter` | a context-changing function in a query, metric or field of a scoped dataset | rewrite without it; for "share of total", compute the total in another query only an `__ALL__` user can see, or drop it |
| `fails with its scope applied: …` | anfra can't reach the scope field from that query (no relationship path), or the AQL is wrong with the filter | add the relationship, or query through a model that reaches it |
| `dataset X has no scope and isn't listed in public` | every queried dataset needs one | add a scope; use `public` only for data everyone may see |
| `aql must be fixed text (no ${...})` | a page builds AQL at runtime | write one fixed query per shape; pass choices as filters |
| `write the query as an explore { }` | pipe-style AQL ignores filters and sorts | wrap it in `explore { }` and alias every column |
| `params.sorts names x, which isn't a result column` | a named query's sort list doesn't match its aliases | use the aliases |

## verify

| Result | Means |
|---|---|
| `PASS … every measure narrowed by the scope` | measures changed where other users' data was involved |
| `PASS … each made only of in-scope data` | rows contain only the user's data (e.g. one row per country, grouped by the scope field): unchanged is correct |
| `PASS … no access: 0 rows, anfra not called` | empty scope works |
| `PASS … __ALL__ on x: same N rows as unscoped` | lifted scope works |
| `warn … scope covers every value` | this user's values cover all data: nothing to compare. Add a narrower test user |
| `FAIL … unchanged by the scope on rows that include others' data` | **a leak**: the measure ignores the scope (context-changing function, or a measure above the scope's grain). Fix the AQL or the model |
| `FAIL … reaches values outside the scope` | the scope filter isn't applied on that field. Report it: likely an anfra issue |
| `FAIL … no access, yet N rows came back` | gateway bug. Report it |

## Other problems

- **Numbers move between years or months**: anfra casts datetimes to `timestamptz`, read in the
  database session's time zone. If timestamps are stored without a zone and the database isn't on
  UTC, read the column as UTC in its dimension:
  `definition: @sql ({{ #SOURCE.created_at }} AT TIME ZONE 'UTC');;`
- **`Can't reach anfra`**: start `anfra serve` in the repo; check `anfra.url`.
- **Can't connect to the users database**: `docker compose up -d` in the anfra-user folder.
- **A data source error from anfra (`process data source configs`)**: in `.anfra/data_sources.yml`,
  quote numeric passwords (`password: "1234"`).
- **An alias equal to a model name** (`region: region.name`) breaks any filter on that model: alias
  it `region_name`.
