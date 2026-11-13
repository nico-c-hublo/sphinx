import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const MODULE_PATH = fileURLToPath(import.meta.url);
const ACTIONS = new Map([
  ['Answer', 'answer'], ['Learn, then try a new scenario', 'learn'],
  ['Dispute this question', 'dispute'], ['Pause', 'pause'],
]);
const checkpoint = async options => (await import('./native-check.js')).runNativeCheckpoint(options);
export const PI_GUIDANCE = [
  'Sphinx Git hooks serve a local browser questionnaire for blocking checkpoints and keep the original Git operation waiting. That same operation continues after verified completion. Native Pi dialogs are fallback checks; they do not resume an exited process.',
  'A repository whose policy sets mode "on-demand" never blocks Git: the human runs sphinx check --pull-request (or sphinx check) when they want the check. Do not run it for them.',
  'Allow enough shell execution time for the human questionnaire. Sphinx waits up to 25 minutes, but the host may cancel the shell sooner. Keep the original process running using the host\'s supported yielding or background execution; do not terminate or duplicate it while the human answers.',
  'Never answer for the human, relay the questionnaire through chat, open or automate its local browser URL, read private Sphinx assessments or answer keys, or bypass Git hooks. After a fallback check passes, verify that the original Git operation exited with a Sphinx blocking failure before retrying. Never repeat successful operations.',
];

function outcomeText(status) {
  if (status === 'busy') return 'A Sphinx questionnaire is already open. Wait for the human to finish it; do not open another interview or duplicate a waiting Git operation.';
  if (status === 'passed') return 'Sphinx fallback checkpoint passed. This does not resume an exited Git process. Before retrying, verify that the original Git operation has exited with a Sphinx blocking failure. Never duplicate a waiting operation or repeat a successful operation.';
  if (status === 'unsupported') return 'Sphinx fallback checkpoint pending. This Pi session has no interactive dialogs. The human can run sphinx check in their own terminal. Never duplicate a waiting Git operation; retry only after the check passes and the original operation has exited with a Sphinx blocking failure. Do not repeat successful operations.';
  if (status === 'pending') return 'Sphinx fallback checkpoint paused. Do not retry Git until the person asks to continue and the previous Git process has exited. Never duplicate a waiting operation.';
  return 'Sphinx fallback checkpoint remains pending. The human can run sphinx check in their own terminal to inspect or resume it. Do not retry Git until the person asks to continue and the previous Git process has exited.';
}

/** Native Pi dialogs are human input, never a model-callable answering tool. */
export async function elicitPiForm(ctx, form, signal) {
  signal?.throwIfAborted();
  const selected = await ctx.ui.select(form.message, [...ACTIONS.keys()], { signal });
  signal?.throwIfAborted();
  const action = ACTIONS.get(selected);
  if (!action) return { action: 'cancel' };
  if (action === 'learn' || action === 'pause') return { action: 'accept', content: { action } };
  const response = await ctx.ui.input(
    `${form.message}\n\n${action === 'dispute' ? 'Why is this question ambiguous or incorrect?' : 'Your prediction and short reason'}`,
    'Up to 8,000 characters. Escape pauses the checkpoint.', { signal },
  );
  signal?.throwIfAborted();
  return response === undefined ? { action: 'cancel' } : { action: 'accept', content: { action, response } };
}

/** Pi 1.2+ fallback dialogs. Waiting Git hooks own their browser presentation. */
export function registerPiIntegration(pi, { home, env = process.env, runCheckpoint = checkpoint } = {}) {
  if (env.SPHINX_EVALUATOR === '1') return;
  const environment = { ...env, ...(home ? { SPHINX_HOME: home } : {}) };
  let lifecycle = new AbortController();
  let tail = Promise.resolve();
  pi.on('before_agent_start', event => {
    // Use Pi's documented mutable guidelines, preserving other prompt sections.
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (Array.isArray(guidelines)) for (const line of PI_GUIDANCE) if (!guidelines.includes(line)) guidelines.push(line);
  });
  pi.on('session_start', () => {
    lifecycle.abort();
    lifecycle = new AbortController();
  });
  pi.on('session_shutdown', () => { lifecycle.abort(); });
  pi.on('tool_result', async (event, ctx) => {
    if (!['bash', 'powershell'].includes(event.toolName) || environment.SPHINX_EVALUATOR === '1') return;
    const signal = ctx.signal ? AbortSignal.any([lifecycle.signal, ctx.signal]) : lifecycle.signal;
    const work = tail.then(async () => {
      if (signal.aborted) return;
      let result;
      try {
        result = await runCheckpoint({
          cwd: ctx.cwd, host: 'pi', hookEvent: 'tool_result',
          hostSession: ctx.sessionManager.getSessionId(), env: environment, signal,
          supportsForm: Boolean(ctx.hasUI && typeof ctx.ui?.select === 'function' && typeof ctx.ui?.input === 'function'),
          elicit: form => elicitPiForm(ctx, form, signal),
        });
      } catch { result = { status: signal.aborted ? 'pending' : 'error' }; }
      if (!result || result.status === 'not-required') return;
      const text = outcomeText(result.status);
      if (!signal.aborted && ctx.hasUI) ctx.ui.notify?.(text, result.status === 'passed' ? 'info' : 'warning');
      // Keep the original shell result, including its failure status. Only this
      // fixed summary enters Pi's transcript; questions and answers do not.
      return {
        content: [...event.content, { type: 'text', text }],
        ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
      };
    });
    // Pi can execute sibling tools concurrently. Serialize dialogs without
    // allowing a rejected attempt to prevent the next queued Git attempt.
    tail = work.then(() => {}, () => {});
    return work;
  });
}

