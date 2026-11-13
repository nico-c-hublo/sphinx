import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadConfig, repositoryConfigInfo, readJson, REPOSITORY_CONFIG_KEYS, stableStringify, validateRepositoryConfig } from './config.js';
import { compileIgnore, loadIgnorePolicy } from './ignore.js';
import { PROJECT_CONTEXT_FILE, PROJECT_CONTEXT_MAX_BYTES, isContextTemplate, contextWithDescription } from './repo-context.js';
import { initializeRepository } from './repo-config.js';

// Agent-driven repository setup: a read-only proposal, then a validated apply.
// No model calls. Writes only the three fixed policy files at the repository root.

export const CONTEXT_TODO = 'TODO(sphinx):';
export const APPLY_COMMAND = 'sphinx init --apply - --json';
export const SETUP_NUDGE = 'This repository has no Sphinx setup; if the user wants one, run `sphinx init --suggest --json` and apply the reviewed proposal with `sphinx init --apply - --json`.';
const IGNORE_HEADER = '# Added by sphinx init --apply';
const IGNORE_MAX_BYTES = 128 * 1024;
const PROPOSAL_KEYS = ['config', 'ignore', 'context'];
const INFORMATIONAL_KEYS = ['version', 'detected', 'nextStep'];

const run = promisify(execFile);
async function git(cwd, args, maxBuffer = 1024 * 1024) {
  try { return (await run('git', args, { cwd, encoding: 'utf8', maxBuffer, timeout: 10000 })).stdout; }
  catch { return null; }
}

// Never let a likely credential reach .sphinxcontext.md, which is sent to the reviewer.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?(?=[^\s'"]*\d)[^\s'"]{12,}/i,
];
export const looksSecret = text => SECRET_PATTERNS.some(pattern => pattern.test(text));

/** Read a small regular file at the repository root without following symlinks. */
async function readSmall(root, name, max = 256 * 1024) {
  let handle;
  try {
    handle = await open(path.join(root, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) return null;
    return await handle.readFile('utf8');
  } catch { return null; } finally { await handle?.close(); }
}

// --- default branch -------------------------------------------------------

async function detectBranch(root) {
  const remotes = (await git(root, ['remote']))?.split('\n').filter(Boolean) || [];
  for (const remote of [...new Set(['origin', ...remotes])].filter(name => remotes.includes(name))) {
    const ref = (await git(root, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]))?.trim();
    if (ref?.startsWith(`refs/remotes/${remote}/`)) return { branches: [ref.slice(`refs/remotes/${remote}/`.length)], from: `refs/remotes/${remote}/HEAD` };
  }
  const refs = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/*/main', 'refs/remotes/*/master']))?.split('\n').filter(Boolean) || [];
  const found = ['main', 'master'].filter(name => refs.some(ref => ref.endsWith(`/${name}`)));
  return found.length ? { branches: found, from: 'existing main/master branches' } : null;
}

// --- ignore suggestions ---------------------------------------------------

