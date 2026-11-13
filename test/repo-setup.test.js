import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyRepositorySetup, CONTEXT_TODO, SETUP_NUDGE, suggestRepositorySetup } from '../src/repo-setup.js';
import { PROJECT_CONTEXT_TEMPLATE } from '../src/repo-context.js';
import { agentHook, ON_DEMAND_GUIDANCE } from '../src/agent.js';
import { cursorAgentHook, TERMINAL_GUIDANCE } from '../src/lifecycle-integrations.js';

const CLI = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));

async function fixture(t, { branch = 'main' } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sphinx-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'), home = path.join(base, 'home');
  await mkdir(repo); await mkdir(home);
  const env = { ...process.env, HOME: home, SPHINX_HOME: path.join(home, 'sphinx'), SPHINX_USER_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'SPHINX_EVALUATOR']) delete env[key];
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '-q', '-b', branch);
  git('config', 'user.name', 'Sphinx Test'); git('config', 'user.email', 'sphinx@example.test'); git('config', 'commit.gpgsign', 'false');
  const write = async (file, text) => { await mkdir(path.dirname(path.join(repo, file)), { recursive: true }); await writeFile(path.join(repo, file), text); };
  const commit = () => { git('add', '-A', '-f'); git('commit', '-qm', 'snapshot'); };
  const cli = (args, input = '') => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, env, encoding: 'utf8', input });
  const files = async () => (await readdir(repo)).filter(name => name.startsWith('.sphinx')).sort();
  return { base, repo, env, git, write, commit, cli, files };
}

const nodeProject = async f => {
  await f.write('package.json', JSON.stringify({ name: 'order-service', description: 'Checkout API for the web shop.' }));
  await f.write('README.md', '# Order service\n\n[![ci](https://example.test/badge.svg)](https://example.test)\n\nThe order service reserves inventory and captures payments for the storefront.\n');
  await f.write('src/index.js', 'export const ok = true;\n');
  await f.write('dist/app.js', 'bundled();\n');
  await f.write('package-lock.json', '{}\n');
  await f.write('assets/logo.png', 'png');
  await f.write('config/secrets.prod.json', '{}\n');
  await f.write('tools/build/script.js', 'build();\n');
  f.commit();
};
const filled = proposal => ({ ...proposal, context: proposal.context.replace(/^TODO\(sphinx\):.*$/m, 'Stock is reserved before payment capture; a failed capture releases it.') });

test('suggest proposes origin HEAD, detected ignore paths, and a context stub without writing', async t => {
  const f = await fixture(t, { branch: 'trunk' });
  await nodeProject(f);
  const bare = path.join(f.base, 'remote.git');
  f.git('init', '-q', '--bare', bare); f.git('remote', 'add', 'origin', bare); f.git('push', '-q', 'origin', 'trunk'); f.git('remote', 'set-head', 'origin', 'trunk');
  const proposal = await suggestRepositorySetup({ repoRoot: f.repo, env: f.env });
  assert.deepEqual(proposal.config.branches, ['trunk']);
  assert.deepEqual(proposal.detected.defaultBranch, { branches: ['trunk'], from: 'refs/remotes/origin/HEAD' });
  assert.deepEqual(proposal.ignore, ['/dist/', 'package-lock.json', '*.png', '/config/secrets.prod.json']);
  assert.match(proposal.detected.ignore['package-lock.json'], /lockfile/);
  assert.equal(proposal.ignore.some(line => line.includes('tools')), false, 'Only real build-output directory names are proposed');
  assert.match(proposal.context, /order-service: Checkout API for the web shop\./);
  assert.match(proposal.context, /reserves inventory and captures payments/);
  assert.ok(proposal.context.includes(CONTEXT_TODO));
  assert.doesNotMatch(proposal.context, /badge/);
  assert.deepEqual(proposal.detected.contextFrom, ['package.json', 'README.md']);
  assert.match(proposal.nextStep, /sphinx init --apply - --json/);
  assert.deepEqual(await f.files(), [], 'suggest is read-only');
});

