import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COMMENT_MARKER, STATUS_CONTEXT, checkRecord, commentBody, githubRepository, pullRequestCheck, pullRequestForBranch, pullRequestPush, runStampJob, saveCommentChoice, savedCommentChoice, scheduleStamp, statusFor, workflowTemplate } from '../src/github.js';
import { DEFAULT_CONFIG, policyHash, validateConfig, validateRepositoryConfig } from '../src/config.js';

const snapshot = { event: 'pre-push', repoRoot: '/repo', head: 'b'.repeat(40), base: 'a'.repeat(40), stats: { files: 2, additions: 10, deletions: 1 }, target: { remote: 'origin', url: 'git@github.com:acme/widgets.git', ref: 'refs/heads/feature' } };
const question = (id, prompt) => ({ id, prompt, choices: [], expectedAnswer: 'PRIVATE_KEY_TEXT', rationale: 'PRIVATE_RATIONALE', acceptance: { prediction: 'PRIVATE_PREDICTION', causalReason: 'x' } });
const session = {
  route: { provider: 'claude', model: 'sonnet' }, config: { level: 'standard', distance: 'high' },
  questions: [question('q1', 'What happens on retry?'), question('t2', 'Follow-up: what if the id is new?')],
  attempts: [
    { index: 0, kind: 'answer', prompt: 'What happens on retry?', answer: 'returns the prior result', verdict: 'correct' },
    { index: 1, kind: 'learn', prompt: 'What does a timeout do?', answer: '', verdict: 'incorrect' },
    { index: 1, kind: 'answer', prompt: 'Follow-up: what if the id is new?', answer: 'creates one', verdict: 'correct' },
  ],
};

test('recognizes GitHub remotes only', () => {
  for (const url of ['https://github.com/acme/widgets.git', 'https://x@github.com/acme/widgets', 'git@github.com:acme/widgets.git', 'ssh://git@github.com/acme/widgets.git'])
    assert.deepEqual(githubRepository(url), { host: 'github.com', owner: 'acme', repo: 'widgets' }, url);
  for (const url of ['https://gitlab.com/acme/widgets.git', '/tmp/repo.git', '', 'https://example.invalid/sphinx.git']) assert.equal(githubRepository(url), null, url);
});

test('summaries count first tries like the score and never include answer keys', () => {
  const record = checkRecord({ session, snapshot, outcome: 'passed' });
  assert.deepEqual(record.questions.map(q => [q.prompt, q.tries, q.firstTry]), [['What happens on retry?', 1, true], ['What does a timeout do?', 2, false]]);
  assert.deepEqual(statusFor(record), { state: 'success', description: 'Sphinx stamped · 2 questions, 1 first try' });
  const body = commentBody([record]);
  assert.ok(body.startsWith(COMMENT_MARKER));
  assert.match(body, /claude sonnet/);
  assert.doesNotMatch(body, /PRIVATE_|returns the prior result/);
  assert.match(commentBody([checkRecord({ session, snapshot, outcome: 'passed', includeAnswers: true })]), /> returns the prior result/);
  assert.equal(statusFor(checkRecord({ session: null, snapshot, outcome: 'skipped' })).state, 'failure');
  assert.equal(statusFor(checkRecord({ session: { questions: [], noQuestionReason: 'docs' }, snapshot, outcome: 'passed' })).description, 'Sphinx stamped · no questions needed');
});

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'sphinx-github-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { SPHINX_HOME: dir };
}
const fakeSpawn = calls => (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
const config = github => ({ ...DEFAULT_CONFIG, github: { ...DEFAULT_CONFIG.github, ...github } });

test('stamping is skipped for other hosts, commits, and when turned off, and never throws', async t => {
  const env = await home(t), calls = [];
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, target: { ...snapshot.target, url: '/tmp/x.git' } }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, event: 'pre-commit' }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({ status: false }), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(calls.length, 0);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({}), env, spawnImpl: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(await scheduleStamp({ snapshot, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].detached, true);
  const job = JSON.parse(await readFile(calls[0][1][1], 'utf8'));
  assert.deepEqual({ ...job, branchFile: undefined }, { version: 1, repo: { host: 'github.com', owner: 'acme', repo: 'widgets' }, sha: snapshot.head, branch: 'feature', branchFile: undefined, status: true, comment: false });
});

