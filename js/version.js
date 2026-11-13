// Written by tools/stamp-version.mjs from package.json. Bump the version there, then run the tool.
export const VERSION = '0.8.2';
export const BUILT = '2026-11-13';

/** "v0.8.0" */
export const versionLabel = () => `v${VERSION}`;

/** "13 Nov 2026" */
export function builtLabel() {
  const [y, m, d] = BUILT.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${d} ${month} ${y}`;
}
