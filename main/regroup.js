// Regroup after setup: split a project into one project per folder group, or combine sibling
// projects into one. Moving a command changes the folder its relative working directory is
// resolved against (folders.js commandFolder), so every move rewrites it; what can't be kept
// (a "Start after" link across projects, a .env outside the new project folder) is reported first.
const path = require('path');
const { commandFolder } = require('./folders');
const { key, contains, isDriveRoot } = require('./roots');
const { shortFolderLabels } = require('./importer');

function within(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Working directory for `folder` inside a project at `base`: relative when inside, else absolute
function workingDirFor(folder, base) {
  if (!folder) return '';
  return within(folder, base) ? path.relative(base, folder) : folder;
}

function envWarning(cmd, folder, newBase, projectName) {
  if (!cmd.envFile) return null;
  const file = path.resolve(folder || newBase, cmd.envFile);
  if ([folder, newBase].filter(Boolean).some(root => within(file, root))) return null;
  return `${cmd.displayName}: its .env file (${cmd.envFile}) is outside ${projectName}'s folder, so it will be ignored.`;
}

function uniqueId(base, taken) {
  const slug = String(base).replace(/\s+/g, '-').toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'project';
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  taken.add(id);
  return id;
}

// ── Split ────────────────────────────────────────────────────────
// Groups = the first folder below the project folder each command runs in ("" = the project folder,
// or a folder outside it; those stay in the original project).
function splitPlan(project) {
  const base = project.baseDirectory;
  if (!base) return { ok: false, error: 'This project has no folder.' };
  const groups = new Map();
  (project.commands || []).forEach(c => {
    const folder = commandFolder(project, c);
    let name = '';
    if (folder && within(folder, base)) name = path.relative(base, folder).split(/[\\/]/)[0] || '';
    const g = groups.get(name.toLowerCase()) || { name, folder: name ? path.join(base, name) : base, commands: [] };
    g.commands.push(c);
    groups.set(name.toLowerCase(), g);
  });
  const list = [...groups.values()];
  if (list.filter(g => g.name).length < 1 || list.length < 2) {
    return { ok: false, error: 'All its services run in one folder, so there is nothing to split.' };
  }
  const groupOf = new Map();
  list.forEach(g => g.commands.forEach(c => groupOf.set(c.id, g)));
  const warnings = [];
  list.forEach(g => g.commands.forEach(c => {
    const dep = c.startAfter && (project.commands || []).find(d => d.id === c.startAfter);
    if (dep && groupOf.get(dep.id) !== g) warnings.push(`${c.displayName} starts after ${dep.displayName}. Projects can't wait on each other, so this link will be removed.`);
    const w = envWarning(c, commandFolder(project, c), g.folder, g.name || project.name);
    if (w) warnings.push(w);
  }));
  return {
    ok: true,
    keeps: list.some(g => !g.name),
    groups: list.map(g => ({ name: g.name || project.name, folder: g.folder, stays: !g.name, commands: g.commands.length })),
    warnings,
    _groups: list,
  };
}

// Mutates db. Returns { ok, created: [projectId], moved: [[fromKey, toKey]] }
function applySplit(db, projectId) {
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  const plan = splitPlan(project);
  if (!plan.ok) return plan;
  const taken = new Set(db.projects.map(p => p.id));
  const moved = [];
  const created = [];
  const index = db.projects.indexOf(project);
  const fresh = [];
  plan._groups.forEach(g => {
    if (!g.name) return; // stays in the original project
    const id = uniqueId(g.name, taken);
    const commands = g.commands.map(c => {
      const folder = commandFolder(project, c);
      const copy = { ...c, workingDirectory: workingDirFor(folder, g.folder) };
      const dep = c.startAfter && g.commands.some(d => d.id === c.startAfter);
      if (!dep) delete copy.startAfter;
      moved.push([`${project.id}:${c.id}`, `${id}:${c.id}`]);
      return copy;
    });
    fresh.push({ id, name: g.name, baseDirectory: g.folder, commands });
    created.push(id);
  });
  const stay = plan._groups.find(g => !g.name);
  if (stay) {
    project.commands = stay.commands.map(c => {
      const dep = c.startAfter && stay.commands.some(d => d.id === c.startAfter);
      if (dep) return c;
      const copy = { ...c };
      delete copy.startAfter;
      return copy;
    });
    db.projects.splice(index + 1, 0, ...fresh);
  } else {
    db.projects.splice(index, 1, ...fresh);
    if (db.activeProject === project.id) db.activeProject = fresh[0].id;
  }
  return { ok: true, created, moved };
}

// ── Combine ──────────────────────────────────────────────────────
// Folder label for a service whose name appears more than once ("Dev (admin-api)")
function folderLabeller(list) {
  const name = (p, c) => path.basename(commandFolder(p, c) || p.baseDirectory);
  const all = [];
  list.forEach(p => (p.commands || []).forEach(c => all.push(name(p, c))));
  const labels = shortFolderLabels([...new Set(all)]);
  return (p, c) => labels.get(name(p, c)) || name(p, c);
}

function commonFolder(folders) {
  const parts = folders.map(f => path.resolve(f).split(/[\\/]/));
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i];
    if (parts.every(p => p[i] !== undefined && p[i].toLowerCase() === seg.toLowerCase())) out.push(seg);
    else break;
  }
  if (!out.length) return null;
  const joined = out.join(path.sep);
  return /^[A-Za-z]:$/.test(joined) ? joined + path.sep : joined;
}

