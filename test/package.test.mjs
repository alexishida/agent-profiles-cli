import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));

test('a package installed into a temporary prefix works and integrates with the shell', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent package ç-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const npmCli = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find(file => file && fs.existsSync(file));
  assert.ok(npmCli, 'Run the tests with npm test (npm is required to validate the package).');
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_DATA_HOME: path.join(tmp, 'data'), npm_config_update_notifier: 'false' };
  const npm = (args, cwd) => {
    const result = spawnSync(process.execPath, [npmCli, ...args], { env, cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.error || result.stderr}`);
    return result.stdout;
  };
  const packOutput = JSON.parse(npm(['pack', '--json', '--pack-destination', tmp, '--ignore-scripts'], repo));
  const packed = Array.isArray(packOutput) ? packOutput[0] : Object.values(packOutput)[0];
  assert.equal(packed.name, 'agent-profiles');
  assert.ok(packed.files.some(file => file.path === 'bin/agent-profiles.mjs'));
  assert.ok(packed.files.some(file => file.path === 'lib/store.mjs'));
  assert.ok(packed.files.some(file => file.path === 'lib/codex.mjs'));
  assert.equal(packed.files.some(file => file.path.startsWith('test/')), false);
  const prefix = path.join(tmp, 'install');
  npm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', path.join(tmp, packed.filename)], tmp);
  const binDir = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const installed = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'agent-profiles', 'bin', 'agent-profiles.mjs');
  const nodeResult = spawnSync(process.execPath, [installed, 'codex', 'create', 'packed', '--no-login'], { env, cwd: tmp, encoding: 'utf8' });
  assert.equal(nodeResult.status, 0, nodeResult.stderr);
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = `${binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || process.env.Path || ''}`;
  if (process.platform === 'win32') {
    const toolsDir = path.join(tmp, 'tools & literal');
    const pkgRoot = path.join(toolsDir, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, 'codex.cmd'), '@echo off\r\nexit /b 99\r\n');
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'codex.mjs' } }));
    fs.writeFileSync(path.join(pkgRoot, 'codex.mjs'), `console.log(JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME, cwd: process.cwd() }));
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`);
    env.PATH = `${toolsDir}${path.delimiter}${env.PATH}`;
    const script = path.join(tmp, 'smoke.ps1');
    fs.writeFileSync(script, '\ufeff' + `$ErrorActionPreference = 'Stop'
agent-profiles codex current
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$integration = agent-profiles codex shell-init powershell | Out-String
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Invoke-Expression $integration
codex 'a b' '' '"quoted"' 'ação' '& echo injected' '$HOME' 'C:\\trailing\\' '--version'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
codex
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:FAKE_EXIT = '7'
codex 'exit-code'
if ($LASTEXITCODE -ne 7) { throw 'Codex exit code was not preserved' }
exit 0
`);
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    for (const shell of [powershell, 'pwsh']) {
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env, cwd: tmp, encoding: 'utf8' });
      if (shell === 'pwsh' && result.error?.code === 'ENOENT') continue;
      assert.equal(result.status, 0, `${shell}: ${result.error || result.stderr}`);
      assert.match(result.stdout, /packed/);
      const calls = result.stdout.trim().split(/\r?\n/).slice(-3).map(line => JSON.parse(line));
      assert.deepEqual(calls[0].args, ['a b', '', '"quoted"', 'ação', '& echo injected', '$HOME', 'C:\\trailing\\', '--version']);
      assert.deepEqual(calls[1].args, []);
      assert.deepEqual(calls[2].args, ['exit-code']);
      for (const call of calls) {
        assert.equal(call.home, path.join(env.XDG_DATA_HOME, 'agent-profiles', 'profiles', 'packed'));
        assert.equal(call.cwd, tmp);
      }
    }
  } else {
    assert.ok(fs.statSync(path.join(binDir, 'agent-profiles')).mode & 0o111);
    const script = path.join(tmp, 'smoke.sh');
    fs.writeFileSync(script, `set -e
agent-profiles codex current
eval "$(agent-profiles codex shell-init "$1")"
`);
    for (const shell of ['bash', 'zsh']) {
      const result = spawnSync(shell, [script, shell], { env, cwd: tmp, encoding: 'utf8' });
      if (result.error?.code === 'ENOENT' && shell === 'zsh') continue;
      assert.equal(result.status, 0, `${shell}: ${result.error || result.stderr}`);
      assert.match(result.stdout, /packed/);
      // `command` bypasses shell functions; test the wrapper through a real stub.
      const stubDir = path.join(tmp, `stub-${shell}`);
      fs.mkdirSync(stubDir);
      fs.writeFileSync(path.join(stubDir, 'agent-profiles'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
      const wrapper = path.join(tmp, `wrapper-${shell}.sh`);
      const init = spawnSync(process.execPath, [installed, 'codex', 'shell-init', shell], { env, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      fs.writeFileSync(wrapper, `${init.stdout}\ncodex 'a b' '--version'\n`);
      const forwarded = spawnSync(shell, [wrapper], { env: { ...env, PATH: `${stubDir}:${env.PATH}` }, cwd: tmp, encoding: 'utf8' });
      assert.equal(forwarded.status, 0, forwarded.stderr);
      assert.deepEqual(forwarded.stdout.trimEnd().split('\n'), ['codex', 'exec', '--', 'a b', '--version']);
    }
  }
});
