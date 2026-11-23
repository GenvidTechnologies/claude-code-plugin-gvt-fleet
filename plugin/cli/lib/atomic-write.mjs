import fs from 'node:fs';
import path from 'node:path';

// Infix of the temporary file name written next to the target before the rename.
export const TMP_INFIX = '.tmp.gvt-fleet.';

// Returns the path to write for `file`: the real path when `file` is (or sits
// behind) a symbolic link, else `file` itself. A link to a missing file throws.
// A hard link is not detected; the rename splits it from the other names.
export function resolveWriteTarget(
  file,
  { realpath = fs.realpathSync.native, lstat = fs.lstatSync } = {},
) {
  try {
    return realpath(file);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  try {
    if (lstat(file).isSymbolicLink()) {
      throw new Error(`${file} is a symbolic link to a missing file`);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return file;
}

export function writeTextAtomic(requested, text) {
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const file = resolveWriteTarget(requested);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}${TMP_INFIX}${process.pid}`;
  const body = String(text).replace(/\r\n?/g, '\n');
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort: the original error is the one to report
    }
    throw err;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function writeJsonAtomic(file, value) {
  writeTextAtomic(file, JSON.stringify(sortKeys(value), null, 2) + '\n');
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Writes JSON (keys in insertion order) and retries the rename when another
// process holds the target. Returns true on success and false on giving up;
// it never throws.
export function writeJsonAtomicRetry(
  file,
  value,
  { attempts = 5, delayMs = 20, rename = fs.renameSync, sleep = sleepSync } = {},
) {
  const tmp = `${file}${TMP_INFIX}${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
    for (let attempt = 1; ; attempt += 1) {
      try {
        rename(tmp, file);
        return true;
      } catch (err) {
        if (!RETRY_CODES.has(err?.code) || attempt >= attempts) throw err;
        sleep(delayMs);
      }
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    return false;
  }
}
