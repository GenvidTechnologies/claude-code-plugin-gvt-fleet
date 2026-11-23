// Fake status-line command for tests. Reads stdin, prints the cwd in cyan,
// and exits with the integer given as the first argument (default 0).
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let cwd;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed.cwd === 'string') cwd = parsed.cwd;
  } catch {
    // Not JSON: fall through to the default.
  }
  const esc = String.fromCharCode(27);
  const n = Number.parseInt(process.argv[2] ?? '0', 10);
  const code = Number.isInteger(n) ? n : 0;
  process.stdout.write(esc + '[36m' + (cwd ?? '-') + esc + '[0m', () => {
    process.exit(code);
  });
});