test('a choice saved by a page or terminal that has since exited decides the comment of the push that stamps the check', async t => {
  const env = await home(t), calls = [];
  const id = 'c'.repeat(64), checked = { ...snapshot, id }, saved = { ...session, id };
  const comment = async () => {
    calls.length = 0;
    assert.equal(await scheduleStamp({ snapshot: checked, session: saved, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
    return JSON.parse(await readFile(calls[0][1][1], 'utf8')).comment;
  };
  assert.equal(await savedCommentChoice(id, env), undefined);
  assert.equal(await comment(), false, 'nothing chosen: github.comment decides');
  assert.equal(await saveCommentChoice(id, true, env), true);
  assert.equal(await savedCommentChoice(id, env), true);
  assert.equal(await comment(), true, 'the Git hook of a later push has no page, and uses the saved choice');
  assert.equal(await saveCommentChoice(id, false, env), true);
  assert.equal(await comment(), false, 'the choice saved last wins, whichever process made it');
  assert.equal(await saveCommentChoice('../escape', true, env), false, 'only a checkpoint ID names a file');
  assert.equal(await saveCommentChoice(id, 'yes', env), false);
});

function fakeGh(responses) {
  const calls = [];
  const gh = async (args, options) => {
    calls.push({ args, input: options.input });
    for (const [pattern, result] of responses) if (pattern.test(args.join(' '))) return typeof result === 'function' ? result() : result;
    return { ok: false, stdout: '' };
  };
  return { gh, calls };
}

async function job(t, overrides = {}) {
  const env = await home(t);
  const branchFile = join(env.SPHINX_HOME, 'branch.json');
  await writeFile(branchFile, JSON.stringify({ records: [checkRecord({ session, snapshot, outcome: 'passed' })] }));
  return { version: 1, repo: { host: 'github.com', owner: 'acme', repo: 'widgets' }, sha: snapshot.head, branch: 'feature', branchFile, status: true, comment: false, ...overrides };
}
const ok = (stdout = '') => ({ ok: true, stdout });

test('without a gh login nothing is posted', async t => {
  const { gh, calls } = fakeGh([]);
  assert.equal(await runStampJob(await job(t), { gh, wait: async () => {} }), 'not-signed-in');
  assert.equal(calls.length, 1);
});

test('waits for the push to land, then posts the commit status', async t => {
  let polls = 0;
  const { gh, calls } = fakeGh([[/^auth/, ok()], [/commits\//, () => (++polls < 3 ? { ok: false } : ok('sha'))], [/statuses\//, ok()]]);
  assert.equal(await runStampJob(await job(t), { gh, wait: async () => {} }), 'done');
  const status = calls.find(call => /statuses\//.test(call.args.join(' ')));
  assert.deepEqual(status.input, { state: 'success', context: STATUS_CONTEXT, description: 'Sphinx stamped · 2 questions, 1 first try' });
  assert.ok(!calls.some(call => call.args[0] === 'pr'));
});

test('creates the pull request comment once, then edits it in place', async t => {
  const responses = [[/^auth/, ok()], [/commits\//, ok('sha')], [/statuses\//, ok()], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[{"number":7}]')], [/issues\/comments\/55/, ok('https://github.com/c/55\n')], [/issues\/7\/comments --method POST/, ok('https://github.com/c/new\n')]];
  const first = fakeGh([[/issues\/7\/comments --paginate/, ok('')], ...responses]);
  assert.equal(await runStampJob(await job(t, { comment: true }), { gh: first.gh, wait: async () => {} }), 'done');
  const posted = first.calls.find(call => /--method POST/.test(call.args.join(' ')) && /issues/.test(call.args.join(' ')));
  assert.ok(posted.input.body.startsWith(COMMENT_MARKER));
  assert.equal(first.calls.filter(call => /statuses\//.test(call.args.join(' '))).at(-1).input.target_url, 'https://github.com/c/new');
  const second = fakeGh([[/issues\/7\/comments --paginate/, ok('55\n')], ...responses]);
  await runStampJob(await job(t, { comment: true }), { gh: second.gh, wait: async () => {} });
  assert.ok(second.calls.some(call => /issues\/comments\/55 --method PATCH/.test(call.args.join(' '))));
});

test('a branch without a pull request gives up quietly', async t => {
  const { gh } = fakeGh([[/^auth/, ok()], [/commits\//, ok('sha')], [/statuses\//, ok()], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[]')]]);
  assert.equal(await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {}, prTries: 3 }), 'no-pull-request');
});

test('github settings validate, merge from .sphinxconfig, and stay out of the policy hash', () => {
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), github: { status: 'yes' } }), /github/);
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), github: { extra: true } }), /github/);
  assert.doesNotThrow(() => validateRepositoryConfig({ github: { comment: true } }));
  assert.equal(policyHash(DEFAULT_CONFIG), policyHash({ ...DEFAULT_CONFIG, github: { status: false, comment: true, answers: true } }));
});

test('the PR comment carries an encoded stamp for the pushed commit, and only this person\u2019s comment is edited', async t => {
  const responses = [[/^auth/, ok()], [/commits\//, ok('sha')], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('')], [/pulls\?state=open/, ok('[{"number":7}]')], [/issues\/7\/comments --paginate/, ok('')], [/issues\/7\/comments --method POST/, ok('https://github.com/c/new\n')]];
  const { gh, calls } = fakeGh(responses);
  await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {} });
  const lookup = calls.find(call => /comments --paginate/.test(call.args.join(' ')));
  assert.match(lookup.args.join(' '), /\.user\.login == "me"/);
  const body = calls.find(call => /--method POST/.test(call.args.join(' '))).input.body;
  const { parseStamp } = await import('../action/index.mjs');
  const stamp = parseStamp(body);
  assert.equal(stamp.head, snapshot.head); assert.equal(stamp.outcome, 'passed');
  assert.deepEqual(stamp.questions.map(q => q.firstTry), [true, false]);
  assert.doesNotMatch(JSON.stringify(stamp), /PRIVATE_|returns the prior result/, 'no answers or answer keys');
});

test('from a fork, the stamp goes to the upstream pull request', async t => {
  const { gh, calls } = fakeGh([[/^auth/, ok()], [/commits\//, ok('sha')], [/^api user/, ok('me\n')], [/repos\/acme\/widgets --jq/, ok('upstream/widgets\n')],
    [/repos\/acme\/widgets\/pulls\?/, ok('[]')], [/repos\/upstream\/widgets\/pulls\?state=open&head=acme%3Afeature/, ok('[{"number":9}]')],
    [/upstream\/widgets\/issues\/9\/comments --paginate/, ok('')], [/upstream\/widgets\/issues\/9\/comments --method POST/, ok('https://github.com/c/9\n')]]);
  assert.equal(await runStampJob(await job(t, { comment: true, status: false }), { gh, wait: async () => {} }), 'done');
  assert.ok(calls.some(call => /upstream\/widgets\/issues\/9\/comments --method POST/.test(call.args.join(' '))));
});

test('a repository running the Sphinx Action gets the comment instead of a commit status', async t => {
  const env = await home(t), calls = [];
  const repoRoot = join(env.SPHINX_HOME, 'repo');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
  await writeFile(join(repoRoot, '.github', 'workflows', 'sphinx.yml'), 'jobs:\n  stamp:\n    steps:\n      - uses: someone/sphinx/action@v1\n');
  assert.equal(await scheduleStamp({ snapshot: { ...snapshot, repoRoot }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  const job = JSON.parse(await readFile(calls[0][1].at(-1), 'utf8'));
  assert.deepEqual([job.status, job.comment], [false, true]);
  calls.length = 0;
  const chosen = { ...session, id: 'c'.repeat(64) };
  await saveCommentChoice(chosen.id, false, env);
  await scheduleStamp({ snapshot: { ...snapshot, repoRoot, id: chosen.id }, session: chosen, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) });
  assert.equal(calls.length, 0, 'turning the toggle off posts nothing');
});

test('the workflow template pins the Action to the release tag, never runs pull request code, and lets a started run finish', () => {
  const text = workflowTemplate('1.2.3');
  assert.match(text, /\n {6}- uses: parthh01\/sphinx\/action@v1\.2\.3\n/);
  assert.match(text, /\npermissions:\n {2}checks: write\n {2}pull-requests: read\n {2}issues: read\n(?! )/);
  assert.match(text, /\n {2}cancel-in-progress: false\n/, 'a comment must not cancel a run that has already started');
  assert.doesNotMatch(text, /checkout|\brun:/, 'it never checks out or runs pull request code');
});

test('the pull request of the checked-out branch comes from gh pr view, with reasons a person can act on', async () => {
  const head = 'c'.repeat(40);
  const reply = result => { const calls = []; return { calls, gh: async (args, options) => { calls.push({ args, options }); return { stderr: '', missing: false, ...result }; } }; };
  const open = reply({ ok: true, stdout: JSON.stringify({ number: 24107, url: 'https://github.com/acme/widgets/pull/24107', state: 'OPEN', baseRefName: 'release/1.2', headRefOid: head }) });
  const { pointsAtBase, ...pull } = await pullRequestForBranch({ cwd: '/repo', gh: open.gh });
  assert.deepEqual(pull, {
    number: 24107, url: 'https://github.com/acme/widgets/pull/24107', baseRefName: 'release/1.2', headRefOid: head,
    repository: { host: 'github.com', owner: 'acme', repo: 'widgets' },
  });
  // It tells the Git engine which remotes hold the base repository, in any URL form.
  for (const url of ['https://github.com/acme/widgets.git', 'git@github.com:Acme/Widgets.git', 'ssh://git@github.com/acme/widgets']) assert.equal(pointsAtBase(url), true, url);
  for (const url of ['https://github.com/someone/widgets.git', 'https://gitlab.com/acme/widgets.git', '/srv/git/widgets.git']) assert.equal(pointsAtBase(url), false, url);
  assert.deepEqual(open.calls[0].args, ['pr', 'view', '--json', 'number,url,state,baseRefName,headRefOid']);
  assert.equal(open.calls[0].options.cwd, '/repo');

  await assert.rejects(pullRequestForBranch({ gh: reply({ ok: false, missing: true }).gh }), /needs the GitHub CLI \(gh\)\. Install it and sign in with gh auth login/);
  await assert.rejects(pullRequestForBranch({ gh: reply({ ok: false, stderr: 'no pull requests found for branch "feature"\n' }).gh }), /No pull request found for the checked-out branch: no pull requests found for branch "feature"/);
  await assert.rejects(pullRequestForBranch({ gh: reply({ ok: true, stdout: JSON.stringify({ number: 3, url: 'https://github.com/acme/widgets/pull/3', state: 'MERGED', baseRefName: 'main', headRefOid: head }) }).gh }), /Pull request #3 is merged; --pull-request checks open pull requests only\./);
  await assert.rejects(pullRequestForBranch({ gh: reply({ ok: true, stdout: JSON.stringify({ number: 3, url: 'https://github.com/acme/widgets/pull/3', state: 'OPEN', baseRefName: 'main' }) }).gh }), /without its number, base branch, or head commit/);
  await assert.rejects(pullRequestForBranch({ gh: reply({ ok: true, stdout: 'not json' }).gh }), /could not read/);
});

test('a pull request check stamps the pull request it names, in its base repository, keeping one record set per pull request', async t => {
  const env = await home(t), calls = [];
  // Checked from a fork clone: the remote is the fork, the pull request lives upstream, and the destination is main.
  const checked = number => ({ ...snapshot, target: { remote: 'upstream', url: 'git@github.com:acme/widgets.git', ref: 'refs/heads/main', pullRequest: { number, url: `https://github.com/upstream-org/widgets/pull/${number}` } } });
  assert.deepEqual(pullRequestCheck(checked(12)), { number: 12, url: 'https://github.com/upstream-org/widgets/pull/12', repository: { host: 'github.com', owner: 'upstream-org', repo: 'widgets' } });
  assert.equal(pullRequestCheck(snapshot), null, 'a push names no pull request');
  assert.equal(await pullRequestPush(checked(12)), true, 'the page offers the stamp although the destination is the default branch');
  assert.equal(await scheduleStamp({ snapshot: checked(12), session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  assert.equal(await scheduleStamp({ snapshot: { ...checked(13), head: 'd'.repeat(40) }, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), true);
  const [first, second] = await Promise.all(calls.map(call => readFile(call[1][1], 'utf8').then(JSON.parse)));
  assert.deepEqual({ ...first, branchFile: undefined }, { version: 1, repo: { host: 'github.com', owner: 'upstream-org', repo: 'widgets' }, sha: snapshot.head, branch: 'main', pullRequest: 12, branchFile: undefined, status: true, comment: false });
  assert.equal(second.pullRequest, 13);
  assert.notEqual(first.branchFile, second.branchFile, 'two pull requests into main keep separate comments');
  assert.deepEqual(JSON.parse(await readFile(first.branchFile, 'utf8')).records.map(record => record.head), [snapshot.head]);
  // A URL that does not name the recorded pull request is not trusted with a stamp.
  const mismatched = { ...checked(12), target: { ...checked(12).target, pullRequest: { number: 12, url: 'https://github.com/upstream-org/widgets/pull/99' } } };
  assert.equal(pullRequestCheck(mismatched).repository, null);
  assert.equal(await pullRequestPush(mismatched), false);
  assert.equal(await scheduleStamp({ snapshot: mismatched, session, outcome: 'passed', config: config({}), env, spawnImpl: fakeSpawn(calls) }), false);
  assert.equal(calls.length, 2);
});

test('the stamp job for a pull request check comments on that pull request without searching for one', async t => {
  const { gh, calls } = fakeGh([[/^auth/, ok()], [/commits\//, ok('sha')], [/statuses\//, ok()], [/^api user/, ok('me\n')],
    [/upstream-org\/widgets\/issues\/12\/comments --paginate/, ok('')], [/upstream-org\/widgets\/issues\/12\/comments --method POST/, ok('https://github.com/c/12\n')]]);
  const stampJob = await job(t, { repo: { host: 'github.com', owner: 'upstream-org', repo: 'widgets' }, branch: 'main', pullRequest: 12, comment: true });
  assert.equal(await runStampJob(stampJob, { gh, wait: async () => {} }), 'done');
  const commands = calls.map(call => call.args.join(' '));
  assert.equal(commands.some(command => /pulls\?|\.parent\.full_name/.test(command)), false, 'no pull request lookup by branch');
  assert.ok(commands.some(command => /repos\/upstream-org\/widgets\/statuses\/b{40} --method POST/.test(command)));
  const { parseStamp } = await import('../action/index.mjs');
  assert.equal(parseStamp(calls.find(call => /issues\/12\/comments --method POST/.test(call.args.join(' '))).input.body).head, snapshot.head);
});

test('GitHub is an optional integration: the CLI, the Git engine, the hook, and the page load without it', async () => {
  // A resolve hook in a fresh process reports whether anything reaches src/github.js.
  const hooks = `export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (resolved.url.endsWith('/src/github.js')) process.stderr.write('github.js loaded\\n');
    return resolved;
  }`;
  const script = `import { register } from 'node:module';
    register('data:text/javascript,' + encodeURIComponent(${JSON.stringify(hooks)}));
    for (const name of ['cli', 'git', 'git-gate', 'browser-interview']) await import(new URL('../src/' + name + '.js', ${JSON.stringify(import.meta.url)}));`;
  const { stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, NO_COLOR: '1' } });
  assert.doesNotMatch(stderr, /github\.js loaded/);
});
