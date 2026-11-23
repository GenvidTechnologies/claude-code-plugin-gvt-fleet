// GitHub label and issue-path helpers shared by the modules that read or write labels.

import { GhError } from './gh.mjs';

const LABEL_COLOR = 'fbca04';

export const isNotFound = (e) => e instanceof GhError && /\b404\b|not found/i.test(`${e.message}\n${e.stderr ?? ''}`);
export const issuePath = (repo, number) => `repos/${repo}/issues/${number}`;
export const labelNames = (data) => (data?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));

/** GET the label; create it when GitHub says 404; read it back. Returns true when the label exists afterwards. */
export async function ensureLabel(gh, repo, name, color = LABEL_COLOR) {
  const path = `repos/${repo}/labels/${encodeURIComponent(name)}`;
  try {
    await gh.rest('GET', path);
    return true;
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  await gh.rest('POST', `repos/${repo}/labels`, { name, color });
  try {
    await gh.rest('GET', path);
    return true;
  } catch (e) {
    if (!isNotFound(e)) throw e;
    return false;
  }
}
