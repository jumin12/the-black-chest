'use strict';
/**
 * Cross-platform `git lfs pull`.
 * Default: tolerate failure (npm postinstall won't break without git/lfs).
 * Strict: npm run pull-assets -- passes --fail to exit nonzero on git/lfs error.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const failOnError = process.argv.includes('--fail') || process.argv.includes('--require');

function main() {
  if (/^1|true|yes$/i.test(String(process.env.SKIP_LFS_POSTINSTALL || '').trim())) {
    console.log('[git-lfs-pull] SKIP_LFS_POSTINSTALL set, skipping.');
    process.exit(0);
    return;
  }
  const r = spawnSync('git', ['lfs', 'pull'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (r.error) {
    const msg = (r.error && r.error.message) ? r.error.message : String(r.error);
    console.warn('[git-lfs-pull] Could not run "git lfs pull":', msg);
    if (failOnError) process.exit(1);
    process.exit(0);
    return;
  }
  if (r.status !== 0 && r.status != null) {
    console.warn('[git-lfs-pull] git lfs pull exited with code', r.status);
    if (failOnError) process.exit(r.status);
  }
  process.exit(0);
}

main();
