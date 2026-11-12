import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { install } from '../src/install.js';
import { DEFAULT_CONFIG, saveConfig } from '../src/config.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/sphinx.js', import.meta.url));
// An executable fixture, not a model. This exercises the production CLI
// transport, Pi reviewer, audit, grading, browser server, and receipt checks.
const PROVIDER = `#!/usr/bin/env node
const fs=require('node:fs');let input='';
process.stdin.on('data',part=>input+=part);
process.stdin.on('end',()=>{
 const data=JSON.parse(input.split('\\n').at(-1));
 const phase=data.proposedQuestions?'audit':data.question?'grade':'review';
 fs.appendFileSync(process.env.SPHINX_FIXTURE_CALLS,JSON.stringify({phase,leaked:input.includes('FIXTURE_IGNORED_SECRET')})+'\\n');
 const evidence=[{path:'app.js',reason:'Set membership is checked before adding a repeated id.'}];
 const question={id:'duplicate',concept:'Duplicate suppression',prompt:'Within one running process, does a repeated id enqueue another entry? Give the causal reason.',choices:[],expectedAnswer:'No. The membership test returns before insertion.',rationale:'The existing id causes the early return.',acceptance:{prediction:'A repeated id does not enqueue another entry.',causalReason:'The membership check returns before insertion.'},evidence};
 let result;
 if(phase==='audit')result={questions:data.proposedQuestions,feedback:'The question matches the supplied source.'};
 else if(phase==='grade')result={questionValid:true,verdict:'correct',feedback:'The existing id causes an early return.',evidence,followUp:null};
 else{
  const seen=(data.conversation||[]).filter(item=>item.content.startsWith('Workspace observation')).map(item=>JSON.parse(item.content.slice(item.content.indexOf('\\n')+1)));
  result=seen.length?{action:'finish',calls:[],assessment:{questions:[question]},summary:'Set membership rejects repeated ids.',evidenceIds:seen.map(item=>item.id)}:{action:'tools',calls:[{name:'read_diff',arguments:JSON.stringify({path:'app.js'})}],assessment:null,summary:'',evidenceIds:[]};
 }
 process.stdout.write(JSON.stringify({type:'result',subtype:'success',structured_output:result}));
});
`;

