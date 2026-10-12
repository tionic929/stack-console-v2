// Finds runnable commands in a project folder: npm scripts, composer scripts, Procfile, Laravel artisan, Django.
// Read-only. Only fixed file names directly inside `dir` are read, each must resolve (symlinks included)
// to a regular file inside `dir`, and files over 1 MB are skipped.
const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 1024 * 1024;

// Long-running vs one-off: names first, then what the script runs.
const SERVER_SCRIPT = /^(dev|start|serve|server|watch|preview|storybook)(:|$)/i;
const TASK_SCRIPT = /^(build|lint|test|e2e|coverage|format|fmt|typecheck|type-check|check|prepare|clean|release|deploy|migrate|seed|generate|codegen|ci)(:|$)/i;
const SERVER_BODY = /\b(vite(?!\s+build)(?=\s|$)|next dev|nuxt dev|nodemon|webpack serve|webpack-dev-server|astro dev|remix dev|tsx watch|--watch|-w(?=\s|$)|http-server)/i;
// Servers that are usually not what you run day to day (after a build, alongside "dev", or a variant of it)
const NOT_PRESELECTED = /^(preview|storybook)(:|$)|:(prod|production|debug|inspect)$/i;
// npm runs these itself; offering them is noise
const LIFECYCLE = /^(preinstall|install|postinstall|prepare|prepublish|prepublishOnly|prepack|postpack|preversion|version|postversion)$/;

const FRIENDLY_DEV = [
  [/\bvite\b/i, 'Vite Dev Server'],
  [/\bnext dev\b/i, 'Next.js Dev Server'],
  [/\bnuxt dev\b/i, 'Nuxt Dev Server'],
  [/\bastro dev\b/i, 'Astro Dev Server'],
  [/\bremix dev\b/i, 'Remix Dev Server'],
];

function within(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Returns the real path of `name` inside `realDir` if it is a regular file there, else null.
// A file that exists but can't be used is reported through `skipped` so the user knows why.
function safeFile(realDir, name, skipped) {
  const file = path.join(realDir, name);
  if (!fs.existsSync(file)) return null;
  try {
    const real = fs.realpathSync(file);
    if (!within(real, realDir)) { skipped && skipped.push({ file: name, reason: 'points outside the project folder' }); return null; }
    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) { skipped && skipped.push({ file: name, reason: 'larger than 1 MB' }); return null; }
    return real;
  } catch {
    skipped && skipped.push({ file: name, reason: 'could not be read' });
    return null;
  }
}

function readText(realDir, name, skipped) {
  const file = safeFile(realDir, name, skipped);
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { skipped && skipped.push({ file: name, reason: 'could not be read' }); return null; }
}

function readJson(realDir, name, skipped) {
  const text = readText(realDir, name, skipped);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { skipped && skipped.push({ file: name, reason: 'is not valid JSON' }); return null; }
}

