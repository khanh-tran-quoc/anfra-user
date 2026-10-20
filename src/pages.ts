// Page queries: the AQL a page declares with app.createQuery(...), read from the page's file
// on the server. At runtime the browser names a query; it never sends AQL. So only AQL written
// in the repo's files runs, and check/verify cover it like any named query.
import { readFile, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import type { NamedQuery } from './config.ts';

export type PageQuery = NamedQuery & { page: string; line: number };
export type Page = { key: string; file: string; queries: Map<string, PageQuery>; errors: string[] };

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);
const QUERY_KEYS = new Set(['dataset', 'aql', 'pageSize']);

// Every page query gets these params: a reader may filter on any field and sort by any column,
// since filters only narrow and the scope is added after them. anfra rejects unknown names.
const OPEN_PARAMS = { filters: [] as string[], sorts: [] as string[], open: true };

function lineOf(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

// A string the source fixes: 'x', "x", or a template literal without ${...}. Identifiers
// resolve to a top-level-or-not `const X = 'x'` in the same script. Anything else: null.
function staticString(node: any, consts: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  if (node.type === 'Identifier' && consts.has(node.name)) return consts.get(node.name)!;
  return null;
}

export function extractQueries(html: string, pageKey: string): { queries: PageQuery[]; errors: string[] } {
  const queries: PageQuery[] = [];
  const errors: string[] = [];
  // Blank out HTML comments (keeping line breaks, so line numbers stay right): a comment that
  // mentions <script> is not a script.
  html = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '').toLowerCase();
    if (!JS_TYPES.has(type)) continue;
    const code = m[2];
    const offset = lineOf(html, m.index! + m[0].indexOf('>') + 1) - 1;
    let ast: acorn.Node;
    try {
      ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: type === 'module' ? 'module' : 'script', allowAwaitOutsideFunction: true, locations: true });
    } catch (err) {
      errors.push(`${pageKey}: a <script> doesn't parse: ${(err as Error).message}`);
      continue;
    }

    const consts = new Map<string, string>();
    walk.simple(ast, {
      VariableDeclaration(node: any) {
        if (node.kind !== 'const') return;
        for (const d of node.declarations) {
          const v = d.id.type === 'Identifier' ? staticString(d.init, new Map()) : null;
          if (v !== null) consts.set(d.id.name, v);
        }
      },
    });

    walk.simple(ast, {
      CallExpression(node: any) {
        const callee = node.callee;
        const isCreate = callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'createQuery';
        if (!isCreate) return;
        const line = offset + node.loc.start.line;
        const where = `${pageKey}:${line}`;
        const name = staticString(node.arguments[0], consts);
        const decl = node.arguments[1];
        if (name === null) return void errors.push(`${where}: createQuery's name must be fixed text`);
        if (!decl || decl.type !== 'ObjectExpression') return void errors.push(`${where} (${name}): createQuery needs { dataset, aql } written in place`);
        const props = new Map<string, any>();
        for (const p of decl.properties) {
          if (p.type !== 'Property' || p.computed || p.kind !== 'init') return void errors.push(`${where} (${name}): no spread or computed keys in createQuery's options`);
          const key = p.key.name ?? p.key.value;
          if (!QUERY_KEYS.has(key)) return void errors.push(`${where} (${name}): unsupported option ${key}`);
          props.set(key, p.value);
        }
        const dataset = staticString(props.get('dataset'), consts);
        const aql = staticString(props.get('aql'), consts);
        if (dataset === null) return void errors.push(`${where} (${name}): dataset must be fixed text or a const string`);
        if (aql === null) return void errors.push(`${where} (${name}): aql must be fixed text (no \${...}): anfra-user only runs AQL written in the page`);
        let pageSize: number | null = null;
        if (props.has('pageSize')) {
          const v = props.get('pageSize');
          if (v.type !== 'Literal' || !Number.isInteger(v.value) || v.value < 1) return void errors.push(`${where} (${name}): pageSize must be a whole number written in place`);
          pageSize = v.value;
        }
        if (queries.some((q) => q.name === name)) return void errors.push(`${where}: query name ${name} is used twice on this page`);
        queries.push({ name, dataset, aql, page: pageKey, line, params: { ...OPEN_PARAMS, max_page_size: pageSize ?? 10000 } });
      },
    });
  }
  return { queries, errors };
}

// Page key: the path the page is served at, without the leading slash or .html.
// pages/my-sales.html → "my-sales"; apps/sales/overview.html → "apps/sales/overview".
export function pageKey(prefix: string, root: string, file: string) {
  const rel = relative(root, file).split(sep).join('/').replace(/\.html$/, '').replace(/(^|\/)index$/, '');
  return [prefix, rel].filter(Boolean).join('/');
}

export function normalizePagePath(path: string) {
  return String(path).replace(/^\/+/, '').replace(/\.html$/, '').replace(/\/+$/, '').replace(/(^|\/)index$/, '');
}

async function htmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

export type Root = { prefix: string; dir: string };

export class PageRegistry {
  pages = new Map<string, Page>();
  roots: Root[];
  private listeners: ((page: Page) => void)[] = [];

  constructor(roots: Root[]) {
    this.roots = roots;
  }

  async loadFile(root: Root, file: string): Promise<Page> {
    const key = pageKey(root.prefix, root.dir, file);
    let html = '';
    try {
      html = await readFile(file, 'utf8');
    } catch {
      this.pages.delete(key);
      return { key, file, queries: new Map(), errors: [] };
    }
    const { queries, errors } = extractQueries(html, key);
    const page: Page = { key, file, queries: new Map(queries.map((q) => [q.name, q])), errors };
    this.pages.set(key, page);
    return page;
  }

  async loadAll() {
    this.pages.clear();
    for (const root of this.roots) for (const file of await htmlFiles(root.dir)) await this.loadFile(root, file);
    return this;
  }

  allQueries(): PageQuery[] {
    return [...this.pages.values()].flatMap((p) => [...p.queries.values()]);
  }

  find(pagePath: string, name: string): { page?: Page; query?: PageQuery } {
    const page = this.pages.get(normalizePagePath(pagePath));
    return { page, query: page?.queries.get(name) };
  }

  onChange(fn: (page: Page) => void) {
    this.listeners.push(fn);
  }

  // Re-read a page whenever its file changes, so a new or edited query is picked up (and
  // re-checked) without restarting.
  watch() {
    for (const root of this.roots) {
      try {
        watch(root.dir, { recursive: true }, async (_event, name) => {
          if (!name || !String(name).endsWith('.html')) return;
          const page = await this.loadFile(root, join(root.dir, String(name)));
          for (const fn of this.listeners) fn(page);
        });
      } catch {
        // folder missing: nothing to watch
      }
    }
  }
}
