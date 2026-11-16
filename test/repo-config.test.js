import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, REPOSITORY_CONFIG_KEYS, writeJson } from '../src/config.js';
import { initializeRepository, setRepositoryMode } from '../src/repo-config.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sphinx-repo-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot);
  const env = { SPHINX_HOME: join(root, 'state'), SPHINX_USER_HOME: join(root, 'home') };
  return { repoRoot, env, config: structuredClone(DEFAULT_CONFIG) };
}

test('initialization creates readable repository policy and ignore template without global settings', async t => {
  const args = await fixture(t);
  const result = await initializeRepository({ ...args, overrides: { branches: ['main'], level: 'thorough', events: ['pre-push', 'pre-commit'] } });
  assert.deepEqual(result.created, [join(args.repoRoot, '.sphinxconfig'), join(args.repoRoot, '.sphinxignore'), join(args.repoRoot, '.sphinxcontext.md')]);
  assert.deepEqual(result.preserved, []);
  assert.deepEqual(result.config.branches, ['main']);
  assert.equal(result.config.level, 'thorough');
  assert.deepEqual(Object.keys(result.config), [...REPOSITORY_CONFIG_KEYS]);
  assert.equal(result.config.provider, undefined);
  assert.equal(result.config.maxModelCalls, undefined);
  const effective = await loadConfig(args.repoRoot, args.env);
  assert.deepEqual(effective.branches, ['main']);
  assert.equal(effective.level, 'thorough');
  assert.match(await readFile(result.ignorePath, 'utf8'), /before content is read/);
  assert.match(await readFile(result.ignorePath, 'utf8'), /\.env/);
});

test('generic defaults inherit configured branches and local policy choices', async t => {
  const args = await fixture(t);
  args.config.branches = ['release/*'];
  args.config.level = 'relaxed';
  args.config.level = 'relaxed';
  const result = await initializeRepository(args);
  assert.deepEqual(result.config.branches, ['release/*']);
  assert.equal(result.config.level, 'relaxed');
  assert.equal(result.config.mode, 'block');
});

test('initialization preserves existing canonical policy and ignore rules byte for byte', async t => {
  const args = await fixture(t);
  const configPath = join(args.repoRoot, '.sphinxconfig');
  const ignorePath = join(args.repoRoot, '.sphinxignore');
  const contextPath = join(args.repoRoot, '.sphinxcontext.md');
  const policy = '{"branches":["protected"],"level":"relaxed"}\n';
  const ignore = '# custom comments\nprivate/\n';
  await writeFile(configPath, policy);
  await writeFile(ignorePath, ignore);
  await writeFile(contextPath, 'Existing project background.');
  const result = await initializeRepository({ ...args, overrides: { branches: ['main'], level: 'thorough' } });
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.preserved, [configPath, ignorePath, contextPath]);
  assert.equal(await readFile(configPath, 'utf8'), policy);
  assert.equal(await readFile(ignorePath, 'utf8'), ignore);
  assert.equal(await readFile(contextPath, 'utf8'), 'Existing project background.');
  assert.deepEqual(result.config, { branches: ['protected'], level: 'relaxed' });
});

test('legacy migration retains exactly the existing policy fields and keeps the legacy file', async t => {
  const args = await fixture(t);
  const legacyPath = join(args.repoRoot, '.sphinx.json');
  const legacy = { branches: ['release/*'], exclude: ['private/**'], mode: 'block' };
  await writeJson(legacyPath, legacy);
  const oldText = await readFile(legacyPath, 'utf8');
  const before = await loadConfig(args.repoRoot, args.env);
  const result = await initializeRepository(args);
  assert.deepEqual(result.config, legacy);
  assert.deepEqual(await loadConfig(args.repoRoot, args.env), before);
  assert.equal(await readFile(legacyPath, 'utf8'), oldText);
  assert.ok(result.preserved.includes(legacyPath));
  assert.ok(result.created.includes(join(args.repoRoot, '.sphinxconfig')));
});