// Projects that could be combined with `project`: same parent folder (automart's three repos)
function combineCandidates(db, project, rootPaths = []) {
  if (!project.baseDirectory) return [];
  const parent = key(path.dirname(project.baseDirectory));
  const roots = new Set(rootPaths.map(key));
  return db.projects.filter(p => p.id !== project.id && !p.archived && p.baseDirectory && !roots.has(key(p.baseDirectory))
    && (key(path.dirname(p.baseDirectory)) === parent || contains(key(project.baseDirectory), key(p.baseDirectory)) || contains(key(p.baseDirectory), key(project.baseDirectory))));
}

function combinePlan(db, projectIds, rootPaths = []) {
  const list = projectIds.map(id => db.projects.find(p => p.id === id)).filter(Boolean);
  if (list.length < 2) return { ok: false, error: 'Pick at least two projects.' };
  if (list.some(p => !p.baseDirectory)) return { ok: false, error: 'Every project needs a folder.' };
  const base = commonFolder(list.map(p => p.baseDirectory));
  if (!base || isDriveRoot(base)) return { ok: false, error: 'These projects are on different drives or only share a drive.' };
  if (rootPaths.some(r => key(r) === key(base))) {
    return { ok: false, error: `These projects only share ${base}, your projects folder. Combine projects inside one folder, like automart.` };
  }
  const name = path.basename(base);
  const warnings = [];
  const names = new Map();
  list.forEach(p => (p.commands || []).forEach(c => names.set(c.displayName, (names.get(c.displayName) || 0) + 1)));
  const renames = [];
  const label = folderLabeller(list);
  list.forEach(p => (p.commands || []).forEach(c => {
    if (names.get(c.displayName) > 1) renames.push(`${c.displayName} → ${c.displayName} (${label(p, c)})`);
  }));
  return { ok: true, base, name, projects: list.map(p => ({ id: p.id, name: p.name, commands: (p.commands || []).length })), commands: list.reduce((n, p) => n + (p.commands || []).length, 0), renames, warnings };
}

function applyCombine(db, projectIds, name, rootPaths = []) {
  const plan = combinePlan(db, projectIds, rootPaths);
  if (!plan.ok) return plan;
  const list = projectIds.map(id => db.projects.find(p => p.id === id));
  const keep = list[0];
  const usedIds = new Set();
  const moved = [];
  const dupNames = new Map();
  list.forEach(p => (p.commands || []).forEach(c => dupNames.set(c.displayName, (dupNames.get(c.displayName) || 0) + 1)));
  const commands = [];
  const label = folderLabeller(list);
  list.forEach(p => {
    const idMap = new Map();
    (p.commands || []).forEach(c => {
      let id = c.id;
      while (usedIds.has(id)) id = `${c.id}_${Math.random().toString(36).slice(2, 6)}`;
      usedIds.add(id);
      idMap.set(c.id, id);
    });
    (p.commands || []).forEach(c => {
      const folder = commandFolder(p, c);
      const copy = { ...c, id: idMap.get(c.id), workingDirectory: workingDirFor(folder, plan.base) };
      if (c.startAfter) copy.startAfter = idMap.get(c.startAfter) || c.startAfter;
      if (dupNames.get(c.displayName) > 1) copy.displayName = `${c.displayName} (${label(p, c)})`;
      moved.push([`${p.id}:${c.id}`, `${keep.id}:${copy.id}`]);
      commands.push(copy);
    });
  });
  keep.name = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 80) : plan.name;
  keep.baseDirectory = plan.base;
  keep.commands = commands;
  if (list.some(p => p.pinned)) keep.pinned = true;
  const drop = new Set(list.slice(1).map(p => p.id));
  db.projects = db.projects.filter(p => !drop.has(p.id));
  if (drop.has(db.activeProject)) db.activeProject = keep.id;
  return { ok: true, projectId: keep.id, moved: moved.filter(([a, b]) => a !== b) };
}

module.exports = { splitPlan, applySplit, combinePlan, applyCombine, combineCandidates, commonFolder, workingDirFor, uniqueId };