test('suggest without remotes falls back to local main/master, reads pyproject, and keeps defaults when nothing is found', async t => {
  const f = await fixture(t, { branch: 'master' });
  await f.write('pyproject.toml', '[build-system]\nname = "not-this"\n\n[project]\nname = "ledger"\ndescription = "Double-entry ledger library."\n');
  await f.write('ledger/__pycache__/core.cpython-312.pyc', 'x');
  await f.write('ledger/core.py', 'x = 1\n');
  f.commit();
  const proposal = await suggestRepositorySetup({ repoRoot: f.repo, env: f.env });
  assert.deepEqual(proposal.config.branches, ['master']);
  assert.equal(proposal.detected.defaultBranch.from, 'existing main/master branches');
  assert.deepEqual(proposal.ignore, ['/ledger/__pycache__/']);
  assert.match(proposal.context, /^ledger: Double-entry ledger library\.$/m);

  const g = await fixture(t, { branch: 'trunk' });
  await g.write('a.txt', 'a\n'); g.commit();
  const fallback = await suggestRepositorySetup({ repoRoot: g.repo, env: g.env });
  assert.equal(fallback.detected.defaultBranch, null);
  assert.deepEqual(fallback.config.branches, ['main', 'master'], 'Inherits the global default policy');
});

test('suggest respects existing policy, context, and ignore rules, and never reads excluded files for context', async t => {
  const f = await fixture(t);
  await nodeProject(f);
  await f.write('.sphinxconfig', JSON.stringify({ branches: ['release'] }));
  await f.write('.sphinxignore', 'dist/\nREADME.md\n');
  await f.write('.sphinxcontext.md', 'Hand-written context.\n');
  const existing = await suggestRepositorySetup({ repoRoot: f.repo, env: f.env });
  assert.equal(existing.config, null);
  assert.equal(existing.context, null);
  assert.deepEqual(existing.detected.existing, ['.sphinxconfig', '.sphinxcontext.md']);
  assert.equal(existing.ignore.includes('/dist/'), false, 'Paths already excluded are not proposed again');
  await f.write('.sphinxcontext.md', PROJECT_CONTEXT_TEMPLATE);
  const template = await suggestRepositorySetup({ repoRoot: f.repo, env: f.env });
  assert.ok(template.context, 'An untouched template is treated as missing context');
  assert.doesNotMatch(template.context, /reserves inventory/, 'An excluded README is not read');
  assert.deepEqual(template.detected.contextFrom, ['package.json']);
});

test('suggest drops derived text that looks like a credential', async t => {
  const f = await fixture(t);
  await f.write('package.json', JSON.stringify({ name: 'leaky', description: 'Uses token = ghp_abcdefghijklmnopqrstuvwxyz0123456789' }));
  f.commit();
  const proposal = await suggestRepositorySetup({ repoRoot: f.repo, env: f.env });
  assert.doesNotMatch(proposal.context, /ghp_/);
});

