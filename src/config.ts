// Loads and validates anfra-user.yml. Anything unexpected is an error: a typo in a
// security config should stop the server, not be ignored.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

export type Scope = {
  dataset: string;
  field: string;            // model.field the filter is put on
  attribute: string;        // user attribute holding the allowed values
  default_values: string[]; // values for a user without the attribute; [] means "sees nothing"
};

export type QueryParams = {
  filters: string[];        // model.field the reader may filter on
  sorts: string[];          // result column aliases the reader may sort by
  max_page_size: number;
  open?: boolean;           // page queries: any field and column (filters only narrow); see pages.ts
};

export type NamedQuery = {
  name: string;
  dataset: string;
  aql: string;
  params: QueryParams;
};

export type Config = {
  version: 1;
  auth: { provider: 'builtin'; session_ttl_seconds: number };
  anfra: { url: string };
  database: { url: string };
  server: { port: number };
  pages: string | null;     // absolute path of the folder served behind sign-in, at /
  apps: string | null;      // an anfra repo's Data Apps folder, served behind sign-in at /apps/
  scopes: Scope[];
  public: string[];
  queries: NamedQuery[];
  warnings: string[];
};

export const ALL = '__ALL__';

const TOP_KEYS = ['version', 'auth', 'anfra', 'database', 'server', 'pages', 'apps', 'scopes', 'public', 'queries'];

class ConfigError extends Error {
  name = 'ConfigError';
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`${where}: must be a list`);
  return v.map((item, i) => {
    if (typeof item === 'number' || typeof item === 'boolean') return String(item);
    if (typeof item !== 'string' || item === '') fail(`${where}[${i}]: must be a non-empty string`);
    return item;
  });
}

