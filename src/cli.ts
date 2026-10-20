#!/usr/bin/env node
// anfra-user <command> [--config anfra-user.yml]
import { parseArgs } from 'node:util';
import { loadConfig } from './config.ts';
import { connect, listUsers, removeUser, setAttributes, upsertUser } from './db.ts';
import { hashPassword } from './auth.ts';
import { createGateway } from './server.ts';
import { Checker, check } from './check.ts';
import { PageRegistry } from './pages.ts';
import { showDataset, type DatasetDescriptor } from './anfra.ts';
import type { Config } from './config.ts';
import { verify } from './verify.ts';
import type { Attributes } from './scopes.ts';

const HELP = `anfra-user: sign-in and per-user data scopes in front of an anfra repo

Usage:
  anfra-user serve                                   start the gateway
  anfra-user check                                   check anfra-user.yml against the repo
  anfra-user verify                                  run every query as every user (the leak test)
  anfra-user users list
  anfra-user users add <email> --password <pw> [--name <name>] [--attr key=value ...]
  anfra-user users set <email> --attr key=value ...  replace those attributes' values
  anfra-user users remove <email>

Options:
  --config <path>   anfra-user.yml (default: ./anfra-user.yml, or $ANFRA_USER_CONFIG)
  --attr key=       an attribute set to no values: the user sees nothing for that scope
  --attr key=__ALL__  lifts the scope: the user sees every row on that field
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
    attr: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});

function parseAttrs(list: string[] = []): Attributes {
  const attrs: Attributes = new Map();
  for (const item of list) {
    const i = item.indexOf('=');
    if (i < 1) throw new Error(`--attr ${item}: write key=value`);
    const key = item.slice(0, i);
    const value = item.slice(i + 1);
    if (!attrs.has(key)) attrs.set(key, []);
    if (value !== '') attrs.get(key)!.push(value);
  }
  return attrs;
}

// The folders whose pages declare queries: pages/ at /, the Data Apps folder at /apps/.
async function pageRegistry(config: Config): Promise<PageRegistry | undefined> {
  const roots = [
    ...(config.pages ? [{ prefix: '', dir: config.pages }] : []),
    ...(config.apps ? [{ prefix: 'apps', dir: config.apps }] : []),
  ];
  return roots.length ? new PageRegistry(roots).loadAll() : undefined;
}

const printFindings = (findings: { level: string; message: string }[]) => {
  for (const f of findings) console.log(`${f.level === 'error' ? 'ERROR' : 'warn '}  ${f.message}`);
};

const showAttrs = (attrs: Attributes) =>
  [...attrs].map(([k, v]) => `${k}=${v.length ? v.join(',') : '(none)'}`).join('  ') || '(no attributes)';

async function main() {
  const [command, sub, arg] = positionals;
  if (opts.help || !command) return void console.log(HELP);
  const config = loadConfig(opts.config ?? process.env.ANFRA_USER_CONFIG ?? 'anfra-user.yml');

  const registry = await pageRegistry(config);
  const pageQueries = registry?.allQueries() ?? [];

  if (command === 'check') {
    const findings = await check(config, registry);
    printFindings(findings);
    const errors = findings.filter((f) => f.level === 'error').length;
    console.log(errors
      ? `\n${errors} error(s): fix them before serving.`
      : `\nOK: ${config.queries.length} named queries, ${pageQueries.length} page queries on ${registry?.pages.size ?? 0} pages, ${config.scopes.length} scopes.`);
    process.exitCode = errors ? 1 : 0;
    return;
  }

  const db = connect(config.database.url);
  try {
    if (command === 'serve') {
      const findings = await check(config, registry);
      printFindings(findings);
      if (findings.some((f) => f.level === 'error')) {
        console.error('\nNot serving: `anfra-user check` found errors.');
        process.exitCode = 1;
        return;
      }
      await db.query('select 1');

      // Anfra.datasets for pages: the datasets a user may query (scoped or public).
      const datasets: Record<string, DatasetDescriptor> = {};
      for (const ds of new Set([...config.scopes.map((x) => x.dataset), ...config.public])) {
        datasets[ds] = (await showDataset(config.anfra.url, ds)).descriptor;
      }

      // A page edited while serving is re-read and re-checked; its failing queries are blocked
      // (403) until the file is fixed, rather than run unchecked.
      const blocked = new Map<string, string>();
      if (registry) {
        registry.watch();
        registry.onChange(async (page) => {
          for (const key of [...blocked.keys()]) if (key.startsWith(`${page.key}#`)) blocked.delete(key);
          const pageFindings = await new Checker(config).checkPage(registry, page.key);
          for (const f of pageFindings) if (f.level === 'error' && f.query) blocked.set(f.query, f.message);
          const n = pageFindings.filter((f) => f.level === 'error').length;
          console.log(n ? `page ${page.key} changed: ${n} problem(s), its failing queries are blocked` : `page ${page.key} changed: ${page.queries.size} queries OK`);
          printFindings(pageFindings);
        });
      }

      const server = createGateway(config, db, { secureCookies: process.env.SECURE_COOKIES === '1', registry, blocked, datasets });
      await new Promise<void>((resolve) => server.listen(config.server.port, '127.0.0.1', resolve));
      console.log(`anfra-user serving on http://127.0.0.1:${config.server.port}  (anfra at ${config.anfra.url})`);
      await new Promise(() => {});                      // until Ctrl-C
    }

    if (command === 'verify') {
      const users = await listUsers(db);
      if (!users.length) throw new Error('No users: add some with `anfra-user users add`');
      const outcomes = await verify(config, users, pageQueries);
      const icon = { pass: 'PASS', warn: 'warn', fail: 'FAIL' };
      const width = Math.max(16, ...outcomes.map((o) => o.query.length));
      for (const o of outcomes) console.log(`${icon[o.status]}  ${o.user.padEnd(20)} ${o.query.padEnd(width)} ${o.detail}`);
      const failed = outcomes.filter((o) => o.status === 'fail').length;
      console.log(failed ? `\n${failed} failure(s).` : `\nOK: ${outcomes.length} checks, ${users.length} users, ${config.queries.length + pageQueries.length} queries.`);
      process.exitCode = failed ? 1 : 0;
      return;
    }

    if (command === 'users') {
      if (sub === 'list') {
        for (const u of await listUsers(db)) console.log(`${u.email.padEnd(28)} ${(u.display_name ?? '').padEnd(20)} ${showAttrs(u.attrs)}`);
        return;
      }
      if (sub === 'add') {
        if (!arg || !opts.password) throw new Error('users add <email> --password <pw>');
        await upsertUser(db, arg, opts.name ?? null, await hashPassword(opts.password));
        await setAttributes(db, arg, parseAttrs(opts.attr));
        console.log(`Saved ${arg}`);
        return;
      }
      if (sub === 'set') {
        if (!arg || !opts.attr?.length) throw new Error('users set <email> --attr key=value ...');
        await setAttributes(db, arg, parseAttrs(opts.attr));
        console.log(`Updated ${arg}`);
        return;
      }
      if (sub === 'remove') {
        if (!arg) throw new Error('users remove <email>');
        console.log((await removeUser(db, arg)) ? `Removed ${arg}` : `No user ${arg}`);
        return;
      }
    }
    console.log(HELP);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(`anfra-user: ${err.message}`);
  process.exitCode = 1;
});
