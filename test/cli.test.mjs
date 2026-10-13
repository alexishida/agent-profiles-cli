import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { storagePaths } from '../lib/store.mjs';
import { resolveCodex } from '../lib/codex.mjs';

const bin = fileURLToPath(new URL('../bin/codex-profile.mjs', import.meta.url));
const packageMetadata = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex profiles ç-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_DATA_HOME: path.join(tmp, 'data'), CODEX_HOME: path.join(tmp, 'ignored') };
  const stateFile = path.join(env.XDG_CONFIG_HOME, 'codex-profiles', 'state.json');
  const profileHome = name => path.join(env.XDG_DATA_HOME, 'codex-profiles', 'profiles', name);
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, cwd: tmp, encoding: 'utf8' });
  const ok = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error || result.stderr}`);
    return result.stdout;
  };
  return { tmp, env, stateFile, profileHome, run, ok };
}

function fakeCodex(f) {
  const dir = path.join(f.tmp, 'tools & literal');
  const pkgRoot = path.join(dir, 'node_modules', '@openai', 'codex');
  fs.mkdirSync(pkgRoot, { recursive: true });
  const script = path.join(pkgRoot, 'codex.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const args = process.argv.slice(2);
console.log(JSON.stringify({args, home: process.env.CODEX_HOME, cwd: process.cwd()}));
if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, 'done');
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'codex.mjs' } }));
  } else {
    fs.writeFileSync(path.join(dir, 'codex'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  }
  // Node normalizes Windows environment keys, but the inherited key may be Path.
  for (const key of Object.keys(f.env)) if (key.toUpperCase() === 'PATH') delete f.env[key];
  f.env.PATH = dir;
  return dir;
}

test('help shows the package version and author', () => {
  const result = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Version: ${packageMetadata.version}`));
  assert.match(result.stdout, new RegExp(`Author: ${packageMetadata.author.name}`));
});

test('creates, switches, lists, and removes profiles outside the checkout', t => {
  const f = fixture(t);
  f.ok('create', 'pessoal', '--no-login');
  f.ok('create', 'trabalho', '--no-login');
  f.ok('use', 'trabalho');
  assert.match(f.ok('current'), /trabalho/);
  assert.match(f.ok('list'), /\* trabalho/);
  f.ok('remove', 'trabalho', '--force');
  assert.match(f.ok('current'), /pessoal/);
  assert.equal(fs.existsSync(f.profileHome('trabalho')), false);
  f.ok('remove', 'pessoal', '--force');
  assert.equal(f.run('current').status, 1);
    assert.match(f.ok('list'), /No profiles/);
});

test('invalid and Windows-reserved names do not create profiles', t => {
  const f = fixture(t);
  for (const name of ['../oops', 'a/b', '_bad', '', 'a'.repeat(65), 'CON', 'nul', 'COM1', 'lpt9']) {
    assert.equal(f.run('create', name, '--no-login').status, 1, name);
    assert.equal(fs.existsSync(f.profileHome('valid')), false);
  }
  assert.match(f.ok('list'), /No profiles/);
});

test('case collisions and inherited properties do not overwrite profiles', t => {
  const f = fixture(t);
  f.ok('create', 'Pessoal', '--no-login');
  assert.equal(f.run('create', 'pessoal', '--no-login').status, 1);
  f.ok('create', 'constructor', '--no-login');
  f.ok('create', 'toString', '--no-login');
  f.ok('use', 'constructor');
  assert.match(f.ok('current'), /constructor/);
  f.ok('remove', 'constructor', '--force');
  assert.equal(f.run('use', 'constructor').status, 1);
});

test('invalid arguments do not change state or remove data', t => {
  const f = fixture(t);
  f.ok('create', 'pessoal', '--no-login');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  for (const args of [['list', 'extra'], ['current', 'extra'], ['use', 'pessoal', 'extra'], ['login', 'pessoal', 'extra'], ['create', 'outro', '--bad'], ['create', 'outro', '--no-login', '--no-login'], ['remove', 'pessoal'], ['remove', 'pessoal', '--force', 'extra'], ['run'], ['unknown']]) {
    const result = f.run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Error:/);
  }
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  assert.equal(fs.existsSync(f.profileHome('pessoal')), true);
});

