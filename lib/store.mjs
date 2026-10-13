import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const reservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function storagePaths(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const configRoot = env.XDG_CONFIG_HOME || (platform === 'win32'
    ? env.APPDATA || paths.join(home, 'AppData', 'Roaming') : paths.join(home, '.config'));
  const dataRoot = env.XDG_DATA_HOME || (platform === 'win32'
    ? env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local') : paths.join(home, '.local', 'share'));
  if (!paths.isAbsolute(configRoot) || !paths.isAbsolute(dataRoot)) {
    throw new Error('XDG_CONFIG_HOME, XDG_DATA_HOME, and system directories must be absolute paths.');
  }
  return {
    root: paths.join(configRoot, 'codex-profiles'),
    profilesRoot: paths.join(dataRoot, 'codex-profiles', 'profiles'),
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
    // Earlier releases used Linux-style locations even on Windows.
    const legacyRoot = path.join(os.homedir(), '.config', 'codex-profiles');
    if (process.platform === 'win32' && !process.env.XDG_CONFIG_HOME
        && !fs.existsSync(path.join(this.root, 'state.json'))
        && fs.existsSync(path.join(legacyRoot, 'state.json'))) {
      this.root = legacyRoot;
      if (!process.env.XDG_DATA_HOME) this.profilesRoot = path.join(os.homedir(), '.local', 'share', 'codex-profiles', 'profiles');
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

  update(change) {
    privateDirectory(this.root);
    const lock = path.join(this.root, 'state.lock');
    let fd;
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch (err) {
      if (err.code === 'EEXIST') throw new Error(`another change is in progress. Try again. If no codex-profile process is running, remove ${lock}.`);
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
      throw new Error(`profile '${name || '(none)'}' does not exist. Run: codex-profile list`);
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
