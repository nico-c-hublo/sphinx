import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir, rename, unlink } from 'node:fs/promises';
import { getPaths, readJson, writeJson } from './config.js';
import { repository } from './git.js';

const TOKEN = /^[a-f0-9-]{36}$/;
const directory = env => path.join(getPaths(env).home, 'presentations');
const filename = (token, env) => {
  if (!TOKEN.test(token)) throw new Error('Invalid questionnaire request.');
  return path.join(directory(env), `${token}.json`);
};

/** One attempt to show a checkpoint's questionnaire: routing metadata, never code or answers. */
export function presentationRequest(session) {
  return { version: 1, token: randomUUID(), id: session.id, repoRoot: session.snapshot.repoRoot, createdAt: Date.now() };
}

/** Git alone queues these requests. */
export async function queuePresentation(session, { env = process.env, delivery } = {}) {
  if (delivery !== undefined && delivery !== 'hook') throw new Error('Invalid questionnaire delivery.');
  const request = {
    ...presentationRequest(session),
    ...(delivery === 'hook' ? { delivery } : {}),
    ...(env.PI_SESSION_ID ? { host: 'pi', hostSession: env.PI_SESSION_ID }
      : env.SPHINX_OPENCODE_SESSION ? { host: 'opencode', hostSession: env.SPHINX_OPENCODE_SESSION }
      : env.SPHINX_CURSOR_SESSION ? { host: 'cursor', hostSession: env.SPHINX_CURSOR_SESSION }
      : env.SPHINX_CLAUDE_SESSION ? { host: 'claude', hostSession: env.SPHINX_CLAUDE_SESSION }
      : env.CODEX_THREAD_ID ? { host: 'codex', hostSession: env.CODEX_THREAD_ID } : {}),
  };
  await writeJson(filename(request.token, env), request);
  return request;
}

export async function listPresentations({ cwd, host, hostSession, checkpointIds, env = process.env }) {
  const files = await readdir(directory(env)).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (!files.length) return [];
  const root = await repository(cwd).then(repo => repo.root).catch(() => null);
  // Cursor does not guarantee sessionStart env reaches shell subprocesses.
  // Its exact Git-emitted IDs can route an untagged git -C push across cwd;
  // they never create requests or override another agent's session ownership.
  const explicitIds = new Set(host === 'cursor' && Array.isArray(checkpointIds)
    ? checkpointIds.filter(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)).slice(0, 64) : []);
  const grouped = new Map();
  for (const file of files.filter(name => TOKEN.test(name.slice(0, -5)) && name.endsWith('.json'))) {
    const request = await readJson(path.join(directory(env), file), null);
    if (!request || request.version !== 1 || !/^[a-f0-9]{64}$/.test(request.id)
      || `${request.token}.json` !== file || !Number.isFinite(request.createdAt)) continue;
    // Git owns these while it waits. A post-tool callback must never start a
    // second interview, including after cancellation or a killed hook process.
    if (request.delivery === 'hook') continue;
    if (explicitIds.size && !explicitIds.has(request.id)) continue;
    // Agent session IDs follow shell commands across git -C and cd. Untagged
    // terminal operations stay in their exact repository instead of crossing projects.
    if (request.hostSession) {
      if (request.host !== host || request.hostSession !== hostSession) continue;
    } else if ((!root || request.repoRoot !== root) && !explicitIds.has(request.id)) continue;
    const group = grouped.get(request.id) || [];
    group.push(request); grouped.set(request.id, group);
  }
  return [...grouped.values()].map(group => {
    group.sort((a, b) => b.createdAt - a.createdAt || b.token.localeCompare(a.token));
    return { ...group[0], superseded: group.slice(1).map(request => request.token) };
  }).sort((a, b) => a.createdAt - b.createdAt);
}

/** Claim each attempt once, so inspecting code after cancellation does not reopen forms. */
export async function claimPresentation(request, { env = process.env } = {}) {
  const file = filename(request.token, env), claimed = `${file}.claimed`;
  try { await rename(file, claimed); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await unlink(claimed);
  // Only remove retries present in the listing. A new Git attempt must remain queued.
  for (const token of request.superseded || []) {
    await unlink(filename(token, env)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return true;
}
