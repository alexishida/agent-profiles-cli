import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Updater, globalPrefix, repositoryUrl, resolveNpmCli, runProcess, restartUpdatedCommand } from '../lib/update.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent update ç-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const prefix = path.join(tmp, 'prefix & literal');
  const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'agent-profiles');
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'agent-profiles', version: '0.0.1' }));
  fs.writeFileSync(path.join(packageRoot, 'bin', 'agent-profiles.mjs'), 'process.exitCode = 0;');
  const npmCli = path.join(tmp, 'npm-cli.js');
  fs.writeFileSync(npmCli, '// test npm launcher');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_DATA_HOME: path.join(tmp, 'data'), AGENT_PROFILES_AUTO_UPDATE: '1' };
  const calls = [];
  const logs = [];
  const f = { tmp, prefix, packageRoot, npmCli, env, calls, logs, commit: 'a'.repeat(40) };
  f.run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return { status: 0, stdout: `${f.commit}\trefs/heads/main\n`, stderr: '' };
    if (args[1] === 'prefix') return { status: 0, stdout: `${prefix}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  f.updater = overrides => new Updater({ packageRoot, env, npmCli, run: (...args) => f.run(...args), log: text => logs.push(text), ...overrides });
  f.cacheFiles = () => fs.readdirSync(path.join(env.XDG_CONFIG_HOME, 'agent-profiles', 'updates'));
  f.cache = () => JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'agent-profiles', 'updates', f.cacheFiles().find(name => name.endsWith('.json'))), 'utf8'));
  return f;
}

function copyInstalledCli(f) {
  fs.mkdirSync(path.join(f.packageRoot, 'lib'));
  for (const file of fs.readdirSync(path.join(source, 'lib'))) fs.copyFileSync(path.join(source, 'lib', file), path.join(f.packageRoot, 'lib', file));
  fs.copyFileSync(path.join(source, 'package.json'), path.join(f.packageRoot, 'package.json'));
  const entry = path.join(f.packageRoot, 'bin', 'agent-profiles.mjs');
  fs.copyFileSync(path.join(source, 'bin', 'agent-profiles.mjs'), entry);
  return entry;
}

test('global prefix detection distinguishes installations from source and local packages', () => {
  assert.equal(globalPrefix('C:\\npm\\node_modules\\agent-profiles', 'win32'), 'C:\\npm');
  assert.equal(globalPrefix('/opt/node/lib/node_modules/agent-profiles', 'linux'), '/opt/node');
  assert.equal(globalPrefix('/work/node_modules/agent-profiles', 'linux'), null);
  assert.equal(globalPrefix('/work/agent-profiles', 'linux'), null);
});

test('automatic updates install the main commit once and detect a new commit without a version bump', async t => {
  const f = fixture(t);
  const updater = f.updater();
  assert.equal((await updater.update({ automatic: true })).status, 'updated');
  assert.deepEqual(f.calls[0].args, ['ls-remote', '--exit-code', repositoryUrl, 'refs/heads/main']);
  const install = f.calls.find(call => call.args[1] === 'install');
  assert.equal(install.command, process.execPath);
  assert.ok(install.args.includes(`git+${repositoryUrl}#${f.commit}`));
  assert.equal(install.args[install.args.indexOf('--prefix') + 1], f.prefix);
  assert.ok(install.args.includes('--allow-git=all'));
  assert.equal(f.cache().commit, f.commit);
  assert.equal((await updater.update({ automatic: true })).status, 'current');
  assert.equal(f.calls.filter(call => call.args[1] === 'install').length, 1);
  f.commit = 'b'.repeat(40);
  assert.equal((await updater.update({ automatic: true })).status, 'updated');
  assert.equal(f.calls.filter(call => call.args[1] === 'install').length, 2);
  assert.equal(f.cache().commit, f.commit);
  assert.equal(f.cacheFiles().length, 1);
});

test('Git installation metadata prevents an unnecessary first reinstall and overrides an old cache', async t => {
  const f = fixture(t);
  const lock = path.join(path.dirname(f.packageRoot), '.package-lock.json');
  fs.writeFileSync(lock, JSON.stringify({ packages: { 'node_modules/agent-profiles': { resolved: `git+${repositoryUrl}#${f.commit}` } } }));
  assert.equal((await f.updater().update({ automatic: true })).status, 'current');
  assert.equal(f.calls.length, 1);
  f.commit = 'b'.repeat(40);
  assert.equal((await f.updater().update({ automatic: true })).status, 'updated');
  // An external reinstall can change the installed commit independently of the updater cache.
  f.commit = 'a'.repeat(40);
  assert.equal((await f.updater().update({ automatic: true })).status, 'current');
});