const DIRECTORIES = [
  ...['node_modules', 'bower_components', 'vendor', 'third_party', '.venv', 'venv'].map(name => [name, 'vendored dependencies']),
  ...['dist', 'target', '.next', '.nuxt', '.turbo', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle'].map(name => [name, 'build output or cache']),
];
const PATTERNS = [
  ...['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'flake.lock'].map(name => [name, 'lockfile']),
  ...['*.min.js', '*.min.css', '*.map', '*.pyc', '*_pb2.py', '*_pb2_grpc.py', '*.pb.go', '*.generated.*'].map(name => [name, 'generated']),
  ...['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'gz', 'tgz', 'jar', 'mp4', 'mov', 'mp3', 'wav', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd'].map(ext => [`*.${ext}`, 'binary asset']),
  ...['.envrc', '*.tfvars', '*.tfstate', '*.tfstate.*', '.htpasswd', 'kubeconfig', '*.kdbx', '*.ovpn'].map(name => [name, 'secret-looking']),
];
const SECRET_NAME = /secret|credential|passw(?:or)?d/i;
const DATA_FILE = /(?:^|\.)(?:json|ya?ml|toml|ini|cfg|conf|env|properties|txt|xml)$|^[^.]+$/i;

async function suggestIgnore(root, policy) {
  const listed = await git(root, ['ls-files', '-z'], 64 * 1024 * 1024);
  if (listed === null) return {};
  const files = listed.split('\0').filter(file => file && !policy.matches(file));
  const found = {};
  const add = (pattern, reason, count) => { found[pattern] = `${reason} (${count} tracked file${count === 1 ? '' : 's'})`; };
  for (const [name, reason] of DIRECTORIES) {
    const prefixes = new Map();
    for (const file of files) {
      const parts = file.split('/'), index = parts.indexOf(name);
      if (index < 0 || index === parts.length - 1) continue;
      const prefix = parts.slice(0, index + 1).join('/');
      prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
    }
    // build/ and out/ are left out on purpose: they often hold build scripts, not output.
    // Anchor a few concrete directories; a generic name could also match source elsewhere.
    if (prefixes.size > 3) add(`${name}/`, reason, [...prefixes.values()].reduce((a, b) => a + b, 0));
    else for (const [prefix, count] of prefixes) add(`/${prefix}/`, reason, count);
  }
  const covered = compileIgnore(Object.keys(found), []);
  for (const [pattern, reason] of PATTERNS) {
    const matches = compileIgnore([pattern], []);
    const count = files.filter(file => matches(file) && !covered(file)).length;
    if (count) add(pattern, reason, count);
  }
  const all = compileIgnore(Object.keys(found), []);
  for (const file of files.filter(file => !all(file) && SECRET_NAME.test(path.posix.basename(file)) && DATA_FILE.test(path.posix.basename(file))).slice(0, 20)) add(`/${file}`, 'secret-looking', 1);
  return found;
}

// --- context stub ---------------------------------------------------------

function tomlStrings(text, sections) {
  const values = {};
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { current = header[1].trim(); continue; }
    const pair = sections.includes(current) && line.match(/^\s*(name|description)\s*=\s*"([^"]*)"\s*$/);
    if (pair && !values[pair[1]]) values[pair[1]] = pair[2];
  }
  return values;
}

