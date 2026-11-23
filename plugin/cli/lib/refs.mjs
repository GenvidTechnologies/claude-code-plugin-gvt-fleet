// Resolve the refs that the installed refs grammar extracts into owner/name#N keys.
// Pure: the config enters as ownRepo and shortNames (short name -> owner/name).

// A ref the grammar marked repo-ambiguous carries target null: the repo name and the
// number are only in ref.line. Scan the line for every "name #N" / "name#N" candidate.
const NAME_REF_RE = /(?<![\w./-])([\w.-]+) ?#(\d+)(?!\w)/g;

function lookupShort(shortNames, name) {
  const lower = name.toLowerCase();
  for (const [short, repo] of Object.entries(shortNames ?? {})) {
    if (short.toLowerCase() === lower) return repo;
  }
  return undefined;
}

function lookupRepo(shortNames, repo) {
  const lower = repo.toLowerCase();
  for (const full of Object.values(shortNames ?? {})) {
    if (full.toLowerCase() === lower) return full;
  }
  return undefined;
}

export function resolveRef(ref, { ownRepo, shortNames } = {}) {
  if (ref.unresolvable === 'repo-ambiguous') {
    const line = typeof ref.line === 'string' ? ref.line : '';
    const wanted = ref.target && Number.isInteger(ref.target.number) ? ref.target.number : undefined;
    const candidates = [];
    for (const m of line.matchAll(NAME_REF_RE)) {
      if (wanted === undefined || Number(m[2]) === wanted) candidates.push({ name: m[1], number: Number(m[2]) });
    }
    if (candidates.length === 0) return { unresolved: 'repo-ambiguous: no name #N on the line' };
    // A word that is not a configured short name means the issue's own repo (user decision
    // 2026-11-03). The grammar gives no number, so one ref may resolve to several keys.
    const keys = [];
    for (const { name, number } of candidates) {
      const repo = lookupShort(shortNames, name);
      if (repo) keys.push({ key: `${repo}#${number}`, via: 'short-name' });
      else if (ownRepo) keys.push({ key: `${ownRepo}#${number}`, via: 'inferred-own-repo' });
      else return { unresolved: 'no-own-repo' };
    }
    // One candidate keeps the plain shape; several come back as `keys`.
    return keys.length === 1 ? keys[0] : { keys };
  }
  if (ref.unresolvable) return { unresolved: ref.unresolvable };
  const target = ref.target;
  if (!target || !Number.isInteger(target.number)) return { unresolved: 'no-target' };
  if (target.repo == null) {
    if (!ownRepo) return { unresolved: 'no-own-repo' };
    return { key: `${ownRepo}#${target.number}`, via: 'own-repo' };
  }
  const known = lookupRepo(shortNames, target.repo);
  if (known) return { key: `${known}#${target.number}`, via: 'owner/name' };
  // A repo outside the config is still a valid key (an external blocker), as written.
  return { key: `${target.repo}#${target.number}`, via: 'owner/name' };
}

export function resolveAll(refs, ctx) {
  const resolved = [];
  const unresolved = [];
  for (const ref of refs) {
    const r = resolveRef(ref, ctx);
    if (r.keys) for (const k of r.keys) resolved.push({ ref, key: k.key, via: k.via });
    else if (r.key) resolved.push({ ref, key: r.key, via: r.via });
    else unresolved.push({ ref, reason: r.unresolved });
  }
  return { resolved, unresolved };
}
