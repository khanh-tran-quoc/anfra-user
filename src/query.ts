// Runs a named query for a user: checks the reader's choices against the query's params,
// then adds the user's scope. Used by the server and by `anfra-user verify`.
import type { Config, NamedQuery } from './config.ts';
import { runQuery, type AnfraDateDrill, type AnfraFilter, type AnfraSort, type QueryResult } from './anfra.ts';
import { resolveScopes, type Attributes, type Resolved } from './scopes.ts';

// Operators that can only narrow a result. Anything else is refused.
export const ALLOWED_OPERATORS = new Set([
  'is', 'is_not', 'contains', 'does_not_contain', 'starts_with', 'ends_with',
  'greater_than', 'less_than', 'between', 'before', 'after', 'last', 'next',
  'is_null', 'not_null', 'is_true', 'is_false',
]);
const MODIFIERS = new Set(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year']);
const GRAINS = MODIFIERS;
// A filter's aggregation (a condition on an aggregate, in the query's having): still only narrows.
const AGGREGATIONS = new Set(['sum', 'avg', 'count', 'count distinct', 'min', 'max', 'median']);
const FIELD_REF = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMEZONE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/;

export class RequestError extends Error {
  name = 'RequestError';
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export type ReaderInput = {
  filters?: unknown; sorts?: unknown; page?: unknown; page_size?: unknown; date_drills?: unknown; timezone?: unknown;
};
const INPUT_KEYS = ['filters', 'sorts', 'page', 'page_size', 'date_drills', 'timezone'];

export type Parsed = {
  filters: AnfraFilter[]; sorts: AnfraSort[]; dateDrills: AnfraDateDrill[]; page: number; pageSize: number; timezone?: string;
};

export function parseReaderInput(query: NamedQuery, input: ReaderInput): Parsed {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new RequestError('Send a JSON object');
  const unknown = Object.keys(input).filter((k) => !INPUT_KEYS.includes(k));
  if (unknown.length) throw new RequestError(`Unknown key ${unknown[0]}: send only ${INPUT_KEYS.join(', ')}`);
  const open = Boolean(query.params.open);
  const rawFilters = input.filters ?? [];
  if (!Array.isArray(rawFilters)) throw new RequestError('filters must be a list');
  const filters = rawFilters.map((f: any, i): AnfraFilter => {
    if (typeof f !== 'object' || f === null) throw new RequestError(`filters[${i}] must be an object`);
    const extra = Object.keys(f).filter((k) => !['field', 'operator', 'values', 'modifier', 'aggregation'].includes(k));
    if (extra.length) throw new RequestError(`filters[${i}]: unknown key ${extra[0]}`);
    // A named query lists its fields; a page query takes any model.field, or a bare metric name
    // (a condition on the metric). Names only, never expressions: anfra rejects unknown ones.
    const allowed = open
      ? typeof f.field === 'string' && (FIELD_REF.test(f.field) || NAME.test(f.field))
      : query.params.filters.includes(f.field);
    if (!allowed) throw new RequestError(`Can't filter ${query.name} on ${f.field}`);
    if (!ALLOWED_OPERATORS.has(f.operator)) throw new RequestError(`Operator ${f.operator} isn't allowed`);
    const values = f.values ?? [];
    if (!Array.isArray(values) || values.length > 1000) throw new RequestError(`filters[${i}].values must be a list`);
    for (const v of values) if (typeof v !== 'string') throw new RequestError(`filters[${i}].values: send every value as a string`);
    const out: AnfraFilter = { field: f.field, operator: f.operator, values };
    if (f.aggregation !== undefined) {
      if (!open) throw new RequestError(`filters[${i}].aggregation isn't allowed on ${query.name}`);
      if (!AGGREGATIONS.has(f.aggregation)) throw new RequestError(`filters[${i}].aggregation: ${f.aggregation} isn't supported`);
      out.aggregation = f.aggregation;
    }
    if (f.modifier !== undefined) {
      if (!MODIFIERS.has(f.modifier)) throw new RequestError(`filters[${i}].modifier: ${f.modifier} isn't a date unit`);
      out.modifier = f.modifier;
    }
    return out;
  });
  // A filter with no values means "no filter" to anfra's SDK: refuse it rather than guess.
  for (const f of filters) {
    const needsValues = !['is_null', 'not_null', 'is_true', 'is_false'].includes(f.operator);
    if (needsValues && f.values.length === 0) throw new RequestError(`Filter on ${f.field} has no values: leave it out instead`);
  }

  const rawSorts = input.sorts ?? [];
  if (!Array.isArray(rawSorts)) throw new RequestError('sorts must be a list');
  const sorts = rawSorts.map((s: any): AnfraSort => {
    const allowed = open ? typeof s?.field === 'string' && NAME.test(s.field) : query.params.sorts.includes(s?.field);
    if (!allowed) throw new RequestError(`Can't sort ${query.name} by ${s?.field}`);
    if (s.direction !== 'asc' && s.direction !== 'desc') throw new RequestError('Sort direction is asc or desc');
    return { field: s.field, direction: s.direction };
  });

  const rawDrills = input.date_drills ?? [];
  if (!Array.isArray(rawDrills)) throw new RequestError('date_drills must be a list');
  if (rawDrills.length && !open) throw new RequestError(`date_drills aren't allowed on ${query.name}`);
  const dateDrills = rawDrills.map((d: any): AnfraDateDrill => {
    if (typeof d?.field !== 'string' || !FIELD_REF.test(d.field)) throw new RequestError('date_drills: field must be model.field');
    if (!GRAINS.has(d.grain)) throw new RequestError(`date_drills: ${d.grain} isn't a grain`);
    return { field: d.field, grain: d.grain };
  });

  let timezone: string | undefined;
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || !TIMEZONE.test(input.timezone)) throw new RequestError('timezone must be an IANA name like Asia/Singapore');
    timezone = input.timezone;
  }

  const page = input.page === undefined ? 1 : Number(input.page);
  if (!Number.isInteger(page) || page < 1) throw new RequestError('page must be a whole number from 1');
  const requested = input.page_size === undefined ? query.params.max_page_size : Number(input.page_size);
  if (!Number.isInteger(requested) || requested < 1) throw new RequestError('page_size must be a whole number from 1');
  return { filters, sorts, dateDrills, page, pageSize: Math.min(requested, query.params.max_page_size), timezone };
}

export type RunResult = QueryResult & { page: number; scope: Resolved };

export async function runNamedQuery(config: Config, query: NamedQuery, attrs: Attributes, input: ReaderInput): Promise<RunResult> {
  const parsed = parseReaderInput(query, input);
  const scope = resolveScopes(config, query.dataset, attrs);
  if (scope.kind === 'none') return { columns: [], rows: [], hasMore: false, page: parsed.page, scope };
  const result = await runQuery(config.anfra.url, {
    dataset: query.dataset,
    aql: query.aql,                                     // from anfra-user.yml or the page file, never from the request
    filters: [...parsed.filters, ...scope.filters],     // the scope last; anfra ANDs them all
    sorts: parsed.sorts,
    dateDrills: parsed.dateDrills,
    timezone: parsed.timezone,
    page: parsed.page,
    pageSize: parsed.pageSize,
  });
  return { ...result, page: parsed.page, scope };
}