function firstParagraph(text) {
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const value = block.trim();
    if (!value || /^(?:#|<|!\[|\[!\[|```|\||[=\-*_~]{3,}|\.\.\s)/.test(value) || /^[=\-~^]{3,}$/m.test(value)) continue;
    const flat = value.replace(/\s+/g, ' ');
    if (flat.length < 20 || !/[a-z].* [a-z]/i.test(flat)) continue;
    if (flat.length <= 500) return flat;
    const cut = flat.slice(0, 500), end = cut.lastIndexOf('. ');
    return end > 100 ? cut.slice(0, end + 1) : `${cut}…`;
  }
  return null;
}

async function suggestContext(root, policy) {
  const readable = async name => policy.matches(name) ? null : readSmall(root, name);
  const from = [];
  let name, description;
  const pkg = await readable('package.json');
  if (pkg) try { const data = JSON.parse(pkg); if (typeof data.name === 'string') name = data.name; if (typeof data.description === 'string') description = data.description; from.push('package.json'); } catch {}
  for (const [file, sections] of [['pyproject.toml', ['project', 'tool.poetry']], ['Cargo.toml', ['package']]]) {
    if (name && description) break;
    const text = await readable(file);
    if (!text) continue;
    const values = tomlStrings(text, sections);
    if (!values.name && !values.description) continue;
    name ||= values.name; description ||= values.description; from.push(file);
  }
  let readme;
  for (const file of ['README.md', 'README.rst', 'README.txt', 'README']) {
    const text = await readable(file);
    if (text && (readme = firstParagraph(text))) { from.push(file); break; }
  }
  const lines = ['# Project context for Sphinx', ''];
  const summary = [name, description].filter(Boolean).join(': ');
  if (summary && !looksSecret(summary)) lines.push(summary, '');
  if (readme && readme !== description && !looksSecret(readme)) lines.push(readme, '');
  lines.push(`${CONTEXT_TODO} Replace this line with a few sentences from your knowledge of the codebase: what it does, who uses it, key workflows, architecture boundaries, and invariants a reviewer should check. No secrets.`);
  return { text: `${lines.join('\n')}\n`, from };
}

// --- suggest --------------------------------------------------------------

/** Inspect a repository read-only and propose its Sphinx setup. */
export async function suggestRepositorySetup({ repoRoot, env = process.env }) {
  const root = path.resolve(repoRoot);
  const info = await repositoryConfigInfo(root);
  const effective = await loadConfig(root, env);
  const policy = await loadIgnorePolicy(root, { env, exclude: effective.exclude });
  const branch = await detectBranch(root);
  const existingContext = await readRegular(path.join(root, PROJECT_CONTEXT_FILE));
  const contextIsTemplate = existingContext === null || isContextTemplate(existingContext);
  let config = null;
  if (!info.exists || info.legacy) {
    const defaults = info.exists ? null : await loadConfig(undefined, env);
    const base = info.exists ? await readJson(info.path) : Object.fromEntries(REPOSITORY_CONFIG_KEYS.map(key => [key, structuredClone(defaults[key])]));
    config = { ...base, ...(branch && !info.exists ? { branches: branch.branches } : {}) };
  }
  const ignore = await suggestIgnore(root, policy);
  const context = contextIsTemplate ? await suggestContext(root, policy) : null;
  return {
    version: 1,
    config,
    ignore: Object.keys(ignore),
    context: context?.text ?? null,
    detected: {
      defaultBranch: branch ? { branches: branch.branches, from: branch.from } : null,
      existing: [info.exists && !info.legacy ? '.sphinxconfig' : null, info.legacy ? '.sphinx.json' : null, existingContext !== null && !contextIsTemplate ? PROJECT_CONTEXT_FILE : null].filter(Boolean),
      ignore,
      contextFrom: context?.from ?? [],
    },
    nextStep: !config && !context && !Object.keys(ignore).length ? 'Nothing to apply; this repository is already set up.'
      : `${context ? `Replace the ${CONTEXT_TODO} line in context, then review` : 'Review'} the proposal and pipe this JSON to: ${APPLY_COMMAND}`,
  };
}

// --- apply ----------------------------------------------------------------

function invalid(errors) {
  return Object.assign(new Error(`Invalid proposal; nothing was written:\n${errors.map(error => `- ${error}`).join('\n')}`), { code: 'SPHINX_INVALID_PROPOSAL', errors });
}

/** Validate a proposal completely before any write. Collects every problem at once. */
export function validateProposal(proposal, { env = process.env } = {}) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw invalid(['expected a JSON object with config, ignore, and context']);
  for (const key of Object.keys(proposal)) if (![...PROPOSAL_KEYS, ...INFORMATIONAL_KEYS].includes(key)) errors.push(`unknown key "${key}"; allowed keys are ${PROPOSAL_KEYS.join(', ')}`);
  const config = proposal.config ?? null;
  if (config !== null) {
    try { validateRepositoryConfig(config, { env, source: 'proposal config' }); }
    catch (error) { errors.push(`config: ${error.message}`); }
    // Agents set Sphinx up; only the human can switch its checks off (sphinx init, interactively).
    if (config && typeof config === 'object') {
      if (config.enabled === false) errors.push('config.enabled cannot be false here; turning Sphinx off is the user\'s decision (they can run sphinx init themselves)');
      for (const key of ['branches', 'events']) if (Array.isArray(config[key]) && !config[key].length) errors.push(`config.${key} cannot be empty here; that would check nothing`);
      if (config.mode === 'on-demand') errors.push('config.mode cannot be on-demand here; whether Git waits for the check is the user\'s decision (they can run sphinx init themselves)');
    }
  }
  const ignore = proposal.ignore ?? [];
  if (!Array.isArray(ignore)) errors.push('ignore must be an array of path patterns');
  else ignore.forEach((line, index) => {
    if (typeof line !== 'string' || !line.trim()) errors.push(`ignore[${index}] must be a nonempty string`);
    else if (/[\r\n\0]/.test(line)) errors.push(`ignore[${index}] must be a single line`);
    else if (line.trim().startsWith('!')) errors.push(`ignore[${index}] "${line}" is a negation; proposals may only add exclusions`);
    else if (line.trim().startsWith('#')) errors.push(`ignore[${index}] "${line}" is a comment; list path patterns only`);
    else if (line.length > 1024) errors.push(`ignore[${index}] exceeds 1024 characters`);
  });
  const context = proposal.context ?? null;
  if (context !== null) {
    if (typeof context !== 'string' || !context.trim()) errors.push('context must be nonempty text, or null to leave .sphinxcontext.md alone');
    else {
      if (context.includes(CONTEXT_TODO)) errors.push(`context still contains the ${CONTEXT_TODO} line; replace it with a short project description`);
      if (context.includes('\0')) errors.push('context must be UTF-8 text');
      if (Buffer.byteLength(context) > PROJECT_CONTEXT_MAX_BYTES) errors.push(`context exceeds ${PROJECT_CONTEXT_MAX_BYTES} bytes; keep it brief`);
      if (looksSecret(context)) errors.push('context looks like it contains a credential; remove it (the reviewer model receives this file)');
    }
  }
  if (errors.length) throw invalid(errors);
  return { config, ignore: [...new Set(ignore.map(line => line.trim()))], context: context === null ? null : `${context.trim()}\n` };
}

