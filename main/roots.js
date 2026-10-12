// Master folders (D:\projects): the folders StackConsole lists repos from, and where each project sits.
// Discovery is read-only and looks at names only: it never opens a manifest, so cloud placeholders
// (OneDrive) aren't downloaded. It goes folder → container → repo → app, skips dependency and
// system folders, never follows links, and stops after a time budget.
const fs = require('fs');
const path = require('path');
const { commandFolder } = require('./folders');

const MARKERS = ['package.json', 'composer.json', 'artisan', 'manage.py', 'procfile'];
const SKIP = new Set(['node_modules', 'vendor', 'bower_components', '__pycache__', 'venv', 'dist', 'build', 'target', 'bin', 'obj',
  'appdata', 'windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', 'recovery', 'perflogs']);
const SCAN_BUDGET_MS = 4000;      // stop listing after this, and say the list is incomplete
const SCAN_TIMEOUT_MS = 10000;    // a hung network drive: give up on the whole scan
const MAX_DIRS = 4000;
const MAX_APPS = 12;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

// ── Paths ────────────────────────────────────────────────────────
// Real path (links and junctions resolved) and a comparison key that ignores case and trailing slashes.
const canonCache = new Map();
function canon(p) {
  if (!p) return null;
  let hit = canonCache.get(p);
  if (!hit) {
    let real;
    try { real = fs.realpathSync.native(p); } catch { real = path.resolve(p); }
    real = real.replace(/[\\/]+$/, '');
    if (/^[A-Za-z]:$/.test(real)) real += path.sep; // a drive root keeps its slash
    hit = { real, key: real.toLowerCase() };
    canonCache.set(p, hit);
  }
  return hit;
}
const key = (p) => canon(p)?.key || '';

function contains(parentKey, childKey) {
  if (!parentKey || !childKey) return false;
  if (parentKey === childKey) return true;
  return childKey.startsWith(parentKey.endsWith(path.sep) ? parentKey : parentKey + path.sep);
}

function forgetPaths() {
  canonCache.clear();
}

const isDriveRoot = (p) => /^[A-Za-z]:[\\/]?$/.test(p) || path.parse(path.resolve(p)).root === path.resolve(p);

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Discovery ────────────────────────────────────────────────────
async function listDir(dir, budget) {
  if (budget.expired()) { budget.truncated = true; return null; }
  budget.count++;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { budget.unreadable++; return null; }
  const dirs = [];
  const files = new Set();
  let git = null;
  for (const e of entries) {
    if (e.name === '.git') { git = e.isDirectory() ? 'dir' : 'file'; continue; }
    if (e.isSymbolicLink()) continue; // never follow links or junctions (loops, folders elsewhere)
    if (e.isDirectory()) {
      const lower = e.name.toLowerCase();
      if (e.name.startsWith('.') || e.name.startsWith('$') || SKIP.has(lower)) continue;
      dirs.push({ name: e.name, path: path.join(dir, e.name) });
    } else if (e.isFile()) {
      files.add(e.name.toLowerCase());
    }
  }
  return { dirs, files, git };
}

const markersOf = (listing) => MARKERS.filter(m => listing.files.has(m));
const isRepo = (listing) => !!listing.git || markersOf(listing).length > 0;

async function describeRepo(dir, listing, budget) {
  const apps = [];
  for (const d of listing.dirs) {
    if (apps.length >= MAX_APPS) break;
    const sub = await listDir(d.path, budget);
    if (sub && markersOf(sub).length) apps.push(d.name);
  }
  const markers = markersOf(listing);
  return {
    kind: 'repo', name: path.basename(dir), path: dir,
    git: !!listing.git, worktree: listing.git === 'file',
    markers, apps, runnable: markers.length > 0 || apps.length > 0,
  };
}

