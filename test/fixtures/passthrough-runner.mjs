// Test fixture: calls passthrough() from lib/proc.mjs so the child's inherited
// output lands on this process's own stdout. Usage: passthrough-runner.mjs <exit code>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { passthrough } = await import(pathToFileURL(path.join(here, '..', '..', 'lib', 'proc.mjs')).href);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks);

const code = await passthrough(
  [process.execPath, path.join(here, 'fake-statusline.mjs'), process.argv[2] ?? '0'],
  { input },
);
process.exit(code);
