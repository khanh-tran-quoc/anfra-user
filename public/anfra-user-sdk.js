// anfra-user SDK: the Anfra Data App SDK's app API, backed by the anfra-user gateway.
//
// The gateway injects this into every page it serves, with the signed-in user's context, so a
// page (or an anfra Data App) written against `Anfra.createApp()` works behind sign-in:
//
//   const app = Anfra.createApp();                       // or AnfraUser.createApp()
//   const q = app.createQuery('by_country', { dataset: 'sales', aql: `explore { ... }` });
//   app.subscribe(render); app.execute();
//
// What differs from the anfra SDK:
// - The AQL a page declares is read from the page FILE by the gateway, which runs that, never what
//   the browser holds. A query must be declared with fixed text (no ${...}): `anfra-user check`
//   lists the ones that aren't, and they fail with a QueryError.
// - Every query carries the user's scope (anfra-user.yml), added on the server.
// - Plugins (export, render, lineage) aren't available: Anfra.plugins.has() is false for them.
// - Cross-filtering a selection of several rows on several columns is approximated by one
//   `is` list per column (a superset of the exact row pairs); a warning says so.
(function () {
  const ctx = window.__ANFRA_USER__ || {};

  class AnfraBaseError extends Error {
    constructor (message, entity) {
      super(message);
      this.entity = entity;
    }
  }
  class ValidationError extends AnfraBaseError { get name () { return 'ValidationError'; } }
  class QueryError extends AnfraBaseError { get name () { return 'QueryError'; } }
  class PermissionError extends AnfraBaseError { get name () { return 'PermissionError'; } }
  class TransportError extends AnfraBaseError { get name () { return 'TransportError'; } }

  const NO_VALUE_OPS = new Set(['is_null', 'not_null', 'is_true', 'is_false']);
  const GRAINS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'];

  function toLogin () {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }

  async function post (url, body, signal, entity) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new TransportError(`Can't reach the gateway: ${err.message}`, entity);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      toLogin();
      throw new PermissionError(data.error || 'Sign in first', entity);
    }
    if (res.status === 503) throw new TransportError(data.error || 'anfra is unavailable', entity);
    if (!res.ok) throw new QueryError(data.error || `Request failed (${res.status})`, entity);
    return data;
  }

  // Calls fn once per tick however many changes happen in it.
  function batcher (fn) {
    let queued = false;
    return () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; fn(); });
    };
  }

  // Start and end (inclusive, as dates) of the period a truncated date value starts.
  function periodRange (value, grain) {
    const d = new Date(String(value).replace(' ', 'T').replace(/(\.\d+)?$/, '') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z'));
    if (Number.isNaN(d.getTime())) return null;
    const end = new Date(d);
    if (grain === 'year') end.setUTCFullYear(end.getUTCFullYear() + 1);
    else if (grain === 'quarter') end.setUTCMonth(end.getUTCMonth() + 3);
    else if (grain === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
    else if (grain === 'week') end.setUTCDate(end.getUTCDate() + 7);
    else if (grain === 'day') end.setUTCDate(end.getUTCDate() + 1);
    else return null;
    end.setUTCDate(end.getUTCDate() - 1);
    const iso = (x) => x.toISOString().slice(0, 10);
    return [iso(d), iso(end)];
  }

  function createApp (options = {}) {
    const entities = new Map();                     // name → query | filter | drill
    const mappings = [];                            // { control, query, field, aggregation }
    const edges = [];                               // { from, to } cross-filter
    const listeners = new Set();
    let selection = null;                           // { source, rows, fields, lossy }
    let changes = 0;
    let appliedChanges = 0;
    const notify = batcher(() => {
      for (const fn of listeners) try { fn(); } catch (err) { console.error(err); }
      for (const q of queries()) q._notify();
    });

    const queries = () => [...entities.values()].filter((e) => e.kind === 'query');
    const unique = (name) => {
      if (typeof name !== 'string' || !name) throw new ValidationError('A name is required');
      if (entities.has(name)) throw new ValidationError(`The name ${name} is already used in this app`, name);
    };
    const changed = () => { changes++; notify(); };

    // ---- What a query sends: its controls' conditions, drills, sort and the cross-filter.
    function inputFor (q) {
      const filters = [];
      const date_drills = [];
      for (const m of mappings) {
        if (m.query !== q) continue;
        const c = m.control;
        if (c.kind === 'filter') {
          const cond = c.condition;
          if (!cond || cond.operator === 'none') continue;
          const values = (cond.values || []).map((v) => (v === null || v === undefined ? v : String(v)));
          if (!NO_VALUE_OPS.has(cond.operator) && values.length === 0) continue;   // no values: no filter
          const f = { field: m.field, operator: cond.operator, values };
          if (cond.modifier) f.modifier = cond.modifier;
          if (m.aggregation) f.aggregation = m.aggregation;
          filters.push(f);
        } else if (c.kind === 'drill' && c.grain) {
          date_drills.push({ field: m.field, grain: c.grain });
        }
      }
      if (selection && selection.source !== q && edges.some((e) => e.from === selection.source && e.to === q)) {
        filters.push(...selectionFilters(selection));
      }
      const input = { filters, sorts: q._sorts, date_drills };
      if (options.timezone) input.timezone = options.timezone;
      return input;
    }

    function selectionFilters (sel) {
      const src = sel.source;
      const cols = (src.result?.columns || []).filter((c) => !c.isMeasure && c.field && (!sel.fields || sel.fields.includes(c.name)));
      if (!cols.length || !sel.rows.length) return [];
      const drillGrain = (field) => mappings.find((m) => m.query === src && m.control.kind === 'drill' && m.field === field)?.control.grain;
      if (sel.rows.length > 1 && cols.length > 1) {
        console.warn('anfra-user: a selection of several rows on several columns is applied as one list per column (a superset).');
      }
      const out = [];
      for (const col of cols) {
        const values = [...new Set(sel.rows.map((r) => r[col.name]))];
        if (col.semantic_type === 'date' || col.semantic_type === 'datetime') {
          const grain = drillGrain(col.field);
          if (!grain || values.length !== 1) {
            console.warn(`anfra-user: can't cross-filter on ${col.name} without a single value and a date drill; skipped.`);
            sel.lossy = true;
            continue;
          }
          const range = periodRange(values[0], grain);
          if (range) out.push({ field: col.field, operator: 'between', values: range });
          continue;
        }
        if (values.some((v) => v === null)) {
          if (values.length === 1) out.push({ field: col.field, operator: 'is_null', values: [] });
          else console.warn(`anfra-user: a null among several selected values of ${col.name} is ignored.`);
        }
        const nonNull = values.filter((v) => v !== null).map(String);
        if (nonNull.length) out.push({ field: col.field, operator: 'is', values: nonNull });
      }
      return out;
    }

    // ---- Query
    function createQuery (name, decl = {}) {
      unique(name);
      if (typeof decl.dataset !== 'string') throw new ValidationError('createQuery needs a dataset', name);
      if (typeof decl.aql !== 'string') throw new ValidationError('createQuery needs aql', name);
      if (decl.pageSize !== undefined && (!Number.isInteger(decl.pageSize) || decl.pageSize < 1)) {
        throw new ValidationError('pageSize must be a whole number of at least 1', name);
      }
      const subs = new Set();
      let controller = null;
      let lastSignature = null;
      let pagesLoaded = 0;

      const q = {
        kind: 'query', name, dataset: decl.dataset, aql: decl.aql, pageSize: decl.pageSize,
        state: 'idle', result: undefined, error: undefined, hasMore: false,
        _sorts: [],
        _notify () { for (const fn of subs) try { fn(); } catch (err) { console.error(err); } },
        _signature () { return JSON.stringify(inputFor(q)); },
        _dirty () { return lastSignature !== q._signature(); },
        async _run () {
          controller?.abort();
          controller = new AbortController();
          const input = inputFor(q);
          lastSignature = JSON.stringify(input);
          q.state = 'executing';
          q.error = undefined;
          notify();
          try {
            const data = await post('/pq', requestBody(input, 1), controller.signal, name);
            pagesLoaded = 1;
            q.result = toResult(data, decl.pageSize, 1);
            q.hasMore = Boolean(data.hasMore);
            q.state = 'success';
            return true;
          } catch (err) {
            if (err.name === 'AbortError') return null;
            q.state = 'error';
            q.error = err;
            return false;
          } finally {
            notify();
          }
        },
        setSort (sorts) {
          if (!Array.isArray(sorts)) throw new ValidationError('setSort takes a list of { field, direction }', name);
          q._sorts = sorts.map((s) => ({ field: s.field, direction: s.direction === 'desc' ? 'desc' : 'asc' }));
          changed();
        },
        async fetchMore () {
          if (!decl.pageSize) throw new ValidationError(`${name} has no pageSize: it has no more pages`, name);
          if (!q.hasMore) return;
          const input = inputFor(q);
          const data = await post('/pq', requestBody(input, pagesLoaded + 1), undefined, name);
          pagesLoaded++;
          const more = toResult(data, decl.pageSize, pagesLoaded);
          q.result = { ...q.result, rows: [...q.result.rows, ...more.rows], meta: { ...q.result.meta, numRows: q.result.rows.length + more.rows.length, page: pagesLoaded } };
          q.hasMore = Boolean(data.hasMore);
          notify();
        },
        select (rows, opts = {}) {
          if (!Array.isArray(rows)) throw new ValidationError('select takes a list of rows', name);
          const known = new Set(q.result?.rows || []);
          for (const r of rows) if (!known.has(r)) throw new ValidationError('select takes rows from this query\'s result', name);
          if (opts.fields) {
            const dims = new Set((q.result?.columns || []).filter((c) => !c.isMeasure).map((c) => c.name));
            for (const f of opts.fields) if (!dims.has(f)) throw new ValidationError(`${f} isn't a dimension column of ${name}`, name);
          }
          selection = rows.length ? { source: q, rows: [...rows], fields: opts.fields, lossy: false } : null;
          changed();
        },
        get selectedRows () {
          if (!selection || selection.source !== q) return [];
          const current = new Set(q.result?.rows || []);
          return selection.rows.filter((r) => current.has(r));
        },
        subscribe (fn) { subs.add(fn); return () => subs.delete(fn); },
        abort () { controller?.abort(); },
        locate () { return locateMarked('data-anfra-query', name); },
      };

      // What /pq takes: which page and query, the reader's input, and the page of rows.
      function requestBody (input, page) {
        return { path: ctx.page, name, ...input, page, ...(decl.pageSize ? { page_size: decl.pageSize } : {}) };
      }
      entities.set(name, q);
      return q;
    }

    function toResult (data, pageSize, page) {
      return {
        columns: data.columns, rows: data.rows,
        meta: pageSize ? { numRows: data.rows.length, page, pageSize } : { numRows: data.rows.length },
        debug: { executedAt: new Date().toISOString(), fromCache: false },
      };
    }

    // ---- Filter
    function createFilter (name, decl = {}) {
      unique(name);
      if (decl.field) {
        if (typeof decl.field !== 'string' || !/^[A-Za-z_]\w*\.[A-Za-z_]\w*$|^[A-Za-z_]\w*$/.test(decl.field)) {
          throw new ValidationError(`${decl.field} isn't a model.field or metric name`, name);
        }
        const ds = decl.dataset ?? (Object.keys(Anfra.datasets).length === 1 ? Object.keys(Anfra.datasets)[0] : undefined);
        if (!ds) throw new ValidationError('createFilter needs a dataset', name);
        const desc = Anfra.datasets[ds];
        if (!desc) throw new ValidationError(`Dataset ${ds} isn't available to this user (no scope or public entry in anfra-user.yml)`, name);
        decl = { ...decl, dataset: ds };
      }
      const f = {
        kind: 'filter', name, field: decl.field, dataset: decl.dataset, label: decl.label, type: decl.type,
        options: Array.isArray(decl.options) ? [...decl.options] : [],
        condition: decl.default ? { ...decl.default } : null,
        async loadOptions (search) {
          if (!decl.field) return f.options;
          const data = await post('/pq/options', { dataset: decl.dataset, field: decl.field, search: search || undefined }, undefined, name);
          f.options = data.options;
          notify();
          return f.options;
        },
        setCondition (cond) {
          if (!cond || typeof cond.operator !== 'string') throw new ValidationError('setCondition takes { operator, values }', name);
          for (const v of cond.values || []) {
            if (typeof v === 'number') throw new ValidationError('Send numbers as strings: a JS number may have lost digits', name);
          }
          f.condition = { ...cond, values: [...(cond.values || [])] };
          changed();
        },
        reset () {
          f.condition = decl.default ? { ...decl.default } : null;
          changed();
        },
        locate () { return locateMarked('data-anfra-control', name); },
      };
      entities.set(name, f);
      return f;
    }

    // ---- Date drill
    function createDateDrill (name, decl = {}) {
      unique(name);
      if (decl.default && !GRAINS.includes(decl.default)) throw new ValidationError(`${decl.default} isn't a grain`, name);
      const d = {
        kind: 'drill', name, label: decl.label, grain: decl.default || null,
        setGrain (grain) {
          if (!GRAINS.includes(grain)) throw new ValidationError(`${grain} isn't a grain`, name);
          d.grain = grain;
          changed();
        },
        locate () { return locateMarked('data-anfra-control', name); },
      };
      entities.set(name, d);
      return d;
    }

    function mapControl (control, query, opts = {}) {
      if (!control || !['filter', 'drill'].includes(control.kind) || entities.get(control.name) !== control) {
        throw new ValidationError('mapControl takes a filter or date drill of this app');
      }
      if (!query || query.kind !== 'query' || entities.get(query.name) !== query) throw new ValidationError('mapControl takes a query of this app');
      if (typeof opts.field !== 'string') throw new ValidationError('mapControl needs { field }', control.name);
      mappings.push({ control, query, field: opts.field, aggregation: opts.aggregation });
      changed();
    }

    function mapCrossFilter (from, to) {
      if (from === to) throw new ValidationError('A query can\'t cross-filter itself', from?.name);
      if (from?.kind !== 'query' || to?.kind !== 'query') throw new ValidationError('mapCrossFilter takes two queries of this app');
      if (from.dataset !== to.dataset) throw new ValidationError('Cross-filtered queries must use the same dataset', from.name);
      edges.push({ from, to });
    }

    async function execute () {
      const run = queries().filter((q) => q.state === 'idle' || q._dirty());
      appliedChanges = changes;
      notify();
      const results = await Promise.all(run.map(async (q) => [q.name, await q._run()]));
      return {
        succeeded: results.filter(([, ok]) => ok === true).map(([n]) => n),
        failed: results.filter(([, ok]) => ok === false).map(([n]) => n),
      };
    }

    const app = {
      title: options.title,
      timezone: options.timezone,
      createQuery, createFilter, createDateDrill, mapControl, mapCrossFilter, execute,
      async refresh () {
        for (const q of queries()) q.state = 'idle';
        return execute();
      },
      subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn); },
      get hasChanges () { return changes !== appliedChanges; },
      get selection () {
        return selection ? { query: selection.source.name, rows: selection.rows, fields: selection.fields, lossy: selection.lossy } : null;
      },
      clearSelection () { selection = null; changed(); },
      abort () { for (const q of queries()) q.abort(); },
    };
    return app;
  }

  function locateMarked (attr, name) {
    const els = [...document.querySelectorAll(`[${attr}]`)].filter((el) => el.getAttribute(attr).split(/\s+/).includes(name));
    if (!els.length) return false;
    els[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
  }

  const sdk = {
    createApp,
    datasets: ctx.datasets || {},
    user: ctx.user || null,
    scopes: ctx.scopes || {},
    page: ctx.page,
    plugins: { has: (name) => name === 'core', list: [{ name: 'core', version: 'anfra-user' }] },
    errors: { ValidationError, QueryError, PermissionError, TransportError },
  };
  const Anfra = sdk;
  // A page or Data App written against the anfra SDK finds it under the same name.
  if (!window.Anfra) window.Anfra = Anfra;
  window.AnfraUser = Object.assign(window.AnfraUser || {}, { createApp, sdk, ALL: '__ALL__' });
})();
