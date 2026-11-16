import { appendFile, lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import path from 'node:path';
import { loadConfig, readJson, repositoryConfigInfo, REPOSITORY_CONFIG_KEYS, validateConfig, validateRepositoryConfig } from './config.js';
import { PROJECT_CONTEXT_FILE, PROJECT_CONTEXT_MAX_BYTES, PROJECT_CONTEXT_TEMPLATE, contextWithDescription } from './repo-context.js';

export const REPOSITORY_IGNORE_TEMPLATE = `# Files excluded from Sphinx assessments before content is read.
# Add project-specific private or generated paths below.
# Examples (uncomment as needed):
# dist/
# coverage/
# **/*.generated.*
# /private-notes/

# Supports *, **, ?, leading /, trailing /, and local ! exceptions.
# Built-in sensitive files, global ignores, and config exclusions cannot be restored.
# .env/.env.*, private keys, and common credentials files are always excluded.
`;

async function regularFileOrMissing(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`Cannot initialize over a symlink or non-regular file: ${file}`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function createOnly(file, contents) {
  try { await writeFile(file, contents, { flag: 'wx', mode: 0o644 }); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    await regularFileOrMissing(file);
    return false;
  }
}

/**
 * Keep a new context file out of Git on this machine only (.git/info/exclude),
 * so preferences stay personal unless the person chooses to commit it.
 */
export async function excludeFromGit(root, file) {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: root });
    const exclude = path.resolve(root, stdout.trim());
    const current = await readFile(exclude, 'utf8').catch(() => '');
    if (current.split('\n').some(line => line.trim() === `/${file}`)) return true;
    await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Sphinx: personal context and preferences. Commit it to share with your team.\n/${file}\n`);
    return true;
  } catch { return false; }
}

// The "mode" value in .sphinxconfig text, so a switch leaves the rest of the file as written.
const MODE_VALUE = /("mode"\s*:\s*)"(?:block|on-demand)"/g;

/**
 * Change only "mode" in an existing .sphinxconfig, the policy a team commits.
 * Never creates the file: sphinx init does, and init never replaces policy.
 * Keeps every other key and the file's formatting when it can prove the edit
 * touched nothing else; otherwise rewrites the same object with the new mode.
 */
export async function setRepositoryMode({ repoRoot, mode, env = process.env }) {
  const root = path.resolve(repoRoot);
  const info = await repositoryConfigInfo(root);
  if (!info.exists) throw new Error(`This repository has no .sphinxconfig, so it follows your machine-wide default. Create one with sphinx init --mode ${mode}, or change the default with sphinx mode ${mode} --global.`);
  if (info.legacy) throw new Error('This repository still uses the legacy .sphinx.json. Run sphinx init to carry it into .sphinxconfig, then run sphinx mode again.');
  const existing = await readJson(info.path);
  validateRepositoryConfig(existing, { env, source: '.sphinxconfig' });
  const previous = (await loadConfig(root, env)).mode ?? 'block';
  if (existing.mode === mode) return { path: info.path, previous, mode, changed: false };
  const next = { ...existing, mode };
  validateRepositoryConfig(next, { env, source: '.sphinxconfig' });
  const text = await readFile(info.path, 'utf8');
  const matches = text.match(MODE_VALUE) ?? [];
  let updated = matches.length === 1 ? text.replace(MODE_VALUE, `$1${JSON.stringify(mode)}`) : null;
  try { if (updated !== null && !isDeepStrictEqual(JSON.parse(updated), next)) updated = null; } catch { updated = null; }
  updated ??= `${JSON.stringify(next, null, 2)}\n`;
  // Written beside the file, then renamed over it, so a reader never sees half a policy.
  const temporary = `${info.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: 'wx', mode: (await stat(info.path)).mode & 0o777 });
    await rename(temporary, info.path);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return { path: info.path, previous, mode, changed: true };
}

