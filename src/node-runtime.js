// Which Node runs Sphinx. Version managers (mise, nvm, fnm, volta) keep several Node versions and
// put the one chosen for the current directory first on PATH, so a project pinned to an old Node
// would run Sphinx with it. This module must load on that old Node: plain syntax and Node
// built-ins only, never a static import of the rest of Sphinx.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, constants } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** The oldest Node Sphinx runs on, as in engines.node in package.json. */
export const MINIMUM_NODE = '22.19.0';

const parts = version => String(version).replace(/^v/, '').split('.').map(part => parseInt(part, 10) || 0);

/** True when `version` is at least MINIMUM_NODE. */
export function supportedNode(version) {
  const have = parts(version), need = parts(MINIMUM_NODE);
  for (let index = 0; index < 3; index++) if (have[index] !== need[index]) return have[index] > need[index];
  return true;
}

/**
 * The spelling of the running Node that PATH reaches it through, so files Sphinx writes keep
 * working when the version moves. process.execPath is always the resolved file: under mise it
 * names installs/node/24.22.1 even when PATH reached it through the installs/node/lts alias,
 * which mise moves to each new LTS. The first PATH entry whose node is the same file wins; a
 * shim that only dispatches to it (mise's shims/node) is a different file and never matches.
 * Falls back to process.execPath.
 */
export function stableNode(env = process.env, execPath = process.execPath) {
  let real;
  try { real = realpathSync(execPath); } catch { return execPath; }
  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'node');
    try { if (statSync(candidate).isFile() && realpathSync(candidate) === real) return candidate; } catch { /* Not this one. */ }
  }
  return execPath;
}

/**
 * Run before anything else loads. Returns null when this Node is new enough. Otherwise reruns the
 * same command with the Node recorded by sphinx install and returns its exit status, or explains
 * the problem and returns 1. SPHINX_NODE_RERUN stops a recorded Node that is itself too old from
 * rerunning forever.
 */
export function nodeGuard({ version = process.versions.node, env = process.env, argv = process.argv, execPath = process.execPath, spawn = spawnSync, read = readFileSync, write = text => process.stderr.write(text) } = {}) {
  if (supportedNode(version)) return null;
  const userHome = path.resolve(env.SPHINX_USER_HOME || homedir());
  const home = path.resolve(env.SPHINX_HOME || path.join(userHome, '.config', 'sphinx'));
  let recorded = null;
  try { recorded = JSON.parse(read(path.join(home, 'install.json'), 'utf8')).node || null; } catch { /* Not installed, or unreadable. */ }
  if (recorded && env.SPHINX_NODE_RERUN !== '1') {
    let same = false;
    try { same = realpathSync(recorded) === realpathSync(execPath); } catch { /* Gone: spawning it fails below. */ }
    if (!same) {
      const result = spawn(recorded, argv.slice(1), { stdio: 'inherit', env: Object.assign({}, env, { SPHINX_NODE_RERUN: '1' }) });
      if (!result.error) return result.status !== null ? result.status : 128 + (constants.signals[result.signal] || 0);
    }
  }
  write(`Sphinx needs Node.js ${MINIMUM_NODE} or newer, but ${execPath} is Node.js ${version}.`
    + (recorded ? ` The Node recorded by sphinx install (${recorded}) could not run it either.` : '')
    + ' Run Sphinx with a newer Node, or run sphinx install from one so Sphinx can use it here.\n');
  return 1;
}
