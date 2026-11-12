import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { getPaths, readJson } from './config.js';
import { checkpointExists } from './sessions.js';

// Sphinx keeps only what it still needs. Finished and abandoned checks, stale
// working contexts, and old background-job records are removed as it goes, and
// the whole data directory is held under a size cap, oldest files first.
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
export const STORAGE_CAP_BYTES = 20 * 1024 * 1024;

async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await files(full));
    else if (entry.isFile()) { const info = await stat(full).catch(() => null); if (info) out.push({ path: full, size: info.size, mtime: info.mtimeMs }); }
  }
  return out;
}

export async function storageUsage(env = process.env) {
  return (await files(getPaths(env).home)).reduce((total, file) => total + file.size, 0);
}

/** Best-effort cleanup; never throws. Recently touched files are always kept. */
export async function collectGarbage({ env = process.env, now = Date.now(), cap = STORAGE_CAP_BYTES } = {}) {
  const home = getPaths(env).home, removed = [];
  const drop = async file => { await rm(file, { force: true }).catch(() => {}); removed.push(file); };
  try {
    for (const file of await files(path.join(home, 'sessions'))) {
      if (!file.path.endsWith('.json') || now - file.mtime < HOUR) continue;
      const session = await readJson(file.path, null).catch(() => null);
      const expired = session?.status === 'passed' && Date.parse(session.expiresAt || 0) < now;
      const skipped = session?.status === 'skipped' && now - file.mtime > DAY;
      const abandoned = !['passed', 'skipped'].includes(session?.status) && now - file.mtime > 7 * DAY;
      if (!session || expired || skipped || abandoned) await drop(file.path);
    }
    for (const file of await files(path.join(home, 'context'))) {
      const context = await readJson(file.path, null).catch(() => null);
      const gone = context?.repoRoot && !(await stat(context.repoRoot).catch(() => null));
      if (!context || gone || now - file.mtime > 14 * DAY) await drop(file.path);
    }
    for (const directory of ['preparations', 'presentations', 'terminals', 'github/jobs']) {
      for (const file of await files(path.join(home, directory))) if (now - file.mtime > 7 * DAY) await drop(file.path);
    }
    // A branch's check records feed its pull request comment while it is active.
    for (const file of await files(path.join(home, 'github', 'branches'))) if (now - file.mtime > 30 * DAY) await drop(file.path);
    // A choice to comment on a pull request (github.js, saveCommentChoice) belongs to its
    // checkpoint and goes with it, so a check created again for the same change starts
    // without a stale choice.
    for (const file of await files(path.join(home, 'github', 'choices'))) {
      if (now - file.mtime > HOUR && !(await checkpointExists(path.basename(file.path, '.json'), env))) await drop(file.path);
    }
    // Size cap: drop the oldest removable data first. Hooks, settings, the
    // install manifest, and credentials are never candidates.
    const removable = (await Promise.all(['sessions', 'context', 'preparations', 'presentations', 'terminals', 'github'].map(dir => files(path.join(home, dir))))).flat()
      .filter(file => now - file.mtime > HOUR && !removed.includes(file.path)).sort((a, b) => a.mtime - b.mtime);
    let total = await storageUsage(env);
    for (const file of removable) { if (total <= cap) break; await drop(file.path); total -= file.size; }
  } catch { /* Cleanup must never affect a check. */ }
  return removed.length;
}