test('explicit creation overrides apply during legacy migration without removing old exclusions', async t => {
  const args = await fixture(t);
  await writeJson(join(args.repoRoot, '.sphinx.json'), { branches: ['old'], exclude: ['private/**'] });
  const result = await initializeRepository({ ...args, overrides: { branches: ['main'], exclude: ['generated/**'] } });
  assert.deepEqual(result.config.branches, ['main']);
  assert.deepEqual(result.config.exclude, ['private/**', 'generated/**']);
});

test('invalid overrides and existing policy values fail before creating either file', async t => {
  const args = await fixture(t);
  for (const overrides of [{ provider: 'claude' }, { branches: 'main' }, { mode: 'unknown' }, { enabled: 1 }, { exclude: [null] }, null]) {
    await assert.rejects(initializeRepository({ ...args, overrides }), /cannot set|configuration|JSON object/i);
    await assert.rejects(stat(join(args.repoRoot, '.sphinxconfig')), { code: 'ENOENT' });
    await assert.rejects(stat(join(args.repoRoot, '.sphinxignore')), { code: 'ENOENT' });
  }
  await writeJson(join(args.repoRoot, '.sphinx.json'), { maxModelCalls: 100 });
  await assert.rejects(initializeRepository(args), /cannot set maxModelCalls/);
  await assert.rejects(stat(join(args.repoRoot, '.sphinxconfig')), { code: 'ENOENT' });
  await assert.rejects(stat(join(args.repoRoot, '.sphinxignore')), { code: 'ENOENT' });
});

test('symlinks and directories are refused without modifying their targets or creating another file', async t => {
  const args = await fixture(t);
  const target = join(args.repoRoot, '.env');
  await writeFile(target, 'SECRET_CONTENT');
  for (const filename of ['.sphinxconfig', '.sphinx.json', '.sphinxignore', '.sphinxcontext.md']) {
    const file = join(args.repoRoot, filename);
    await symlink(target, file);
    await assert.rejects(initializeRepository(args), /symlink/);
    assert.equal(await readFile(target, 'utf8'), 'SECRET_CONTENT');
    if (filename !== '.sphinxconfig') await assert.rejects(stat(join(args.repoRoot, '.sphinxconfig')), { code: 'ENOENT' });
    await rm(file);
  }
  await mkdir(join(args.repoRoot, '.sphinxignore'));
  await assert.rejects(initializeRepository(args), /non-regular/);
  await assert.rejects(stat(join(args.repoRoot, '.sphinxconfig')), { code: 'ENOENT' });
});

test('setup accepts project context separately from policy and preserves existing prose', async t => {
  const args = await fixture(t);
  const first = await initializeRepository({ ...args, context: 'A warehouse application. Stock reservations must be atomic.' });
  assert.match(await readFile(first.contextPath, 'utf8'), /## About this project\nA warehouse application\. Stock reservations must be atomic\.\n\n## What to ask about\n/);
  const second = await initializeRepository({ ...args, context: 'New text must not overwrite existing context.' });
  assert.equal(await readFile(second.contextPath, 'utf8'), await readFile(first.contextPath, 'utf8'));
  assert.equal(first.config.context, undefined);
});

test('canonical policy wins during initialization without parsing shadowed legacy contents', async t => {
  const args = await fixture(t);
  await writeJson(join(args.repoRoot, '.sphinxconfig'), { branches: ['main'] });
  await writeFile(join(args.repoRoot, '.sphinx.json'), 'not JSON');
  const result = await initializeRepository(args);
  assert.deepEqual(result.config, { branches: ['main'] });
  assert.ok(result.preserved.includes(join(args.repoRoot, '.sphinx.json')));
  assert.equal(await readFile(join(args.repoRoot, '.sphinx.json'), 'utf8'), 'not JSON');
});

test('repeated initialization creates no new files and keeps stable policy bytes', async t => {
  const args = await fixture(t);
  const first = await initializeRepository(args);
  const content = await readFile(first.configPath, 'utf8');
  const second = await initializeRepository(args);
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.config, first.config);
  assert.equal(await readFile(first.configPath, 'utf8'), content);
});