export function parseDuration(text: string, where: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(text).trim());
  if (!m) fail(`${where}: "${text}" is not a duration like 30m, 8h or 7d`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

const FIELD_REF = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseConfig(raw: unknown, baseDir: string, env: NodeJS.ProcessEnv = process.env): Config {
  if (!isObject(raw)) fail('anfra-user.yml: must be a mapping');
  onlyKeys(raw, TOP_KEYS, 'anfra-user.yml');
  if (raw.version !== 1) fail('version: must be 1');
  const warnings: string[] = [];

  const auth = raw.auth ?? {};
  if (!isObject(auth)) fail('auth: must be a mapping');
  onlyKeys(auth, ['provider', 'session_ttl'], 'auth');
  if ((auth.provider ?? 'builtin') !== 'builtin') fail('auth.provider: only "builtin" (email and password) is supported');
  const session_ttl_seconds = parseDuration(String(auth.session_ttl ?? '8h'), 'auth.session_ttl');

  const anfraRaw = raw.anfra ?? {};
  if (!isObject(anfraRaw)) fail('anfra: must be a mapping');
  onlyKeys(anfraRaw, ['url'], 'anfra');
  const anfraUrl = env.ANFRA_URL ?? String(anfraRaw.url ?? 'http://127.0.0.1:7878');
  const host = new URL(anfraUrl).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    warnings.push(`anfra.url ${anfraUrl} is not a loopback address: make sure nothing but this gateway can reach it, since anfra has no sign-in`);
  }

  const dbRaw = raw.database ?? {};
  if (!isObject(dbRaw)) fail('database: must be a mapping');
  onlyKeys(dbRaw, ['url'], 'database');
  const dbUrl = env.DATABASE_URL ?? String(dbRaw.url ?? 'postgres://anfra_user:anfra_user@127.0.0.1:5433/anfra_user');

  const serverRaw = raw.server ?? {};
  if (!isObject(serverRaw)) fail('server: must be a mapping');
  onlyKeys(serverRaw, ['port'], 'server');
  const port = Number(env.PORT ?? serverRaw.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('server.port: must be a port number');

  const pages = raw.pages === undefined || raw.pages === null ? null : resolve(baseDir, String(raw.pages));
  const apps = raw.apps === undefined || raw.apps === null ? null : resolve(baseDir, String(raw.apps));

  if (!Array.isArray(raw.scopes ?? [])) fail('scopes: must be a list');
  const scopes: Scope[] = ((raw.scopes ?? []) as unknown[]).map((s, i) => {
    const where = `scopes[${i}]`;
    if (!isObject(s)) fail(`${where}: must be a mapping`);
    onlyKeys(s, ['dataset', 'field', 'attribute', 'default_values'], where);
    for (const key of ['dataset', 'field', 'attribute']) {
      if (typeof s[key] !== 'string' || s[key] === '') fail(`${where}.${key}: required`);
    }
    if (!FIELD_REF.test(s.field as string)) fail(`${where}.field: "${s.field}" must be model.field`);
    const default_values = stringList(s.default_values, `${where}.default_values`);
    if (default_values.includes(ALL)) {
      warnings.push(`${where} (${s.dataset}): default_values contains ${ALL}, so every user without "${s.attribute}" sees all of ${s.dataset}`);
    }
    return { dataset: s.dataset as string, field: s.field as string, attribute: s.attribute as string, default_values };
  });

  const publicDatasets = stringList(raw.public, 'public');
  for (const ds of publicDatasets) {
    if (scopes.some((s) => s.dataset === ds)) fail(`public: ${ds} also has a scope; a dataset is either scoped or public`);
  }

  if (!Array.isArray(raw.queries ?? [])) fail('queries: must be a list');
  const names = new Set<string>();
  const queries: NamedQuery[] = ((raw.queries ?? []) as unknown[]).map((q, i) => {
    const where = `queries[${i}]`;
    if (!isObject(q)) fail(`${where}: must be a mapping`);
    onlyKeys(q, ['name', 'dataset', 'aql', 'params'], where);
    if (typeof q.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(q.name)) fail(`${where}.name: letters, digits, _ and - only`);
    if (names.has(q.name)) fail(`${where}.name: "${q.name}" is used twice`);
    names.add(q.name);
    if (typeof q.dataset !== 'string' || q.dataset === '') fail(`${where}.dataset: required`);
    if (typeof q.aql !== 'string' || !q.aql.trim()) fail(`${where}.aql: required`);
    if (!scopes.some((s) => s.dataset === q.dataset) && !publicDatasets.includes(q.dataset)) {
      fail(`${where} (${q.name}): dataset ${q.dataset} has no scope and is not listed in public`);
    }
    const p = q.params ?? {};
    if (!isObject(p)) fail(`${where}.params: must be a mapping`);
    onlyKeys(p, ['filters', 'sorts', 'max_page_size'], `${where}.params`);
    const filters = stringList(p.filters, `${where}.params.filters`);
    for (const f of filters) if (!FIELD_REF.test(f)) fail(`${where}.params.filters: "${f}" must be model.field`);
    const sorts = stringList(p.sorts, `${where}.params.sorts`);
    for (const s of sorts) if (!ALIAS.test(s)) fail(`${where}.params.sorts: "${s}" must be a result column alias`);
    const max_page_size = Number(p.max_page_size ?? 500);
    if (!Number.isInteger(max_page_size) || max_page_size < 1 || max_page_size > 10000) {
      fail(`${where}.params.max_page_size: a whole number from 1 to 10000`);
    }
    return { name: q.name, dataset: q.dataset, aql: q.aql, params: { filters, sorts, max_page_size } };
  });

  return {
    version: 1,
    auth: { provider: 'builtin', session_ttl_seconds },
    anfra: { url: anfraUrl.replace(/\/$/, '') },
    database: { url: dbUrl },
    server: { port },
    pages,
    apps,
    scopes,
    public: publicDatasets,
    queries,
    warnings,
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(`Can't read ${file}`);
  }
  return parseConfig(YAML.parse(text), dirname(file), env);
}

export function scopesFor(config: Pick<Config, 'scopes'>, dataset: string): Scope[] {
  return config.scopes.filter((s) => s.dataset === dataset);
}
