// Scripted fake for lib/gh.mjs. Keys are a GraphQL operation name or `METHOD path`.

function opName(query) {
  return /\b(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? null;
}

export function createFakeGh(script = {}) {
  const calls = [];

  function respond(key, args) {
    const entry = script[key];
    if (entry === undefined) throw new Error(`fake-gh: no script for ${key}`);
    return typeof entry === 'function' ? entry(...args) : entry;
  }

  return {
    calls,
    async graphql(query, vars = {}) {
      const op = opName(query) ?? '(anonymous)';
      const isMutation = /^\s*mutation\b/.test(query);
      calls.push({ kind: 'graphql', key: op, query, vars, write: isMutation });
      const r = await respond(op, [vars, query]);
      return { data: null, errors: null, rate: {}, ...r };
    },
    async rest(method, path, body) {
      const m = method.toUpperCase();
      const key = `${m} ${path}`;
      calls.push({ kind: 'rest', key, method: m, path, body, write: m !== 'GET' });
      const r = await respond(key, [body]);
      return { data: null, rate: {}, ...r };
    },
    /** Non-GET REST calls and GraphQL mutations. */
    writes() {
      return calls.filter((c) => c.write);
    },
  };
}
