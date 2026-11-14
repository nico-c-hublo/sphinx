import path from 'node:path';
import { settingsTarget } from './user-file.js';
import { lstat, readFile, mkdir, writeFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stableNode } from './node-runtime.js';

const START = '# >>> Sphinx managed MCP server';
const END = '# <<< Sphinx managed MCP server';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function readText(file) {
  try {
    return await readFile((await settingsTarget(file)).path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function parseJson(text, file) {
  if (text === null) return {};
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new Error(`Cannot read ${file}: invalid JSON object. Fix the file and try again.`); }
}

async function writeText(link, text) {
  const { path: file, linked } = await settingsTarget(link);
  // Never delete a dotfiles target through its link; leave it empty instead.
  if (text === null && !linked) { await rm(file, { force: true }); return; }
  text ??= '';
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const mode = await stat(file).then(s => s.mode & 0o777).catch(() => 0o600);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { mode, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

// Read TOML key paths without rewriting TOML or interpreting any setting values.
function keyPath(text) {
  const keys = []; let position = 0;
  while (position < text.length) {
    while (/\s/.test(text[position] || '')) position++;
    if (text[position] === '"') {
      const match = text.slice(position).match(/^"(?:[^"\\]|\\.)*"/);
      if (!match) return null;
      try { keys.push(JSON.parse(match[0])); } catch { return null; }
      position += match[0].length;
    } else if (text[position] === "'") {
      const end = text.indexOf("'", position + 1); if (end < 0) return null;
      keys.push(text.slice(position + 1, end)); position = end + 1;
    } else {
      const match = text.slice(position).match(/^[\w-]+/); if (!match) return null;
      keys.push(match[0]); position += match[0].length;
    }
    while (/\s/.test(text[position] || '')) position++;
    if (position === text.length) return keys;
    if (text[position++] !== '.') return null;
  }
  return keys;
}

function tomlLines(text, file) {
  let mode = null, line = '', escaped = false;
  const lines = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i], triple = text.slice(i, i + 3);
    if (char === '\n') { lines.push(line); line = ''; if (mode === '"' || mode === "'") throw new Error(`Cannot safely update malformed TOML: ${file}`); continue; }
    if (mode === '"""' || mode === "'''") {
      if (triple === mode && !escaped) { mode = null; i += 2; }
      escaped = char === '\\' && !escaped && mode === '"""'; continue;
    }
    if (mode) {
      line += char;
      if (char === mode && !escaped) mode = null;
      escaped = char === '\\' && !escaped && mode === '"'; continue;
    }
    if (char === '#') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
    if (triple === '"""' || triple === "'''") { mode = triple; line += '""'; i += 2; continue; }
    if (char === '"' || char === "'") mode = char;
    line += char;
  }
  if (mode) throw new Error(`Cannot safely update malformed TOML: ${file}`);
  lines.push(line); return lines;
}

function assertNoCodexConflict(text, file) {
  let table = [];
  for (const line of tomlLines(text, file)) {
    const header = line.match(/^\s*\[\[?(.+?)\]\]?\s*$/);
    if (header) {
      table = keyPath(header[1]);
      if (!table) throw new Error(`Cannot safely inspect TOML table names in ${file}. Configure the Sphinx MCP server manually.`);
      if (table[0] === 'mcp_servers' && table[1] === 'sphinx') throw new Error(`An existing sphinx MCP server is defined in ${file}. Rename or remove that entry before installing Sphinx.`);
      continue;
    }
    const assignment = line.match(/^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[\w.-]|\s)+)=/);
    if (!assignment) continue;
    const keys = keyPath(assignment[1].trim());
    if (!keys) continue;
    const full = [...table, ...keys];
    if (full[0] === 'mcp_servers' && (full.length === 1 || full[1] === 'sphinx')) throw new Error(`An existing or inline MCP definition in ${file} conflicts with sphinx. Move it to separate server tables before installing.`);
  }
}

export function nativeHookSpecs(name, sessionHandler) {
  // A plain command, not an MCP tool call: it needs no MCP connection, so it works
  // in sessions opened before installation and exits silently when nothing is queued.
  const handler = { type: 'command', command: sessionHandler.command, timeout: 1800, statusMessage: 'Sphinx understanding check' };
  return [
    // Codex uses the handler's statusMessage as its /hooks display name too.
    { event: 'SessionStart', group: { hooks: [{ ...sessionHandler, statusMessage: 'Sphinx session setup' }] } },
    { event: 'PostToolUse', group: { matcher: 'Bash', hooks: [handler] } },
    ...(name === 'claude' ? [{ event: 'PostToolUseFailure', group: { matcher: 'Bash', hooks: [handler] } }] : []),
  ];
}

export const installedHookSpecs = installed => installed.hooks || [{ event: 'SessionStart', group: { hooks: [installed.handler] } }];

export function hasHook(document, spec) {
  return !!document.hooks?.[spec.event]?.some(group => {
    const { hooks, ...metadata } = group;
    const { hooks: expected, ...expectedMetadata } = spec.group;
    return same(metadata, expectedMetadata) && hooks?.some(handler => same(handler, expected[0]));
  });
}