test('manual update reinstalls main even when current or automatic updating is disabled', async t => {
  const f = fixture(t);
  f.env.AGENT_PROFILES_AUTO_UPDATE = '0';
  assert.equal((await f.updater().update({ automatic: true })).status, 'skipped');
  assert.equal(f.calls.length, 0);
  await f.updater().update();
  await f.updater().update();
  assert.equal(f.calls.filter(call => call.args[1] === 'install').length, 2);
});

test('source and npm-linked checkouts are skipped automatically; explicit update targets the global prefix', async t => {
  const f = fixture(t);
  const checkout = path.join(f.tmp, 'checkout');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'keep'), 'source work');
  assert.equal((await f.updater({ packageRoot: checkout }).update({ automatic: true })).status, 'skipped');
  assert.equal(f.calls.length, 0);
  const result = await f.updater({ packageRoot: checkout }).update();
  assert.equal(result.entry, path.join(f.packageRoot, 'bin', 'agent-profiles.mjs'));
  assert.equal(fs.readFileSync(path.join(checkout, 'keep'), 'utf8'), 'source work');
  assert.equal(f.calls[0].args[1], 'prefix');
  if (process.platform !== 'win32') {
    const linked = path.join(f.tmp, 'linked-prefix', 'lib', 'node_modules', 'agent-profiles');
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.symlinkSync(checkout, linked, 'dir');
    const before = f.calls.length;
    assert.equal((await f.updater({ packageRoot: linked }).update({ automatic: true })).status, 'skipped');
    assert.equal(f.calls.length, before);
  }
});

test('invalid main responses and Git failures never start installation', async t => {
  const f = fixture(t);
  for (const response of ['not-a-commit\trefs/heads/main\n', `${f.commit}\trefs/tags/v999\n`]) {
    f.run = async () => ({ status: 0, stdout: response, stderr: '' });
    await assert.rejects(f.updater().update(), /latest commit on main/);
    assert.deepEqual(f.cacheFiles(), []);
  }
  f.run = async () => ({ status: 128, stdout: '', stderr: 'network unavailable' });
  await assert.rejects(f.updater().update(), /network unavailable/);
  assert.deepEqual(f.cacheFiles(), []);
});

test('failed npm installation preserves the previous commit stamp and profile data', async t => {
  const f = fixture(t);
  await f.updater().update();
  const profileState = path.join(f.env.XDG_CONFIG_HOME, 'agent-profiles', 'state.json');
  fs.writeFileSync(profileState, 'test profile state');
  f.commit = 'b'.repeat(40);
  const run = f.run;
  f.run = async (...args) => args[1][1] === 'install' ? { status: 1, stdout: '', stderr: 'permission denied' } : run(...args);
  await assert.rejects(f.updater().update(), /permission denied/);
  assert.equal(f.cache().commit, 'a'.repeat(40));
  assert.equal(fs.readFileSync(profileState, 'utf8'), 'test profile state');
  assert.equal(f.cacheFiles().length, 1);
});

test('simultaneous updates are serialized with an exclusive lock', async t => {
  const f = fixture(t);
  let release;
  let started;
  const reachedGit = new Promise(resolve => { started = resolve; });
  const run = f.run;
  f.run = async (...args) => {
    if (args[0] === 'git') {
      started();
      await new Promise(resolve => { release = resolve; });
    }
    return run(...args);
  };
  const first = f.updater().update();
  await reachedGit;
  try {
    await assert.rejects(f.updater().update(), err => err.code === 'UPDATE_BUSY');
  } finally {
    release();
    await first;
  }
  assert.equal(f.calls.filter(call => call.args[1] === 'install').length, 1);
  assert.equal(f.cacheFiles().length, 1);
});

test('subprocess execution preserves literal arguments, output, exit codes, and enforces deadlines', async () => {
  const args = ['a b', '', '"quoted"', 'ação', '& echo injected'];
  const result = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1))); console.error("diagnostic"); process.exitCode=7;', '--', ...args]);
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.match(result.stderr, /diagnostic/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { timeout: 150 }), /timed out/);
  await assert.rejects(runProcess('missing-agent-profiles-executable', []), /ENOENT/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'console.log("x".repeat(70000));']), /too much output/);
});

