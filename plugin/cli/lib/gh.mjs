// GitHub access over `gh api`. Takes the process runner as a dependency.

function parseRate(stderr, headers) {
  const info = {};
  const text = `${headers ?? ''}\n${stderr ?? ''}`;
  const remaining = /x-ratelimit-remaining:\s*(\d+)/i.exec(text);
  const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(text);
  if (remaining) info.remaining = Number(remaining[1]);
  if (reset) info.reset = Number(reset[1]);
  if (/secondary rate limit/i.test(text)) info.secondary = true;
  else if (/rate limit/i.test(text)) info.limited = true;
  return info;
}

export class GhError extends Error {
  constructor(message, { code, stderr, rate } = {}) {
    super(message);
    this.name = 'GhError';
    this.code = code;
    this.stderr = stderr;
    this.rate = rate ?? {};
  }
}

/**
 * @param {{run: Function, onResult?: Function}} deps
 * onResult(info) is a hook point called after every call with {kind, rate}.
 */
export function createGh({ run, onResult } = {}) {
  async function call(argv, input, kind) {
    const res = await run(['gh', ...argv], { input });
    const rate = parseRate(res.stderr, '');
    if (onResult) onResult({ kind, rate, code: res.code });
    if (res.code !== 0) {
      // `gh api graphql` exits 1 on any GraphQL error but still prints the JSON with partial `data`.
      // Hand that back to the caller, unless GitHub is rate limiting us.
      const bodyRate = parseRate(res.stdout, '');
      if (kind === 'graphql' && !rate.limited && !rate.secondary && !bodyRate.secondary) {
        let body = null;
        try {
          body = JSON.parse(res.stdout);
        } catch {
          body = null;
        }
        if (body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object') {
          return { data: body, rate };
        }
      }
      // Otherwise `gh api` prints the JSON error body on stdout and a summary on stderr.
      throw new GhError(`gh ${argv[0]} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`, {
        code: res.code,
        stderr: res.stderr,
        rate: { ...bodyRate, ...rate },
      });
    }
    let data;
    try {
      data = res.stdout.trim() === '' ? null : JSON.parse(res.stdout);
    } catch (e) {
      throw new GhError(`gh ${argv[0]}: invalid JSON: ${e.message}`, { code: res.code, stderr: res.stderr });
    }
    return { data, rate };
  }

  return {
    /** Run a GraphQL query. Returns {data, errors, rate}. */
    async graphql(query, vars = {}) {
      const argv = ['api', 'graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(vars)) {
        argv.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
      }
      const { data, rate } = await call(argv, undefined, 'graphql');
      return { data: data?.data ?? null, errors: data?.errors ?? null, rate };
    },
    /** Run a REST call. Returns {data, rate}. */
    async rest(method, path, body) {
      const argv = ['api', '-X', method.toUpperCase(), path];
      let input;
      if (body !== undefined) {
        argv.push('--input', '-');
        input = JSON.stringify(body);
      }
      return call(argv, input, 'rest');
    },
  };
}
