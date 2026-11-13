import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { settingsTarget } from './user-file.js';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { blocksGit, getPaths, loadConfig } from './config.js';
import { nativeHookSpecs, installedHookSpecs, hasHook, addHook, removeHook, prepareMcp, commitMcp, rollbackMcp, removeMcp, inspectMcp } from './agent-settings.js';
import { lifecycleHome, prepareCursorIntegration, prepareOpenCodeIntegration, removeLifecycleIntegration, lifecycleIntegrationStatus } from './lifecycle-integrations.js';
import { preparePiIntegration, removePiIntegration, piIntegrationStatus, piIntegrationHome } from './pi-integration.js';

// All documented Git hook names, including server, mail, p4, and fsmonitor hooks.
const HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout',
  'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive',
  'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite',
  'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
];
const GATED = new Set(['pre-push', 'pre-commit']);
const PREPARED = new Set(['post-commit', 'post-merge', 'post-rewrite', 'post-checkout']);
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

/**
 * The shell command hooks use to run Sphinx. Prefer the package manager's own
 * `sphinx` on PATH (an npm/yarn symlink or a pnpm/bun shim): it survives
 * upgrades, unlike a versioned store path. Node's directory is put first on
 * PATH so GUI-launched agents without a login PATH still find node. A checkout
 * without such a shim falls back to absolute node and CLI paths.
 * Returns shell `env` assignments (placed before any exec) and the `command`.
 */
export async function sphinxLauncher(cliPath, env = process.env, execPath = process.execPath) {
  const real = await realpath(cliPath).catch(() => cliPath);
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
    const candidate = path.join(directory, 'sphinx');
    try {
      const info = await stat(candidate);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
      const matches = await realpath(candidate) === real
        || (info.size < 64 * 1024 && (await readFile(candidate, 'utf8')).includes('sphinx-understand/bin/sphinx.js'));
      if (matches) return { env: `PATH=${quote(path.dirname(execPath))}:"$PATH" `, command: quote(candidate) };
    } catch { /* Not a usable shim. */ }
  }
  return { env: '', command: `${quote(execPath)} ${quote(cliPath)}` };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const AGENTS = ['codex', 'claude', 'pi', 'cursor', 'opencode'];

function gitEnvironment(env) {
  // An explicit integration home must never write the caller's real global file.
  return env.SPHINX_USER_HOME ? {
    ...env, HOME: env.SPHINX_USER_HOME,
    GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL || path.join(env.SPHINX_USER_HOME, '.gitconfig'),
  } : env;
}

