#!/usr/bin/env node
/**
 * Give the compiled CLI entry its executable bit.
 *
 * `tsc` writes mode 0644, so a fresh clone plus `npm run build` produces
 * `dist/src/cli/main.js` without execute permission. `npm install -g` links that
 * path into the global bin directory, and the resulting command fails with
 * "permission denied" - a failure that never shows up locally, because running
 * the file through `node dist/...` does not need the bit.
 *
 * The shebang itself lives in `src/cli/main.ts` so the compiler emits it.
 */
import { chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'dist', 'src', 'cli', 'main.js');

try {
  await access(ENTRY, constants.F_OK);
} catch {
  console.error(`build output missing: ${ENTRY} (run tsc first)`);
  process.exit(1);
}

// 0o755: owner rwx, group/other r-x. Not 0o777 - a world-writable file in a
// published package is a security problem, not a convenience.
await chmod(ENTRY, 0o755);

const { mode } = await import('node:fs').then((fs) => fs.statSync(ENTRY));
if ((mode & 0o100) === 0) {
  console.error(`failed to set the executable bit on ${ENTRY}`);
  process.exit(1);
}
console.log(`bin executable: ${path.relative(ROOT, ENTRY)}`);
