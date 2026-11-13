// Writes js/version.js from package.json's version and today's UTC date, so the
// game can show which build is running (title screen, settings, console).
//
//   node tools/stamp-version.mjs          # stamp after bumping package.json
//   node tools/stamp-version.mjs --check  # fail if js/version.js and package.json disagree (npm test)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = path.join(root, 'js', 'version.js');

if (process.argv.includes('--check')) {
  const { VERSION, BUILT } = await import(new URL('../js/version.js', import.meta.url));
  const problems = [];
  if (VERSION !== pkg.version) problems.push(`js/version.js says ${VERSION}, package.json says ${pkg.version}. Run: node tools/stamp-version.mjs`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(BUILT) || Number.isNaN(Date.parse(BUILT))) problems.push(`BUILT is not a date: ${BUILT}`);
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) problems.push(`VERSION is not major.minor.patch: ${VERSION}`);
  if (problems.length) { console.error('Version check failed:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log(`Version OK: v${VERSION} (${BUILT})`);
} else {
  const built = new Date().toISOString().slice(0, 10);
  writeFileSync(file, `// Written by tools/stamp-version.mjs from package.json. Bump the version there, then run the tool.
export const VERSION = '${pkg.version}';
export const BUILT = '${built}';

/** "v0.8.0" */
export const versionLabel = () => \`v\${VERSION}\`;

/** "13 Nov 2026" */
export function builtLabel() {
  const [y, m, d] = BUILT.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return \`\${d} \${month} \${y}\`;
}
`);
  console.log(`Stamped js/version.js: v${pkg.version} (${built})`);
}