async function git(args, cwd, env, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => accepted.includes(code)
      ? resolve(stdout.trimEnd())
      : reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`)));
  });
}

async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await readFile((await settingsTarget(file)).path, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('expected an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error(`Cannot read ${file}: invalid JSON. Fix the file and try again.`);
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

async function writeJson(link, value) {
  // Write through a dotfiles symlink to its target, atomically, keeping the link.
  const file = (await settingsTarget(link)).path;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await stat(file).then(s => s.mode & 0o777).catch(() => 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function manifestFor(env) {
  const paths = getPaths(env);
  const manifest = await readJson(paths.install, { version: 1, installs: {}, agents: {} });
  if (manifest.version !== 1 || !manifest.installs || !manifest.agents) throw new Error('Unsupported Sphinx install manifest.');
  return { paths, manifest };
}

async function repoInfo(cwd, env) {
  const root = await git(['rev-parse', '--show-toplevel'], cwd, env);
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env);
  // Git refuses --worktree in a repository with linked worktrees unless the extension is on, so ask only then.
  const worktreeEnabled = await git(['config', '--bool', '--get', 'extensions.worktreeConfig'], cwd, env, [0, 1]);
  const worktreeValue = worktreeEnabled === 'true' ? await git(['config', '--worktree', '--get', 'core.hooksPath'], cwd, env, [0, 1]) : '';
  const scope = worktreeValue ? '--worktree' : '--local';
  const identity = scope === '--worktree' ? root : commonDir;
  return { root, commonDir, scope, id: `repo-${hash(identity).slice(0, 20)}` };
}

async function currentConfig(scope, cwd, env, { expand = false } = {}) {
  const output = await git(['config', scope, '--null', ...(expand ? ['--path'] : []), '--get-all', 'core.hooksPath'], cwd, env, [0, 1]);
  return output ? output.replace(/\0$/, '').split('\0') : [];
}

// Resolves symlinks through the nearest existing ancestor, so a folder that is
// gone compares equal to its parent's real path (macOS /var is /private/var).
async function canonical(file) {
  const resolved = path.resolve(file);
  try { return await realpath(resolved); } catch {}
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(await canonical(parent), path.basename(resolved));
}

function isInside(root, directory) {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// The directory Git resolves a relative core.hooksPath against: the working tree
// root (each linked worktree has its own, including worktrees of a bare repository),
// or the Git directory of a bare repository. Outside any repository, cwd stands in.
async function hooksPathBase(cwd, env) {
  try { return await git(['rev-parse', '--show-toplevel'], cwd, env); } catch {}
  try {
    if (await git(['rev-parse', '--is-bare-repository'], cwd, env) === 'true') return await git(['rev-parse', '--absolute-git-dir'], cwd, env);
  } catch {}
  return cwd;
}

// Resolves core.hooksPath values, as Git does from cwd, to the real path of the folder
// they name, or null for no value. Every check compares these folders, never the
// spelling. Values must come from git config --path: an unexpanded ~ would resolve
// as a folder named ~. Only a relative value needs the base, which Git reports once.
function hooksPathResolver(cwd, env) {
  let base;
  return async value => {
    if (!value) return null;
    if (path.isAbsolute(value)) return canonical(value);
    base ??= hooksPathBase(cwd, env);
    return canonical(path.resolve(await base, value));
  };
}

// The recorded Sphinx install whose hooks folder is this resolved folder.
async function installForFolder(folder, manifest) {
  if (!folder) return null;
  for (const entry of Object.values(manifest.installs)) {
    if (await canonical(entry.hookDir) === folder) return entry;
  }
  return null;
}

// A tool that sets a repository's own core.hooksPath can still run the Sphinx hooks: each of
// its hooks ends by running the global hook of the same name (hublo-tools does this, after
// husky). Nothing in that folder says so reliably, so a Sphinx hook that runs while the
// repository's hooks setting names a folder no install records writes it down: that folder
// demonstrably passes control on to this install. Doctor and install trust it from then on.
const chainsFile = paths => path.join(paths.home, 'chains.json');
const ACTION = { 'pre-push': 'push', 'pre-commit': 'commit' };

async function recordChain({ event, entry, cwd, env, paths, manifest }) {
  const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
  const folder = await hooksPathResolver(cwd, env)(effective);
  if (!folder || await installForFolder(folder, manifest)) return;
  const stored = await readJson(chainsFile(paths), {});
  const chains = stored.version === 1 && stored.folders && typeof stored.folders === 'object' ? stored : { version: 1, folders: {} };
  const previous = chains.folders[folder];
  const record = previous?.install === entry.id && previous.events ? previous : { install: entry.id, events: {} };
  record.events[event] = new Date().toISOString();
  chains.folders[folder] = record;
  await writeJson(chainsFile(paths), chains);
}

// How a folder that hides the Sphinx hooks still reaches them: the install it was seen running,
// the gated events this repository's policy checks that it has not run through it (or no longer
// has a hook for), and the latest one it did run. Null when it was never seen running one.
async function chainCoverage(folder, { cwd, env, paths, manifest }) {
  if (!folder) return null;
  const chains = await readJson(chainsFile(paths), null).catch(() => null);
  const record = chains?.version === 1 ? chains.folders?.[folder] : null;
  const entry = record?.events && manifest.installs[record.install];
  if (!entry) return null;
  const root = await git(['rev-parse', '--show-toplevel'], cwd, env).catch(() => null);
  const config = root ? await loadConfig(root, env).catch(() => null) : null;
  const required = (config?.events ?? [...GATED]).filter(event => GATED.has(event));
  const missing = [];
  for (const event of required) {
    let runnable = false;
    try { await access(path.join(folder, event), constants.X_OK); runnable = true; } catch {}
    if (!runnable || !record.events[event]) missing.push(event);
  }
  const [last] = Object.entries(record.events).filter(([event]) => GATED.has(event)).sort(([, a], [, b]) => String(b).localeCompare(String(a)));
  return { entry, missing, last };
}

// A folder under Sphinx's own hooks directory that no install records is an orphan,
// left behind by a lost or reset manifest; chaining to it would make every
// pass-through hook call itself.
async function isOrphanedSphinxHookDir(folder, paths) {
  return isInside(await canonical(path.join(paths.home, 'hooks')), folder);
}

// The hooks setting an install replaces, with the config scope it comes from, in the
// option form an install records (--global, --system, --local, --worktree; --command
// for a value from git -c or the environment, which is no git config option).
async function hooksPathBeforeInstall(repo, cwd, env) {
  if (repo) {
    const output = await git(['config', '--show-scope', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
    const tab = output.indexOf('\t');
    return output ? { scope: `--${output.slice(0, tab)}`, value: output.slice(tab + 1) } : null;
  }
  // A global install replaces the setting every repository falls back to, so a
  // local or worktree value around cwd is not it: ask the global, then the system file.
  const global = await git(['config', '--global', '--includes', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
  if (global) return { scope: '--global', value: global };
  const system = await git(['config', '--system', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1, 128]);
  return system ? { scope: '--system', value: system } : null;
}

async function sourceBeforeInstall({ repo, cwd, env, paths, manifest, resolveHooksPath }) {
  const setting = await hooksPathBeforeInstall(repo, cwd, env);
  if (!setting) return { source: { kind: 'default' } };
  const folder = await resolveHooksPath(setting.value);
  const inherited = await installForFolder(folder, manifest);
  if (inherited) return { source: inherited.source };
  // Never take Sphinx's own hooks folder for the one it replaced: what was there
  // before Sphinx is unknown, so chain to Git's default hooks folder instead.
  if (await isOrphanedSphinxHookDir(folder, paths)) return { source: { kind: 'default' }, orphan: setting };
  return { source: { kind: 'path', value: setting.value } };
}

// Where a setting that names an orphan lives on after this install, and how to clear it.
function orphanWarning({ value, scope }, repo) {
  const base = `core.hooksPath pointed at a Sphinx hooks folder no install records (${value}); existing hooks now chain from Git's default hooks folder. Uninstall restores the original setting.`;
  if (scope === '--system') return `${base} The system core.hooksPath still names that folder${repo ? '' : ' and applies again after uninstall'}; remove it with: git config --system --unset-all core.hooksPath`;
  if (repo && scope === '--global') return `${base} The global core.hooksPath still names that folder; run sphinx install without --repo to repair it.`;
  return base;
}

