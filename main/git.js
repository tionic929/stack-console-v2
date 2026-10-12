// Git branch of a folder, read straight from .git/HEAD (no git binary needed).
// Works for normal repos, worktrees and submodules (".git" file with "gitdir: …").
// Results are cached per HEAD file and refreshed when its mtime changes.
const fs = require('fs');
const path = require('path');

const gitDirCache = new Map();  // folder -> { gitDir, root } | null
const headCache = new Map();    // HEAD path -> { mtimeMs, info }

function findGitDir(start) {
  const key = path.resolve(start);
  if (gitDirCache.has(key)) return gitDirCache.get(key);
  let dir = key;
  let found = null;
  for (let i = 0; i < 64; i++) {
    const dotgit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotgit);
      if (stat.isDirectory()) { found = { gitDir: dotgit, root: dir }; break; }
      if (stat.isFile()) {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
        if (m) { found = { gitDir: path.resolve(dir, m[1]), root: dir }; break; }
      }
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  gitDirCache.set(key, found);
  return found;
}

// Returns { branch, detached, root } or null when the folder isn't inside a git repo.
function branchInfo(folder) {
  if (!folder) return null;
  let repo;
  try { repo = findGitDir(folder); } catch { return null; }
  if (!repo) return null;
  const head = path.join(repo.gitDir, 'HEAD');
  let mtimeMs;
  try { mtimeMs = fs.statSync(head).mtimeMs; } catch { return null; }
  const cached = headCache.get(head);
  if (cached && cached.mtimeMs === mtimeMs) return cached.info;

  let info = null;
  try {
    const text = fs.readFileSync(head, 'utf8').trim();
    const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) info = { branch: ref[1], detached: false, root: repo.root };
    else if (/^[0-9a-f]{7,40}$/i.test(text)) info = { branch: text.slice(0, 7), detached: true, root: repo.root };
  } catch {}
  headCache.set(head, { mtimeMs, info });
  return info;
}

// Has any cached HEAD changed since it was read? (cheap: one stat per known repo)
function anyBranchChanged() {
  for (const [head, cached] of headCache) {
    try { if (fs.statSync(head).mtimeMs !== cached.mtimeMs) return true; } catch { return true; }
  }
  return false;
}

// Folders can become repos (git init) or move; forget the folder → repo mapping
function forgetFolders() {
  gitDirCache.clear();
}

module.exports = { branchInfo, anyBranchChanged, forgetFolders };
