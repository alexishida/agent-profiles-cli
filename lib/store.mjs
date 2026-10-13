import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function storagePaths(env = process.env, platform = process.platform, home = os.homedir(), namespace = 'agent-profiles') {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configRoot = env.XDG_CONFIG_HOME || (platform === 'win32'
    ? env.APPDATA || paths.join(home, 'AppData', 'Roaming') : paths.join(home, '.config'));
  const dataRoot = env.XDG_DATA_HOME || (platform === 'win32'
    ? env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local') : paths.join(home, '.local', 'share'));
  if (!paths.isAbsolute(configRoot) || !paths.isAbsolute(dataRoot)) {
    throw new Error('XDG_CONFIG_HOME, XDG_DATA_HOME, and system directories must be absolute paths.');
  }
  return {
    root: paths.join(configRoot, namespace),
    profilesRoot: paths.join(dataRoot, namespace, 'profiles'),
  };
}

function statOrNull(file) {
  try { return fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function directory(dir) {
  const stat = statOrNull(dir);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`unexpected directory or symbolic link: ${dir}`);
  }
}

function privateDirectory(dir) {
  directory(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
}

export class Store {
  constructor() {
    Object.assign(this, storagePaths());
    // Preserve existing home paths, including credentials tied to those paths.
    const legacy = [storagePaths(process.env, process.platform, os.homedir(), 'codex-profiles')];
    if (process.platform === 'win32' && !process.env.XDG_CONFIG_HOME) {
      legacy.push({
        root: path.join(os.homedir(), '.config', 'codex-profiles'),
        profilesRoot: process.env.XDG_DATA_HOME
          ? path.join(process.env.XDG_DATA_HOME, 'codex-profiles', 'profiles')
          : path.join(os.homedir(), '.local', 'share', 'codex-profiles', 'profiles'),
      });
    }
    if (!statOrNull(path.join(this.root, 'state.json'))) {
      const previous = legacy.find(candidate => statOrNull(path.join(candidate.root, 'state.json')));
      if (previous) Object.assign(this, previous);
    }
    this.stateFile = path.join(this.root, 'state.json');
  }

  validName(name) {
    if (typeof name !== 'string' || !namePattern.test(name) || reservedName.test(name)) {
      throw new Error('invalid name. Use up to 64 ASCII letters, numbers, _, or -, starting with a letter or number; avoid Windows reserved names (CON, NUL, COM1, etc.).');
    }
    return name;
  }

  homeFor(name) { return path.join(this.profilesRoot, this.validName(name)); }

  read() {
    try {
      directory(this.root);
      const stat = statOrNull(this.stateFile);
      if (!stat) return { active: null, profiles: Object.create(null) };
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('state.json must be a regular file');
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!isObject(state) || !isObject(state.profiles)) throw new Error('invalid format');
      const names = new Set();
      for (const [name, profile] of Object.entries(state.profiles)) {
        this.validName(name);
        if (names.has(name.toLowerCase())) throw new Error('ambiguous profile names');
        names.add(name.toLowerCase());
        if (!isObject(profile) || profile.home !== this.homeFor(name)) throw new Error(`unexpected path for '${name}'`);
      }
      if (state.active !== null && (typeof state.active !== 'string' || !Object.hasOwn(state.profiles, state.active))) {
        throw new Error('invalid active profile');
      }
      return state;
    } catch (err) {
      throw new Error(`could not read ${this.stateFile}: ${err.message}`);
    }
  }

  save(state) {
    const tmp = path.join(this.root, `state-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, this.stateFile);
    } finally {
      if (statOrNull(tmp)) fs.unlinkSync(tmp);
    }
  }

  remove(state, name) {
    this.removeProfiles(state, [name]);
  }

  removeAll(state) {
    const names = Object.keys(state.profiles);
    if (names.length) this.removeProfiles(state, names);
  }

  removeProfiles(state, names) {
    // Validate every target before moving or deleting any data.
    const targets = names.map(name => {
      this.ensureProfile(state, name);
      this.checkProfileHome(name);
      return { home: this.homeFor(name), staged: path.join(this.profilesRoot, `.removed-${randomUUID()}`) };
    });
    const next = { ...state, profiles: { ...state.profiles } };
    for (const name of names) delete next.profiles[name];
    if (names.includes(next.active)) next.active = Object.keys(next.profiles).sort()[0] || null;
    const moved = [];
    try {
      for (const target of targets) {
        if (!statOrNull(target.home)) continue;
        fs.renameSync(target.home, target.staged);
        moved.push(target);
      }
      this.save(next);
    } catch (err) {
      const restoreErrors = [];
      for (const target of moved.reverse()) {
        try { fs.renameSync(target.staged, target.home); } catch (restoreError) {
          restoreErrors.push(`${target.staged}: ${restoreError.message}`);
        }
      }
      if (restoreErrors.length) {
        throw new Error(`could not complete removal or restore profiles. Recover their data from ${restoreErrors.join('; ')}`, { cause: err });
      }
      throw err;
    }
    Object.assign(state, next);
    const cleanupErrors = [];
    for (const target of moved) {
      try { fs.rmSync(target.staged, { recursive: true, force: true }); } catch (err) {
        cleanupErrors.push(`${target.staged}: ${err.message}`);
      }
    }
    if (cleanupErrors.length) {
      throw new Error(`profiles removed from state, but some data remains at ${cleanupErrors.join('; ')}`);
    }
  }

  update(change) {
    privateDirectory(this.root);
    const lock = path.join(this.root, 'state.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`another change is in progress. Try again. If no agent-profiles process is running, remove ${lock}.`);
      throw err;
    }
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
      change(this.read());
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }

  ensureProfile(state, name) {
    if (!name || !Object.hasOwn(state.profiles, name)) {
      throw new Error(`profile '${name || '(none)'}' does not exist. Run: agent-profiles codex list`);
    }
    return state.profiles[name];
  }

  prepareProfilesRoot() {
    privateDirectory(path.dirname(this.profilesRoot));
    privateDirectory(this.profilesRoot);
  }

  checkProfileHome(name) {
    directory(path.dirname(this.profilesRoot));
    directory(this.profilesRoot);
    directory(this.homeFor(name));
  }

  prepareProfile(name) {
    this.prepareProfilesRoot();
    privateDirectory(this.homeFor(name));
  }
}