function sourceShell(source) {
  // git init runs reference-transaction while creating HEAD, before rev-parse
  // accepts the new repository; Git still exports that repository as GIT_DIR.
  return source.kind === 'path'
    ? `hook_dir=${quote(source.value)}\n`
    : 'if ! hook_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then\n  if [ -z "${GIT_DIR:-}" ] || [ ! -d "$GIT_DIR" ]; then\n    git rev-parse --git-common-dir >/dev/null\n    exit 128\n  fi\n  hook_dir=$GIT_DIR\nfi\nhook_dir="$hook_dir/hooks"\n';
}

function hookScript({ event, source, launcher, home, id }) {
  const header = '#!/bin/sh\n# Managed by Sphinx. Existing hooks remain in their original directory.\n';
  if (GATED.has(event)) {
    return `${header}SPHINX_HOME=${quote(home)} SPHINX_INSTALL_ID=${quote(id)} ${launcher.env}exec ${launcher.command} hook git ${quote(event)} "$@"\n`;
  }
  if (PREPARED.has(event)) {
    // The existing hook retains streaming stdin and its exit status. Scheduling
    // has no terminal, runs asynchronously, and never gates the Git operation.
    return `${header}${sourceShell(source)}hook="$hook_dir/${event}"\nstatus=0\nif [ -x "$hook" ]; then\n  "$hook" "$@"\n  status=$?\nfi\nif [ "\${SPHINX_EVALUATOR:-}" != "1" ]; then\n  SPHINX_HOME=${quote(home)} ${launcher.env}${launcher.command} prepare </dev/null >/dev/null 2>&1 &\nfi\nexit "$status"\n`;
  }
  // Protocol hooks such as proc-receive must retain streaming stdin/stdout.
  // They exec the prior hook directly rather than buffering input in Node.
  return `${header}${sourceShell(source)}hook="$hook_dir/${event}"\nif [ -x "$hook" ]; then\n  exec "$hook" "$@"\nfi\nexit 0\n`;
}

async function hookNames(source, cwd, env, resolveHooksPath) {
  let directory;
  if (source.kind === 'path') directory = await resolveHooksPath(source.value);
  else {
    try { directory = path.join(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env), 'hooks'); }
    catch { return HOOKS; }
  }
  const existing = await readdir(directory).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return [];
    throw error;
  });
  return [...new Set([...HOOKS, ...existing.filter(name => /^[a-z][a-z0-9-]*$/.test(name))])];
}

