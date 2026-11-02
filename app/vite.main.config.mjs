import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function buildInfo() {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  let commit = '';
  let modified = false;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    modified = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* Source archives can be built without Git metadata. */ }
  return { commit, modified, buildDate: new Date().toISOString() };
}

export default defineConfig(() => ({
  define: { __ANNOBIO_BUILD_INFO__: JSON.stringify(buildInfo()) },
}));