test('the questionnaire can set a repository distance, keeping its other settings', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setRepositoryDistance } = await import('../src/repo-config.js');
  const dir = await mkdtemp(join(tmpdir(), 'sphinx-set-distance-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await setRepositoryDistance(dir, 'low');
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.sphinxconfig'), 'utf8')), { version: 1, distance: 'low' });
  await writeFile(join(dir, '.sphinxconfig'), JSON.stringify({ version: 1, branches: ['main'], exclude: ['dist/**'], distance: 'low' }));
  await setRepositoryDistance(dir, 'high');
  assert.deepEqual(JSON.parse(await readFile(join(dir, '.sphinxconfig'), 'utf8')), { version: 1, branches: ['main'], exclude: ['dist/**'], distance: 'high' });
  // Only the distance line changes in a hand-formatted file.
  await writeFile(join(dir, '.sphinxconfig'), '{\n  "version": 1,\n  "branches": ["main"]\n}\n');
  await setRepositoryDistance(dir, 'low');
  assert.equal(await readFile(join(dir, '.sphinxconfig'), 'utf8'), '{\n  "version": 1,\n  "branches": ["main"],\n  "distance": "low"\n}\n');
  await assert.rejects(setRepositoryDistance(dir, 'sideways'), /distance must be/);
});

test('setRepositoryMode changes only the mode value and keeps the file as written', async t => {
  const args = await fixture(t), file = join(args.repoRoot, '.sphinxconfig');
  const written = '{\n  "version": 1,\n  "events": ["pre-push"],\n  "branches": ["*"],\n  "mode": "block",\n  "exclude": ["dist/"]\n}\n';
  await writeFile(file, written, { mode: 0o640 });
  const result = await setRepositoryMode({ repoRoot: args.repoRoot, mode: 'on-demand', env: args.env });
  assert.deepEqual({ previous: result.previous, mode: result.mode, changed: result.changed }, { previous: 'block', mode: 'on-demand', changed: true });
  assert.equal(await readFile(file, 'utf8'), written.replace('"mode": "block"', '"mode": "on-demand"'), 'Only the value changes; compact arrays stay compact');
  assert.equal((await stat(file)).mode & 0o777, 0o640, 'The file keeps its permissions');
  assert.equal((await loadConfig(args.repoRoot, args.env)).mode, 'on-demand');
  const again = await setRepositoryMode({ repoRoot: args.repoRoot, mode: 'on-demand', env: args.env });
  assert.equal(again.changed, false);
});

test('setRepositoryMode adds a missing mode, keeps every other key, and never creates or repairs policy', async t => {
  const args = await fixture(t), file = join(args.repoRoot, '.sphinxconfig');
  await assert.rejects(setRepositoryMode({ repoRoot: args.repoRoot, mode: 'block', env: args.env }), /no \.sphinxconfig.*sphinx init --mode block.*--global/s);
  await assert.rejects(stat(file), { code: 'ENOENT' }, 'sphinx init stays the only command that creates policy');
  await writeFile(join(args.repoRoot, '.sphinx.json'), JSON.stringify({ branches: ['main'] }));
  await assert.rejects(setRepositoryMode({ repoRoot: args.repoRoot, mode: 'block', env: args.env }), /legacy \.sphinx\.json/);
  await rm(join(args.repoRoot, '.sphinx.json'));
  await writeFile(file, JSON.stringify({ branches: ['release/*'], level: 'thorough' }));
  await setRepositoryMode({ repoRoot: args.repoRoot, mode: 'on-demand', env: args.env });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { branches: ['release/*'], level: 'thorough', mode: 'on-demand' });
  const invalid = '{ "level": "nope", "mode": "block" }';
  await writeFile(file, invalid);
  await assert.rejects(setRepositoryMode({ repoRoot: args.repoRoot, mode: 'on-demand', env: args.env }), /level/);
  assert.equal(await readFile(file, 'utf8'), invalid, 'An invalid policy is left untouched');
});