// One master folder → { exists, items: [repo | folder{repos}], other, truncated, unreadable, watch }
async function scanRoot(rootPath) {
  const budget = {
    start: Date.now(), count: 0, unreadable: 0, truncated: false,
    expired() { return Date.now() - this.start > SCAN_BUDGET_MS || this.count > MAX_DIRS; },
  };
  const result = { path: rootPath, exists: false, items: [], other: 0, truncated: false, unreadable: 0, watch: [rootPath], scannedAt: Date.now() };
  const top = await listDir(rootPath, budget);
  if (!top) { result.exists = isDir(rootPath); return result; }
  result.exists = true;

  for (const d of top.dirs) {
    const listing = await listDir(d.path, budget);
    if (!listing) continue;
    result.watch.push(d.path);
    if (isRepo(listing)) { result.items.push(await describeRepo(d.path, listing, budget)); continue; }
    // Not a repo itself: a container (automart, system barebones) when it holds repos
    const repos = [];
    let others = 0;
    for (const c of listing.dirs) {
      const sub = await listDir(c.path, budget);
      if (sub && isRepo(sub)) repos.push(await describeRepo(c.path, sub, budget));
      else others++;
    }
    if (repos.length) result.items.push({ kind: 'folder', name: d.name, path: d.path, repos: repos.sort(byName), others });
    else result.other++;
  }
  result.items.sort(byName);
  result.truncated = budget.truncated;
  result.unreadable = budget.unreadable;
  return result;
}

