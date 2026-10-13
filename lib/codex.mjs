import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function executable(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(err.code)) return false;
    throw err;
  }
}

export function resolveCodex(env = process.env, platform = process.platform) {
  const pathValue = Object.entries(env).find(([key]) => platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH')?.[1] || '';
  const isWSL = platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(os.release()));
  for (let dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    if (platform === 'win32' && dir.startsWith('"') && dir.endsWith('"')) dir = dir.slice(1, -1);
    for (const name of platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex']) {
      const file = path.resolve(dir, name);
      if (!executable(file, platform)) continue;
      const realFile = fs.realpathSync(file);
      if (isWSL && /^\/mnt\/[a-z]\//i.test(realFile)) continue;
      if (name !== 'codex.cmd') return { command: file, args: [] };
      // Resolve npm's JS entry point without cmd.exe so arguments stay literal.
      const packageRoot = path.join(path.dirname(realFile), 'node_modules', '@openai', 'codex');
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`npm launcher not found next to ${file}. Reinstall @openai/codex or use codex.exe on PATH.`);
        throw err;
      }
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.codex;
      if (pkg.name !== '@openai/codex' || typeof bin !== 'string') throw new Error(`invalid npm launcher: ${file}`);
      const entry = path.resolve(packageRoot, bin);
      const relative = path.relative(packageRoot, entry);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || !executable(entry, 'win32')) {
        throw new Error(`invalid npm entry point: ${file}`);
      }
      const bundledNode = path.join(path.dirname(realFile), 'node.exe');
      return { command: executable(bundledNode, 'win32') ? bundledNode : process.execPath, args: [entry] };
    }
  }
  throw new Error(`Codex was not found on PATH. Install Codex in the current environment (Windows, Linux, or WSL).${isWSL ? ' In WSL, use a Linux installation outside /mnt/c and other Windows drives.' : ''}`);
}

export function callCodex(home, args) {
  const launcher = resolveCodex();
  const result = spawnSync(launcher.command, [...launcher.args, ...args], {
    env: { ...process.env, CODEX_HOME: home }, stdio: 'inherit', shell: false,
  });
  if (result.error) throw new Error(`failed to run Codex: ${result.error.message}`);
  if (result.signal) return 128 + (os.constants.signals[result.signal] || 1);
  return result.status ?? 1;
}