async function executable(name, env) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try { await access(path.join(directory, name), constants.X_OK); return true; } catch {}
  }
  return false;
}

async function detectedAgents({ paths, env, manifest }) {
  const integrationHome = name => name === 'pi'
    ? piIntegrationHome(paths, env)
    : ['cursor', 'opencode'].includes(name) ? lifecycleHome(name, paths, env) : paths[`${name}Home`];
  return (await Promise.all(AGENTS.map(async name =>
    (await executable(name, env) || await exists(integrationHome(name)) || manifest.agents[name]) ? name : null))).filter(Boolean);
}

export async function detectAgents({ env = process.env } = {}) {
  const { paths, manifest } = await manifestFor(env);
  return detectedAgents({ paths, env, manifest });
}

async function prepareAgents({ agents, paths, env, cliPath, launcher, manifest }) {
  const selected = agents === 'auto'
    ? await detectedAgents({ paths, env, manifest })
    : agents === 'none' ? [] : Array.isArray(agents) ? agents : agents.split(',').map(x => x.trim());
  if ((!selected.length && agents !== 'auto' && agents !== 'none') || selected.some(name => !AGENTS.includes(name))) throw new Error('--agents must be auto, none, or a comma-separated list of codex, claude, pi, cursor, opencode.');
  const result = [];
  for (const name of new Set(selected)) {
    if (['pi', 'cursor', 'opencode'].includes(name)) {
      const prepare = name === 'pi' ? preparePiIntegration : name === 'cursor' ? prepareCursorIntegration : prepareOpenCodeIntegration;
      result.push(await prepare(paths, { env, cliPath, launcher, previous: manifest.agents[name] }));
      continue;
    }
    const file = path.join(paths[`${name}Home`], name === 'codex' ? 'hooks.json' : 'settings.json');
    const document = await readJson(file, {});
    if (document.hooks !== undefined && (!document.hooks || typeof document.hooks !== 'object' || Array.isArray(document.hooks))) throw new Error(`Invalid hooks object in ${file}`);
    const command = `SPHINX_HOME=${quote(paths.home)} ${launcher.env}${launcher.command} hook agent ${name}`;
    const handler = { type: 'command', command, timeout: 10 };
    const hooks = nativeHookSpecs(name, handler);
    for (const { event } of hooks) {
      if (document.hooks?.[event] !== undefined && (!Array.isArray(document.hooks[event]) || document.hooks[event].some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks)))) throw new Error(`Invalid ${event} hooks in ${file}`);
    }
    const previous = manifest.agents[name];
    if (previous && previous.file !== file) throw new Error(`${name} integration home changed. Uninstall the existing integration using its original home before reinstalling.`);
    for (const spec of previous ? installedHookSpecs(previous) : []) {
      const old = spec.group.hooks[0];
      const lookalike = (document.hooks?.[spec.event] || []).some(group => group.hooks.some(item => old.type === 'command' ? item?.command === old.command : item?.server === old.server && item?.tool === old.tool));
      if (!hasHook(document, spec) && lookalike) throw new Error(`Refusing to replace an edited ${name} integration in ${file}. Uninstall first to preserve your edits.`);
    }
    const mcp = await prepareMcp({ name, paths, env, cliPath, previous: previous?.mcp });
    const emptyEvents = previous?.emptyEvents ?? hooks.filter(({ event }) => Array.isArray(document.hooks?.[event]) && document.hooks[event].length === 0).map(({ event }) => event);
    result.push({ name, file, document, originalDocument: structuredClone(document), handler, hooks, mcp, previous, emptyEvents, existed: previous?.existed ?? await exists(file) });
  }
  return result;
}

export async function installedAgents({ env = process.env } = {}) {
  const { manifest } = await manifestFor(env);
  return AGENTS.filter(name => manifest.agents[name]);
}

