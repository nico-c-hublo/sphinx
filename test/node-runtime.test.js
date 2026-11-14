import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MINIMUM_NODE, supportedNode, stableNode, nodeGuard } from '../src/node-runtime.js';

async function base(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sphinx node '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the minimum Node matches engines.node in package.json', async () => {
  const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
  assert.equal(pkg.engines.node, `>=${MINIMUM_NODE}`);
  for (const version of [MINIMUM_NODE, '22.20.0', '24.0.0', 'v26.10.0']) assert.equal(supportedNode(version), true, version);
  for (const version of ['22.18.9', '20.11.1', '18.0.0', 'v16.20.2']) assert.equal(supportedNode(version), false, version);
});

test('stableNode names the PATH entry that reaches the running Node, not the folder it resolves to', async t => {
  const dir = await base(t);
  const alias = path.join(dir, 'installs', 'node', 'lts', 'bin'), shims = path.join(dir, 'shims'), other = path.join(dir, 'other');
  for (const folder of [alias, shims, other]) await mkdir(folder, { recursive: true });
  await symlink(process.execPath, path.join(alias, 'node'));
  // A shim that dispatches to some node is another file: it is never taken for this one.
  await writeFile(path.join(shims, 'node'), '#!/bin/sh\nexec node "$@"\n'); await chmod(path.join(shims, 'node'), 0o755);
  const PATH = ['relative/bin', shims, other, alias].join(path.delimiter);
  assert.equal(stableNode({ PATH }), path.join(alias, 'node'));
  assert.equal(stableNode({ PATH: [shims, other].join(path.delimiter) }), process.execPath, 'Nothing on PATH reaches it: the resolved file');
  assert.equal(stableNode({ PATH }, path.join(dir, 'missing', 'node')), path.join(dir, 'missing', 'node'), 'An unknown Node is kept as given');
});

test('nodeGuard lets a new enough Node through and reruns an old one with the Node sphinx install recorded', async t => {
  const dir = await base(t);
  const home = path.join(dir, 'sphinx-home'), recorded = path.join(dir, 'recorded', 'node');
  await mkdir(home); await writeFile(path.join(home, 'install.json'), JSON.stringify({ version: 1, installs: {}, agents: {}, node: recorded }));
  const messages = [], calls = [];
  const write = text => messages.push(text);
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { status: 7, signal: null }; };
  const argv = ['/old/node', '/pkg/bin/sphinx.js', 'hook', 'git', 'pre-push'];
  const env = { SPHINX_HOME: home, PATH: '/usr/bin' };

  assert.equal(nodeGuard({ version: MINIMUM_NODE, env, argv, spawn, write }), null);
  assert.equal(calls.length + messages.length, 0);

  assert.equal(nodeGuard({ version: '20.11.1', env, argv, execPath: '/old/node', spawn, write }), 7, 'The rerun exit status is returned');
  assert.equal(calls[0].command, recorded);
  assert.deepEqual(calls[0].args, ['/pkg/bin/sphinx.js', 'hook', 'git', 'pre-push']);
  assert.equal(calls[0].options.stdio, 'inherit', 'Hook input and the terminal go straight to the rerun');
  assert.equal(calls[0].options.env.SPHINX_NODE_RERUN, '1');
  assert.equal(calls[0].options.env.SPHINX_HOME, home);
  assert.deepEqual(messages, []);

  assert.equal(nodeGuard({ version: '20.11.1', env, argv, execPath: '/old/node', spawn: () => ({ status: null, signal: 'SIGTERM' }), write }), 143);
});

test('nodeGuard explains itself instead of looping or failing obscurely', async t => {
  const dir = await base(t);
  const home = path.join(dir, 'sphinx-home'); await mkdir(home);
  const run = (env, spawn = () => { throw new Error('must not rerun'); }) => {
    const messages = [];
    const status = nodeGuard({ version: '20.11.1', env: { SPHINX_HOME: home, ...env }, argv: ['/old/node', '/pkg/bin/sphinx.js', 'status'], execPath: '/old/node', spawn, write: text => messages.push(text) });
    return { status, message: messages.join('') };
  };
  let result = run({});
  assert.equal(result.status, 1);
  assert.match(result.message, /needs Node\.js 22\.19\.0 or newer, but \/old\/node is Node\.js 20\.11\.1.*run sphinx install from one/);

  await writeFile(path.join(home, 'install.json'), JSON.stringify({ node: '/recorded/node' }));
  result = run({ SPHINX_NODE_RERUN: '1' });
  assert.equal(result.status, 1, 'A recorded Node that is itself too old does not rerun again');
  assert.match(result.message, /recorded by sphinx install \(\/recorded\/node\) could not run it either/);

  result = run({}, () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), status: null }));
  assert.equal(result.status, 1, 'A recorded Node that is gone');
  assert.match(result.message, /could not run it either/);
});