test('apply writes all three files, then is idempotent', async t => {
  const f = await fixture(t);
  await nodeProject(f);
  const proposal = filled(await suggestRepositorySetup({ repoRoot: f.repo, env: f.env }));
  const first = await applyRepositorySetup({ repoRoot: f.repo, proposal, env: f.env });
  assert.deepEqual(first.created, ['.sphinxconfig', '.sphinxignore', '.sphinxcontext.md']);
  assert.deepEqual(first.warnings, []);
  const snapshot = await Promise.all(['.sphinxconfig', '.sphinxignore', '.sphinxcontext.md'].map(name => readFile(path.join(f.repo, name), 'utf8')));
  assert.match(snapshot[1], /# Added by sphinx init --apply\n\/dist\/\npackage-lock\.json\n/);
  assert.match(snapshot[2], /failed capture releases it/);
  assert.doesNotMatch(snapshot[2], /TODO/);
  const second = await applyRepositorySetup({ repoRoot: f.repo, proposal, env: f.env });
  assert.deepEqual([second.created, second.updated, second.ignoreAdded, second.warnings], [[], [], [], []]);
  assert.deepEqual(await Promise.all(['.sphinxconfig', '.sphinxignore', '.sphinxcontext.md'].map(name => readFile(path.join(f.repo, name), 'utf8'))), snapshot);
});

test('apply merges ignore lines, replaces only an untouched context template, and keeps user policy', async t => {
  const f = await fixture(t);
  await f.write('.sphinxignore', '# mine\nprivate/\n');
  await f.write('.sphinxcontext.md', PROJECT_CONTEXT_TEMPLATE);
  const proposal = { config: { branches: ['main'] }, ignore: ['private/', 'dist/'], context: 'A ledger service.' };
  const first = await applyRepositorySetup({ repoRoot: f.repo, proposal, env: f.env });
  assert.deepEqual(first.created, ['.sphinxconfig']);
  assert.deepEqual(first.updated.sort(), ['.sphinxcontext.md', '.sphinxignore']);
  assert.deepEqual(first.ignoreAdded, ['dist/']);
  assert.equal(await readFile(path.join(f.repo, '.sphinxignore'), 'utf8'), '# mine\nprivate/\n\n# Added by sphinx init --apply\ndist/\n');
  assert.match(await readFile(path.join(f.repo, '.sphinxcontext.md'), 'utf8'), /## About this project\nA ledger service\.\n\n## What to ask about/);

  const changed = await applyRepositorySetup({ repoRoot: f.repo, proposal: { config: { branches: ['release'] }, ignore: ['build/'], context: 'Different.' }, env: f.env });
  assert.deepEqual(changed.updated, ['.sphinxignore']);
  assert.equal(changed.warnings.length, 2);
  assert.match(changed.warnings.join('\n'), /\.sphinxcontext\.md already exists and was kept/);
  assert.match(changed.warnings.join('\n'), /\.sphinxconfig already exists and was kept \(proposal differs in branches\)/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.repo, '.sphinxconfig'), 'utf8')).branches, ['main']);
  assert.match(await readFile(path.join(f.repo, '.sphinxcontext.md'), 'utf8'), /## About this project\nA ledger service\.\n\n## What to ask about/);
  assert.equal(await readFile(path.join(f.repo, '.sphinxignore'), 'utf8'), '# mine\nprivate/\n\n# Added by sphinx init --apply\ndist/\nbuild/\n');
});

test('invalid proposals list every actionable problem and write nothing', async t => {
  const f = await fixture(t);
  const bad = { config: { branches: 'main', provider: 'claude' }, ignore: ['!keep.txt', '', 'a\nb', '# note'], context: `About.\n${CONTEXT_TODO} fill me\nkey: -----BEGIN RSA PRIVATE KEY-----`, extra: true };
  await assert.rejects(applyRepositorySetup({ repoRoot: f.repo, proposal: bad, env: f.env }), error => {
    assert.equal(error.code, 'SPHINX_INVALID_PROPOSAL');
    const text = error.errors.join('\n');
    for (const pattern of [/unknown key "extra"/, /config: .*cannot set provider/, /ignore\[0\].*negation/, /ignore\[1\] must be a nonempty string/, /ignore\[2\] must be a single line/, /ignore\[3\].*comment/, /still contains the TODO\(sphinx\)/, /credential/]) assert.match(text, pattern);
    return true;
  });
  await assert.rejects(applyRepositorySetup({ repoRoot: f.repo, proposal: { config: { branches: 'main' } }, env: f.env }), /config: .*branches must be an array/);
  await assert.rejects(applyRepositorySetup({ repoRoot: f.repo, proposal: [], env: f.env }), /expected a JSON object/);
  assert.deepEqual(await f.files(), []);
  await symlink(path.join(f.base, 'elsewhere'), path.join(f.repo, '.sphinxignore'));
  await assert.rejects(applyRepositorySetup({ repoRoot: f.repo, proposal: { ignore: ['dist/'] }, env: f.env }), /symlink/);
  assert.deepEqual(await f.files(), ['.sphinxignore'], 'A symlinked ignore file stops apply before any write');
});

