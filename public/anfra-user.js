// anfra-user browser client. Load it from the gateway: <script src="/anfra-user.js"></script>
//
//   const au = AnfraUser.connect();
//   const me = await au.me();                    // { email, name, scopes: { country: ['Brazil'] | '__ALL__' } }
//   const res = await au.query('by_month', {     // { columns, rows, hasMore, page }
//     filters: [{ field: 'products.category', operator: 'is', values: ['Books'] }],
//     sorts: [{ field: 'period', direction: 'asc' }],
//   });
//
// Every number in rows arrives as a string with every digit, as anfra sends it: Number(v) to chart it.
(function () {
  class AnfraUserError extends Error {
    constructor (message, status) {
      super(message);
      this.name = 'AnfraUserError';
      this.status = status;
    }
  }

  function toLogin () {
    const next = location.pathname + location.search;
    location.href = '/login?next=' + encodeURIComponent(next);
  }

  async function request (method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      toLogin();
      throw new AnfraUserError(data.error || 'Sign in first', 401);
    }
    if (!res.ok) throw new AnfraUserError(data.error || `Request failed (${res.status})`, res.status);
    return data;
  }

  window.AnfraUser = {
    connect () {
      return {
        me: () => request('GET', '/me'),
        queries: () => request('GET', '/queries'),
        query: (name, options = {}) => request('POST', '/q/' + encodeURIComponent(name), options),
        logout: async () => {
          await request('POST', '/auth/logout', {});
          location.href = '/login';
        },
      };
    },
    ALL: '__ALL__',
  };
})();
