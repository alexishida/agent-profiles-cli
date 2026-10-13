#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');
const author = typeof packageMetadata.author === 'string' ? packageMetadata.author : packageMetadata.author?.name;

const usage = `Codex Profiles — account manager for Windows, Linux, and WSL

Version: ${packageMetadata.version}
Author: ${author}

Usage:
  codex-profile create NAME [--no-login]  Creates a profile and starts sign-in
  codex-profile list                      Lists profiles
  codex-profile use NAME                  Sets the active profile
  codex-profile current                   Shows the active profile
  codex-profile login [NAME]              Signs in to a profile
  codex-profile exec [--] [ARGS]          Runs Codex with the active profile
  codex-profile run NAME [--] [ARGS]      Runs Codex with a specific profile
  codex-profile remove NAME --force       Deletes a profile and its data
  codex-profile shell-init bash|zsh|powershell
                                         Prints shell integration code
  codex-profile help                      Shows this help`;

function shellInit(shell) {
  if (shell === 'powershell' || shell === 'pwsh') {
    return `# Codex Profiles integration (PowerShell)
function global:codex {
  & codex-profile exec '--' @args
}`;
  }
  if (shell === 'bash' || shell === 'zsh') {
    return `# Codex Profiles integration (${shell})
function codex() {
  command codex-profile exec -- "$@"
}`;
  }
  throw new Error('usage: codex-profile shell-init bash|zsh|powershell');
}

async function main() {
  const [action = 'help', ...args] = process.argv.slice(2);
  // Help and shell setup work even when the state is unavailable or corrupt.
  if (['help', '-h', '--help'].includes(action)) {
    if (args.length) throw new Error('usage: codex-profile help');
    console.log(usage);
    return;
  }
  if (action === 'shell-init') {
    if (args.length !== 1) throw new Error('usage: codex-profile shell-init bash|zsh|powershell');
    console.log(shellInit(args[0]));
    return;
  }
  if (!['create', 'list', 'use', 'current', 'login', 'exec', 'run', 'remove'].includes(action)) {
    throw new Error(`unknown command '${action}'. Run codex-profile help.`);
  }
  if (['list', 'current'].includes(action) && args.length) throw new Error(`usage: codex-profile ${action}`);
  if (action === 'use' && args.length !== 1) throw new Error('usage: codex-profile use NAME');
  if (action === 'login' && args.length > 1) throw new Error('usage: codex-profile login [NAME]');
  if (action === 'create' && (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--no-login'))) {
    throw new Error('usage: codex-profile create NAME [--no-login]');
  }
  if (action === 'run' && !args.length) throw new Error('usage: codex-profile run NAME [--] [ARGS]');
  if (action === 'remove' && (args.length !== 2 || args[1] !== '--force')) {
    throw new Error('to delete credentials and sessions, confirm with: codex-profile remove NAME --force');
  }

  const { Store } = await import('../lib/store.mjs');
  const store = new Store();
  if (['create', 'use', 'remove'].includes(action)) store.validName(args[0]);
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
        store.ensureProfile(state, name);
        store.checkProfileHome(name);
        fs.rmSync(store.homeFor(name), { recursive: true, force: true });
        delete state.profiles[name];
        if (state.active === name) state.active = Object.keys(state.profiles).sort()[0] || null;
        store.save(state);
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
    if (!names.length) console.log('No profiles. Create one with: codex-profile create personal');
    for (const name of names) console.log(`${state.active === name ? '*' : ' '} ${name}  ${state.profiles[name].home}`);
    return;
  }
  if (action === 'current') {
    if (!state.active) throw new Error('no active profile. Create one with: codex-profile create personal');
    console.log(`${state.active} (${store.ensureProfile(state, state.active).home})`);
    return;
  }

  const name = action === 'exec' ? state.active : (args[0] || state.active);
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
