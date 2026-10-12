// Project and command folders: where a command runs, whether a folder still exists, where a moved
// folder probably went, and opening a folder in Explorer, VS Code or a terminal.
// Folders always come from StackConsole's own config, never from a path sent by a window.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// The folder a command runs in: its working directory, relative to the project folder or absolute.
function commandFolder(project, cmd) {
  const base = project.baseDirectory || '';
  const wd = (cmd.workingDirectory || '').trim();
  if (!wd) return base || null;
  if (path.isAbsolute(wd)) return wd;
  return base ? path.join(base, wd) : null;
}

// Where did a missing folder go? 1) same path on another drive (C:\projects → D:\projects),
// 2) a folder with the same name next to the user's other project folders. Cached briefly.
const candidateCache = new Map(); // missing path -> { at, value }

function relinkCandidate(missing, knownFolders) {
  if (!missing) return null;
  const hit = candidateCache.get(missing);
  if (hit && Date.now() - hit.at < 10000) return hit.value;

  let value = null;
  const drive = missing.match(/^([A-Za-z]):[\\/](.*)$/);
  if (drive) {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (letter === drive[1].toUpperCase()) continue;
      const candidate = `${letter}:\\${drive[2]}`;
      if (isDir(candidate)) { value = candidate; break; }
    }
  }
  if (!value) {
    const name = path.basename(missing);
    const roots = new Set();
    knownFolders.filter(isDir).forEach(f => { roots.add(path.dirname(f)); roots.add(f); });
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (candidate !== missing && isDir(candidate)) { value = candidate; break; }
    }
  }
  candidateCache.set(missing, { at: Date.now(), value });
  return value;
}

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

// VS Code's `code` is a .cmd shim; launch Code.exe directly so no shell parses the folder path.
async function findVsCode() {
  if (process.platform !== 'win32') return (await run('which', ['code'])).trim() || null;
  const shims = (await run('where', ['code'])).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const candidates = [
    ...shims.map(s => path.resolve(path.dirname(s), '..', 'Code.exe')),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
  ];
  return candidates.find(c => fs.existsSync(c)) || null;
}

function detached(file, args, options = {}) {
  return new Promise(resolve => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false, ...options });
      child.once('error', () => resolve(false));
      child.once('spawn', () => { child.unref(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

// target: 'explorer' | 'vscode' | 'terminal'. Returns { ok } or { ok: false, error }.
async function openFolder(target, folder, shell) {
  if (!isDir(folder)) return { ok: false, error: `Folder not found: ${folder}` };
  if (target === 'explorer') {
    const err = await shell.openPath(folder);
    return err ? { ok: false, error: err } : { ok: true };
  }
  if (target === 'vscode') {
    const code = await findVsCode();
    if (!code) return { ok: false, error: 'VS Code wasn\'t found. Install it, or turn on "Add to PATH" in its installer.' };
    return (await detached(code, [folder])) ? { ok: true } : { ok: false, error: 'VS Code could not be started.' };
  }
  if (target === 'terminal') {
    if (process.platform === 'win32') {
      // Windows Terminal if present, else a classic console; the folder is passed as cwd, not parsed
      if (await detached('wt.exe', ['-d', '.'], { cwd: folder })) return { ok: true };
      return (await detached('cmd.exe', ['/c', 'start', 'StackConsole', 'cmd.exe'], { cwd: folder })) ? { ok: true } : { ok: false, error: 'No terminal could be started.' };
    }
    const term = process.platform === 'darwin' ? ['open', ['-a', 'Terminal', folder]] : ['x-terminal-emulator', []];
    return (await detached(term[0], term[1], { cwd: folder })) ? { ok: true } : { ok: false, error: 'No terminal could be started.' };
  }
  return { ok: false, error: 'Unknown action.' };
}

module.exports = { isDir, commandFolder, relinkCandidate, openFolder };