export async function install({ config, agents = 'auto', repo = false, cwd = process.cwd(), env = process.env, cliPath }) {
  if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('Installation requires an absolute CLI path.');
  if (process.platform === 'win32') throw new Error('Use Sphinx from WSL; native Windows installation is not supported yet.');
  const { paths, manifest } = await manifestFor(env);
  const messages = [], warnings = [];
  const info = repo ? await repoInfo(cwd, env) : { id: 'global', scope: '--global', root: null };
  const id = info.id;
  const previous = manifest.installs[id];
  // Validate every selected settings file before mutating any integration.
  const launcher = await sphinxLauncher(cliPath, env);
  const agentPlans = await prepareAgents({ agents, paths, env, cliPath, launcher, manifest });
  // Raw values are what uninstall restores; comparisons need them expanded, as Git reads them.
  const scopeValues = await currentConfig(info.scope, cwd, env);
  const resolveHooksPath = hooksPathResolver(cwd, env);
  if (previous && await resolveHooksPath((await currentConfig(info.scope, cwd, env, { expand: true })).at(-1)) !== await canonical(previous.hookDir)) {
    throw new Error('Git hooks changed since Sphinx was installed. Run sphinx uninstall first; your current configuration will be preserved.');
  }
  let entry = previous;
  if (!entry) {
    const { source, orphan } = await sourceBeforeInstall({ repo, cwd, env, paths, manifest, resolveHooksPath });
    // Only the chain source changes for an orphaned folder. previousValues keeps the
    // original setting, so uninstall still restores exactly what was there before.
    if (orphan) warnings.push(orphanWarning(orphan, repo));
    entry = { id, scope: info.scope, root: info.root, hookDir: path.join(paths.home, 'hooks', id), previousValues: scopeValues, source, files: {} };
  }
  const directoryState = await lstat(entry.hookDir).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (directoryState?.isSymbolicLink()) throw new Error(`Refusing to replace a symlinked hook directory: ${entry.hookDir}`);
  const names = await hookNames(entry.source, cwd, env, resolveHooksPath);
  const scripts = names.map(event => ({ event, content: hookScript({ event, source: entry.source, launcher, home: paths.home, id }) }));
  for (const { event, content } of scripts) {
    const file = path.join(entry.hookDir, event);
    const fileState = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (fileState?.isSymbolicLink()) throw new Error(`Refusing to overwrite edited hook symlink: ${file}`);
    if (fileState) {
      const current = await readFile(file, 'utf8');
      if (hash(current) !== entry.files[event] && current !== content) throw new Error(`Refusing to overwrite edited hook: ${file}`);
    }
  }
  await mkdir(entry.hookDir, { recursive: true, mode: 0o700 });
  for (const { event, content } of scripts) {
    const file = path.join(entry.hookDir, event);
    await writeFile(file, content, { mode: 0o755 });
    await chmod(file, 0o755);
    entry.files[event] = hash(content);
  }
  entry.preparationVersion = 1;
  manifest.installs[id] = entry;
  await writeJson(paths.install, manifest);
  await git(['config', info.scope, '--replace-all', 'core.hooksPath', entry.hookDir], cwd, env);
  messages.push(`Git hooks installed ${repo ? `for ${info.root}` : 'for this user'}. Existing hooks are chained.`);
  for (const plan of agentPlans) {
    if (plan.commit) {
      await plan.commit();
      try {
        manifest.agents[plan.name] = plan.record;
        await writeJson(paths.install, manifest);
      } catch (error) { await plan.rollback(); throw error; }
      messages.push(plan.name === 'pi' ? 'Pi extension installed with native human questionnaire dialogs.' : `${plan.name === 'cursor' ? 'Cursor lifecycle hooks' : 'OpenCode lifecycle plugin'} installed with local browser questionnaires; no automatic terminal popup.`);
      continue;
    }
    const { name, file, document, handler, hooks, mcp, previous: prior, existed, emptyEvents } = plan;
    for (const spec of prior ? installedHookSpecs(prior) : []) removeHook(document, spec);
    for (const spec of hooks) addHook(document, spec);
    await commitMcp(mcp);
    try {
      if (!same(await readJson(file, {}), plan.originalDocument)) throw new Error(`Settings changed during installation: ${file}. Retry installation.`);
      await writeJson(file, document);
    } catch (error) { await rollbackMcp(mcp); throw error; }
    manifest.agents[name] = { file, handler, hooks, existed, emptyEvents, mcp: mcp.record };
    await writeJson(paths.install, manifest);
    messages.push(`${name === 'codex' ? 'Codex' : 'Claude Code'} native questionnaire hooks and Sphinx MCP server installed.`);
  }
  if (!agentPlans.length && agents === 'auto') warnings.push('No supported coding agent was detected. Install one, then rerun sphinx install; Git hooks are ready.');
  if (!repo) {
    try {
      await git(['rev-parse', '--git-dir'], cwd, env);
      const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
      const folder = await resolveHooksPath(effective);
      const chained = await chainCoverage(folder, { cwd, env, paths, manifest });
      if (!await installForFolder(folder, manifest) && !(chained && !chained.missing.length)) warnings.push('This repository overrides core.hooksPath. Run sphinx install --repo here to chain that hook setup.');
    } catch {}
  }
  return { messages, warnings, agents: agentPlans.map(plan => plan.name) };
}