// The production Git gate, asking in the terminal: its real runGitTerminalCheck runs the
// real `sphinx check` with stdin marked as a terminal (as cli.test.js does). That screen goes
// to Git's output, and each line arrives from a file the test writes once its prompt shows.
const terminalLauncher = `import { dispatchHook } from ${JSON.stringify(fileURLToPath(new URL('../src/install.js', import.meta.url)))};
import { runGitGate } from ${JSON.stringify(fileURLToPath(new URL('../src/git-gate.js', import.meta.url)))};
import { runGitTerminalCheck } from ${JSON.stringify(fileURLToPath(new URL('../src/git-interview.js', import.meta.url)))};
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const cli = ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
if (process.argv[2] !== 'hook') process.exit(0);
const event = process.argv[4], controller = new AbortController(); let input = '';
if (event === 'pre-push') for await (const chunk of process.stdin) input += chunk;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort(new Error('fixture interrupted')));
const spawnImpl = (command, args, options) => {
  const script = "Object.defineProperty(process.stdin,'isTTY',{value:true});const {main}=await import(" + JSON.stringify(cli) + ");try{process.exitCode=await main(" + JSON.stringify(args.slice(1)) + ");}catch(error){console.error(error.message);process.exitCode=error.exitCode||1;}";
  const child = spawn(command, ['--input-type=module', '-e', script], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stderr, { end: false }); child.stderr.pipe(process.stderr, { end: false });
  (async () => { for (let n = 0; child.exitCode === null && child.signalCode === null;) { const file = join(process.env.SPHINX_FIXTURE_TERMINAL, 'input-' + n); const line = await readFile(file, 'utf8').catch(() => null); if (line === null) { await delay(20); continue; } await rm(file); child.stdin.write(line + '\\n'); n++; } })();
  return child;
};
const askInTerminal = options => runGitTerminalCheck({ ...options, openTty: () => openSync('/dev/null', 'r'), spawnImpl });
try { process.exitCode = await dispatchHook({ event, args: process.argv.slice(5), input, gate: args => runGitGate({ ...args, askInTerminal, signal: controller.signal }) }); }
catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }
`;
// The production Git gate with no terminal of its own, as in a coding agent's shell: its real
// runGitTerminalCheck opens a separate window through the real launcher, worker, and CLI. Only the
// desktop terminal program is replaced, by a detached process that can outlive Git as a real one
// does, and the window's TTY by typed files in and a log out.
const windowLauncher = `import { dispatchHook } from ${JSON.stringify(fileURLToPath(new URL('../src/install.js', import.meta.url)))};
import { runGitGate } from ${JSON.stringify(fileURLToPath(new URL('../src/git-gate.js', import.meta.url)))};
import { runGitTerminalCheck, runGitCheckpointTerminal } from ${JSON.stringify(fileURLToPath(new URL('../src/git-interview.js', import.meta.url)))};
import { launchCheckpointTerminal } from ${JSON.stringify(fileURLToPath(new URL('../src/terminal-launch.js', import.meta.url)))};
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
if (process.argv[2] !== 'hook') process.exit(0);
const event = process.argv[4], controller = new AbortController(), base = dirname(process.env.SPHINX_FIXTURE_TERMINAL); let input = '';
if (event === 'pre-push') for await (const chunk of process.stdin) input += chunk;
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort(new Error('fixture interrupted')));
const terminal = async (command, { env }) => {
  const child = spawn(process.execPath, [join(base, 'window.mjs'), ...command.args.slice(-2)], { env, detached: true, stdio: 'ignore' });
  appendFileSync(join(base, 'windows.txt'), '+' + child.pid + '\\n'); child.unref(); return true;
};
const launch = options => launchCheckpointTerminal({ ...options, platform: 'linux', launch: terminal, findExecutable: async name => name === 'xterm' ? '/fixture/xterm' : null });
// Never the browser fallback, which would open a real tab on macOS.
const askInTerminal = async options => { const result = await runGitTerminalCheck({ ...options, openTty: () => null, openWindow: values => runGitCheckpointTerminal({ ...values, platform: 'linux', launch }) }); return result.status === 'unavailable' ? { ...result, status: 'pending' } : result; };
try { process.exitCode = await dispatchHook({ event, args: process.argv.slice(5), input, gate: args => runGitGate({ ...args, askInTerminal, signal: controller.signal }) }); }
catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }
`;
const windowScript = `import { runCheckpointTerminal } from ${JSON.stringify(fileURLToPath(new URL('../src/terminal-launch.js', import.meta.url)))};
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const cli = ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)}, typed = process.env.SPHINX_FIXTURE_TERMINAL, base = dirname(typed);
const spawnImpl = (command, args, options) => {
  const script = "Object.defineProperty(process.stdin,'isTTY',{value:true});const {main}=await import(" + JSON.stringify(cli) + ");try{process.exitCode=await main(" + JSON.stringify(args.slice(1)) + ");}catch(error){console.error(error.message);process.exitCode=error.exitCode||1;}";
  const child = spawn(command, ['--input-type=module', '-e', script], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => appendFileSync(join(base, 'window.log'), chunk)); child.stderr.on('data', chunk => appendFileSync(join(base, 'window.log'), chunk));
  // Windows take typed lines in order, across windows.
  (async () => { while (child.exitCode === null && child.signalCode === null) { const [next] = (await readdir(typed)).filter(name => /^input-\\d+$/.test(name)).sort((a, b) => a.slice(6) - b.slice(6)); if (!next) { await delay(20); continue; } const line = await readFile(join(typed, next), 'utf8'); await rm(join(typed, next)); child.stdin.write(line + '\\n'); } })();
  return child;
};
const result = await runCheckpointTerminal({ recordFile: process.argv[2], token: process.argv[3], isTTY: true, spawnImpl, pause: async () => {} });
appendFileSync(join(base, 'window.log'), '[window exit ' + result.code + ']\\n'); appendFileSync(join(base, 'windows.txt'), '-' + process.pid + '\\n');
`;
const ANSWER = 'No. Set membership returns before another insertion in the same process.';

