process.env.GVT_FLEET_FAKE_ONLY = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ConfigError,
  effectiveRepoSettings,
  loadConfig,
  repoShortName,
  resolveRepoArg,
  runWithConfig,
  validateBranchRecord,
  validateConfig,
} from '../lib/config.mjs';
import { parseOverlay } from '../lib/sync.mjs';
import { createFakeGh } from './fakes/fake-gh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dupFixture = path.join(here, 'fixtures', 'config-dup-name.json');

const base = (repos) => ({ version: 1, claimAccount: 'someone', repos });

test('R1: entry overrides enabled flag and label names', async () => {
  const cfg = base([
    { repo: 'example-org/archive', enabled: false },
    { repo: 'example-org/webapp', blockedLabel: 'waiting', triagedLabel: 'ready' },
  ]);
  const text = JSON.stringify(cfg);
  const loaded = await loadConfig({ file: 'x.json', readFile: async () => text });
  const off = effectiveRepoSettings(loaded.repos[0], {}, 'main');
  assert.equal(off.enabled, false);
  const on = effectiveRepoSettings(loaded.repos[1], {}, 'main');
  assert.equal(on.enabled, true);
  assert.equal(on.blockedLabel, 'waiting');
  assert.equal(on.triagedLabel, 'ready');
  assert.equal(on.inProgressLabel, 'in-progress');
  assert.equal(on.defaultBranch, 'main');
});

test('R2: bugTracker values overlay defaults and config overrides overlay bugTracker', () => {
  const none = effectiveRepoSettings({ repo: 'a/b' }, {}, 'main');
  assert.deepEqual(
    [none.triagedLabel, none.inProgressLabel, none.blockedLabel, none.defaultBranch],
    ['triaged', 'in-progress', 'blocked', 'main'],
  );
  const bt = { triagedLabel: 'bt-triaged', blockedLabel: 'bt-blocked', defaultBranch: 'trunk' };
  const overlaid = effectiveRepoSettings({ repo: 'a/b' }, bt, 'main');
  assert.equal(overlaid.triagedLabel, 'bt-triaged');
  assert.equal(overlaid.blockedLabel, 'bt-blocked');
  assert.equal(overlaid.inProgressLabel, 'in-progress');
  assert.equal(overlaid.defaultBranch, 'trunk');
  const top = effectiveRepoSettings({ repo: 'a/b', blockedLabel: 'entry-blocked' }, bt, 'main');
  assert.equal(top.blockedLabel, 'entry-blocked');
  assert.equal(top.triagedLabel, 'bt-triaged');
});

test('R192: config accepts a project of the form owner/number on a repo entry and rejects any other value', () => {
  const check = (entry) => validateConfig(base([{ repo: 'a/b', ...entry }]));
  assert.equal(check({ project: 'example-org/6' }).ok, true);
  assert.equal(effectiveRepoSettings({ repo: 'a/b', project: 'o/12' }, {}, 'main').project, 'o/12');
  assert.equal(effectiveRepoSettings({ repo: 'a/b' }, {}, 'main').project, null);
  for (const bad of ['o', 'o/0', 'o/x', '/6', 'o/6/7', '', 6]) {
    const r = check({ project: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.errors[0].message, /project must be a string of the form owner\/number/);
  }
});

test('R192: the retired nowLabel and nextLabel are unknown config keys, and the bugTracker overlay ignores them', () => {
  const check = (entry) => validateConfig(base([{ repo: 'a/b', ...entry }]));
  assert.match(check({ nowLabel: 'class:now' }).errors[0].message, /unknown key "nowLabel"/);
  assert.match(check({ nextLabel: 'class:next' }).errors[0].message, /unknown key "nextLabel"/);
  const { bugTracker, error } = parseOverlay('{"bugTracker": {"nowLabel": "bt-now", "triagedLabel": "bt-t"}}');
  assert.equal(error, null);
  assert.deepEqual(bugTracker, { triagedLabel: 'bt-t' });
  assert.equal('nowLabel' in effectiveRepoSettings({ repo: 'a/b' }, {}, 'main'), false);
});

test('R3: duplicate short name is an error naming both entries', async () => {
  await assert.rejects(loadConfig({ file: dupFixture }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.errors.length, 1);
    const { entry, message } = err.errors[0];
    assert.match(entry, /repos\[1\] GenvidTechnologies\/webapp/);
    assert.match(message, /duplicate short name "webapp"/);
    assert.match(message, /repos\[0\] example-org\/webapp/);
    return true;
  });
  // Other rejections, each placed where only its own rule applies.
  const bad = (repos) => validateConfig(base(repos));
  assert.match(bad([{ repo: 'noslash' }]).errors[0].message, /owner\/name/);
  assert.match(bad([{ repo: 'a/b' }, { repo: 'a/b' }]).errors[0].message, /duplicate repo/);
  assert.match(bad([{ repo: 'a/b', blockedLabel: 5 }]).errors[0].message, /blockedLabel must be/);
  assert.equal(bad([{ repo: 'a/b' }, { repo: 'c/d' }]).ok, true);
});

