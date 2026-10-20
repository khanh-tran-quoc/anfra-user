// The gateway: sign-in, /me, named queries, page queries, and the repo's pages behind sign-in.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import { AuthError, SESSION_COOKIE, login, logout, userForSession, type User } from './auth.ts';
import { describeScopes, resolveScopes } from './scopes.ts';
import { RequestError, runNamedQuery } from './query.ts';
import { AnfraError, runQuery, type DatasetDescriptor } from './anfra.ts';
import type { PageRegistry } from './pages.ts';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 64 * 1024;
const FIELD_REF = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json', headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'DENY',
    ...headers,
  });
  res.end(body);
}
const json = (res: ServerResponse, status: number, data: unknown, headers = {}) => send(res, status, JSON.stringify(data), 'application/json', headers);

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(id: string, maxAge: number, secure: boolean) {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// JSON bodies only. A cross-site <form> can't send application/json without a CORS
// preflight, which this server never answers, so this also stops CSRF on the POSTs.
async function readJson(req: IncomingMessage): Promise<any> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new RequestError('Send a JSON body (content-type: application/json)', 415);
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RequestError('Request body too large', 413);
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError('Body is not valid JSON');
  }
}

// The file a URL path names under root, or null. No ../ escapes; /x serves x.html or x/index.html.
async function resolveFile(root: string, urlPath: string): Promise<string | null> {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/') || rel === '') rel += 'index.html';
  const file = resolve(root, '.' + normalize('/' + rel));
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  for (const candidate of [file, file + '.html', join(file, 'index.html')]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // try the next
    }
  }
  return null;
}

