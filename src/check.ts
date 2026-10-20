// `anfra-user check`: refuse to serve what can't be shown to respect the scopes.
// Covers the named queries in anfra-user.yml and the queries pages declare (pages.ts).
import type { Config, NamedQuery } from './config.ts';
import { scopesFor } from './config.ts';
import { AnfraError, runQuery, showDataset, validateQuery, type DatasetShape } from './anfra.ts';
import type { PageQuery, PageRegistry } from './pages.ts';

// AQL functions that change a metric's context: they can drop the filters a scope adds,
// or move the join path the scope filter travels on. See the AQL reference: metric functions.
export const ESCAPING_FUNCTIONS = [
  'of_all', 'exclude', 'exclude_grains', 'keep', 'keep_grains', 'dimensionalize',
  'percent_of_total', 'running_total_all', 'with_relationships',
];
const ESCAPE_RE = new RegExp(`\\b(${ESCAPING_FUNCTIONS.join('|')})\\s*\\(|running_total!`, 'g');

export function escapingFunctionsIn(aql: string): string[] {
  return [...new Set([...aql.matchAll(ESCAPE_RE)].map((m) => m[1] ?? 'running_total!'))];
}

export type Finding = { level: 'error' | 'warning'; message: string; query?: string };

export const queryKey = (q: NamedQuery | PageQuery) => ('page' in q ? `${q.page}#${q.name}` : q.name);
const label = (q: NamedQuery | PageQuery) => ('page' in q ? `${q.page}:${q.line} query ${q.name}` : `query ${q.name}`);

export class Checker {
  config: Config;
  private shapes = new Map<string, DatasetShape | Error>();
  constructor(config: Config) {
    this.config = config;
  }

  private async shape(ds: string): Promise<DatasetShape | Error> {
    if (!this.shapes.has(ds)) {
      try {
        this.shapes.set(ds, await showDataset(this.config.anfra.url, ds));
      } catch (err) {
        if (err instanceof AnfraError && err.code === 'anfra_unreachable') throw err;
        this.shapes.set(ds, err as Error);
      }
    }
    return this.shapes.get(ds)!;
  }

  // The datasets themselves: scope fields exist, no metric or field escapes a scope.
  async checkDatasets(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const error = (message: string) => findings.push({ level: 'error', message });
    const scoped = [...new Set(this.config.scopes.map((s) => s.dataset))];
    for (const ds of scoped) {
      const shape = await this.shape(ds);
      if (shape instanceof Error) {
        error(`dataset ${ds}: ${shape.message}`);
        continue;
      }
      const scopes = scopesFor(this.config, ds);
      for (const s of scopes) if (!shape.fields.has(s.field)) error(`scope on ${ds}: field ${s.field} isn't in the dataset`);
      for (const m of shape.metrics) {
        const found = escapingFunctionsIn(m.definition);
        if (found.length) error(`${ds}.${m.name} uses ${found.join(', ')}, which can ignore the scope filter on ${scopes.map((s) => s.field).join(', ')}`);
      }
      for (const f of shape.fieldDefinitions) {
        const found = escapingFunctionsIn(f.definition);
        if (found.length) error(`${f.fqn} uses ${found.join(', ')}, which can ignore the scope filter`);
      }
    }
    return findings;
  }

  async checkQuery(q: NamedQuery | PageQuery): Promise<Finding[]> {
    const findings: Finding[] = [];
    const key = queryKey(q);
    const where = label(q);
    const error = (message: string) => findings.push({ level: 'error', message: `${where}: ${message}`, query: key });
    const scoped = scopesFor(this.config, q.dataset).length > 0;
    if (!scoped && !this.config.public.includes(q.dataset)) {
      error(`dataset ${q.dataset} has no scope and isn't listed in public`);
      return findings;
    }
    const shape = await this.shape(q.dataset);
    if (shape instanceof Error) {
      error(`dataset ${q.dataset}: ${shape.message}`);
      return findings;
    }
    const found = escapingFunctionsIn(q.aql);
    if (found.length && scoped) error(`uses ${found.join(', ')}, which can ignore the scope filter`);
    if (!/^\s*(?:(?:dimension|metric)\b[\s\S]*?)?explore\s*\{/.test(q.aql)) {
      error('write the query as an explore { }, so filters and sorts apply to it');
    }
    for (const f of q.params.filters) if (!shape.fields.has(f)) error(`params.filters names ${f}, which isn't in ${q.dataset}`);

    let diagnostics: string[];
    try {
      diagnostics = await validateQuery(this.config.anfra.url, q.dataset, q.aql);
    } catch (err) {
      diagnostics = [(err as Error).message];
    }
    for (const d of diagnostics) error(d);
    if (diagnostics.length) return findings;

    // Run it once with every scope field required to be set: this fails when anfra has no
    // relationship path from the query to a scope field, and gives the real column names.
    try {
      const probe = await runQuery(this.config.anfra.url, {
        dataset: q.dataset,
        aql: q.aql,
        filters: scopesFor(this.config, q.dataset).map((s) => ({ field: s.field, operator: 'not_null', values: [] })),
        pageSize: 1,
      });
      const names = new Set(probe.columns.map((c) => c.name));
      for (const s of q.params.sorts) if (!names.has(s)) error(`params.sorts names ${s}, which isn't a result column (${[...names].join(', ')})`);
    } catch (err) {
      error(`fails with its scope applied: ${(err as Error).message}`);
    }
    return findings;
  }

  async checkPage(registry: PageRegistry, pageKey: string): Promise<Finding[]> {
    const page = registry.pages.get(pageKey);
    if (!page) return [];
    const findings: Finding[] = page.errors.map((message) => ({ level: 'error', message, query: `${pageKey}#*` }));
    for (const q of page.queries.values()) findings.push(...(await this.checkQuery(q)));
    return findings;
  }
}

export async function check(config: Config, registry?: PageRegistry): Promise<Finding[]> {
  const findings: Finding[] = config.warnings.map((message) => ({ level: 'warning', message }));
  const checker = new Checker(config);
  try {
    findings.push(...(await checker.checkDatasets()));
    for (const q of config.queries) findings.push(...(await checker.checkQuery(q)));
    if (registry) for (const key of registry.pages.keys()) findings.push(...(await checker.checkPage(registry, key)));
  } catch (err) {
    findings.push({ level: 'error', message: (err as Error).message });
  }
  return findings;
}
