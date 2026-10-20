// Turns a user's attributes into the filters every query of theirs carries.
// This file is the security core: keep it small, pure and tested (test/scopes.test.ts).
import { ALL, scopesFor, type Config } from './config.ts';

export type Attributes = Map<string, string[]>;

export type ScopeFilter = { field: string; operator: 'is'; values: string[] };

export type Resolved =
  | { kind: 'none' }                              // the user may see no rows: don't ask anfra at all
  | { kind: 'filters'; filters: ScopeFilter[]; lifted: string[] };

// The values a user has for one scope: their attribute when set (even to an empty
// list), otherwise the scope's default_values.
export function valuesFor(attrs: Attributes, attribute: string, defaults: string[]): string[] {
  return attrs.has(attribute) ? attrs.get(attribute)! : defaults;
}

export function resolveScopes(config: Pick<Config, 'scopes' | 'public'>, dataset: string, attrs: Attributes): Resolved {
  const scopes = scopesFor(config, dataset);
  if (scopes.length === 0) {
    // Unscoped datasets are refused unless the config says they are public.
    if (config.public.includes(dataset)) return { kind: 'filters', filters: [], lifted: [] };
    return { kind: 'none' };
  }
  const filters: ScopeFilter[] = [];
  const lifted: string[] = [];
  for (const scope of scopes) {
    const values = valuesFor(attrs, scope.attribute, scope.default_values);
    if (values.includes(ALL)) {
      lifted.push(scope.attribute);
      continue;
    }
    // Never send an empty filter: an empty list would be "no filter" to some clients.
    if (values.length === 0) return { kind: 'none' };
    filters.push({ field: scope.field, operator: 'is', values: [...new Set(values.map(String))] });
  }
  return { kind: 'filters', filters, lifted };
}

// What /me shows: the caller's own resolved values per attribute.
export function describeScopes(config: Pick<Config, 'scopes'>, attrs: Attributes): Record<string, string[] | typeof ALL> {
  const out: Record<string, string[] | typeof ALL> = {};
  for (const scope of config.scopes) {
    const values = valuesFor(attrs, scope.attribute, scope.default_values);
    out[scope.attribute] = values.includes(ALL) ? ALL : [...new Set(values)];
  }
  return out;
}