async function fixture(t, { terminal = false, windowed = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'sphinx-browser-git-'));
  const home = path.join(base, 'home'), repo = path.join(base, 'repo'), bin = path.join(base, 'bin'), remote = path.join(base, 'remote.git'), typed = path.join(base, 'terminal');
  await Promise.all([home, repo, bin, typed].map(directory => mkdir(directory)));
  const env = {
    HOME: home, SPHINX_USER_HOME: home, SPHINX_HOME: path.join(home, '.sphinx'),
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    // SSH mode prints the local URL and cannot invoke any desktop launcher. A separate window
    // needs a desktop instead; its launcher never reaches a real terminal or browser.
    // CI must be false to exercise the actual browser default, not fallback.
    ...(windowed ? { DISPLAY: ':99' } : { SSH_CONNECTION: 'disposable-test-no-desktop' }), CI: 'false', TERM: 'dumb', NO_COLOR: '1',
    SPHINX_FIXTURE_CALLS: path.join(base, 'calls.jsonl'), SPHINX_FIXTURE_HOOKS: path.join(base, 'hooks.txt'), SPHINX_FIXTURE_TERMINAL: typed,
  };
  await writeFile(path.join(bin, 'claude'), PROVIDER, { mode: 0o755 });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    // Separate windows are detached from Git, as a desktop terminal is; stop any still open.
    const windows = (await readFile(path.join(base, 'windows.txt'), 'utf8').catch(() => '')).split('\n');
    for (const line of windows) if (line.startsWith('+') && !windows.includes(`-${line.slice(1)}`)) { try { process.kill(-Number(line.slice(1)), 'SIGKILL'); } catch {} }
    await Promise.allSettled(children.map(child => child.finished));
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });
  const git = async (...args) => (await exec('git', args, { cwd: repo, env, timeout: 15000 })).stdout.trimEnd();
  const bare = (...args) => git('--git-dir', remote, ...args);
  await git('init', '-q', '-b', 'main'); await git('config', 'user.name', 'Sphinx browser fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false'); await git('init', '--bare', '-q', remote); await git('remote', 'add', 'origin', remote);
  const app = 'const seen=new Set();\nexport function enqueue(id){if(seen.has(id))return false;seen.add(id);return true;}\n';
  await writeFile(path.join(repo, 'app.js'), app);
  await writeFile(path.join(repo, '.sphinxignore'), '.env\n'); await writeFile(path.join(repo, '.env'), 'FIXTURE_IGNORED_SECRET=never-transmit\n');
  await git('add', '.'); await git('commit', '-qm', 'Fixture queue');
  await writeFile(path.join(repo, '.git/hooks/pre-push'), '#!/bin/sh\nprintf "pre-push\\n" >> "$SPHINX_FIXTURE_HOOKS"\ncat > /dev/null\n', { mode: 0o755 });
  const config = { ...structuredClone(DEFAULT_CONFIG), provider: 'claude', model: null, models: Object.fromEntries(['small', 'medium', 'large'].map(tier => [tier, { provider: 'claude', model: null }])), backgroundPreparation: false, ...(terminal || windowed ? { interface: 'terminal' } : {}) };
  if (terminal) await writeFile(path.join(base, 'terminal-launcher.mjs'), terminalLauncher);
  if (windowed) { await writeFile(path.join(base, 'window-launcher.mjs'), windowLauncher); await writeFile(path.join(base, 'window.mjs'), windowScript); }
  await saveConfig(config, env); await install({ config, cwd: repo, env, agents: 'none', cliPath: terminal ? path.join(base, 'terminal-launcher.mjs') : windowed ? path.join(base, 'window-launcher.mjs') : CLI });
  const startPush = (args = ['push', 'origin', 'main']) => {
    const child = spawn('git', args, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })); });
    child.output = () => stderr;
    return child;
  };
  const until = async (child, url, phase) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = await (await fetch(`${url}/state`)).json();
      if (state.phase === phase) return state;
      assert.ok(!['error', 'recovery'].includes(state.phase) || phase === state.phase, JSON.stringify(state));
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Git exited before ${phase}: ${JSON.stringify(await child.finished)}`);
      await delay(20);
    }
    assert.fail(`Browser ${phase} did not become ready: ${child.output()}`);
  };
  // A held pass opens at the consent step; its page never shows a question.
  const page = async (child, phase = 'question') => {
    const deadline = Date.now() + 20000; let url;
    while (Date.now() < deadline) {
      url ||= child.output().match(/Sphinx questionnaire: (http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+)/u)?.[1];
      if (url) {
        const state = await (await fetch(`${url}/state`)).json();
        if (state.phase === phase) return { url, state };
        assert.ok(!['error', 'recovery', ...(phase === 'consent' ? ['question'] : [])].includes(state.phase), JSON.stringify(state));
      }
      if (child.exitCode !== null || child.signalCode !== null) assert.fail(`Git exited before the browser ${phase}: ${JSON.stringify(await child.finished)}`);
      await delay(20);
    }
    assert.fail(`Browser ${phase} did not become ready: ${child.output()}`);
  };
  const question = child => page(child);
  const submit = ({ url, state }, action, response) => fetch(`${url}/action`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: new URL(url).origin, 'X-Sphinx-Token': new URL(url).pathname.slice(1),
  }, body: JSON.stringify({ id: state.id, revision: state.revision, action, ...(action === 'answer' ? { questionId: state.question.id, response } : {}) }) });
  const hooks = async () => (await readFile(env.SPHINX_FIXTURE_HOOKS, 'utf8')).trim().split('\n');
  const calls = async () => (await readFile(env.SPHINX_FIXTURE_CALLS, 'utf8')).trim().split('\n').map(JSON.parse);
  // Types one line into the terminal check once `prompt` has appeared in Git's output.
  const type = async (child, prompt, line) => {
    const deadline = Date.now() + 20000;
    while (!child.output().includes(prompt)) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) assert.fail(`No prompt ${JSON.stringify(prompt)}: ${child.output()}`);
      await delay(20);
    }
    child.typed = (child.typed ?? -1) + 1;
    await writeFile(path.join(typed, 'next'), line); await rename(path.join(typed, 'next'), path.join(typed, `input-${child.typed}`));
  };
  // Waits for Git's output to match, failing as soon as that Git operation exits instead.
  const said = async (child, pattern) => {
    const deadline = Date.now() + 20000;
    while (!pattern.test(child.output())) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) assert.fail(`Git never printed ${pattern}: ${JSON.stringify(await Promise.race([child.finished, delay(10)]) ?? child.output())}`);
      await delay(20);
    }
  };
  const sessions = async () => { const directory = path.join(env.SPHINX_HOME, 'sessions'); return Promise.all((await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8')))); };
  // A separate window's screen, and a line typed there once `prompt` has shown `count` times.
  // With `child`, waiting fails as soon as that Git operation exits instead.
  const screen = () => readFile(path.join(base, 'window.log'), 'utf8').catch(() => '');
  const shown = async (text, { count = 1, child } = {}) => {
    const deadline = Date.now() + 20000;
    while ((await screen()).split(text).length - 1 < count) {
      if (Date.now() > deadline || (child && (child.exitCode !== null || child.signalCode !== null))) assert.fail(`The window never showed ${JSON.stringify(text)}: ${await screen()}${child ? `\nGit: ${child.output()}` : ''}`);
      await delay(20);
    }
  };
  let windowLines = 0;
  const typeInWindow = async (prompt, line, options) => {
    await shown(prompt, options);
    await writeFile(path.join(typed, 'next'), line); await rename(path.join(typed, 'next'), path.join(typed, `input-${windowLines++}`));
  };
  return { repo, env, app, git, bare, startPush, page, question, until, submit, hooks, calls, type, said, sessions, screen, shown, typeInWindow, children };
}

test('actual default browser hook continues one original push after direct fixture input, while Pause stops a changed push', { timeout: 60000 }, async t => {
  const f = await fixture(t), firstHead = await f.git('rev-parse', 'HEAD');
  const first = f.startPush(), page = await f.question(first);
  assert.equal(first.exitCode, null); assert.equal(page.state.waitingGit, true);
  assert.equal(page.state.question.id, 'duplicate');
  assert.equal(page.state.question.expectedAnswer, undefined);
  assert.equal(page.state.question.acceptance, undefined);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.deepEqual(await f.hooks(), ['pre-push']);
  assert.match(first.output(), /No application was brought to the foreground/);
  const answer = await f.submit(page, 'answer', 'No. Set membership returns before another insertion in the same process.');
  assert.equal(answer.status, 202);
  const consent = await f.until(first, page.url, 'consent');
  assert.equal((await f.submit({ url: page.url, state: consent }, 'proceed')).status, 200);
  const passed = await first.finished;
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stderr, /Continuing this Git operation/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), firstHead);
  assert.equal(f.children.length, 1, 'Completion cannot start a second Git invocation');
  assert.deepEqual(await f.hooks(), ['pre-push']);
  assert.doesNotMatch(passed.stderr, /Set membership returns|Within one running process/);
  await assert.rejects(fetch(`${page.url}/state`), 'The per-operation listener must close after Git finishes');

  await writeFile(path.join(f.repo, 'app.js'), `${f.app}\nexport const retryLimit=3;\n`);
  await f.git('add', 'app.js'); await f.git('commit', '-qm', 'Change fixture retry limit');
  const second = f.startPush(), nextPage = await f.question(second);
  assert.notEqual(nextPage.state.id, page.state.id); assert.equal(second.exitCode, null);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), firstHead);
  assert.equal((await f.submit(nextPage, 'pause')).status, 200);
  const paused = await second.finished;
  assert.notEqual(paused.code, 0); assert.match(paused.stderr, /This Git operation was stopped/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), firstHead);
  assert.deepEqual(await f.hooks(), ['pre-push', 'pre-push']);
  const pending = JSON.parse((await exec(process.execPath, [CLI, 'pending', '--json'], { cwd: f.repo, env: f.env })).stdout);
  assert.equal(pending.length, 1); assert.equal(pending[0].id, nextPage.state.id); assert.equal(pending[0].status, 'active');
  const calls = (await readFile(f.env.SPHINX_FIXTURE_CALLS, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.phase === 'grade').length, 1, 'Pause never grades an answer');
  assert.ok(calls.every(call => !call.leaked), 'Ignored fixture data must never enter any outbound prompt');
  await assert.rejects(fetch(`${nextPage.url}/state`));
});

test('Stop push after a pass keeps the original push from going through, and the same push later asks only Continue or Stop', { timeout: 90000 }, async t => {
  const f = await fixture(t), head = await f.git('rev-parse', 'HEAD');
  const push = f.startPush(), page = await f.question(push);
  assert.equal((await f.submit(page, 'answer', ANSWER)).status, 202);
  const consent = await f.until(push, page.url, 'consent');
  assert.deepEqual(consent.choices.map(choice => choice.label), ['Continue push', 'Stop push']);
  assert.equal((await f.submit({ url: page.url, state: consent }, 'stop')).status, 200);
  const stopped = await push.finished;
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stderr, /you stopped this push after passing, so it did not go through\. Your pass is saved; the next push of this change asks only whether to continue\. A coding agent must not retry it unless you ask\./);
  assert.doesNotMatch(stopped.stderr, /Set membership returns|Within one running process/);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  const calls = await f.calls();
  // The same push again, as a coding agent might retry it: only the choice, first Stop, then Continue.
  for (const choice of ['stop', 'proceed']) {
    const retry = f.startPush(), held = await f.page(retry, 'consent');
    assert.equal(retry.exitCode, null);
    assert.equal(held.state.message, 'You passed this change earlier, but that push did not go through. Continue the push?');
    assert.deepEqual(held.state.messages.filter(item => item.kind === 'question'), [], 'no questions');
    assert.equal(held.state.feedback, undefined, 'nor the earlier feedback, out of context');
    assert.match(retry.output(), /Sphinx: you passed the understanding check for refs\/heads\/main earlier, but that push did not go through\./);
    assert.doesNotMatch(retry.output(), /understanding check needed/);
    assert.match(retry.output(), /\nSphinx: open the local URL above\. No application was brought to the foreground\.\n/, 'there is nothing to answer');
    assert.equal((await f.submit(held, choice)).status, 200);
    const result = await retry.finished;
    if (choice === 'stop') {
      assert.notEqual(result.code, 0); assert.match(result.stderr, /you stopped this push after passing/);
      await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'), 'Stop keeps it held');
    } else {
      assert.equal(result.code, 0, result.stderr); assert.match(result.stderr, /\nSphinx: continuing this Git operation\.\n/);
      assert.equal(await f.bare('rev-parse', 'refs/heads/main'), head);
    }
  }
  assert.deepEqual(await f.calls(), calls, 'asking again made no model call');
  assert.equal(calls.filter(call => call.phase === 'grade').length, 1);
  assert.deepEqual(await f.hooks(), ['pre-push', 'pre-push', 'pre-push']);
});

test('a push to two protected destinations asks to continue once, after both pass, and Stop holds both, so pushing either again asks', { timeout: 120000 }, async t => {
  const f = await fixture(t), head = await f.git('rev-parse', 'HEAD'), both = ['push', 'origin', 'main', 'main:master'];
  const push = f.startPush(both), page = await f.question(push);
  assert.equal((await f.submit(page, 'answer', ANSWER)).status, 202);
  // Reached without a Continue: the first destination never asked.
  const next = await f.until(push, page.url, 'question');
  assert.deepEqual([page.state.target, next.target], ['refs/heads/main', 'refs/heads/master']);
  assert.equal(push.exitCode, null); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal((await f.submit({ url: page.url, state: next }, 'answer', ANSWER)).status, 202);
  const consent = await f.until(push, page.url, 'consent');
  assert.equal(consent.target, 'refs/heads/master');
  assert.equal((await f.submit({ url: page.url, state: consent }, 'stop')).status, 200);
  assert.notEqual((await push.finished).code, 0);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  const calls = await f.calls();
  // Pushing only the destination that passed first still asks; Stop leaves it held.
  const first = f.startPush(), held = await f.page(first, 'consent');
  assert.equal(held.state.target, 'refs/heads/main');
  assert.equal(held.state.message, 'You passed this change earlier, but that push did not go through. Continue the push?');
  assert.equal((await f.submit(held, 'stop')).status, 200);
  assert.notEqual((await first.finished).code, 0);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  // The whole push again: main moves on without asking, and master asks once for both.
  const again = f.startPush(both), last = await f.page(again, 'consent');
  assert.equal(last.state.target, 'refs/heads/master');
  assert.deepEqual(last.state.messages.filter(item => item.kind === 'question'), []);
  // Moving on past main is no Continue: while master waits, main is still held, so pushing it alone asks too.
  assert.deepEqual((await f.sessions()).map(session => [session.snapshot.target.ref, !!session.held]).sort(), [['refs/heads/main', true], ['refs/heads/master', true]]);
  const alone = f.startPush(), asked = await f.page(alone, 'consent');
  assert.equal(asked.state.target, 'refs/heads/main');
  assert.equal((await f.submit(asked, 'stop')).status, 200);
  assert.notEqual((await alone.finished).code, 0); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal((await f.submit(last, 'proceed')).status, 200);
  const result = await again.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.match(/earlier, but that push did not go through\./g).length, 2);
  assert.match(result.stderr, /\nSphinx: continuing this Git operation\.\n/);
  assert.match(result.stderr, /Git is waiting for you to choose in the local Sphinx questionnaire whether this push should continue/);
  assert.deepEqual([await f.bare('rev-parse', 'refs/heads/main'), await f.bare('rev-parse', 'refs/heads/master')], [head, head]);
  assert.deepEqual(await f.calls(), calls, 'no model call after the first push');
});

test('in the terminal, stop after a pass holds it: the same push asks only continue or stop, and continue pushes it', { timeout: 90000 }, async t => {
  const f = await fixture(t, { terminal: true }), head = await f.git('rev-parse', 'HEAD');
  const push = f.startPush();
  await f.type(push, '/stop\n  › ', ANSWER);
  await f.type(push, 'continue / stop: ', 'stop');
  const stopped = await push.finished;
  assert.notEqual(stopped.code, 0);
  assert.match(stopped.stderr, /Question 1 of 1/); assert.match(stopped.stderr, /✓ Understanding check complete\./);
  assert.match(stopped.stderr, /‖ Push stopped\. It did not go through; your pass is saved\./);
  assert.match(stopped.stderr, /Sphinx: you stopped this push after passing, so it did not go through\. Your pass is saved; the next push of this change asks only whether to continue\./, 'exit 4 reached Git as a stop');
  assert.doesNotMatch(stopped.stderr, /Sphinx questionnaire:/, 'the terminal asked, not the browser');
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  const calls = await f.calls();
  const retry = f.startPush();
  await f.type(retry, 'continue / stop: ', 'continue');
  const result = await retry.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Sphinx: you passed the understanding check for refs\/heads\/main earlier, but that push did not go through\./);
  assert.match(result.stderr, /✓ You passed this change earlier, but that push did not go through\.\n\n {2}Continue the push\?/);
  assert.doesNotMatch(result.stderr, /Question 1|Understanding check complete|Open-book/);
  assert.match(result.stderr, /\nSphinx: continuing this Git operation\.\n/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), head);
  assert.deepEqual(await f.calls(), calls, 'asking again made no model call');
});

test('a second copy of the push started at the consent step waits instead of going through, and Stop ends both', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const push = f.startPush(), page = await f.question(push);
  assert.equal((await f.submit(page, 'answer', ANSWER)).status, 202);
  const consent = await f.until(push, page.url, 'consent');
  const [session] = await f.sessions();
  assert.equal(session.status, 'passed'); assert.ok(session.held, 'held as it was saved, before any choice');
  // A coding agent starts the same push again while the human reads the choice.
  const copy = f.startPush();
  await f.said(copy, /Do not start another copy of this push\./);
  await delay(500);
  assert.equal(copy.exitCode, null, 'the copy waits for the same choice'); await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  assert.equal((await f.submit({ url: page.url, state: consent }, 'stop')).status, 200);
  const [stopped, copied] = await Promise.all([push.finished, copy.finished]);
  assert.notEqual(stopped.code, 0); assert.match(stopped.stderr, /you stopped this push after passing, so it did not go through/);
  assert.notEqual(copied.code, 0); assert.match(copied.stderr, /Sphinx: you passed, but this push stopped before you chose to continue, so it did not go through\./);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'), 'Stop held for both');
});

test('a separate terminal window that outlives a cancelled push holds the pass made there, so a retry asks only continue or stop', { timeout: 90000 }, async t => {
  const f = await fixture(t, { windowed: true }), head = await f.git('rev-parse', 'HEAD');
  const push = f.startPush();
  await f.shown('/stop\n  › ', { child: push });
  // A coding agent's shell timed out: the host ends Git and its hook, but not the window.
  process.kill(-push.pid, 'SIGTERM');
  assert.notEqual((await push.finished).code, 0);
  await f.typeInWindow('/stop\n  › ', ANSWER);
  await f.shown('continue / stop: ');
  const [session] = await f.sessions();
  assert.equal(session.status, 'passed'); assert.ok(session.held, 'held as it passed, though no Git gate is left to hold it');
  await f.typeInWindow('continue / stop: ', 'stop');
  await f.shown('[window exit 4]');
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
  const calls = await f.calls();
  const retry = f.startPush();
  await f.typeInWindow('continue / stop: ', 'continue', { count: 2, child: retry });
  const result = await retry.finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Sphinx: you passed the understanding check for refs\/heads\/main earlier, but that push did not go through\./);
  const asked = (await f.screen()).split('[window exit 4]')[1];
  assert.match(asked, /✓ You passed this change earlier, but that push did not go through\./); assert.doesNotMatch(asked, /Question 1/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), head);
  assert.deepEqual(await f.calls(), calls, 'asking again made no model call');
});

test('a retry of one destination waits on the window an earlier destination left open, then asks in its own window whether to continue', { timeout: 90000 }, async t => {
  const f = await fixture(t, { windowed: true });
  const both = f.startPush(['push', 'origin', 'main', 'main:master']);
  await f.shown('/stop\n  › ', { child: both });
  process.kill(-both.pid, 'SIGTERM');
  assert.notEqual((await both.finished).code, 0);
  // The agent retries main alone; main's window, opened as an earlier destination, is still open.
  const retry = f.startPush();
  await f.said(retry, /Do not start another copy of this push\./);
  await f.typeInWindow('/stop\n  › ', ANSWER);
  await f.shown('This push has another destination to check next.');
  // That window never asked whether to continue, so the retry asks in a window of its own.
  await f.typeInWindow('continue / stop: ', 'stop', { child: retry });
  const result = await retry.finished;
  assert.notEqual(result.code, 0, result.stderr); assert.match(result.stderr, /you stopped this push after passing/);
  assert.match((await f.screen()).split('[window exit 0]')[1], /✓ You passed this change earlier, but that push did not go through\.\n\n {2}Continue the push\?/);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'));
});

test('a check passed with sphinx answer while the browser page waits lets the same push continue', { timeout: 60000 }, async t => {
  const f = await fixture(t), head = await f.git('rev-parse', 'HEAD');
  const push = f.startPush(), page = await f.question(push);
  const answered = JSON.parse((await exec(process.execPath, [CLI, 'answer', page.state.id, '--text', 'No. Set membership returns before another insertion in the same process.', '--json'], { cwd: f.repo, env: f.env, timeout: 20000 })).stdout);
  assert.equal(answered.status, 'passed');
  const consent = await f.until(push, page.url, 'consent');
  assert.equal((await f.submit({ url: page.url, state: consent }, 'proceed')).status, 200);
  const passed = await Promise.race([push.finished, delay(15000).then(() => assert.fail(`The push kept waiting after continue: ${push.output()}`))]);
  assert.equal(passed.code, 0, passed.stderr); assert.match(passed.stderr, /Continuing this Git operation/);
  assert.equal(await f.bare('rev-parse', 'refs/heads/main'), head);
  assert.equal(f.children.length, 1); assert.deepEqual(await f.hooks(), ['pre-push']);
});

test('sphinx check --browser serves the page with no Git operation waiting, resumes a pause there, and ends on a pass without asking to continue', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  // The real CLI with no terminal at all: stdin is ignored and nothing is marked as a TTY.
  const startCheck = (...args) => {
    const child = spawn(process.execPath, [CLI, 'check', '--browser', ...args], { cwd: f.repo, env: f.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    f.children.push(child); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output })); });
    child.output = () => output;
    return child;
  };
  const ended = child => Promise.race([child.finished, delay(15000).then(() => assert.fail(`sphinx check --browser kept running: ${child.output()}`))]);

  const first = startCheck(), page = await f.question(first);
  assert.equal(page.state.waitingGit, false, 'no Git operation waits on a manual check');
  assert.equal(page.state.question.id, 'duplicate');
  assert.equal(page.state.question.expectedAnswer, undefined);
  assert.match(first.output(), /No application was brought to the foreground/);
  assert.equal((await f.submit(page, 'pause')).status, 200);
  const paused = await f.until(first, page.url, 'paused');
  assert.equal(paused.resume, `sphinx check --browser --id ${page.state.id}`, 'a pause reopens on the page, not in the terminal');
  const stopped = await ended(first);
  assert.equal(stopped.code, 1, stopped.output);
  // The terminal wraps long lines, so any whitespace may separate the words.
  assert.match(stopped.output, new RegExp(`Progress saved\\.\\s+Run\\s+sphinx\\s+check\\s+--browser\\s+--id\\s+${page.state.id}`));
  await assert.rejects(fetch(`${page.url}/state`), 'the listener closes when the command ends');

  // Closing the terminal saves the check and closes the page, like Ctrl+C.
  const hungUp = startCheck('--id', page.state.id), open = await f.question(hungUp);
  process.kill(-hungUp.pid, 'SIGHUP');
  const hangup = await ended(hungUp);
  assert.equal(hangup.code, 130, hangup.output);
  assert.match(hangup.output, new RegExp(`Progress saved\\.\\s+Run\\s+sphinx\\s+check\\s+--browser\\s+--id\\s+${page.state.id}`));
  await assert.rejects(fetch(`${open.url}/state`), 'a hang-up closes the listener too');

  const second = startCheck('--id', page.state.id), resumed = await f.question(second);
  assert.equal(resumed.state.id, page.state.id); assert.equal(resumed.state.waitingGit, false);
  assert.equal((await f.submit(resumed, 'answer', ANSWER)).status, 202);
  const done = await f.until(second, resumed.url, 'passed');
  assert.match(done.message, /You passed\. You can close this tab\./);
  const passed = await ended(second);
  assert.equal(passed.code, 0, passed.output);
  assert.match(passed.output, /Understanding check complete/);
  assert.equal((await f.sessions()).find(session => session.id === page.state.id).status, 'passed');
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/main'), 'a manual check never pushes');
  assert.equal((await f.calls()).some(call => call.leaked), false, 'ignored files stay out of model requests');
});

test('a push check passed on the page after its Git process exited comments on the pull request when the push that follows stamps it', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  // Unlike insteadOf, which every snapshot would see through, ssh keeps the GitHub URL in
  // the check and the push alike; a fake ssh serves the local bare repository for it.
  const remote = await f.git('remote', 'get-url', 'origin'), ssh = path.join(path.dirname(f.repo), 'ssh');
  await writeFile(ssh, `#!/bin/sh\nfor last; do :; done\nexec sh -c "$(printf '%s' "$last" | sed "s|'acme/widgets.git'|'${remote}'|")"\n`, { mode: 0o755 });
  f.env.GIT_SSH_COMMAND = ssh;
  await f.git('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
  // Pushes of every branch are checked, as in a repository that reviews pull request branches.
  await writeFile(path.join(f.repo, '.sphinxconfig'), JSON.stringify({ version: 1, branches: ['*'] }));
  await f.git('add', '.sphinxconfig'); await f.git('commit', '-qm', 'Check every branch');
  await f.git('push', '-q', '--no-verify', 'origin', 'main');
  await f.git('switch', '-qc', 'feature');
  await writeFile(path.join(f.repo, 'app.js'), `${f.app}export const size=()=>seen.size;\n`);
  await f.git('commit', '-qam', 'Count queued IDs');
  const head = await f.git('rev-parse', 'HEAD');
  // A signed-in gh that finds pull request #12 for the branch and logs every call the stamp worker makes.
  const ghLog = path.join(path.dirname(f.repo), 'gh.log');
  await writeFile(path.join(f.env.PATH.split(path.delimiter)[0], 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "${ghLog}"
case "$*" in
  "auth status"*) exit 0 ;;
  *"/commits/${head}"*) printf '${head}'; exit 0 ;;
  *"/statuses/"*) exit 0 ;;
  *"pulls?state=open"*) printf '[{"number":12}]'; exit 0 ;;
  *"issues/12/comments --method POST"*) printf 'https://github.com/acme/widgets/pull/12#c'; exit 0 ;;
  *"issues/12/comments"*) exit 0 ;;
  "api user"*) printf 'fixture'; exit 0 ;;
