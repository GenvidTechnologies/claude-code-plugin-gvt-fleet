// Scripted fake with the same shape as createClaude in lib/claude-cli.mjs.
//
// script[op] is a value, a function (arg, callIndex) => value, or `sequence(a, b, ...)`: element n
// answers the n-th call of that op (the last element answers every later call). A plain array is
// a value, so `agents: [...]` still returns that list.
// `script.track: true` turns on a session list: startBg adds a session, agents lists the sessions,
// stop marks one `done`, and rm (when script.rm is absent) removes it.
import { bgArgv } from '../../plugin/cli/lib/claude-cli.mjs';

class Sequence {
  constructor(items) {
    this.items = items;
  }
}

export const sequence = (...items) => new Sequence(items);

export function createFakeClaude(script = {}) {
  const calls = [];
  const sessions = [];
  const counts = {};

  function respond(op, arg, fallback) {
    const n = counts[op] ?? 0;
    counts[op] = n + 1;
    let entry = script[op];
    if (entry === undefined) return typeof fallback === 'function' ? fallback(arg, n) : fallback;
    if (entry instanceof Sequence) entry = entry.items[Math.min(n, entry.items.length - 1)];
    return typeof entry === 'function' ? entry(arg, n) : entry;
  }

  const find = (id) => sessions.find((s) => s.id === id || s.sessionId === id);

  return {
    calls,
    sessions,
    async startBg(opts) {
      calls.push({ op: 'startBg', ...opts, argv: bgArgv(opts) });
      return respond('startBg', opts, () => {
        if (!script.track) return { stdout: '', id: 'fake0001' };
        const id = (0x1000a000 + sessions.length + 1).toString(16);
        sessions.push({ id, sessionId: `${id}-0000-4000-8000-000000000000`, name: opts.name, cwd: opts.cwd, kind: 'background', state: 'working' });
        return { stdout: `backgrounded ${id}\n`, id };
      });
    },
    async agents({ all = false } = {}) {
      calls.push({ op: 'agents', all });
      return respond('agents', { all }, () => (script.track ? sessions.map((s) => ({ ...s })) : []));
    },
    async stop(id) {
      calls.push({ op: 'stop', id });
      return respond('stop', id, () => {
        const s = script.track ? find(id) : null;
        if (s) s.state = 'done';
        return { code: 0, stdout: '', stderr: '' };
      });
    },
    async rm(id, opts = {}) {
      calls.push({ op: 'rm', id, ...opts });
      return respond('rm', { id, ...opts }, () => {
        const s = script.track ? find(id) : null;
        if (s) sessions.splice(sessions.indexOf(s), 1);
        return { code: 0, stdout: '', stderr: '' };
      });
    },
  };
}