test('exec and run preserve arguments, CODEX_HOME, cwd, and the active profile', t => {
  const f = fixture(t);
  fakeCodex(f);
  f.ok('create', 'pessoal', '--no-login');
  f.ok('create', 'trabalho', '--no-login');
  const args = ['a b', '', '"quoted"', 'ação', '& echo injected', '%PATH%', '!PATH!', '$HOME', '`echo bad`', 'semi;colon', 'C:\\trailing\\'];
  const active = JSON.parse(f.ok('exec', '--', ...args));
  assert.deepEqual(active.args, args);
  assert.equal(active.home, f.profileHome('pessoal'));
  assert.equal(active.cwd, f.tmp);
  const other = JSON.parse(f.ok('run', 'trabalho', '--', ...args));
  assert.deepEqual(other.args, args);
  assert.equal(other.home, f.profileHome('trabalho'));
  assert.match(f.ok('current'), /pessoal/);
  assert.deepEqual(JSON.parse(f.ok('exec', '--version')).args, ['--version']);
  assert.deepEqual(JSON.parse(f.ok('run', 'trabalho', '--version')).args, ['--version']);
});

test('create and login use the correct profile and release the lock before Codex', t => {
  const f = fixture(t);
  fakeCodex(f);
  const lines = f.ok('create', 'pessoal').trim().split('\n');
  const firstLogin = JSON.parse(lines.at(-1));
  assert.deepEqual(firstLogin.args, ['login']);
  assert.equal(firstLogin.home, f.profileHome('pessoal'));
  assert.equal(fs.existsSync(path.join(path.dirname(f.stateFile), 'state.lock')), false);
  f.ok('create', 'trabalho', '--no-login');
  assert.equal(JSON.parse(f.ok('login', 'trabalho')).home, f.profileHome('trabalho'));
  assert.equal(JSON.parse(f.ok('login')).home, f.profileHome('pessoal'));
});

test('Codex exit code is propagated without truncating output', t => {
  const f = fixture(t);
  fakeCodex(f);
  f.ok('create', 'pessoal', '--no-login');
  f.env.FAKE_EXIT = '7';
  const result = f.run('exec');
  assert.equal(result.status, 7);
  assert.equal(JSON.parse(result.stdout).home, f.profileHome('pessoal'));
});

test('missing Codex produces an actionable error', t => {
  const f = fixture(t);
  fakeCodex(f);
  f.ok('create', 'pessoal', '--no-login');
  f.env.PATH = path.join(f.tmp, 'missing');
  const result = f.run('exec');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Codex was not found on PATH/);
});

test('malformed state is rejected while help and shell-init remain available', t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.stateFile), { recursive: true });
  for (const state of ['{broken', '[]', JSON.stringify({ active: null, profiles: [] }), JSON.stringify({ active: 'missing', profiles: {} }), JSON.stringify({ active: null, profiles: { pessoal: { home: f.tmp } } })]) {
    fs.writeFileSync(f.stateFile, state);
    const result = f.run('list');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read/);
    assert.match(f.ok('help'), /Windows, Linux, and WSL/);
    assert.match(f.ok('shell-init', 'powershell'), /@args/);
    assert.equal(fs.readFileSync(f.stateFile, 'utf8'), state);
  }
});

test('existing directories and symbolic links are not overwritten or deleted', t => {
  const f = fixture(t);
  f.ok('create', 'pessoal', '--no-login');
  const target = path.join(f.tmp, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'untouched');
  fs.rmdirSync(f.profileHome('pessoal'));
  fs.symlinkSync(target, f.profileHome('pessoal'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run('remove', 'pessoal', '--force').status, 1);
  assert.equal(f.run('exec').status, 1);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'untouched');
  fs.mkdirSync(f.profileHome('existing'));
  fs.writeFileSync(path.join(f.profileHome('existing'), 'keep'), 'existing');
  assert.equal(f.run('create', 'existing', '--no-login').status, 1);
  assert.equal(fs.readFileSync(path.join(f.profileHome('existing'), 'keep'), 'utf8'), 'existing');
});

