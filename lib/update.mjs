import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { storagePaths } from './store.mjs';

export const repositoryUrl = 'https://github.com/alexishida/agent-profiles-cli.git';
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export function globalPrefix(packageRoot, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (paths.basename(packageRoot) !== 'agent-profiles' || paths.basename(paths.dirname(packageRoot)) !== 'node_modules') return null;
  const parent = paths.dirname(paths.dirname(packageRoot));
  if (platform === 'win32') return parent;
  return paths.basename(parent) === 'lib' ? paths.dirname(parent) : null;
}

function regularFile(file) {
  try { return fs.statSync(file).isFile(); } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes(err.code)) return false;
    throw err;
  }
}

export function resolveNpmCli(env = process.env) {
  const candidates = [];
  if (env.npm_execpath && path.basename(env.npm_execpath) === 'npm-cli.js') candidates.push(env.npm_execpath);
  const pathValue = Object.entries(env).find(([key]) => process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')?.[1] || '';
  for (let dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    if (process.platform === 'win32' && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
    const launcher = path.resolve(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!regularFile(launcher)) continue;
    const real = fs.realpathSync(launcher);
    candidates.push(process.platform === 'win32'
      ? path.join(path.dirname(real), 'node_modules', 'npm', 'bin', 'npm-cli.js') : real);
  }
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const found = candidates.find(file => path.basename(file) === 'npm-cli.js' && regularFile(file));
  if (!found) throw new Error('npm was not found. Install npm in the current environment to update Agent Profiles.');
  return found;
}

export function runProcess(command, args, { env = process.env, cwd = os.tmpdir(), timeout = 5000, stdio = 'pipe' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio, shell: false, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    const capture = (chunk, stream) => {
      bytes += chunk.length;
      if (bytes > 65536) {
        failure = new Error(`${path.basename(command)} returned too much output.`);
        child.kill('SIGKILL');
        return;
      }
      if (stream === 'stdout') stdout.push(chunk);
      else stderr.push(chunk);
    };
    child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
    const timer = timeout > 0 ? setTimeout(() => {
      failure = new Error(`${path.basename(command)} timed out after ${timeout} ms.`);
      child.kill('SIGKILL');
    }, timeout) : null;
    child.on('error', err => { failure = err; });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

function privateDirectory(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unexpected update directory or symbolic link: ${dir}`);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

export class Updater {
  constructor({ packageRoot, env = process.env, run = runProcess, npmCli, log = message => console.error(message) }) {
    this.packageRoot = fs.realpathSync(packageRoot);
    this.env = env;
    this.run = run;
    this.npmCli = npmCli;
    this.log = log;
  }

  async checked(command, args, options = {}) {
    const result = await this.run(command, args, { env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...options });
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.stderr?.trim() || `exit ${result.status}${result.signal ? ` (${result.signal})` : ''}`}`);
    return result.stdout;
  }

  installedCommit(cacheFile) {
    const metadata = readJson(path.join(this.packageRoot, 'package.json'));
    const lock = readJson(path.join(path.dirname(this.packageRoot), '.package-lock.json'));
    const resolved = lock?.packages?.['node_modules/agent-profiles']?.resolved;
    const commit = typeof resolved === 'string' ? resolved.match(/#([a-f0-9]{40}|[a-f0-9]{64})$/i)?.[1] : null;
    if (commit) return commit.toLowerCase();
    if (typeof metadata?.gitHead === 'string' && commitPattern.test(metadata.gitHead)) return metadata.gitHead.toLowerCase();
    const cached = readJson(cacheFile);
    return cached?.repository === repositoryUrl && typeof cached.commit === 'string' && commitPattern.test(cached.commit) ? cached.commit.toLowerCase() : null;
  }

  async update({ automatic = false } = {}) {
    if (automatic && this.env.AGENT_PROFILES_AUTO_UPDATE === '0') return { status: 'skipped' };
    let prefix = globalPrefix(this.packageRoot);
    // A source checkout or npm-linked checkout must never be overwritten.
    if (automatic && (!prefix || fs.existsSync(path.join(this.packageRoot, '.git')))) return { status: 'skipped' };
    if (!prefix) {
      this.npmCli ||= resolveNpmCli(this.env);
      prefix = (await this.checked(process.execPath, [this.npmCli, 'prefix', '--global'])).trim();
    }
    if (!path.isAbsolute(prefix)) throw new Error('npm returned an invalid global installation prefix.');
    const packageRoot = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', 'agent-profiles');
    const root = storagePaths(this.env).root;
    privateDirectory(root);
    const updateRoot = path.join(root, 'updates');
    privateDirectory(updateRoot);
    const key = createHash('sha256').update(packageRoot).digest('hex');
    const cache = path.join(updateRoot, `${key}.json`);
    const lock = path.join(updateRoot, `${key}.lock`);
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      throw Object.assign(new Error(`another update is in progress. Try again. If no updater is running, remove ${lock}.`), { code: 'UPDATE_BUSY' });
    }
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
      const remote = await this.checked('git', ['ls-remote', '--exit-code', repositoryUrl, 'refs/heads/main']);
      const match = remote.trim().match(/^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/heads\/main$/i);
      if (!match) throw new Error('could not resolve the latest commit on main.');
      const commit = match[1].toLowerCase();
      if (automatic && this.installedCommit(cache) === commit) return { status: 'current', commit };
      this.npmCli ||= resolveNpmCli(this.env);
      this.log(`Updating Agent Profiles from main (${commit.slice(0, 12)})...`);
      await this.checked(process.execPath, [this.npmCli, 'install', '--global', '--prefix', prefix,
        '--allow-git=all', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', `git+${repositoryUrl}#${commit}`],
      { timeout: 180000, stdio: ['ignore', 2, 2] });
      const entry = path.join(packageRoot, 'bin', 'agent-profiles.mjs');
      if (!regularFile(entry) || readJson(path.join(packageRoot, 'package.json'))?.name !== 'agent-profiles') {
        throw new Error('npm reported success, but the Agent Profiles installation could not be verified.');
      }
      const temporary = path.join(updateRoot, `${key}-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify({ repository: repositoryUrl, commit }) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, cache);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      return { status: 'updated', commit, entry };
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
}

export async function restartUpdatedCommand(entry, args, env = process.env) {
  const result = await runProcess(process.execPath, [entry, ...args], {
    env: { ...env, AGENT_PROFILES_AUTO_UPDATE: '0' }, cwd: process.cwd(), timeout: 0, stdio: 'inherit',
  });
  return result.signal ? 128 + (os.constants.signals[result.signal] || 1) : result.status ?? 1;
}