esac
exit 1
`, { mode: 0o755 });
  // The check of this push, resumed on the page with no Git operation waiting (as after the push's Git process exited).
  const child = spawn(process.execPath, [CLI, 'check', '--browser', '--remote', 'origin', '--branch', 'feature'], { cwd: f.repo, env: f.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(child); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output })); });
  child.output = () => output;
  const page = await f.question(child);
  assert.equal(page.state.waitingGit, false);
  assert.deepEqual(page.state.stamp, { post: false, action: false }, 'offered although no push waits: the push that follows stamps it');
  const choose = await fetch(`${page.url}/action?stamp=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(page.url).origin, 'X-Sphinx-Token': new URL(page.url).pathname.slice(1) }, body: JSON.stringify({ post: true }) });
  assert.equal(choose.status, 200);
  assert.equal((await f.submit(page, 'answer', ANSWER)).status, 202);
  await f.until(child, page.url, 'passed');
  const passed = await Promise.race([child.finished, delay(15000).then(() => assert.fail(`sphinx check kept running: ${child.output()}`))]);
  assert.equal(passed.code, 0, passed.output);

  // The push has no page of its own; its hook takes the choice saved with the check.
  const pushed = await f.startPush(['push', 'origin', 'feature']).finished;
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(await f.bare('rev-parse', 'refs/heads/feature'), head);
  const last = path.join(f.env.SPHINX_HOME, 'github', 'last.json');
  for (let i = 0; i < 500 && !(await readFile(last, 'utf8').catch(() => '')); i++) await delay(20);
  assert.equal(JSON.parse(await readFile(last, 'utf8')).result, 'done', await readFile(ghLog, 'utf8').catch(() => ''));
  const calls = await readFile(ghLog, 'utf8');
  assert.match(calls, new RegExp(`statuses/${head} --method POST`), 'the commit status, as before');
  assert.match(calls, /issues\/12\/comments --method POST/, 'and the comment chosen on the page');
});

