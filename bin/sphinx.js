#!/usr/bin/env node
// The guard runs before the rest of Sphinx loads: on a Node that is too old, Sphinx's own
// modules may not even parse, so they are imported only once the Node is known to be new enough.
import { nodeGuard } from '../src/node-runtime.js';

const rerun = nodeGuard();
if (rerun !== null) process.exitCode = rerun;
else {
  const { main } = await import('../src/cli.js');
  const { formatError } = await import('../src/terminal.js');
  const { withUsageLedger } = await import('../src/usage.js');
  // Only the real CLI process records model usage to the on-disk ledger.
  try { process.exitCode = await withUsageLedger(process.env, () => main(process.argv.slice(2))); }
  catch (error) {
    formatError(error, { plain: process.argv.includes('--json') || ['hook', 'mcp'].includes(process.argv[2]) });
    process.exitCode = error.exitCode || 1;
  }
}