test('R3: unknown key is an error naming the entry', () => {
  const entryBad = validateConfig(base([{ repo: 'a/b' }, { repo: 'c/d', blokedLabel: 'x' }]));
  assert.equal(entryBad.ok, false);
  assert.equal(entryBad.errors.length, 1);
  assert.match(entryBad.errors[0].entry, /repos\[1\] c\/d/);
  assert.match(entryBad.errors[0].message, /unknown key "blokedLabel"/);
  const topBad = validateConfig({ ...base([{ repo: 'a/b' }]), extra: 1 });
  assert.equal(topBad.ok, false);
  assert.match(topBad.errors[0].message, /unknown key "extra"/);
});

test('R3: a config error stops before any gh write call', async () => {
  const gh = createFakeGh({});
  let ran = false;
  await assert.rejects(
    runWithConfig(
      dupFixture,
      gh,
      async () => {
        ran = true;
        await gh.rest('POST', '/repos/a/b/issues/1/labels', {});
      },
    ),
    ConfigError,
  );
  assert.equal(ran, false);
  assert.equal(gh.calls.length, 0);
  assert.equal(gh.writes().length, 0);
});

test('Q6: branch record validator accepts the documented format and rejects bad entries', () => {
  const good = {
    version: 1,
    repos: {
      'example-org/webapp': {
        'a-branch': { disposition: 'issue', issue: 'example-org/webapp#412', decided: '2026-11-04', by: 'coordinator' },
        'b-branch': { disposition: 'keep', decided: '2026-11-03', by: 'coach' },
      },
    },
  };
  assert.equal(validateBranchRecord(good).ok, true);
  const noIssue = structuredClone(good);
  delete noIssue.repos['example-org/webapp']['a-branch'].issue;
  assert.match(validateBranchRecord(noIssue).errors[0].message, /issue must be/);
  const keepWithIssue = structuredClone(good);
  keepWithIssue.repos['example-org/webapp']['b-branch'].issue = 'a/b#1';
  assert.match(validateBranchRecord(keepWithIssue).errors[0].message, /only allowed/);
});

test('R147: resolveRepoArg accepts the full name and the short name, case-insensitive, and gives null for an unknown repo', () => {
  const config = {
    version: 1,
    repos: [{ repo: 'example-org/Webapp' }, { repo: 'GenvidTechnologies/claude-code-plugin-gvt-dev' }],
  };
  assert.equal(resolveRepoArg('example-org/webapp', config), config.repos[0]);
  assert.equal(resolveRepoArg('EXAMPLE-ORG/WEBAPP', config), config.repos[0]);
  assert.equal(resolveRepoArg('webapp', config), config.repos[0]);
  assert.equal(resolveRepoArg('WEBAPP', config), config.repos[0]);
  assert.equal(resolveRepoArg('Claude-Code-Plugin-Gvt-Dev', config), config.repos[1]);
  assert.equal(resolveRepoArg('nothing', config), null);
  assert.equal(resolveRepoArg('example-org/nothing', config), null);
});

test('R147: repoShortName gives the part after the slash', () => {
  const config = { version: 1, repos: [{ repo: 'example-org/webapp' }] };
  assert.equal(repoShortName('example-org/webapp', config), 'webapp');
  assert.equal(repoShortName('GenvidTechnologies/claude-code-plugin-gvt-dev', config), 'claude-code-plugin-gvt-dev');
});