function titleCase(name) {
  return name.replace(/[:_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function npmRunner(realDir) {
  if (safeFile(realDir, 'pnpm-lock.yaml')) return 'pnpm';
  if (safeFile(realDir, 'yarn.lock')) return 'yarn';
  if (safeFile(realDir, 'bun.lockb') || safeFile(realDir, 'bun.lock')) return 'bun';
  return 'npm';
}

function iconFor(command, body) {
  const s = `${command} ${body || ''}`;
  if (/vite/i.test(s)) return 'vite';
  if (/artisan|laravel/i.test(s)) return 'laravel';
  if (/python|uvicorn|django|manage\.py|flask/i.test(s)) return 'python';
  if (/react|next/i.test(s)) return 'react';
  if (/vue|nuxt/i.test(s)) return 'vue';
  if (/node|npm|pnpm|yarn|bun/i.test(s)) return 'node';
  return null;
}

function npmItems(realDir, scripts) {
  const runner = npmRunner(realDir);
  const names = Object.keys(scripts);
  const isHook = (name) => {
    const m = name.match(/^(pre|post)(.+)$/);
    return !!m && names.includes(m[2]);
  };
  return Object.entries(scripts)
    .filter(([name, body]) => typeof body === 'string' && !LIFECYCLE.test(name) && !isHook(name))
    .map(([name, body]) => {
      const server = !TASK_SCRIPT.test(name) && (SERVER_SCRIPT.test(name) || SERVER_BODY.test(body));
      // "start" next to "dev" (or Nest's "start:dev") is usually the production server
      const preselect = server && !NOT_PRESELECTED.test(name) && !(name === 'start' && (names.includes('dev') || names.includes('start:dev')));
      const command = runner === 'npm' ? `npm run ${name}` : `${runner} ${name}`;
      const friendly = name === 'dev' ? FRIENDLY_DEV.find(([re]) => re.test(body)) : null;
      return { name: friendly ? friendly[1] : titleCase(name), command, detail: body, kind: server ? 'server' : 'task', icon: iconFor(command, body), preselect };
    });
}

function composerItems(scripts) {
  return Object.entries(scripts)
    .filter(([name]) => !/^(pre|post)-/.test(name))
    .map(([name, body]) => ({
      name: titleCase(name),
      command: `composer run ${name}`,
      detail: Array.isArray(body) ? body.join(' && ') : String(body),
      kind: /^(dev|serve)$/.test(name) ? 'server' : 'task',
      icon: 'php',
      // Laravel's composer "dev" starts serve + queue + vite together; offer it, but don't pre-tick it
      preselect: false,
    }));
}

function scanProjectFolder(dir, existingCommands = []) {
  let realDir;
  try {
    realDir = dir ? fs.realpathSync(dir) : null;
    if (!realDir || !fs.statSync(realDir).isDirectory()) throw new Error();
  } catch {
    return { ok: false, error: dir ? `Folder not found: ${dir}` : 'This project has no folder set.' };
  }

  const known = new Set(existingCommands.map(c => String(c.command || '').trim().toLowerCase()));
  const groups = [];
  const skipped = [];
  // Skips commands the project already has, and duplicates across sources (Procfile vs artisan)
  const add = (source, items) => {
    const fresh = items.filter(i => !known.has(i.command.toLowerCase()));
    fresh.forEach(i => known.add(i.command.toLowerCase()));
    if (fresh.length) groups.push({ source, items: fresh });
  };

  const pkg = readJson(realDir, 'package.json', skipped);
  if (pkg && pkg.scripts && typeof pkg.scripts === 'object') add('package.json', npmItems(realDir, pkg.scripts));

  const composer = readJson(realDir, 'composer.json', skipped);
  if (composer && composer.scripts && typeof composer.scripts === 'object') add('composer.json', composerItems(composer.scripts));

  if (safeFile(realDir, 'artisan', skipped)) {
    add('Laravel (artisan)', [
      { name: 'Laravel Dev Server', command: 'php artisan serve', detail: '', kind: 'server', icon: 'laravel', preselect: true },
      { name: 'Queue Worker', command: 'php artisan queue:work', detail: '', kind: 'worker', icon: 'laravel', preselect: true },
      { name: 'Scheduler', command: 'php artisan schedule:work', detail: '', kind: 'worker', icon: 'laravel', preselect: false },
    ]);
  }

  if (safeFile(realDir, 'manage.py', skipped)) {
    add('Django (manage.py)', [{ name: 'Django Dev Server', command: 'python manage.py runserver', detail: '', kind: 'server', icon: 'python', preselect: true }]);
  }

  const procfile = readText(realDir, 'Procfile', skipped);
  if (procfile !== null) {
    const items = procfile.split(/\r?\n/).slice(0, 100)
      .map(l => l.match(/^([\w-]+):\s*(.+)$/)).filter(Boolean)
      .map(m => ({ name: titleCase(m[1]), command: m[2].trim(), detail: '', kind: m[1] === 'web' ? 'server' : 'worker', icon: iconFor(m[2]), preselect: true }));
    add('Procfile', items);
  }

  return { ok: true, dir: realDir, groups, skipped };
}

// Apps one level down (lms_app/backend + lms_app/frontend, or a folder holding several repos).
// Real folders only (no links), dependency and dot folders skipped.
const APP_MARKERS = ['package.json', 'composer.json', 'artisan', 'manage.py', 'Procfile'];
const NOT_APPS = /^(node_modules|vendor|bower_components|__pycache__|venv|dist|build|target|bin|obj)$/i;

function appFolders(realDir) {
  let entries = [];
  try { entries = fs.readdirSync(realDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.') && !NOT_APPS.test(e.name))
    .filter(e => APP_MARKERS.some(m => fs.existsSync(path.join(realDir, e.name, m))))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 12);
}

const normWd = (wd) => String(wd || '').trim().replace(/^\.[\\/]/, '').replace(/[\\/]+$/, '').toLowerCase();

// Short labels that still tell folders apart: "automart-3.0-admin-api" next to "automart-3.0-admin-web"
// → "admin-api" / "admin-web" (the shortest ending of at least two words that no other folder shares).
function shortFolderLabels(names) {
  const words = (n) => n.split(/(?=[-_ .])/);
  const ending = (n, k) => { const w = words(n); return w.slice(Math.max(0, w.length - k)).join('').replace(/^[-_ .]/, ''); };
  const out = new Map();
  names.forEach(n => {
    const total = words(n).length;
    for (let k = Math.min(2, total); k <= total; k++) {
      const label = ending(n, k);
      if (k === total || !names.some(o => o !== n && ending(o, k).toLowerCase() === label.toLowerCase())) { out.set(n, label); break; }
    }
  });
  return out;
}

// The project folder and its apps. Items carry the workingDirectory they run in ('' = the project folder).
// The same command in two apps is two commands; the same name in two apps says which folder.
function scanProjectTree(dir, existingCommands = []) {
  const existingIn = (wd) => existingCommands.filter(c => normWd(c.workingDirectory) === wd.toLowerCase());
  const top = scanProjectFolder(dir, existingIn(''));
  if (!top.ok) return top;
  const groups = top.groups.map(g => ({ ...g, folder: '', items: g.items.map(i => ({ ...i, workingDirectory: '' })) }));
  const skipped = [...top.skipped];
  appFolders(top.dir).forEach(app => {
    const res = scanProjectFolder(path.join(top.dir, app), existingIn(app));
    if (!res.ok || !within(res.dir, top.dir)) return;
    res.groups.forEach(g => groups.push({ source: `${app}/${g.source}`, folder: app, items: g.items.map(i => ({ ...i, workingDirectory: app })) }));
    res.skipped.forEach(s => skipped.push({ ...s, file: `${app}/${s.file}` }));
  });
  const counts = new Map();
  groups.forEach(g => g.items.forEach(i => counts.set(i.name, (counts.get(i.name) || 0) + 1)));
  const labels = shortFolderLabels([...new Set(groups.map(g => g.folder).filter(Boolean))]);
  groups.forEach(g => g.items.forEach(i => { if (counts.get(i.name) > 1 && i.workingDirectory) i.name = `${i.name} (${labels.get(i.workingDirectory) || i.workingDirectory})`; }));
  return { ok: true, dir: top.dir, groups, skipped };
}

module.exports = { scanProjectFolder, scanProjectTree, appFolders, shortFolderLabels };