test('a pull request checked with sphinx check --browser --pull-request offers the stamp and, once passed, records it for that pull request', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const url = 'https://github.com/acme/widgets.git', remote = (await f.git('remote', 'get-url', 'origin'));
  await f.git('config', `url.${remote}.insteadOf`, url); await f.git('remote', 'set-url', 'origin', url);
  await f.git('push', '-q', '--no-verify', 'origin', 'main');
  await f.git('switch', '-qc', 'feature');
  await writeFile(path.join(f.repo, 'app.js'), `${f.app}export const size=()=>seen.size;\n`);
  await f.git('commit', '-qam', 'Count queued IDs'); await f.git('push', '-q', '--no-verify', '--set-upstream', 'origin', 'feature');
  const head = await f.git('rev-parse', 'HEAD');
  // gh knows the pull request and nothing else, so the stamp worker stops at "not signed in".
  const pull = JSON.stringify({ number: 12, url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', baseRefName: 'main', headRefOid: head });
  await writeFile(path.join(f.env.PATH.split(path.delimiter)[0], 'gh'), `#!/bin/sh\n[ "$1 $2" = "pr view" ] && { printf '%s' '${pull}'; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [CLI, 'check', '--browser', '--pull-request'], { cwd: f.repo, env: f.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  f.children.push(child); let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  child.finished = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output })); });
  child.output = () => output;

  const page = await f.question(child);
  assert.equal(page.state.waitingGit, false);
  assert.deepEqual(page.state.stamp, { post: false, action: false }, 'the page offers to post the stamp to the pull request');
  const choose = await fetch(`${page.url}/action?stamp=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(page.url).origin, 'X-Sphinx-Token': new URL(page.url).pathname.slice(1) }, body: JSON.stringify({ post: true }) });
  assert.equal(choose.status, 200);
  assert.equal((await f.submit(page, 'answer', ANSWER)).status, 202);
  await f.until(child, page.url, 'passed');
  const passed = await Promise.race([child.finished, delay(15000).then(() => assert.fail(`sphinx check kept running: ${child.output()}`))]);
  assert.equal(passed.code, 0, passed.output);
  assert.match(passed.output, /Posting\s+the\s+result\s+to\s+pull\s+request\s+#12\s+on\s+GitHub/);
  const branches = path.join(f.env.SPHINX_HOME, 'github', 'branches');
  const [recorded] = await Promise.all((await readdir(branches)).map(async name => JSON.parse(await readFile(path.join(branches, name), 'utf8'))));
  assert.equal(recorded.ref, 'pull/acme/widgets/12');
  assert.deepEqual(recorded.records.map(record => [record.head, record.outcome, record.ref]), [[head, 'passed', 'refs/heads/main']]);
  await assert.rejects(f.bare('rev-parse', '--verify', 'refs/heads/feature^{commit}').then(sha => assert.notEqual(sha, head)), 'a pull request check never pushes');
});
