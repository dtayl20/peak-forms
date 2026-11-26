// Single source of truth for the deploy build version.
//
// Derived from package.json `version` + git short SHA + build date, e.g.
//   "0.1.0-56b4046-20261009"
//
// It is consumed in two places so the embed URL and the widget it loads always
// agree: the SPA build (vite.config.js `define` -> Editor embed snippet) and the
// widget stamp (scripts/after-build.mjs -> dist/widget.js).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function buildVersion() {
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || pkgVersion;
  } catch { /* keep default */ }

  let sha = '';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* no git (e.g. tarball) — fall through */ }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return [pkgVersion, sha || 'nogit', date].join('-');
}