export async function uninstall({ env = process.env, cwd = process.cwd(), repo = false } = {}) {
  const { paths, manifest } = await manifestFor(env);
  const messages = [], warnings = [];
  const id = repo ? (await repoInfo(cwd, env)).id : 'global';
  const entry = manifest.installs[id];
  if (entry) {
    const resolveHooksPath = hooksPathResolver(cwd, env);
    const values = await currentConfig(entry.scope, cwd, env, { expand: true });
    const owned = values.length === 1 && await resolveHooksPath(values[0]) === await canonical(entry.hookDir);
    if (owned) {
      await git(['config', entry.scope, '--unset-all', 'core.hooksPath'], cwd, env, [0, 5]);
      for (const value of entry.previousValues) await git(['config', entry.scope, '--add', 'core.hooksPath', value], cwd, env);
    } else warnings.push('Git core.hooksPath changed after installation; the current setting was preserved.');
    const hookDirectoryState = await lstat(entry.hookDir).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (hookDirectoryState?.isSymbolicLink()) warnings.push(`Preserved edited hook directory symlink: ${entry.hookDir}`);
    for (const [name, digest] of Object.entries(hookDirectoryState?.isSymbolicLink() ? {} : entry.files)) {
      const file = path.join(entry.hookDir, name);
      const state = await lstat(file).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (state?.isSymbolicLink()) { warnings.push(`Preserved edited hook symlink: ${file}`); continue; }
      if (!await exists(file)) continue;
      if (hash(await readFile(file)) === digest) await rm(file);
      else warnings.push(`Preserved edited hook: ${file}`);
    }
    await rmdir(entry.hookDir).catch(() => {});
    // Uninstall stays reversible, but a restored folder that is gone disables every hook.
    // Git uses only the last value, checked from cwd. A relative global value names a
    // folder in each repository, so it is not checked. A relative local value is checked
    // in cwd's worktree only; the repository's other worktrees resolve it from their own roots.
    const effective = owned ? (await currentConfig(entry.scope, cwd, env, { expand: true })).at(-1) : null;
    if (effective && (path.isAbsolute(effective) || entry.scope !== '--global') && !await exists(await resolveHooksPath(effective))) {
      warnings.push(`Restored core.hooksPath to ${effective}, its setting before installation, but that folder no longer exists, so Git runs no hooks. If nothing else needs it, remove it with: git config ${entry.scope} --unset-all core.hooksPath`);
    }
    delete manifest.installs[id];
    messages.push(`Removed ${repo ? 'repository' : 'global'} Git integration.`);
  } else messages.push(`No ${repo ? 'repository' : 'global'} Git integration was installed.`);
  // Repository uninstall only removes its Git override; agent integration is user-wide.
  if (!repo) {
    for (const [name, installed] of Object.entries(manifest.agents)) {
      try {
        if (['pi', 'cursor', 'opencode'].includes(name)) {
          warnings.push(...await (name === 'pi' ? removePiIntegration : removeLifecycleIntegration)(paths, installed));
          delete manifest.agents[name];
          messages.push(`Removed managed ${name} integration; any user edits were preserved.`);
          continue;
        }
        const document = await readJson(installed.file, {});
        let removed = false;
        for (const spec of installedHookSpecs(installed)) {
          if (removeHook(document, spec)) removed = true;
          else warnings.push(`The ${name} ${spec.event} hook was removed or edited after installation; its settings were preserved.`);
        }
        for (const event of installed.emptyEvents || []) {
          document.hooks ??= {};
          document.hooks[event] ??= [];
        }
        if (removed) {
          if (!installed.existed && !Object.keys(document).length) await rm(installed.file, { force: true });
          else await writeJson(installed.file, document);
          messages.push(`Removed ${name} integration.`);
        }
        const mcpResult = await removeMcp(installed.mcp);
        if (mcpResult.edited) warnings.push(`The ${name} sphinx MCP server was edited after installation; preserved ${installed.mcp.file}.`);
        if (mcpResult.removed) messages.push(`Removed ${name} Sphinx MCP registration.`);
        delete manifest.agents[name];
      } catch (error) { warnings.push(error.message); }
    }
    if (Object.keys(manifest.installs).length) warnings.push('Repository integrations remain installed. Run sphinx uninstall --repo in those repositories to remove them.');
  }
  if (await exists(paths.install)) await writeJson(paths.install, manifest);
  return { messages, warnings };
}