export function addHook(document, spec) {
  document.hooks ??= {}; document.hooks[spec.event] ??= [];
  if (!hasHook(document, spec)) document.hooks[spec.event].push(spec.group);
}

export function removeHook(document, spec) {
  let removed = false;
  const groups = document.hooks?.[spec.event];
  if (!Array.isArray(groups)) return false;
  document.hooks[spec.event] = groups.flatMap(group => {
    const { hooks, ...metadata } = group;
    const { hooks: expected, ...expectedMetadata } = spec.group;
    if (!same(metadata, expectedMetadata) || !Array.isArray(hooks)) return [group];
    const filtered = hooks.filter(handler => { if (!same(handler, expected[0])) return true; removed = true; return false; });
    return filtered.length ? [{ ...group, hooks: filtered }] : [];
  });
  if (!document.hooks[spec.event].length) delete document.hooks[spec.event];
  if (!Object.keys(document.hooks).length) delete document.hooks;
  return removed;
}

export async function prepareMcp({ name, paths, env, cliPath, previous }) {
  const file = name === 'codex' ? path.join(paths.codexHome, 'config.toml')
    : path.join(!env.SPHINX_USER_HOME && env.CLAUDE_CONFIG_DIR ? paths.claudeHome : paths.userHome, '.claude.json');
  if (previous && previous.file !== file) throw new Error(`The ${name} MCP configuration path changed. Uninstall using the previous environment before reinstalling.`);
  const before = await readText(file), existed = previous?.existed ?? before !== null;
  if (name === 'claude') {
    const document = parseJson(before, file);
    if (document.mcpServers !== undefined && (!document.mcpServers || Array.isArray(document.mcpServers) || typeof document.mcpServers !== 'object')) throw new Error(`Invalid mcpServers object in ${file}`);
    const existing = document.mcpServers?.sphinx;
    if (Object.hasOwn(document.mcpServers || {}, 'sphinx') && (!previous || !same(existing, previous.entry))) throw new Error(`Refusing to replace an existing or edited sphinx MCP server in ${file}. Remove or rename that entry first.`);
    const entry = { type: 'stdio', command: stableNode(env), args: [cliPath, 'mcp'], env: { SPHINX_HOME: paths.home }, timeout: 1800000 };
    document.mcpServers ??= {}; document.mcpServers.sphinx = entry;
    return { before, after: `${JSON.stringify(document, null, 2)}\n`, record: { kind: 'json', file, existed, entry } };
  }
  let base = before || '';
  if (previous) {
    if (base.includes(previous.block)) base = base.replace(previous.block, '');
    else if (before !== null) throw new Error(`Refusing to replace an edited Sphinx MCP block in ${file}. Uninstall first to preserve your edits.`);
  }
  if (base.includes(START) || base.includes(END)) throw new Error(`Untracked Sphinx MCP block in ${file}. Remove or rename it before installing.`);
  assertNoCodexConflict(base, file);
  const separator = base ? base.endsWith('\n') ? '\n' : '\n\n' : '';
  const block = `${separator}${START}\n[mcp_servers.sphinx]\ncommand = ${JSON.stringify(stableNode(env))}\nargs = ${JSON.stringify([cliPath, 'mcp'])}\ntool_timeout_sec = 1800\nenv = { SPHINX_HOME = ${JSON.stringify(paths.home)} }\n${END}\n`;
  return { before, after: base + block, record: { kind: 'toml', file, existed, block } };
}

export async function commitMcp(plan) {
  if (await readText(plan.record.file) !== plan.before) throw new Error(`Settings changed during installation: ${plan.record.file}. Retry installation.`);
  await writeText(plan.record.file, plan.after);
}

export async function rollbackMcp(plan) {
  if (await readText(plan.record.file) === plan.after) await writeText(plan.record.file, plan.before);
}

export async function removeMcp(record) {
  if (!record) return { removed: false, missing: true };
  const text = await readText(record.file);
  if (text === null) return { removed: false, missing: true };
  if (record.kind === 'toml') {
    if (!text.includes(record.block)) return { removed: false, edited: true };
    const after = text.replace(record.block, '');
    await writeText(record.file, !record.existed && !after.trim() ? null : after);
  } else {
    const document = parseJson(text, record.file);
    if (!same(document.mcpServers?.sphinx, record.entry)) return { removed: false, edited: true };
    delete document.mcpServers.sphinx;
    if (!Object.keys(document.mcpServers).length) delete document.mcpServers;
    await writeText(record.file, !record.existed && !Object.keys(document).length ? null : `${JSON.stringify(document, null, 2)}\n`);
  }
  return { removed: true };
}

export async function inspectMcp(record) {
  if (!record) return false;
  try {
    const text = await readText(record.file);
    if (text === null) return false;
    return record.kind === 'toml' ? text.includes(record.block) : same(parseJson(text, record.file).mcpServers?.sphinx, record.entry);
  } catch { return false; }
}
