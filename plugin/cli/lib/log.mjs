import nodeFs from 'node:fs';
import path from 'node:path';
import { LEGACY } from './legacy-names.mjs';

const LOG_NAME = 'gvt-fleet.log.jsonl';

// True when the path exists as any kind of entry. A dangling link counts as present.
function present(fs, file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    return undefined; // unknown: the caller skips the carry-over
  }
}

// `opts.fs` is a seam for tests that need a rename failure.
export function createLog(stateDir, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const file = path.join(stateDir, LOG_NAME);
  const oldFile = path.join(stateDir, LEGACY.logFile);
  let checked = false;
  const write = (event) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
  };
  // Carries the old log over once per log object. The old file is renamed only
  // when the new one is missing. A failed rename leaves both files in place.
  const carryOver = () => {
    if (checked) return;
    checked = true;
    // Only a definite "new missing, old present" renames. An unknown lstat result skips it.
    if (present(fs, file) !== false || present(fs, oldFile) !== true) return;
    try {
      fs.renameSync(oldFile, file);
    } catch (e) {
      // ENOENT: another process renamed it first; append as usual.
      if (e.code !== 'ENOENT') write({ event: 'log-rename-failed', from: LEGACY.logFile, code: e.code });
      return;
    }
    write({ event: 'log-renamed', from: LEGACY.logFile });
  };
  return {
    file,
    append(event) {
      fs.mkdirSync(stateDir, { recursive: true });
      carryOver();
      write(event);
    },
  };
}