test('CLI suggest and apply round-trip through stdin with JSON results and errors', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await nodeProject(f);
  const suggest = f.cli(['init', '--suggest', '--json']);
  assert.equal(suggest.status, 0, suggest.stderr);
  const proposal = JSON.parse(suggest.stdout);
  const rejected = f.cli(['init', '--apply', '-', '--json'], suggest.stdout);
  assert.equal(rejected.status, 1);
  assert.deepEqual(JSON.parse(rejected.stdout), { ok: false, errors: ['context still contains the TODO(sphinx): line; replace it with a short project description'] });
  assert.deepEqual(await f.files(), []);
  const applied = f.cli(['init', '--apply', '-', '--json'], JSON.stringify(filled(proposal)));
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).created, ['.sphinxconfig', '.sphinxignore', '.sphinxcontext.md']);
  const file = path.join(f.base, 'proposal.json');
  await writeFile(file, JSON.stringify(filled(proposal)));
  const again = f.cli(['init', '--apply', file]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Preserved \.sphinxconfig/);
  const mixed = f.cli(['init', '--suggest', '--yes']);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /Use either --suggest or --apply/);
  const help = f.cli(['init', '--help']);
  assert.match(help.stdout, /--suggest/);
  assert.match(help.stdout, /--apply <file\|->/);
});

test('SessionStart nudges agents toward setup only when the repository has no .sphinxconfig', async t => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex']) {
    const context = async input => (await agentHook({ agent, input: { hook_event_name: 'SessionStart', ...input }, env: {} })).output.hookSpecificOutput.additionalContext;
    assert.ok((await context({ cwd: f.repo })).endsWith(`\n${SETUP_NUDGE}`));
    assert.equal((await context({})).includes(SETUP_NUDGE), false);
    assert.equal((await context({ cwd: f.base })).includes(SETUP_NUDGE), false, 'No nudge outside a Git repository');
  }
  assert.equal((await cursorAgentHook({ input: { hook_event_name: 'sessionStart', workspace_roots: [f.repo] }, env: {} })).additional_context, `${TERMINAL_GUIDANCE}\n${SETUP_NUDGE}`);
  await f.write('.sphinxconfig', '{}\n');
  assert.equal((await agentHook({ agent: 'claude', input: { hook_event_name: 'SessionStart', cwd: f.repo }, env: {} })).output.hookSpecificOutput.additionalContext.includes(SETUP_NUDGE), false);
  assert.equal((await cursorAgentHook({ input: { hook_event_name: 'sessionStart', cwd: f.repo }, env: {} })).additional_context, TERMINAL_GUIDANCE);
});

test('SessionStart tells agents when a repository checks only on demand, so they never wait for or run the check', async t => {
  const f = await fixture(t);
  const context = async () => (await agentHook({ agent: 'claude', input: { hook_event_name: 'SessionStart', cwd: f.repo }, env: f.env })).output.hookSpecificOutput.additionalContext;
  await f.write('.sphinxconfig', '{}\n');
  assert.equal((await context()).includes(ON_DEMAND_GUIDANCE), false);
  await f.write('.sphinxconfig', '{ "mode": "on-demand" }\n');
  assert.ok((await context()).endsWith(`\n${ON_DEMAND_GUIDANCE}`));
  await f.write('.sphinxconfig', '{ "mode": "broken" }\n');
  assert.equal((await context()).includes(ON_DEMAND_GUIDANCE), false, 'An unreadable policy never breaks session start');
});

test('an agent proposal cannot switch checks off', async () => {
  const { validateProposal } = await import('../src/repo-setup.js');
  for (const config of [{ version: 1, enabled: false }, { version: 1, branches: [] }, { version: 1, events: [] }]) {
    assert.throws(() => validateProposal({ version: 1, config, ignore: [], context: null }), /cannot be false|cannot be empty/);
  }
  // Whether Git waits for the check is the human's call too.
  assert.throws(() => validateProposal({ version: 1, config: { version: 1, mode: 'on-demand' }, ignore: [], context: null }), /config\.mode cannot be on-demand here/);
  assert.equal(validateProposal({ version: 1, config: { version: 1, mode: 'block' }, ignore: [], context: null }).config.mode, 'block');
});