export function piIntegrationHome(paths, env = process.env) {
  const customHome = !env.SPHINX_USER_HOME && env.PI_CODING_AGENT_DIR;
  const piHome = paths.piHome || (customHome ? customHome.replace(/^~(?=\/|$)/u, paths.userHome) : path.join(paths.userHome, '.pi', 'agent'));
  return path.resolve(piHome);
}
const integrationFile = (paths, env) => path.join(piIntegrationHome(paths, env), 'extensions', 'sphinx.js');

export function piExtensionSource({ home, modulePath = MODULE_PATH }) {
  return `// Managed by Sphinx. Fallback human answers stay in Pi's native dialogs.\nimport { registerPiIntegration } from ${JSON.stringify(modulePath)};\nexport default function sphinx(pi) { registerPiIntegration(pi, { home: ${JSON.stringify(home)} }); }\n`;
}

async function inspectFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 100000) throw new Error(`Refusing to replace a nonregular or oversized Pi extension: ${file}`);
    return { text: await handle.readFile('utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (['ELOOP', 'EMLINK'].includes(error.code)) throw new Error(`Refusing to replace a Pi extension symlink: ${file}`);
    throw error;
  } finally { await handle?.close(); }
}

async function checkDirectory(directory) {
  const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Refusing to use a nonregular Pi extensions directory: ${directory}`);
}

async function replaceFile(file, text, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** Validate first; the shared installer commits only after all integrations pass. */
export async function preparePiIntegration(paths, { env = process.env, cliPath, previous } = {}) {
  const file = integrationFile(paths, env);
  await checkDirectory(path.dirname(file));
  if (previous && previous.file !== file) throw new Error('Pi integration home changed. Uninstall the previous integration first.');
  const before = await inspectFile(file);
  const source = piExtensionSource({ home: paths.home });
  if (before && hash(before.text) !== previous?.sha256 && before.text !== source) throw new Error(`Refusing to overwrite an existing or edited Pi extension: ${file}`);
  const record = { kind: 'pi-extension', version: 1, file, sha256: hash(source), modulePath: MODULE_PATH, home: paths.home, cliPath };
  let committed = false;
  return {
    name: 'pi', record,
    async commit() {
      await checkDirectory(path.dirname(file));
      const current = await inspectFile(file);
      if (current?.text !== before?.text) throw new Error(`Pi extension changed during installation: ${file}. Retry installation.`);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await replaceFile(file, source, before?.mode);
      committed = true;
    },
    async rollback() {
      if (!committed) return;
      const current = await inspectFile(file);
      if (current?.text !== source) return;
      if (before) await replaceFile(file, before.text, before.mode);
      else await rm(file);
      committed = false;
    },
  };
}

export async function removePiIntegration(_paths, record) {
  if (!record?.file) return [];
  let current;
  try { current = await inspectFile(record.file); }
  catch { return [`Preserved edited Pi extension: ${record.file}`]; }
  if (!current) return [];
  if (hash(current.text) !== record.sha256) return [`Preserved edited Pi extension: ${record.file}`];
  await rm(record.file);
  return [];
}

export async function piIntegrationStatus(paths, { record, cliPath, env = process.env } = {}) {
  const file = record?.file || integrationFile(paths, env);
  let current;
  try { current = await inspectFile(file); }
  catch { return { installed: Boolean(record), healthy: false, file, detail: 'Pi extension was replaced or is unreadable.' }; }
  const healthy = Boolean(record && current && hash(current.text) === record.sha256
    && record.modulePath === MODULE_PATH && (!cliPath || record.cliPath === cliPath));
  return { installed: Boolean(record), healthy, file, detail: healthy ? 'Sphinx fallback native dialogs are installed; Pi must load the extension. Blocking Git hooks use a local browser page and wait; they do not open a terminal window.' : 'Sphinx Pi extension is missing, edited, or points to an older installation.' };
}
