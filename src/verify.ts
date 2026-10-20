// `anfra-user verify`: the leak test. Runs every named query as every user, through the
// same code path the server uses, and compares against what anfra returns without a scope.
import type { Config, NamedQuery } from './config.ts';
import { ALL, scopesFor } from './config.ts';
import { runQuery, type QueryResult } from './anfra.ts';
import { runNamedQuery } from './query.ts';
import type { Attributes } from './scopes.ts';

export type VerifyUser = { email: string; attrs: Attributes };
export type Outcome = { user: string; query: string; status: 'pass' | 'fail' | 'warn'; detail: string };

const keyOf = (row: Record<string, unknown>, dims: string[]) => JSON.stringify(dims.map((d) => row[d]));

// Measure columns whose value is the same with and without the scope, on every row that also
// draws on data outside the scope (a key the complement query returns too). A row made only of
// the user's own data, e.g. their own country's row, is rightly the same: it is not compared.
function unchangedMeasures(scoped: QueryResult, unscoped: QueryResult, complement: QueryResult): { columns: string[]; compared: number } {
  const dims = scoped.columns.filter((c) => !c.isMeasure).map((c) => c.name);
  const measures = scoped.columns.filter((c) => c.isMeasure).map((c) => c.name);
  const byKey = new Map(unscoped.rows.map((r) => [keyOf(r, dims), r]));
  const outside = new Set(complement.rows.map((r) => keyOf(r, dims)));
  const shared = scoped.rows.filter((row) => outside.has(keyOf(row, dims)) && byKey.has(keyOf(row, dims)));
  const columns = measures.filter((m) => shared.length > 0 && shared.every((row) => String(byKey.get(keyOf(row, dims))![m]) === String(row[m])));
  return { columns, compared: shared.length };
}

export async function verify(config: Config, users: VerifyUser[], pageQueries: (NamedQuery & { page: string })[] = []): Promise<Outcome[]> {
  const out: Outcome[] = [];
  const unscopedCache = new Map<string, QueryResult>();
  const allValuesCache = new Map<string, Set<string>>();

  // Every value of a scope field in the dataset, to tell whether a user's scope restricts anything.
  async function allValues(dataset: string, field: string) {
    const key = `${dataset}|${field}`;
    if (!allValuesCache.has(key)) {
      const r = await runQuery(config.anfra.url, { dataset, aql: `explore { dimensions { v: ${field} } }` });
      allValuesCache.set(key, new Set(r.rows.map((row) => String(row.v))));
    }
    return allValuesCache.get(key)!;
  }

  for (const q of [...config.queries, ...pageQueries]) {
    const label = 'page' in q ? `${q.page}#${q.name}` : q.name;
    if (!unscopedCache.has(label)) {
      unscopedCache.set(label, await runQuery(config.anfra.url, { dataset: q.dataset, aql: q.aql, pageSize: q.params.max_page_size }));
    }
    const unscoped = unscopedCache.get(label)!;

    for (const user of users) {
      const record = (status: Outcome['status'], detail: string) => out.push({ user: user.email, query: label, status, detail });
      try {
        const result = await runNamedQuery(config, q, user.attrs, {});

        if (result.scope.kind === 'none') {
          if (result.rows.length === 0) record('pass', 'no access: 0 rows, anfra not called');
          else record('fail', `no access, yet ${result.rows.length} rows came back`);
          continue;
        }

        // Every value of each scope field this user can reach must be one of theirs.
        let restricts = false;
        for (const f of result.scope.filters) {
          const probe = await runQuery(config.anfra.url, {
            dataset: q.dataset, aql: `explore { dimensions { v: ${f.field} } }`, filters: result.scope.filters,
          });
          const outside = probe.rows.map((r) => String(r.v)).filter((v) => !f.values.includes(v));
          if (outside.length) {
            record('fail', `${f.field} reaches values outside the scope: ${outside.slice(0, 5).join(', ')}`);
            continue;
          }
          const every = await allValues(q.dataset, f.field);
          if ([...every].some((v) => !f.values.includes(v))) restricts = true;
        }

        if (result.scope.filters.length === 0) {
          // Every scope lifted with __ALL__ (or a public dataset): the user sees what anfra does unscoped.
          const same = JSON.stringify(result.rows) === JSON.stringify(unscoped.rows);
          const why = scopesFor(config, q.dataset).length ? `${ALL} on ${result.scope.lifted.join(', ')}` : 'public dataset';
          record(same ? 'pass' : 'fail', same ? `${why}: same ${result.rows.length} rows as unscoped` : `${why}, yet the result differs from unscoped`);
          continue;
        }

        if (!restricts) {
          record('warn', `scope covers every value of ${result.scope.filters.map((f) => f.field).join(', ')}: nothing to compare against`);
          continue;
        }
        // The same query over everything outside the user's scope.
        const complement = await runQuery(config.anfra.url, {
          dataset: q.dataset, aql: q.aql, pageSize: q.params.max_page_size,
          filters: result.scope.filters.map((f) => ({ ...f, operator: 'is_not' })),
        });
        const { columns: unchanged, compared } = unchangedMeasures(result, unscoped, complement);
        const hasMeasures = result.columns.some((c) => c.isMeasure);
        if (unchanged.length) {
          record('fail', `${unchanged.join(', ')} unchanged by the scope on rows that include others' data: likely ignores the scope filter`);
        } else if (!hasMeasures) {
          record('pass', `${result.rows.length} rows, only in-scope values`);
        } else if (compared === 0) {
          record('pass', `${result.rows.length} rows, each made only of in-scope data`);
        } else {
          record('pass', `${result.rows.length} rows, every measure narrowed by the scope`);
        }
      } catch (err) {
        record('fail', (err as Error).message);
      }
    }
  }
  return out;
}