async function readRegular(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!(await handle.stat()).isFile()) throw new Error(`Refusing to edit a non-regular file: ${file}`);
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'ELOOP') throw new Error(`Refusing to edit a symlink: ${file}`);
    throw error;
  } finally { await handle?.close(); }
}

async function writeRegular(file, text, flags) {
  const handle = await open(file, flags | constants.O_WRONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Refusing to edit a non-regular file: ${file}`);
    await handle.writeFile(text);
  } finally { await handle.close(); }
}

/** Write a reviewed proposal. Existing policy and context are preserved; ignore lines are merged. Idempotent. */
export async function applyRepositorySetup({ repoRoot, proposal, config, env = process.env }) {
  const root = path.resolve(repoRoot);
  const plan = validateProposal(proposal, { env });
  const ignorePath = path.join(root, '.sphinxignore'), contextPath = path.join(root, PROJECT_CONTEXT_FILE);
  // Checks symlinks and sizes before initializeRepository makes its first write.
  const [ignoreBefore, contextBefore] = await Promise.all([readRegular(ignorePath), readRegular(contextPath)]);
  const replaceTemplate = isContextTemplate(contextBefore) && plan.context !== null;
  const missingIgnore = plan.ignore.filter(line => !new Set((ignoreBefore ?? '').split(/\r?\n/).map(value => value.trim())).has(line));
  if (Buffer.byteLength(`${ignoreBefore ?? ''}${missingIgnore.join('\n')}`) > IGNORE_MAX_BYTES) throw invalid([`.sphinxignore would exceed ${IGNORE_MAX_BYTES} bytes`]);

  const init = await initializeRepository({ repoRoot: root, config, overrides: plan.config ?? {}, context: plan.context ?? undefined, env });
  const name = file => path.relative(root, file);
  const created = init.created.map(name), preserved = init.preserved.map(name), updated = [], warnings = [];

  if (missingIgnore.length) {
    const current = await readRegular(ignorePath) ?? '';
    const missing = plan.ignore.filter(line => !new Set(current.split(/\r?\n/).map(value => value.trim())).has(line));
    if (missing.length) {
      await writeRegular(ignorePath, `${current && !current.endsWith('\n') ? '\n' : ''}${current.includes(IGNORE_HEADER) ? '' : `\n${IGNORE_HEADER}\n`}${missing.join('\n')}\n`, constants.O_APPEND);
      if (!created.includes('.sphinxignore')) { updated.push('.sphinxignore'); preserved.splice(preserved.indexOf('.sphinxignore'), 1); }
    }
  }
  if (replaceTemplate && isContextTemplate(await readRegular(contextPath))) {
    await writeRegular(contextPath, contextWithDescription(plan.context), constants.O_TRUNC);
    updated.push(PROJECT_CONTEXT_FILE); preserved.splice(preserved.indexOf(PROJECT_CONTEXT_FILE), 1);
  } else if (plan.context !== null && !created.includes(PROJECT_CONTEXT_FILE) && await readRegular(contextPath) !== contextWithDescription(plan.context)) {
    warnings.push(`${PROJECT_CONTEXT_FILE} already exists and was kept; edit it directly to change it.`);
  }
  if (plan.config && !created.includes('.sphinxconfig')) {
    const differs = Object.keys(plan.config).filter(key => stableStringify(plan.config[key]) !== stableStringify(init.config[key]));
    if (differs.length) warnings.push(`.sphinxconfig already exists and was kept (proposal differs in ${differs.join(', ')}); edit it directly to change it.`);
  }
  return { ok: true, repo: root, created, updated, preserved, ignoreAdded: missingIgnore, warnings, config: init.config };
}

/** One sentence for agent session start, only when the repository has no Sphinx policy. */
export async function setupNudge(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
    if (!root) return null;
    return (await repositoryConfigInfo(root)).exists ? null : SETUP_NUDGE;
  } catch { return null; }
}