export async function dispatchHook({ event, args = [], input = '', cwd = process.cwd(), env = process.env, gate }) {
  if (!/^[a-z][a-z0-9-]*$/.test(event)) throw new Error('Invalid Git hook event.');
  const { paths, manifest } = await manifestFor(env);
  let entry = manifest.installs[env.SPHINX_INSTALL_ID];
  const named = !!entry;
  if (!entry) {
    const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
    entry = await installForFolder(await hooksPathResolver(cwd, env)(effective), manifest);
  }
  if (!entry) throw new Error('Sphinx hook installation is missing. Run sphinx install to repair it.');
  if (Number(env.SPHINX_HOOK_DEPTH || 0) > 0) throw new Error('Recursive Sphinx Git hook detected. Run sphinx doctor and repair the hook chain.');
  // Only diagnostics depend on the record, so failing to write it never stops Git.
  if (named && GATED.has(event) && env.SPHINX_EVALUATOR !== '1') await recordChain({ event, entry, cwd, env, paths, manifest }).catch(() => {});
  const directory = entry.source.kind === 'path' ? path.resolve(cwd, entry.source.value)
    : path.join(await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, env), 'hooks');
  const original = path.join(directory, event);
  let isExecutable = false;
  try { await access(original, constants.X_OK); isExecutable = true; } catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
  }
  if (isExecutable) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(original, args, { cwd, env: { ...env, SPHINX_HOOK_DEPTH: '1' }, stdio: [event === 'pre-commit' ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
      child.stdin?.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.on('error', reject);
      child.on('close', (status, signal) => resolve(status ?? (osConstants.signals[signal] ? 128 + osConstants.signals[signal] : 1)));
      child.stdin?.end(input);
    });
    if (code !== 0) return code;
  }
  if (env.SPHINX_EVALUATOR === '1' || !GATED.has(event)) return 0;
  return gate({ event, args, input, cwd });
}

// On demand, the pull request check finds its pull request with gh. Only asked for a repository on GitHub.
async function onDemandGhCheck(cwd, env, readiness) {
  const root = await git(['rev-parse', '--show-toplevel'], cwd, env);
  if (blocksGit(await loadConfig(root, env))) return null;
  const { githubRepository, ghReadiness, GH_READINESS_TEXT } = await import('./github.js');
  const urls = (await git(['config', '--get-regexp', '^remote\\..*\\.url$'], cwd, env, [0, 1])).split('\n').map(line => line.slice(line.indexOf(' ') + 1)).filter(Boolean);
  if (!urls.some(url => githubRepository(url))) return null;
  const state = await (readiness ?? ghReadiness)({ cwd, env });
  return { name: 'GitHub CLI for on-demand checks', ok: state === 'ok', detail: state === 'ok' ? 'gh is signed in; sphinx check --pull-request and background preparation can find this branch\'s pull request.' : GH_READINESS_TEXT[state] };
}

