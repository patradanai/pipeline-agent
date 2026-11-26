/** Platform-neutral, read-only Git workspace inspection used by QA and delivery. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fingerprint of the working tree (diff + status + untracked contents). Never runs repo code. */
export function snapshotWorkingTree(cwd) {
  if (!cwd) return { available: false, reason: 'Workspace not available' };
  try {
    const root = execFileSync('git',['rev-parse','--show-toplevel'],{ cwd, encoding: 'utf8', timeout: 3500, stdio:['ignore','pipe','ignore'] }).trim();
    const diff = execFileSync('git',['diff','--binary','HEAD','--'],{ cwd: root, encoding:'buffer', maxBuffer: 16*1024*1024, timeout: 6500 });
    const porcelain = execFileSync('git',['status','--porcelain=v1','-z'],{ cwd: root, encoding:'buffer', maxBuffer: 4*1024*1024, timeout: 6500 });
    const untracked = execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{ cwd: root, encoding:'buffer', maxBuffer: 4*1024*1024, timeout:6500 });
    const hash = createHash('sha256'); hash.update(diff); hash.update(porcelain);
    const names = untracked.toString('utf8').split('\0').filter(Boolean);
    if (names.length > 250) return { available: false, reason: 'Too many untracked files for bounded snapshot' };
    for (const name of names) {
      if (!name || name.startsWith('/') || name.split('/').includes('..')) return { available: false, reason:'Untracked path safety check failed' };
      const path = join(root, name);
      const st = lstatSync(path);
      if (!st.isFile() || st.size > 5*1024*1024) return { available: false, reason:`Untracked file cannot be fingerprinted: ${name}` };
      hash.update(name); hash.update(readFileSync(path));
    }
    return { available: true, hash: hash.digest('hex'), root, files: names.length };
  } catch { return { available:false, reason: 'Git fingerprint unavailable (not a repository or command failed)' }; }
}

/** Read-only Git inventory of changed/untracked files for QA scoping. */
export function inspectWorkspaceScope(cwd) {
  const git = (args, limit = 1024 * 1024) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: limit, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '' }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const root = git(['rev-parse', '--show-toplevel']).trim();
    const head = git(['rev-parse', '--short', 'HEAD']).trim();
    const changed = git(['diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const files = [...new Set([...changed, ...untracked])].slice(0, 250);
    return {
      available: true, root, head, files,
      hasCurrentDiff: Boolean(changed.length || untracked.length),
      truncated: changed.length + untracked.length > 250,
      note: (changed.length || untracked.length)
        ? 'Working tree differences exist. Inspect these files and verify the exact approved BIZ/REQ/TC scope.'
        : 'No uncommitted files found relative to HEAD. Inspect approved target files directly; do not infer QA PASS or NOT_RUN solely from an empty diff.',
    };
  } catch {
    return { available: false, files: [], reason: 'Git status/diff inventory unavailable in this workspace. Use read/grep/glob and approved plan for a bounded static review; unverified runtime tests remain NOT_RUN.' };
  }
}