function withTimeout(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function statMtime(p) {
  return withTimeout(fs.promises.stat(p).then(s => s.mtimeMs, () => -1), 1500, -2);
}

// Keeps one scan per master folder, refreshes it when its folder layout changes.
function createRootScanner({ onChange }) {
  const scans = new Map();     // root key -> scan result (+ sig)
  const running = new Map();   // root key -> promise

  async function signature(scan) {
    const times = await Promise.all(scan.watch.map(statMtime));
    return times.join(',');
  }

  function rescan(rootPath) {
    const k = key(rootPath);
    if (running.has(k)) return running.get(k);
    let changed = true;
    const job = (async () => {
      const result = await withTimeout(scanRoot(rootPath), SCAN_TIMEOUT_MS, { path: rootPath, exists: true, timedOut: true, items: [], other: 0, watch: [rootPath], scannedAt: Date.now() });
      result.sig = await signature(result);
      const before = scans.get(k);
      const shape = (s) => s && JSON.stringify([s.exists, s.items, s.other, s.truncated, s.timedOut, s.unreadable]);
      changed = !before || shape(before) !== shape(result);
      scans.set(k, result);
    })().catch(() => {}).finally(() => { running.delete(k); if (changed) onChange(); });
    running.set(k, job);
    return job;
  }

  // Make the scans match the configured master folders
  function sync(rootPaths) {
    const wanted = new Set(rootPaths.map(key));
    [...scans.keys()].forEach(k => { if (!wanted.has(k)) scans.delete(k); });
    rootPaths.forEach(p => { if (!scans.has(key(p))) rescan(p); });
  }

  // Cheap check (one stat per listed folder); `full` rescans regardless, for files appearing inside repos
  async function poll(rootPaths, full = false) {
    for (const p of rootPaths) {
      const scan = scans.get(key(p));
      if (!scan || running.has(key(p))) continue;
      if (full || (await signature(scan)) !== scan.sig) rescan(p);
    }
  }

  return { scans, sync, rescan, poll, isScanning: (p) => running.has(key(p)) };
}

// ── Where things go ──────────────────────────────────────────────
// Folders a project already covers: its own folder and each command's folder. Exact matches only:
// a project whose folder is D:\projects itself must not hide every repo inside it.
function coveredKeys(projects) {
  const covered = new Set();
  projects.forEach(p => {
    if (p.baseDirectory) covered.add(key(p.baseDirectory));
    (p.commands || []).forEach(c => { const f = commandFolder(p, c); if (f) covered.add(key(f)); });
  });
  return covered;
}

// The deepest master folder holding `folder`, or -1
function rootIndexFor(folderKey, rootKeys) {
  let best = -1;
  rootKeys.forEach((rk, i) => { if (contains(rk, folderKey) && (best === -1 || rk.length > rootKeys[best].length)) best = i; });
  return best;
}

// Everything the sidebar needs: per project its section (pinned / root / other / empty / archived)
// and container folder; per master folder the repos not set up yet. Derived on each read, never saved.
function buildWorkspace(db, scanner) {
  const projects = db.projects || [];
  const roots = (db.projectRoots || []).filter(r => r && typeof r.path === 'string' && r.path);
  const rootCanon = roots.map(r => canon(r.path));
  const rootKeys = rootCanon.map(c => c.key);
  const covered = coveredKeys(projects);
  const hidden = new Set((db.hiddenRepos || []).map(key));

  // Two projects on one folder (Smartlab / SmartLaboratory System) get told apart
  const byFolder = new Map();
  projects.forEach(p => { if (p.baseDirectory) { const k = key(p.baseDirectory); byFolder.set(k, [...(byFolder.get(k) || []), p]); } });

  const placement = {};
  projects.forEach(p => {
    const place = { section: 'empty', root: null, container: null, hint: null };
    placement[p.id] = place;
    if (p.archived) { place.section = 'archived'; return; }
    const k = p.baseDirectory ? key(p.baseDirectory) : '';
    const twins = k ? (byFolder.get(k) || []).filter(o => o.id !== p.id && !o.archived) : [];
    if (twins.length) { place.hint = 'shares its folder'; place.twin = twins[0].name; }

    const i = k ? rootIndexFor(k, rootKeys) : -1;
    if (i !== -1) {
      const rel = path.relative(rootCanon[i].real, canon(p.baseDirectory).real);
      const segs = rel ? rel.split(/[\\/]/) : [];
      place.root = roots[i].path;
      if (segs.length >= 2) place.container = { name: segs[0], path: path.join(roots[i].path, segs[0]) };
      if (segs.length >= 3 && !place.hint) place.hint = segs.slice(1).join('/');
    }

    if (!p.baseDirectory || !(p.commands || []).length) place.section = 'empty';
    else if (p.pinned) place.section = 'pinned';
    else place.section = i !== -1 ? 'root' : 'other';
    // Outside every master folder: say where (only worth it when there are master folders to compare with)
    if (place.section === 'other' && roots.length && !place.hint) place.hint = path.dirname(canon(p.baseDirectory).real);
    if (place.section === 'pinned' && !place.hint) place.hint = i !== -1 ? path.relative(roots[i].path, path.dirname(p.baseDirectory)) || roots[i].path : null;
  });

  const rootsOut = roots.map((r, i) => {
    const scan = scanner ? scanner.scans.get(rootKeys[i]) : null;
    const mark = (repo) => ({ ...repo, hidden: hidden.has(key(repo.path)) });
    const items = [];
    (scan?.items || []).forEach(it => {
      if (it.kind === 'repo') {
        if (!covered.has(key(it.path))) items.push(mark(it));
      } else {
        const open = it.repos.filter(rp => !covered.has(key(rp.path))).map(mark);
        if (open.length) items.push({ ...it, repos: open, setUp: it.repos.length - open.length, hidden: hidden.has(key(it.path)) });
      }
    });
    const exists = scan ? scan.exists : isDir(r.path);
    return {
      path: r.path,
      name: path.basename(r.path) || r.path,
      exists,
      scanning: scanner ? (!scan || scanner.isScanning(r.path)) : false,
      truncated: !!scan?.truncated,
      timedOut: !!scan?.timedOut,
      unreadable: scan?.unreadable || 0,
      other: scan?.other || 0,
      items,
    };
  });

  return { enabled: roots.length > 0, roots: rootsOut, placement };
}

// First run: suggest the folder that holds most of your projects (never a drive root).
function suggestRoot(projects) {
  const unique = new Map();
  projects.map(p => p.baseDirectory).filter(f => f && isDir(f)).map(f => canon(f)).forEach(c => unique.set(c.key, c));
  const folders = [...unique.values()];
  if (!folders.length) return null;
  // A project folder and its parents, except repos (a repo is a project, not a folder of projects)
  const looksLikeRepo = (dir) => ['.git', ...MARKERS].some(f => fs.existsSync(path.join(dir, f)));
  const candidates = new Set();
  folders.forEach(f => {
    let dir = f.real;
    while (dir && !isDriveRoot(dir)) {
      candidates.add(dir);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  });
  [...candidates].forEach(dir => { if (looksLikeRepo(dir)) candidates.delete(dir); });
  let best = null;
  candidates.forEach(dir => {
    const k = dir.toLowerCase();
    const n = folders.filter(f => contains(k, f.key)).length;
    if (!best || n > best.n || (n === best.n && dir.length > best.dir.length)) best = { dir, n };
  });
  return best ? best.dir : null;
}

// Can `candidate` be added next to `existing` master folders?
function checkOverlap(candidate, existingPaths) {
  const k = key(candidate);
  for (const p of existingPaths) {
    const ek = key(p);
    if (ek === k) return { ok: false, error: `${p} is already in the list.` };
    if (contains(ek, k)) return { ok: false, error: `It's already inside ${p}.` };
  }
  const inside = existingPaths.filter(p => contains(k, key(p)));
  return inside.length ? { ok: false, contains: inside } : { ok: true };
}

module.exports = { canon, key, contains, forgetPaths, scanRoot, createRootScanner, buildWorkspace, suggestRoot, checkOverlap, coveredKeys, isDriveRoot };