export async function doctor({ env = process.env, cwd = process.cwd(), ghReadiness } = {}) {
  const { paths, manifest } = await manifestFor(env);
  const checks = [];
  const global = manifest.installs.global;
  const resolveHooksPath = hooksPathResolver(cwd, env);
  const globalValue = await git(['config', '--global', '--includes', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
  checks.push({ name: 'Global Git hooks', ok: !!global && await installForFolder(await resolveHooksPath(globalValue), manifest) === global, detail: globalValue || 'Not installed' });
  try {
    await git(['rev-parse', '--git-dir'], cwd, env);
    const effective = await git(['config', '--path', '--get', 'core.hooksPath'], cwd, env, [0, 1]);
    const folder = await resolveHooksPath(effective);
    const entry = await installForFolder(folder, manifest);
    // Name the setting that hides the global hooks: tools such as husky set a repository's own core.hooksPath.
    const override = entry ? null : await hooksPathBeforeInstall(true, cwd, env);
    const own = override && override.scope !== '--global' && override.scope !== '--system';
    const setting = own ? `this repository's ${override.scope.slice(2)} core.hooksPath (${override.value})` : `core.hooksPath (${effective})`;
    const chain = entry ? null : await chainCoverage(folder, { cwd, env, paths, manifest });
    const covering = entry ?? (chain && !chain.missing.length ? chain.entry : null);
    let detail;
    if (entry) detail = `Sphinx active: ${effective}`;
    else if (covering) detail = `Covered through ${setting}: its hooks run the Sphinx hooks${chain.last ? ` (${chain.last[0]} last went through on ${String(chain.last[1]).slice(0, 10)})` : ''}.`;
    else if (chain) {
      const events = chain.missing.join(' and ');
      detail = `Not confirmed: ${setting} runs the Sphinx hooks, but Sphinx has not seen its ${events} hook do so, and this repository's policy checks ${chain.missing.length > 1 ? 'those events' : 'that event'}. If that hook passes control on, ${chain.missing.map(event => ACTION[event]).join(' and ')} once and run sphinx doctor again; otherwise run sphinx install --repo here to chain it.`;
    } else detail = own
      ? `Not covered: ${setting} replaces the global Sphinx hooks, often set by tools such as husky. Run sphinx install --repo here to chain that hook setup. If that setup already runs your global hooks itself, commit or push once and run sphinx doctor again.`
      : 'Not covered. A local, worktree, or conditional override may require sphinx install --repo.';
    checks.push({ name: 'Current repository', ok: !!covering, detail });
    const gh = await onDemandGhCheck(cwd, env, ghReadiness).catch(() => null);
    if (gh) checks.push(gh);
    if (covering) {
      for (const name of [...GATED, ...PREPARED]) {
        const file = path.join(covering.hookDir, name);
        const content = await readFile(file).catch(() => null);
        let runnable = false;
        try { await access(file, constants.X_OK); runnable = true; } catch {}
        const preparationCurrent = !PREPARED.has(name) || covering.preparationVersion === 1;
        checks.push({ name: `${name} dispatcher`, ok: preparationCurrent && runnable && content !== null && hash(content) === covering.files[name], detail: preparationCurrent ? file : 'Background preparation hooks need updating. Run sphinx install.' });
      }
    }
  } catch { checks.push({ name: 'Current repository', ok: true, detail: 'Not inside a Git repository; global installation still applies to other repositories.' }); }
  for (const name of AGENTS) {
    const installed = manifest.agents[name];
    if (['pi', 'cursor', 'opencode'].includes(name)) {
      const result = await (name === 'pi' ? piIntegrationStatus : lifecycleIntegrationStatus)(paths, { record: installed, env });
      checks.push({ name: `${name} integration`, ok: installed ? result.healthy : true, detail: !installed
        ? `Not selected. Optional: sphinx install --agents ${name}.`
        : !result.healthy ? `Integration is missing or changed. Run sphinx install --agents ${name}.`
          : name === 'pi' ? `${result.file}; native human dialogs configured. Run /reload in Pi; dialog support is required.`
            : `${result.file}; local browser questionnaires configured. macOS opens the page in the background; other environments show its local URL. Human answers stay in the questionnaire; terminal checks are explicit${name === 'cursor' ? '; local sessions only, not cloud agents' : '; OpenCode 1.x plugin'}.` });
      continue;
    }
    let present = false;
    if (installed) {
      try {
        const document = await readJson(installed.file, {});
        present = !!installed.hooks && installedHookSpecs(installed).every(spec => hasHook(document, spec));
      } catch {}
    }
    checks.push({ name: `${name} integration`, ok: installed ? present : true, detail: present
      ? `${installed.file}; native questionnaire hooks configured${name === 'codex' ? '; review/trust in /hooks is required and cannot be verified by Sphinx' : '; start a new session to load changes'}`
      : installed ? `Native questionnaire hooks are missing, legacy, or changed. Run sphinx install --agents ${name}.`
        : `Not selected. Optional: sphinx install --agents ${name}.` });
    if (installed) {
      const mcpPresent = await inspectMcp(installed.mcp);
      checks.push({ name: `${name} questionnaire server`, ok: mcpPresent, detail: mcpPresent
        ? `${installed.mcp.file}; sphinx registration present. Connection and native-form support must be checked in the host /mcp panel.`
        : `Sphinx MCP registration is missing or changed. Run sphinx install --agents ${name}.` });
    }
  }
  checks.push({ name: 'Sphinx state', ok: true, detail: paths.home });
  return { checks };
}