/** Create repository policy files without overwriting existing policy or ignore rules. */
export async function initializeRepository({ repoRoot, config, overrides = {}, context, env = process.env }) {
  const root = path.resolve(repoRoot);
  const defaults = config || await loadConfig(undefined, env);
  validateConfig(defaults);
  validateRepositoryConfig(overrides, { env, source: '.sphinxconfig overrides' });
  const info = await repositoryConfigInfo(root);
  const configPath = path.join(root, '.sphinxconfig');
  const ignorePath = path.join(root, '.sphinxignore');
  const contextPath = path.join(root, PROJECT_CONTEXT_FILE);
  // Validate both existing policy files before making either mutation.
  const existing = info.exists ? await readJson(info.path) : null;
  if (info.exists) validateRepositoryConfig(existing, { env, source: path.basename(info.path) });
  await regularFileOrMissing(ignorePath);
  await regularFileOrMissing(contextPath);
  if (context !== undefined && (typeof context !== 'string' || !context.trim() || context.includes('\0') || Buffer.byteLength(context) > PROJECT_CONTEXT_MAX_BYTES)) throw new Error(`Project context must be nonempty text of at most ${PROJECT_CONTEXT_MAX_BYTES} bytes.`);
  const base = existing || Object.fromEntries(REPOSITORY_CONFIG_KEYS.map(key => [key, structuredClone(defaults[key])]));
  let local = { ...base, ...overrides };
  if (Object.hasOwn(overrides, 'exclude')) local.exclude = [...new Set([...(base.exclude || []), ...overrides.exclude])];
  validateRepositoryConfig(local, { env });

  const created = [];
  const preserved = [];
  if (!info.exists || info.legacy) {
    if (await createOnly(configPath, `${JSON.stringify(local, null, 2)}\n`)) created.push(configPath);
    else preserved.push(configPath);
  } else preserved.push(configPath);
  // Re-read after exclusive creation to honor an existing file or a concurrent initializer.
  local = await readJson(configPath);
  validateRepositoryConfig(local, { env });
  if (info.legacy || info.shadowed) preserved.push(info.legacy ? info.path : info.shadowed);
  if (await createOnly(ignorePath, REPOSITORY_IGNORE_TEMPLATE)) created.push(ignorePath);
  else preserved.push(ignorePath);
  let contextExcluded = false;
  if (await createOnly(contextPath, context === undefined ? PROJECT_CONTEXT_TEMPLATE : contextWithDescription(context))) {
    created.push(contextPath);
    contextExcluded = await excludeFromGit(root, PROJECT_CONTEXT_FILE);
  } else preserved.push(contextPath);
  return { configPath, ignorePath, contextPath, created, preserved, contextExcluded, config: local };
}

/**
 * Set this repository's understanding distance in .sphinxconfig, keeping every
 * other setting. A legacy .sphinx.json policy is carried into the new file.
 */
export async function setRepositoryDistance(repoRoot, distance, { env = process.env } = {}) {
  const info = await repositoryConfigInfo(repoRoot);
  const current = info.exists ? await readJson(info.path) : { version: 1 };
  const next = { ...current, version: current.version ?? 1, distance };
  validateRepositoryConfig(next, { env });
  const file = path.join(repoRoot, '.sphinxconfig');
  // Edit only the distance line of an existing .sphinxconfig, so its layout survives.
  const text = info.exists && !info.legacy ? await readFile(file, 'utf8') : null;
  const edited = text === null ? null : Object.hasOwn(current, 'distance')
    ? text.replace(/("distance"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(distance)}`)
    : text.replace(/\s*\}\s*$/, match => `,\n  "distance": ${JSON.stringify(distance)}${match.startsWith('\n') ? match : `\n${match.trimStart()}`}`);
  let output = `${JSON.stringify(next, null, 2)}\n`;
  try { if (edited !== null && JSON.stringify(JSON.parse(edited)) === JSON.stringify(next)) output = edited; } catch { /* Fall back to rewriting the file. */ }
  await writeFile(file, output, { mode: 0o644 });
  return file;
}
