#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');
const author = typeof packageMetadata.author === 'string' ? packageMetadata.author : packageMetadata.author?.name;

const usage = `Agent Profiles — Codex account manager for Windows, Linux, and WSL

Version: ${packageMetadata.version}
Author: ${author}

Usage:
  agent-profiles codex create NAME [--no-login]      Creates a profile and starts sign-in
  agent-profiles codex list                          Lists profiles
  agent-profiles codex use NAME                      Sets the active profile
  agent-profiles codex current                       Shows the active profile
  agent-profiles codex login [NAME]                  Signs in to a profile
  agent-profiles codex exec [--] [ARGS]              Runs Codex with the active profile
  agent-profiles codex run NAME [--] [ARGS]          Runs Codex with a specific profile
  agent-profiles codex remove NAME --force           Deletes a profile and its data
  agent-profiles codex remove-all --force             Deletes all Codex profiles and their data
  agent-profiles codex shell-init bash|zsh|powershell
                                                     Prints shell integration code
  agent-profiles codex help                          Shows Codex command help
  agent-profiles help                                Shows this help`;

function shellInit(shell) {
  if (shell === 'powershell' || shell === 'pwsh') {
    return `# Agent Profiles integration (PowerShell)
function global:codex {
  [string[]] $arguments = @($args)
  $json = ConvertTo-Json -InputObject @($arguments) -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  & agent-profiles codex __powershell-exec $encoded
}`;
  }
  if (shell === 'bash' || shell === 'zsh') {
    return `# Agent Profiles integration (${shell})
function codex() {
  command agent-profiles codex exec -- "$@"
}`;
  }
  throw new Error('usage: agent-profiles codex shell-init bash|zsh|powershell');
}

async function main() {
  const [agent = 'help', ...agentArgs] = process.argv.slice(2);
  if (['help', '-h', '--help'].includes(agent)) {
    if (agentArgs.length) throw new Error('usage: agent-profiles help');
    console.log(usage);
    return;
  }
  if (agent !== 'codex') {
    throw new Error(`unknown or unsupported agent '${agent}'. Currently only Codex is supported. Use: agent-profiles codex COMMAND. Run agent-profiles help.`);
  }
  let [action = 'help', ...args] = agentArgs;
  if (action === '__powershell-exec') {
    try {
      if (args.length !== 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args[0])) {
        throw new Error('invalid encoding');
      }
      const decoded = JSON.parse(Buffer.from(args[0], 'base64').toString('utf8'));
      if (!Array.isArray(decoded) || !decoded.every(arg => typeof arg === 'string')) throw new Error('invalid arguments');
      action = 'exec';
      args = ['--', ...decoded];
    } catch {
      throw new Error('invalid PowerShell integration arguments. Run agent-profiles codex shell-init powershell again.');
    }
  }
  // Help and shell setup work even when the state is unavailable or corrupt.
  if (['help', '-h', '--help'].includes(action)) {
    if (args.length) throw new Error('usage: agent-profiles codex help');
    console.log(usage);
    return;
  }
  if (action === 'shell-init') {
    if (args.length !== 1) throw new Error('usage: agent-profiles codex shell-init bash|zsh|powershell');
    console.log(shellInit(args[0]));
    return;
  }
  if (!['create', 'list', 'use', 'current', 'login', 'exec', 'run', 'remove', 'remove-all'].includes(action)) {
    throw new Error(`unknown command '${action}'. Run agent-profiles help.`);
  }
  if (['list', 'current'].includes(action) && args.length) throw new Error(`usage: agent-profiles codex ${action}`);
  if (action === 'use' && args.length !== 1) throw new Error('usage: agent-profiles codex use NAME');
  if (action === 'login' && args.length > 1) throw new Error('usage: agent-profiles codex login [NAME]');
  if (action === 'create' && (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--no-login'))) {
    throw new Error('usage: agent-profiles codex create NAME [--no-login]');
  }
  if (action === 'run' && !args.length) throw new Error('usage: agent-profiles codex run NAME [--] [ARGS]');
  if (action === 'remove' && (args.length !== 2 || args[1] !== '--force')) {
    throw new Error('to delete credentials and sessions, confirm with: agent-profiles codex remove NAME --force');
  }
  if (action === 'remove-all' && (args.length !== 1 || args[0] !== '--force')) {
    throw new Error('to delete all Codex profiles, credentials, and sessions, confirm with: agent-profiles codex remove-all --force');
  }

  const { Store } = await import('../lib/store.mjs');
  const store = new Store();
  if (action === 'remove-all') {
    store.update(state => {
      const count = Object.keys(state.profiles).length;
      if (!count) {
        console.log('No Codex profiles to remove.');
        return;
      }
      store.removeAll(state);
      console.log(`Removed ${count} Codex profiles. Active: (none).`);
    });
    return;
  }
  if (['create', 'use', 'remove', 'run'].includes(action) || (action === 'login' && args.length)) store.validName(args[0]);
  if (['create', 'use', 'remove'].includes(action)) {
    const { default: fs } = await import('node:fs');
    store.update(state => {
      const name = store.validName(args[0]);
      if (action === 'create') {
        if (Object.keys(state.profiles).some(existing => existing.toLowerCase() === name.toLowerCase())) {
          throw new Error(`profile '${name}' already exists (profile names are case-insensitive).`);
        }
        const home = store.homeFor(name);
        store.prepareProfilesRoot();
        // Exclusive creation rejects existing directories and dangling symlinks.
        fs.mkdirSync(home, { mode: 0o700 });
        try {
          state.profiles[name] = { home, createdAt: new Date().toISOString() };
          if (!state.active) state.active = name;
          store.save(state);
        } catch (err) {
          fs.rmdirSync(home);
          throw err;
        }
        console.log(`Profile '${name}' created at ${home}${state.active === name ? ' (active)' : ''}.`);
      } else if (action === 'use') {
        store.ensureProfile(state, name);
        state.active = name;
        store.save(state);
        console.log(`Active profile: ${name}. New Codex sessions will use this account.`);
      } else {
        store.remove(state, name);
        console.log(`Profile '${name}' removed. Active: ${state.active || '(none)'}.`);
      }
    });
    if (action === 'create' && args[1] !== '--no-login') {
      console.log(`Opening Codex sign-in for '${args[0]}'...`);
      const { callCodex } = await import('../lib/codex.mjs');
      process.exitCode = callCodex(store.homeFor(args[0]), ['login']);
    }
    return;
  }

  const state = store.read();
  if (action === 'list') {
    const names = Object.keys(state.profiles).sort();
    if (!names.length) console.log('No profiles. Create one with: agent-profiles codex create personal');
    for (const name of names) console.log(`${state.active === name ? '*' : ' '} ${name}  ${state.profiles[name].home}`);
    return;
  }
  if (action === 'current') {
    if (!state.active) throw new Error('no active profile. Create one with: agent-profiles codex create personal');
    console.log(`${state.active} (${store.ensureProfile(state, state.active).home})`);
    return;
  }

  const name = action === 'exec' ? state.active : (args[0] ?? state.active);
  const profile = store.ensureProfile(state, name);
  store.prepareProfile(name);
  const rest = action === 'run' ? args.slice(1) : args;
  const codexArgs = action === 'login' ? ['login'] : (rest[0] === '--' ? rest.slice(1) : rest);
  const { callCodex } = await import('../lib/codex.mjs');
  process.exitCode = callCodex(profile.home, codexArgs);
}

try {
  await main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