test('the lock prevents lost updates and is cleaned up after errors', t => {
  const f = fixture(t);
  f.ok('create', 'pessoal', '--no-login');
  const lock = path.join(path.dirname(f.stateFile), 'state.lock');
  const before = fs.readFileSync(f.stateFile, 'utf8');
  fs.writeFileSync(lock, '123\n');
  const result = f.run('create', 'outro', '--no-login');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /another change is in progress/);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  fs.unlinkSync(lock);
  assert.equal(f.run('use', 'missing').status, 1);
  assert.equal(fs.existsSync(lock), false);
  f.ok('create', 'outro', '--no-login');
  assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)), ['state.json']);
});

test('concurrent creates preserve every profile whose operation succeeded', async t => {
  const f = fixture(t);
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const name = `profile${i}`;
    const child = spawn(process.execPath, [bin, 'create', name, '--no-login'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ name, status, stderr }));
  })));
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  let successes = 0;
  for (const run of runs) {
    if (run.status === 0) {
      successes++;
      assert.equal(state.profiles[run.name].home, f.profileHome(run.name));
    } else {
      assert.equal(run.status, 1);
      assert.match(run.stderr, /another change is in progress/);
      assert.equal(Object.hasOwn(state.profiles, run.name), false);
    }
  }
  assert.ok(successes > 0);
  assert.equal(Object.keys(state.profiles).length, successes);
});

test('private permissions on Linux and WSL', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  f.ok('create', 'pessoal', '--no-login');
  assert.equal(fs.statSync(f.profileHome('pessoal')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
  f.ok('use', 'pessoal');
  assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600);
});

test('Windows, Linux, and XDG default roots reject relative paths', () => {
  assert.deepEqual(storagePaths({}, 'linux', '/home/test'), { root: '/home/test/.config/codex-profiles', profilesRoot: '/home/test/.local/share/codex-profiles/profiles' });
  assert.deepEqual(storagePaths({ APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\test'), { root: 'C:\\Roaming\\codex-profiles', profilesRoot: 'C:\\Local\\codex-profiles\\profiles' });
  assert.equal(storagePaths({}, 'win32', 'C:\\Users\\test').root, 'C:\\Users\\test\\AppData\\Roaming\\codex-profiles');
  assert.equal(storagePaths({ XDG_CONFIG_HOME: '/custom/config', XDG_DATA_HOME: '/custom/data' }, 'linux', '/home/test').root, '/custom/config/codex-profiles');
  assert.throws(() => storagePaths({ XDG_CONFIG_HOME: 'relative' }, 'linux', '/home/test'), /absolute paths/);
});

test('shell-init supports Bash, Zsh, and PowerShell and rejects extra arguments', t => {
  const f = fixture(t);
  for (const shell of ['bash', 'zsh']) assert.match(f.ok('shell-init', shell), /command codex-profile exec -- "\$@"/);
  for (const shell of ['powershell', 'pwsh']) assert.match(f.ok('shell-init', shell), /function global:codex/);
  assert.equal(f.run('shell-init', 'cmd').status, 1);
  assert.equal(f.run('shell-init', 'bash', 'extra').status, 1);
});

test('the Windows launcher honors Path, accepts spaces, and does not run the cmd shim', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const dir = fakeCodex(f);
  const launcher = resolveCodex({ Path: `"${dir}"` }, 'win32');
  assert.equal(launcher.command, process.execPath);
  assert.match(launcher.args[0], /codex\.mjs$/);
  const pkgFile = path.join(dir, 'node_modules', '@openai', 'codex', 'package.json');
  fs.writeFileSync(pkgFile, JSON.stringify({ name: '@openai/codex', bin: { codex: '../../../outside.mjs' } }));
  assert.throws(() => resolveCodex({ Path: dir }, 'win32'), /invalid npm entry point/);
});