// JSON safe to put inside <script>: no "</script>", no HTML comment openers.
const scriptJson = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function injectSdk(html: string, context: unknown): string {
  const tags = `<script>window.__ANFRA_USER__=${scriptJson(context)}</script><script src="/anfra-user-sdk.js"></script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tags + html.slice(head.index + head[0].length);
  const doctype = /<!doctype[^>]*>/i.exec(html);
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + tags + html.slice(doctype.index + doctype[0].length);
  return tags + html;
}

function audit(event: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

export type GatewayOptions = {
  secureCookies?: boolean;
  registry?: PageRegistry;
  blocked?: Map<string, string>;                      // page query key → why `check` blocked it
  datasets?: Record<string, DatasetDescriptor>;       // for the SDK's Anfra.datasets
};

export function createGateway(config: Config, db: Db, opts: GatewayOptions = {}) {
  const secure = Boolean(opts.secureCookies);
  const registry = opts.registry;
  const blocked = opts.blocked ?? new Map();
  const roots = [
    ...(config.apps ? [{ prefix: '/apps/', dir: config.apps, key: 'apps/' }] : []),
    ...(config.pages ? [{ prefix: '/', dir: config.pages, key: '' }] : []),
  ];

  async function servePage(res: ServerResponse, user: User, path: string): Promise<boolean> {
    for (const root of roots) {
      if (!path.startsWith(root.prefix)) continue;
      const file = await resolveFile(root.dir, path.slice(root.prefix.length));
      if (!file) continue;
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      if (extname(file) !== '.html') {
        send(res, 200, await readFile(file), type);
        return true;
      }
      const rel = file.slice(root.dir.length + 1).split(sep).join('/').replace(/\.html$/, '').replace(/(^|\/)index$/, '');
      const context = {
        page: root.key + rel,
        user: {
          id: user.email, name: user.displayName ?? user.email, email: user.email, role: 'viewer',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          permissions: { canViewGeneratedSql: false, canExportData: false },
        },
        scopes: describeScopes(config, user.attrs),
        datasets: opts.datasets ?? {},
      };
      send(res, 200, injectSdk(await readFile(file, 'utf8'), context), type);
      return true;
    }
    return false;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // --- Open to everyone: the sign-in page, the client scripts, sign-in itself.
    if (method === 'GET' && path === '/login') return send(res, 200, await readFile(join(PUBLIC_DIR, 'login.html')), TYPES['.html']);
    if (method === 'GET' && (path === '/anfra-user.js' || path === '/anfra-user-sdk.js')) {
      return send(res, 200, await readFile(join(PUBLIC_DIR, path.slice(1))), TYPES['.js']);
    }
    if (method === 'GET' && path === '/health') return json(res, 200, { ok: true });

    if (method === 'POST' && path === '/auth/login') {
      const body = await readJson(req);
      try {
        const id = await login(db, body.email, body.password, config.auth.session_ttl_seconds);
        audit({ event: 'login', email: String(body.email).toLowerCase() });
        return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(id, config.auth.session_ttl_seconds, secure) });
      } catch (err) {
        if (err instanceof AuthError) {
          audit({ event: 'login_failed', email: String(body.email ?? '').toLowerCase() });
          return json(res, 401, { error: err.message });
        }
        throw err;
      }
    }

    // --- Everything below needs a session.
    const sessionId = cookies(req)[SESSION_COOKIE];
    const user: User | null = await userForSession(db, sessionId);

    if (method === 'POST' && path === '/auth/logout') {
      await readJson(req);
      await logout(db, sessionId);
      return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0, secure) });
    }

    if (!user) {
      if (method === 'GET') return send(res, 302, '', 'text/plain', { location: `/login?next=${encodeURIComponent(path + url.search)}` });
      return json(res, 401, { error: 'Sign in first' });
    }

    if (method === 'GET' && path === '/me') {
      return json(res, 200, { email: user.email, name: user.displayName, scopes: describeScopes(config, user.attrs) });
    }

    if (method === 'GET' && path === '/queries') {
      return json(res, 200, config.queries.map((q) => ({ name: q.name, dataset: q.dataset, params: q.params })));
    }

    // Named queries from anfra-user.yml.
    const m = /^\/q\/([A-Za-z0-9_-]+)$/.exec(path);
    if (m && method === 'POST') {
      const query = config.queries.find((q) => q.name === m[1]);
      if (!query) return json(res, 404, { error: `No query named ${m[1]}` });
      const body = await readJson(req);
      const started = Date.now();
      const result = await runNamedQuery(config, query, user.attrs, body);
      audit({
        event: 'query', email: user.email, query: query.name, rows: result.rows.length, ms: Date.now() - started,
        scope: result.scope.kind === 'none' ? 'none' : { filters: result.scope.filters, lifted: result.scope.lifted },
      });
      return json(res, 200, { columns: result.columns, rows: result.rows, hasMore: result.hasMore, page: result.page });
    }

    // Page queries: the AQL the page file declares, picked by page and query name.
    if (method === 'POST' && path === '/pq') {
      if (!registry) return json(res, 404, { error: 'Page queries are off: set pages or apps in anfra-user.yml' });
      const { path: pagePath, name, ...input } = await readJson(req);
      const { page, query } = registry.find(pagePath, name);
      if (!page) return json(res, 404, { error: `No page ${pagePath}` });
      if (!query) {
        return json(res, 404, {
          error: `Query ${name} isn't declared in ${page.key}'s source with fixed text. anfra-user only runs AQL written in the page file` +
            (page.errors.length ? `: ${page.errors.join('; ')}` : ''),
        });
      }
      const key = `${page.key}#${name}`;
      const why = blocked.get(key) ?? blocked.get(`${page.key}#*`);
      if (why) return json(res, 403, { error: `Blocked by anfra-user check: ${why}` });
      const started = Date.now();
      const result = await runNamedQuery(config, query, user.attrs, input);
      audit({
        event: 'page_query', email: user.email, page: page.key, query: name, rows: result.rows.length, ms: Date.now() - started,
        scope: result.scope.kind === 'none' ? 'none' : { filters: result.scope.filters, lifted: result.scope.lifted },
      });
      return json(res, 200, { columns: result.columns, rows: result.rows, hasMore: result.hasMore, page: result.page });
    }

    // A filter's options: the field's values the user may see, for createFilter().loadOptions().
    if (method === 'POST' && path === '/pq/options') {
      const { dataset, field, search, limit } = await readJson(req);
      if (typeof dataset !== 'string' || typeof field !== 'string' || !FIELD_REF.test(field)) {
        throw new RequestError('Send { dataset, field: "model.field", search? }');
      }
      const scope = resolveScopes(config, dataset, user.attrs);
      if (scope.kind === 'none') return json(res, 200, { options: [] });
      const filters = [...scope.filters] as { field: string; operator: string; values: string[] }[];
      if (search !== undefined && search !== '') {
        if (typeof search !== 'string' || search.length > 200) throw new RequestError('search must be text');
        filters.unshift({ field, operator: 'contains', values: [search] });
      }
      const pageSize = Math.min(Math.max(Number(limit) || 1000, 1), 1000);
      const result = await runQuery(config.anfra.url, {
        dataset, aql: `explore { dimensions { v: ${field} } sorts { v asc } }`, filters, pageSize,
      });
      return json(res, 200, { options: result.rows.map((r) => r.v).filter((v) => v !== null) });
    }

    if (method === 'GET' && (await servePage(res, user, path))) return;
    return json(res, 404, { error: 'Not found' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof RequestError) return json(res, err.status, { error: err.message });
      if (err instanceof AnfraError) {
        audit({ event: 'anfra_error', code: err.code, message: err.message });
        return json(res, err.code === 'anfra_unreachable' ? 503 : 422, { error: err.message });
      }
      console.error(err);
      json(res, 500, { error: 'Something went wrong' });
    });
  });
}