test('restarting after update preserves arguments and suppresses recursive updating', async t => {
  const f = fixture(t);
  const marker = path.join(f.tmp, 'restarted.json');
  const entry = path.join(f.tmp, 'new-entry.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs';
fs.writeFileSync(process.env.RESTART_MARKER, JSON.stringify({args: process.argv.slice(2), disabled: process.env.AGENT_PROFILES_AUTO_UPDATE, cwd: process.cwd()}));
process.exitCode = 7;
`);
  const args = ['codex', 'exec', '--', 'a b', '', '"quoted"'];
  const status = await restartUpdatedCommand(entry, args, { ...f.env, RESTART_MARKER: marker });
  assert.equal(status, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { args, disabled: '0', cwd: process.cwd() });
});

test('npm is resolved to a JavaScript entry point without a shell shim', t => {
  const f = fixture(t);
  assert.equal(resolveNpmCli({ npm_execpath: f.npmCli }), f.npmCli);
});

test('offline automatic checks preserve operational stdout, while explicit updates fail clearly', t => {
  const f = fixture(t);
  const entry = copyInstalledCli(f);
  const env = { ...f.env, npm_execpath: f.npmCli, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.tmp, 'no-global-git-config'),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${path.join(f.tmp, 'missing-remote').replaceAll('\\', '/')}.insteadOf`, GIT_CONFIG_VALUE_0: repositoryUrl };
  const invoke = (...args) => spawnSync(process.execPath, [entry, ...args], { env, cwd: f.tmp, encoding: 'utf8', timeout: 15000 });
  for (const args of [['help'], ['codex', 'shell-init', 'powershell']]) {
    const result = invoke(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(path.join(env.XDG_CONFIG_HOME, 'agent-profiles', 'updates')), false);
  }
  const invalid = invoke('update', 'extra');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /usage: agent-profiles update/);
  const list = invoke('codex', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^No profiles\./);
  assert.match(list.stderr, /Warning: automatic update failed/);
  const manual = invoke('update');
  assert.equal(manual.status, 1);
  assert.equal(manual.stdout, '');
  assert.match(manual.stderr, /Error:/);
  assert.deepEqual(f.cacheFiles(), []);
});

test('installed CLI auto-updates from a local main branch and executes the new entry point', t => {
  const f = fixture(t);
  const remote = path.join(f.tmp, 'remote');
  fs.mkdirSync(remote);
  const gitEnv = { ...f.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(f.tmp, 'no-global-git-config') };
  const git = (...args) => {
    const result = spawnSync('git', args, { env: gitEnv, cwd: remote, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout.trim();
  };
  git('init');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(remote, 'fixture.txt'), 'old tagged release');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'tagged');
  git('tag', 'v999.0.0');
  fs.writeFileSync(path.join(remote, 'fixture.txt'), 'new main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'main');
  const head = git('rev-parse', 'refs/heads/main');
  const entry = copyInstalledCli(f);
  const marker = path.join(f.tmp, 'npm-install.json');
  fs.writeFileSync(f.npmCli, `const fs = require('node:fs');
fs.writeFileSync(process.env.INSTALL_MARKER, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(process.env.INSTALL_ENTRY, 'console.log(JSON.stringify({updated:true,args:process.argv.slice(2),auto:process.env.AGENT_PROFILES_AUTO_UPDATE}));');
`);
  const env = { ...gitEnv, npm_execpath: f.npmCli, INSTALL_MARKER: marker, INSTALL_ENTRY: entry,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote.replaceAll('\\', '/')}.insteadOf`, GIT_CONFIG_VALUE_0: repositoryUrl };
  const result = spawnSync(process.execPath, [entry, 'codex', 'list'], { env, cwd: f.tmp, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.ok(result.stdout.trim(), `empty stdout; stderr: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), { updated: true, args: ['codex', 'list'], auto: '0' });
  assert.match(result.stderr, /Updating Agent Profiles from main/);
  const installArgs = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.ok(installArgs.includes(`git+${repositoryUrl}#${head}`));
  assert.equal(installArgs[installArgs.indexOf('--prefix') + 1], f.prefix);
  assert.equal(f.cache().commit, head);
});
