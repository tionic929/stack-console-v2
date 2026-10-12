const { esc, icons, normalizeStatus, statusLabel, statusIndicator, avatar, portOf, confirmDialog, openMenu } = window.ui;
const { tile } = window.identity;
const $ = (id) => document.getElementById(id);

let appState = null;
// What the main panel shows: a service of any project, the shell, or nothing.
let selection = null;          // { kind: 'cmd', projectId, id } | { kind: 'shell' } | null

// Log view state: which stream is in the DOM and the last line sequence rendered
let renderedKey = null;
let renderedSeq = 0;
let loadingQueue = null;       // lines that arrive while a snapshot is loading
let unseenLines = 0;
let pendingAction = null;      // disables the header actions until main reports the new status
const MAX_DOM_LINES = 5000;
const SHELL_KEY = 'shell';

// Per-viewer preference (safe to lose)
function readPref(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Tree state: which projects are collapsed (per viewer), whether archived projects are listed
const savedCollapsed = readPref('sc.collapsed', null);
let collapsed = new Set(Array.isArray(savedCollapsed) ? savedCollapsed : []);
let collapseDefaultsPending = !Array.isArray(savedCollapsed);
let showArchived = !!readPref('sc.showArchived', false);

// Sections (master folders, folders, Pinned, Not set up, Empty…): open or closed, per viewer
const openState = readPref('sc.open', {}) || {};
const isOpen = (key, fallback) => (key in openState ? !!openState[key] : fallback);
function setOpen(key, value) {
  openState[key] = value;
  writePref('sc.open', openState);
}
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byProjectName = (a, b) => collator.compare(a.name, b.name);

let revealProjectId = null;    // a project just set up: expand, select and scroll to it
let pendingScrollKey = null;   // a row to bring into view after the next sidebar render
let lastSelectedPlace = null;  // the selected project's section, to follow it when it moves

// ── Static chrome ────────────────────────────────────────────────
window.ui.initWindowControls();
$('ShellAvatar').innerHTML = icons.terminal;
$('BtnNewProject').innerHTML = icons.plus;
$('BtnRootsMenu').innerHTML = icons.more;
$('TriggerProjManager').innerHTML = `${icons.folder}<span>Manage projects</span>`;
$('BtnStart').innerHTML = `${icons.play}<span>Start</span>`;
$('BtnStartNow').innerHTML = `${icons.play}<span>Start now</span>`;
$('BtnRestart').innerHTML = `${icons.restart}<span>Restart</span>`;
$('BtnStop').innerHTML = `${icons.stop}<span>Stop</span>`;
$('BtnServiceMore').innerHTML = icons.more;
$('FindIcon').innerHTML = icons.search;
$('FindPrev').innerHTML = icons.chevronUp;
$('FindNext').innerHTML = icons.chevronDown;
$('ToggleTimestamps').innerHTML = icons.clock;
$('CopyLogsBtn').innerHTML = `${icons.copy}<span>Copy</span>`;

$('WinBtnMin').addEventListener('click', () => window.api.minimize());
$('WinBtnMax').addEventListener('click', () => window.api.maximize());
$('TriggerProjManager').addEventListener('click', () => window.api.openProjectManager());
$('BtnNewProject').addEventListener('click', () => window.api.newProjectCommand());
$('BtnRootsMenu').addEventListener('click', () => openRootsMenu());

const finder = window.logFind.create({
  logs: $('TerminalLogs'),
  term: $('Terminal'),
  input: $('FindInput'),
  count: $('FindCount'),
  nav: $('FindNav'),
  prev: $('FindPrev'),
  next: $('FindNext'),
  only: $('FindOnly'),
  levelButtons: [$('LevelAll'), $('LevelWarn'), $('LevelError')],
});

// Second log beside the main one: Ctrl+click a service, drag it onto the log, or ⋯ → Open another log beside
let beside = readPref('sc.beside', null); // { projectId, commandId } | null
const lastServiceOf = new Map();         // projectId -> the service last shown, for the icons-only sidebar
const logB = new window.LogView({
  term: $('TerminalB'),
  logs: $('TerminalLogsB'),
  jump: $('JumpLatestB'),
  max: MAX_DOM_LINES,
  arrowIcon: icons.arrowDown,
  lineElement: (entry) => lineElement(entry),
  placeholder: () => placeholderFor(besideCmd()),
});

// Every edge drags: sidebar (icons only · compact · full names), header, everything-running panel, the two logs
window.layout.init({
  onDensity: () => { if (appState) renderSidebar(); },
  onPanel: () => {
    renderPanelToggle();
    if (!appState) return;
    renderStrip();
    if (window.layout.panelOpen()) renderStackPanel();
  },
});
$('BtnStackPanel').addEventListener('click', () => window.layout.togglePanel());

let showTimestamps = readPref('sc.showTimestamps', false);
function renderTimestampToggle() {
  $('TerminalLogs').classList.toggle('show-ts', showTimestamps);
  $('TerminalLogsB').classList.toggle('show-ts', showTimestamps);
  $('ToggleTimestamps').setAttribute('aria-pressed', String(showTimestamps));
}
renderTimestampToggle();
$('ToggleTimestamps').addEventListener('click', () => {
  showTimestamps = !showTimestamps;
  writePref('sc.showTimestamps', showTimestamps);
  renderTimestampToggle();
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

$('CopyLogsBtn').addEventListener('click', async () => {
  await copyText(finder.visibleText(showTimestamps));
  const label = $('CopyLogsBtn').querySelector('span');
  label.textContent = 'Copied';
  setTimeout(() => { label.textContent = 'Copy'; }, 1200);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !$('LogToolbar').hidden) {
    e.preventDefault();
    finder.focus();
  }
});

function notify(title, body) {
  return confirmDialog({ title, body, actions: [{ label: 'OK', value: null, variant: 'primary', autofocus: true }] });
}

// ── State helpers ────────────────────────────────────────────────
const projects = () => appState?.projects || [];
const visibleProjects = () => projects().filter(p => !p.archived);
const archivedProjects = () => projects().filter(p => p.archived);

function projectById(id) {
  return projects().find(p => p.id === id) || null;
}

// Master folders and where each project sits (worked out by main on every state)
const workspace = () => appState?.workspace || { enabled: false, roots: [], placement: {}, prompt: null };
const placeOf = (p) => workspace().placement[p.id] || { section: 'other' };

function activeProject() {
  return projectById(appState?.activeProject);
}

function commandsOf(project) {
  return (project && project.commands) || [];
}

function selectedProject() {
  return selection?.kind === 'cmd' ? projectById(selection.projectId) : null;
}

function selectedCmd() {
  const project = selectedProject();
  return project ? commandsOf(project).find(c => c.id === selection.id) || null : null;
}

// What service actions send to main: the project is always explicit now
function target(cmd = selectedCmd()) {
  return { projectId: selection.projectId, commandId: cmd.id };
}

function countByStatus(commands) {
  const counts = { running: 0, starting: 0, waiting: 0, offline: 0, crashed: 0 };
  commands.forEach(c => { const s = normalizeStatus(c.status); if (s in counts) counts[s]++; });
  return counts;
}

const isLive = (status) => ['running', 'starting', 'waiting'].includes(normalizeStatus(status));
const liveCount = (commands) => commands.filter(c => isLive(c.status)).length;

// Tool windows (Add/Edit command, Import, Rename) work on the active project: point it first
function withActive(projectId, fn) {
  if (appState && appState.activeProject !== projectId) window.api.setActiveProject(projectId);
  fn();
}

// Keep the selection valid: prefer the active project's first service, then any project's.
function reconcileSelection() {
  if (selection && selection.kind === 'shell') return;
  const project = selectedProject();
  if (selection && project && !project.archived && selectedCmd()) return;
  const order = [activeProject(), ...visibleProjects()].filter(p => p && !p.archived);
  for (const p of order) {
    const first = commandsOf(p)[0];
    if (first) { selection = { kind: 'cmd', projectId: p.id, id: first.id }; return; }
  }
  selection = null;
}

// Where a service runs, relative to its project: "frontend", "" (project root), or another repo's folder name
function folderGroup(project, cmd) {
  const base = (project.baseDirectory || '').replace(/[\\/]+$/, '');
  const folder = (cmd.folder || '').replace(/[\\/]+$/, '');
  if (!folder || !base) return { key: '', label: '' };
  const inside = folder.toLowerCase() === base.toLowerCase() || folder.toLowerCase().startsWith(`${base.toLowerCase()}\\`) || folder.toLowerCase().startsWith(`${base.toLowerCase()}/`);
  if (inside) {
    const rel = folder.slice(base.length).replace(/^[\\/]+/, '');
    return { key: rel.toLowerCase(), label: rel };
  }
  const name = folder.split(/[\\/]/).pop();
  return { key: folder.toLowerCase(), label: name, outside: true, full: folder };
}

function baseName(p) {
  return (p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

// Long branch names keep both ends: the type ("feature/", "fix/") and the ticket or version ("QP1522", "v0.5")
function shortBranch(branch, max = 26) {
  if (branch.length <= max) return branch;
  const head = Math.ceil((max - 1) * 0.4);
  return `${branch.slice(0, head)}…${branch.slice(-(max - 1 - head))}`;
}

// Characters a sidebar label may use: at full width names, paths and branches are never cut (they wrap)
const room = (compact) => (window.layout.density() === 'full' ? Infinity : compact);

// Long paths keep their last folder: "smart-lab-in…/mobile", "C:\Users\sh…\qa-tree"
function shortPath(p, max = 22) {
  if (!p || p.length <= max) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const segs = p.split(/[\\/]/);
  const last = segs.pop();
  if (last.length >= max - 2 || !segs.length) return `…${last.slice(-(max - 1))}`;
  return `${segs.join(sep).slice(0, max - last.length - 2)}…${sep}${last}`;
}

function branchHtml(branch, detached, max) {
  if (!branch) return '';
  const title = detached ? `Detached HEAD at ${branch}` : `Git branch ${branch}`;
  return `<span class="branch-label" title="${esc(title)}">${icons.branch}<span>${esc(shortBranch(branch, max))}</span></span>`;
}

// ── Rendering ────────────────────────────────────────────────────
function render() {
  applyCollapseDefaults();
  revealNewProject();
  reconcileSelection();
  renderSidebar();
  renderMain();
  renderPaneTitles();
  renderFooter();
}

// First run of the tree: projects without services start collapsed
function applyCollapseDefaults() {
  if (!collapseDefaultsPending || !appState) return;
  collapseDefaultsPending = false;
  visibleProjects().filter(p => !commandsOf(p).length).forEach(p => collapsed.add(p.id));
  writePref('sc.collapsed', [...collapsed]);
}

function serviceSubline(cmd) {
  const status = normalizeStatus(cmd.status);
  const port = portOf(cmd);
  if (cmd.folderMissing && !isLive(status)) return 'Folder missing';
  if (status === 'crashed') return `Crashed${cmd.exitCode !== null && cmd.exitCode !== undefined ? ` · exit ${cmd.exitCode}` : ''}${cmd.restartGaveUp ? ' · gave up' : ''}`;
  if (status === 'waiting') return `Waiting for ${cmd.waitingFor || 'dependency'}…`;
  if (status === 'starting' && cmd.restartAttempt) return `Restarting (${cmd.restartAttempt})…`;
  return `${statusLabel(status)}${port ? ` · :${port}` : ''}`;
}

function projectSubline(p) {
  const cmds = commandsOf(p);
  const counts = countByStatus(cmds);
  const parts = [];
  if (p.folderMissing) parts.push(`<span class="is-warn">${icons.warn}Folder missing</span>`);
  else if (p.branch) parts.push(branchHtml(p.branch, p.detached, room(18)));
  if (counts.crashed) parts.push(`<span class="is-crashed">${statusIndicator('crashed')} ${counts.crashed} crashed</span>`);
  const live = counts.running + counts.starting + counts.waiting;
  if (live) parts.push(`<span class="is-live">${statusIndicator('running')} ${counts.running} running${counts.starting + counts.waiting ? ` · ${counts.starting + counts.waiting} starting` : ''}</span>`);
  if (!live && !counts.crashed) parts.push(`<span>${cmds.length ? `${cmds.length} stopped` : (p.baseDirectory ? 'No services' : 'No folder · empty')}</span>`);
  return parts.join('');
}

function serviceRow(p, cmd) {
  const status = normalizeStatus(cmd.status);
  const isActive = selection?.kind === 'cmd' && selection.projectId === p.id && selection.id === cmd.id;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `svc-row${isActive ? ' active' : ''}`;
  row.dataset.focusKey = `c:${p.id}:${cmd.id}`;
  if (isActive) row.setAttribute('aria-current', 'true');
  row.title = `${cmd.folder ? `${cmd.displayName}\n${cmd.folder}` : cmd.displayName}\nCtrl+click or drag onto the log to open beside`;
  row.draggable = true;
  row.addEventListener('dragstart', (e) => startServiceDrag(e, p.id, cmd.id));
  row.innerHTML = `
    ${avatar(cmd)}
    <span class="svc-title-stack">
      <span class="svc-name">${esc(cmd.displayName)}</span>
      <span class="svc-port-sub" data-status="${cmd.folderMissing && !isLive(status) ? 'crashed' : status}">${esc(serviceSubline(cmd))}</span>
    </span>
    ${statusIndicator(status)}`;
  row.addEventListener('click', (e) => serviceClick(e, p.id, cmd.id));
  return row;
}

// `folder`: the container folder this project stands in for, when it's the only project in it
function projectNode(p, folder) {
  const cmds = commandsOf(p);
  const live = liveCount(cmds);
  const expanded = !collapsed.has(p.id);
  const node = document.createElement('div');
  node.className = `tree-project id-rail ${window.identity.colourClass(p)}`;

  const head = document.createElement('div');
  head.className = 'tree-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.dataset.focusKey = `p:${p.id}`;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.title = p.baseDirectory || 'No folder set';
  // Where it is, when the tree doesn't already say: a nested folder, a twin, pinned or outside the master folders
  const place = placeOf(p);
  const hint = place.hint || folder || '';
  const hintTitle = place.twin ? `Same folder as ${place.twin}: ${p.baseDirectory}` : (p.baseDirectory || '');
  const hintHtml = hint ? `<span class="tree-hint" title="${esc(hintTitle)}">${folder && !place.hint ? `${icons.folder}` : ''}<span>${esc(place.twin ? hint : shortPath(hint, room(18)))}</span></span>` : '';
  toggle.innerHTML = `<span class="tree-caret">${icons.chevronRight}</span>${tile(p)}<span class="tree-text"><span class="tree-name">${esc(p.name)}</span>${hintHtml}<span class="tree-sub">${projectSubline(p)}</span></span>`;
  toggle.addEventListener('click', () => toggleProject(p.id));

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'tree-act';
  run.dataset.kind = live ? 'stop' : 'start';
  run.dataset.focusKey = `a:${p.id}`;
  run.innerHTML = live ? icons.stop : icons.play;
  run.setAttribute('aria-label', live ? `Stop all services in ${p.name}` : `Start all services in ${p.name}`);
  run.title = live ? 'Stop all services in this project' : (p.folderMissing ? 'Folder missing' : 'Start all services in this project');
  run.disabled = !cmds.length || (!live && !!p.folderMissing);
  run.addEventListener('click', () => (live ? stopProject(p) : window.api.launchAll(p.id)));

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'tree-act';
  more.dataset.focusKey = `m:${p.id}`;
  more.innerHTML = icons.more;
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.setAttribute('aria-label', `More actions for ${p.name}`);
  more.title = 'Folder actions, import, rename, archive';
  more.addEventListener('click', () => openProjectMenu(p, more));

  head.append(toggle, run, more);
  node.appendChild(head);
  if (!expanded) return node;

  const kids = document.createElement('div');
  kids.className = 'tree-kids';

  if (p.folderMissing) {
    const note = document.createElement('div');
    note.className = 'tree-note is-warn';
    note.innerHTML = `<span>Folder not found:</span><span class="path">${esc(p.baseDirectory)}</span><span class="inline-row"></span>`;
    const row = note.querySelector('.inline-row');
    if (p.relinkTo) row.appendChild(smallButton(`Relink to ${baseName(p.relinkTo)}`, () => relinkProject(p), `Use ${p.relinkTo}`));
    row.appendChild(smallButton('Change folder…', () => chooseFolder(p)));
    kids.appendChild(note);
  }

  if (!cmds.length) {
    const note = document.createElement('div');
    note.className = 'tree-note';
    note.innerHTML = '<span>No services yet.</span><span class="inline-row"></span>';
    const row = note.querySelector('.inline-row');
    row.appendChild(smallButton('Add command', () => withActive(p.id, () => window.api.openAddCommand())));
    const imp = smallButton('Import…', () => withActive(p.id, () => window.api.openImportCommands()));
    imp.disabled = !p.baseDirectory || !!p.folderMissing;
    if (imp.disabled) imp.title = p.baseDirectory ? 'Folder missing' : 'Choose the project folder first (⋯ → Choose folder…)';
    row.appendChild(imp);
    kids.appendChild(note);
  }

  // Group services by the folder they run in when a repo holds several apps (frontend / backend / …)
  const groups = [];
  cmds.forEach(cmd => {
    const g = folderGroup(p, cmd);
    let group = groups.find(x => x.key === g.key);
    if (!group) { group = { ...g, items: [] }; groups.push(group); }
    group.items.push(cmd);
  });
  const showGroups = groups.some(g => g.key !== '');
  groups.forEach(g => {
    if (showGroups) {
      const label = document.createElement('div');
      label.className = 'tree-group';
      const first = g.items[0];
      // Branch only when it differs from the project's (another repo, or a worktree on another branch)
      const differs = first.branch && (first.repoRoot !== p.repoRoot || first.branch !== p.branch);
      label.innerHTML = `<span class="tree-group-name" title="${esc(g.full || g.label || p.baseDirectory || '')}">${esc(g.label || baseName(p.baseDirectory))}${g.outside ? ' ↗' : ''}</span>${differs ? branchHtml(first.branch, first.detached, room(22)) : ''}`;
      kids.appendChild(label);
    }
    g.items.forEach(cmd => kids.appendChild(serviceRow(p, cmd)));
  });

  node.appendChild(kids);
  return node;
}

function smallButton(label, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn-secondary btn-sm';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function archivedNode() {
  const list = archivedProjects();
  const node = document.createElement('div');
  node.className = 'tree-archived';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.dataset.focusKey = 'archived';
  toggle.setAttribute('aria-expanded', String(showArchived));
  toggle.innerHTML = `<span class="tree-caret">${icons.chevronRight}</span><span class="tree-text"><span class="tree-sub">Archived (${list.length})</span></span>`;
  toggle.addEventListener('click', () => {
    showArchived = !showArchived;
    writePref('sc.showArchived', showArchived);
    renderSidebar();
  });
  node.appendChild(toggle);
  if (showArchived) {
    list.forEach(p => {
      const row = document.createElement('div');
      row.className = 'tree-archived-item';
      row.innerHTML = `<span title="${esc(p.baseDirectory || 'No folder')}">${esc(p.name)}</span>`;
      const b = smallButton('Unarchive', () => archiveProject(p, false));
      b.dataset.focusKey = `u:${p.id}`;
      b.setAttribute('aria-label', `Unarchive ${p.name}`);
      row.appendChild(b);
      node.appendChild(row);
    });
  }
  return node;
}

// ── Sections, master folders, Not set up ─────────────────────────
function actButton(iconHtml, label, onClick, focusKey) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tree-act';
  b.innerHTML = iconHtml;
  b.setAttribute('aria-label', label);
  b.title = label;
  if (focusKey) b.dataset.focusKey = focusKey;
  b.addEventListener('click', () => onClick(b));
  return b;
}

function noteNode(text, tone) {
  const n = document.createElement('div');
  n.className = `tree-note${tone ? ` is-${tone}` : ''}`;
  n.textContent = text;
  return n;
}

// A collapsible group: a master folder, a container folder, Pinned, Not set up, Other locations, Empty
function sectionNode({ key, label, labelHtml, count, sub, fallback = true, kind = 'section', title, actions = [], icon = '' }) {
  const open = isOpen(key, fallback);
  const node = document.createElement('div');
  node.className = `tree-section is-${kind}`;
  const head = document.createElement('div');
  head.className = 'tree-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'tree-toggle';
  toggle.dataset.focusKey = `s:${key}`;
  toggle.setAttribute('aria-expanded', String(open));
  if (title) toggle.title = title;
  const countHtml = count !== undefined && count !== null ? ` <span class="section-count">${esc(count)}</span>` : '';
  toggle.innerHTML = `<span class="tree-caret">${icons.chevronRight}</span>${icon}<span class="tree-text"><span class="section-label">${labelHtml || esc(label)}${countHtml}</span>${sub ? `<span class="tree-sub">${sub}</span>` : ''}</span>`;
  toggle.addEventListener('click', () => { setOpen(key, !open); renderSidebar(); });
  head.appendChild(toggle);
  actions.forEach(a => head.appendChild(a));
  node.appendChild(head);
  const body = document.createElement('div');
  body.className = 'tree-section-body';
  if (open) node.appendChild(body);
  return { node, body, open };
}

const folderIcon = () => `<span class="tree-folder-icon" aria-hidden="true">${icons.folder}</span>`;
const lower = (s) => String(s || '').toLowerCase();

function liveSubline(list) {
  const cmds = list.flatMap(p => commandsOf(p));
  const counts = countByStatus(cmds);
  const parts = [];
  if (counts.crashed) parts.push(`<span class="is-crashed">${statusIndicator('crashed')} ${counts.crashed} crashed</span>`);
  const live = counts.running + counts.starting + counts.waiting;
  if (live) parts.push(`<span class="is-live">${statusIndicator('running')} ${live} running</span>`);
  return parts.join('');
}

// Set-up projects of one master folder in folder order: container folders and projects, A–Z.
// A container holding a single project is shown as that project, so the tree stays shallow.
function rootBody(root, body, list) {
  if (!root.exists) body.appendChild(rootMissingNote(root));
  else if (root.timedOut) body.appendChild(noteNode('Couldn\'t finish reading this folder. A network drive may be slow or offline.', 'warn'));
  else if (root.truncated) body.appendChild(noteNode('This folder holds more than StackConsole reads quickly, so the list below is incomplete. A smaller folder works better.', 'warn'));

  const entries = [];
  const containers = new Map();
  list.forEach(p => {
    const c = placeOf(p).container;
    if (!c) { entries.push({ name: p.name, project: p }); return; }
    if (!containers.has(lower(c.path))) {
      const e = { name: c.name, folder: c, projects: [] };
      containers.set(lower(c.path), e);
      entries.push(e);
    }
    containers.get(lower(c.path)).projects.push(p);
  });
  entries.sort((a, b) => collator.compare(a.name, b.name));
  entries.forEach(e => {
    if (e.project) { body.appendChild(projectNode(e.project)); return; }
    if (e.projects.length === 1) { body.appendChild(projectNode(e.projects[0], e.folder.name)); return; }
    const s = sectionNode({ key: `folder:${lower(e.folder.path)}`, label: e.folder.name, kind: 'folder', title: e.folder.path, icon: folderIcon(), sub: liveSubline(e.projects) });
    if (s.open) e.projects.sort(byProjectName).forEach(p => s.body.appendChild(projectNode(p)));
    body.appendChild(s.node);
  });
  if (root.exists) body.appendChild(notSetUpNode(root));
}

function rootMissingNote(root) {
  const note = document.createElement('div');
  note.className = 'tree-note is-warn';
  note.innerHTML = `<span>Folder not found:</span><span class="path">${esc(root.path)}</span><span>Its projects are kept. Reconnect the drive or point it somewhere else.</span><span class="inline-row"></span>`;
  const row = note.querySelector('.inline-row');
  if (root.relinkTo) row.appendChild(smallButton(`Relink to ${root.relinkTo}`, () => relinkRoot(root)));
  row.appendChild(smallButton('Change folder…', () => changeRoot(root)));
  row.appendChild(smallButton('Remove', () => removeRoot(root)));
  return note;
}

const STACK_NAMES = { 'package.json': 'npm', 'composer.json': 'composer', artisan: 'Laravel', 'manage.py': 'Django', procfile: 'Procfile' };
function repoSummary(r) {
  if (r.kind === 'folder') return `${r.repos.length} repo${r.repos.length === 1 ? '' : 's'}`;
  const parts = [];
  if (r.apps && r.apps.length) parts.push(`${r.apps.length} app${r.apps.length === 1 ? '' : 's'}: ${r.apps.join(', ')}`);
  else if (r.markers && r.markers.length) parts.push(r.markers.map(m => STACK_NAMES[m] || m).join(' + '));
  else parts.push('no commands found');
  if (r.worktree) parts.push('worktree');
  if (r.parent) parts.unshift(`in ${r.parent}`);
  return parts.join(' · ');
}

// A repo that isn't a project yet: Set up (one click), or Hide (not a project)
function repoRow(r, isHidden = false) {
  const row = document.createElement('div');
  row.className = 'repo-row';
  row.title = r.path;
  row.innerHTML = `<span class="repo-text"><span class="repo-name">${esc(r.name)}</span><span class="repo-sub">${esc(repoSummary(r))}</span></span>`;
  const fk = lower(r.path);
  if (isHidden) {
    const b = smallButton('Unhide', () => hideRepo(r, false));
    b.classList.add('repo-setup');
    b.dataset.focusKey = `ru:${fk}`;
    b.setAttribute('aria-label', `Unhide ${r.name}`);
    row.appendChild(b);
    return row;
  }
  const setup = smallButton('Set up', () => setUp(r.path, 'repo'), `Create a project for ${r.name} with the commands it lists`);
  setup.classList.add('repo-setup');
  setup.dataset.focusKey = `rs:${fk}`;
  setup.setAttribute('aria-label', `Set up ${r.name}`);
  const more = actButton(icons.more, `More for ${r.name}`, (btn) => openMenu(btn, [
    { label: 'Set up', hint: r.runnable ? '' : 'no commands yet', action: () => setUp(r.path, 'repo') },
    { label: 'Hide', hint: 'not a project', action: () => hideRepo(r, true) },
  ], `Actions for ${r.name}`), `rm:${fk}`);
  more.setAttribute('aria-haspopup', 'menu');
  row.append(setup, more);
  return row;
}

// A folder of repos (automart, system barebones): one project with apps, or one project per repo
function setupFolderNode(f) {
  const n = f.repos.length;
  const btn = smallButton('Set up ▾', null, `Set up ${f.name}`);
  btn.classList.add('repo-setup');
  btn.dataset.focusKey = `rf:${lower(f.path)}`;
  btn.setAttribute('aria-haspopup', 'menu');
  btn.addEventListener('click', () => openMenu(btn, [
    { label: 'As one project', hint: `${n} app${n === 1 ? '' : 's'}`, disabled: f.setUp > 0, title: f.setUp ? 'Some repos here are already projects. Set up the rest separately, then use Combine with…' : `${f.name}, with a folder group per repo`, action: () => setUp(f.path, 'one') },
    { label: `As ${n} separate project${n === 1 ? '' : 's'}`, action: () => setUp(f.path, 'separate') },
    'separator',
    { label: 'Hide folder', hint: 'not projects', action: () => hideRepo(f, true) },
  ], `Set up ${f.name}`));
  const s = sectionNode({ key: `nsf:${lower(f.path)}`, label: f.name, kind: 'folder', title: f.path, icon: folderIcon(), fallback: false, sub: `<span>${esc(repoSummary(f))}${f.setUp ? ` · ${f.setUp} set up` : ''}</span>`, actions: [btn] });
  if (s.open) f.repos.forEach(r => s.body.appendChild(repoRow(r)));
  return s.node;
}

function notSetUpNode(root) {
  const shown = [], quiet = [], hidden = [];
  root.items.forEach(it => {
    if (it.hidden) { hidden.push(it); return; }
    if (it.kind !== 'folder') { (it.runnable ? shown : quiet).push(it); return; }
    hidden.push(...it.repos.filter(r => r.hidden));
    quiet.push(...it.repos.filter(r => !r.hidden && !r.runnable));
    const open = it.repos.filter(r => !r.hidden && r.runnable);
    if (open.length) shown.push({ ...it, repos: open });
  });
  const count = shown.reduce((n, it) => n + (it.kind === 'folder' ? it.repos.length : 1), 0);
  const scanning = root.scanning && !root.items.length;
  const s = sectionNode({ key: `notsetup:${lower(root.path)}`, label: scanning ? 'Not set up · looking…' : 'Not set up', count: scanning ? null : count, fallback: false, kind: 'notsetup', title: `Repos in ${root.path} that aren't projects yet` });
  if (!s.open) return s.node;
  if (!count && !quiet.length && !hidden.length) s.body.appendChild(noteNode(scanning ? 'Looking for repos…' : 'Everything in this folder is set up.'));
  // A folder with one repo left is just that repo (no "one project or one project?" question)
  shown.forEach(it => s.body.appendChild(it.kind === 'folder'
    ? (it.repos.length === 1 ? repoRow({ ...it.repos[0], parent: it.name }) : setupFolderNode(it))
    : repoRow(it)));
  if (quiet.length) {
    const q = sectionNode({ key: `quiet:${lower(root.path)}`, label: `${quiet.length} without commands`, fallback: false, kind: 'minor', title: 'No package.json, composer.json, artisan, manage.py or Procfile found' });
    if (q.open) quiet.forEach(r => q.body.appendChild(repoRow(r)));
    s.body.appendChild(q.node);
  }
  if (hidden.length) {
    const h = sectionNode({ key: `hidden:${lower(root.path)}`, label: 'Hidden', count: hidden.length, fallback: false, kind: 'minor' });
    if (h.open) hidden.forEach(r => h.body.appendChild(repoRow(r, true)));
    s.body.appendChild(h.node);
  }
  return s.node;
}

function promptCard(prompt) {
  const card = document.createElement('div');
  card.className = 'root-prompt';
  card.innerHTML = `<b>Where do you keep your projects?</b>
    <span>Pick the folder that holds your repos. StackConsole lists what it finds; nothing is added until you set it up.</span>
    ${prompt.suggestion ? `<span class="path">${esc(prompt.suggestion)}</span>` : ''}
    <span class="inline-row"></span>`;
  const row = card.querySelector('.inline-row');
  if (prompt.suggestion) {
    const use = smallButton('Use this folder', () => addRoot({ suggested: true }), prompt.suggestion);
    use.className = 'btn-primary btn-sm';
    row.appendChild(use);
  }
  row.appendChild(smallButton(prompt.suggestion ? 'Choose another…' : 'Choose folder…', () => addRoot({ pick: true })));
  const later = smallButton('Not now', () => window.api.dismissRootPrompt());
  later.className = 'btn-ghost btn-sm';
  row.appendChild(later);
  return card;
}

// Running now: every running, starting, waiting or crashed service as a shortcut (crashed first).
// Shown with master folders, where the list is long; the rows below never move.
function renderStrip() {
  const strip = $('RunningStrip');
  const items = [];
  visibleProjects().forEach(p => commandsOf(p).forEach(c => {
    const s = normalizeStatus(c.status);
    if (s !== 'offline') items.push({ p, c, s });
  }));
  if (!workspace().enabled || !items.length || window.layout.panelOpen()) { strip.hidden = true; strip.innerHTML = ''; return; }
  const rank = { crashed: 0, waiting: 1, starting: 1, running: 2 };
  items.sort((a, b) => (rank[a.s] ?? 3) - (rank[b.s] ?? 3) || collator.compare(a.p.name, b.p.name) || collator.compare(a.c.displayName, b.c.displayName));
  const all = isOpen('strip:all', false);
  const max = window.innerHeight < 640 ? 2 : 3; // a short window keeps most of its height for the tree
  const focusKey = document.activeElement?.dataset?.focusKey;
  strip.hidden = false;
  strip.innerHTML = '<div class="run-strip-title">Running now</div>';
  (all ? items : items.slice(0, max)).forEach(({ p, c, s }) => {
    const active = selection?.kind === 'cmd' && selection.projectId === p.id && selection.id === c.id;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `run-row${active ? ' active' : ''}`;
    b.dataset.focusKey = `run:${p.id}:${c.id}`;
    b.title = `${c.displayName} · ${p.name} · ${statusLabel(s)}`;
    b.innerHTML = `${statusIndicator(s)}<span class="run-name">${esc(c.displayName)}</span>${tile(p, 'sm')}<span class="run-project">${esc(p.name)}</span>`;
    b.addEventListener('click', (e) => serviceClick(e, p.id, c.id));
    strip.appendChild(b);
  });
  if (items.length > max) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'run-more';
    more.dataset.focusKey = 'run:more';
    more.textContent = all ? 'Show less' : `+${items.length - max} more`;
    more.addEventListener('click', () => { setOpen('strip:all', !all); renderStrip(); });
    strip.appendChild(more);
  }
  if (focusKey && focusKey.startsWith('run')) strip.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

let stripResize = null;
window.addEventListener('resize', () => {
  clearTimeout(stripResize);
  stripResize = setTimeout(() => { if (appState) renderStrip(); }, 150);
});

function renderHeading() {
  const ws = workspace();
  const single = ws.enabled && ws.roots.length === 1 ? ws.roots[0] : null;
  const h = $('ProjectsHeading');
  h.textContent = single ? single.path : 'Projects';
  h.title = single ? `Projects folder: ${single.path}` : '';
  h.classList.toggle('is-path', !!single);
  $('BtnRootsMenu').setAttribute('aria-label', single ? `Actions for ${single.path}` : 'Projects folders');
  $('BtnRootsMenu').title = single ? 'Projects folder actions' : 'Projects folders';
}

// Sidebar at icons-only width: one tile per project, its worst status as a badge
function renderRail() {
  const nav = $('SidebarRail');
  const focusKey = document.activeElement?.dataset?.focusKey;
  nav.innerHTML = '';
  const list = visibleProjects().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || byProjectName(a, b));
  list.forEach(p => {
    const cmds = commandsOf(p);
    const c = countByStatus(cmds);
    const badge = c.crashed ? 'crashed' : c.running ? 'running' : (c.starting || c.waiting) ? 'starting' : '';
    const words = [c.running && `${c.running} running`, (c.starting + c.waiting) && `${c.starting + c.waiting} starting`, c.crashed && `${c.crashed} crashed`].filter(Boolean);
    const current = selection?.kind === 'cmd' && selection.projectId === p.id;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rail-item ${window.identity.colourClass(p)}${current ? ' is-active' : ''}`;
    b.dataset.focusKey = `rail:${p.id}`;
    const label = `${p.name}${words.length ? `: ${words.join(', ')}` : (cmds.length ? '' : ': no services')}`;
    b.setAttribute('aria-label', label);
    b.title = label;
    if (current) b.setAttribute('aria-current', 'true');
    b.innerHTML = `${tile(p, 'md')}${badge ? `<span class="rail-badge">${statusIndicator(badge)}</span>` : ''}`;
    b.addEventListener('click', () => openFromRail(p));
    nav.appendChild(b);
  });
  const sep = document.createElement('span');
  sep.className = 'rail-sep';
  const bottom = document.createElement('span');
  bottom.className = 'rail-bottom';
  bottom.append(
    actButton(icons.terminal, 'Shell', () => selectShell(), 'rail:shell'),
    actButton(icons.chevronRight, 'Show names (Ctrl+B)', () => window.layout.toggleSidebar(), 'rail:expand'),
  );
  nav.append(sep, bottom);
  if (focusKey) nav.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// A project in the rail opens what you last looked at there, else what needs you (crashed, then running)
function openFromRail(p) {
  const cmds = commandsOf(p);
  if (!cmds.length) {
    // Nothing to show on its own: bring the names back with this project in view
    expandProject(p.id);
    pendingScrollKey = `p:${p.id}`;
    window.layout.toggleSidebar();
    return;
  }
  const by = (status) => cmds.find(c => normalizeStatus(c.status) === status);
  const cmd = cmds.find(c => c.id === lastServiceOf.get(p.id)) || by('crashed') || cmds.find(c => isLive(c.status)) || cmds[0];
  selectService(p.id, cmd.id);
}

$('SidebarRail').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...$('SidebarRail').querySelectorAll('button')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
});

function renderSidebar() {
  if (window.layout.density() === 'rail') { renderRail(); return; }
  renderHeading();
  renderStrip();
  const container = $('ProcessWrapperList');
  // Re-rendering replaces the rows; keep keyboard focus and the scroll position
  const focusKey = document.activeElement?.dataset?.focusKey;
  const scrollTop = container.scrollTop;
  container.innerHTML = '';

  const ws = workspace();
  const shown = visibleProjects();
  const inSection = (section) => shown.filter(p => placeOf(p).section === section).sort(byProjectName);

  if (ws.prompt) container.appendChild(promptCard(ws.prompt));

  const pinned = inSection('pinned');
  if (pinned.length) {
    const s = sectionNode({ key: 'pinned', label: 'Pinned', count: pinned.length });
    if (s.open) pinned.forEach(p => s.body.appendChild(projectNode(p)));
    container.appendChild(s.node);
  }

  if (ws.enabled) {
    const single = ws.roots.length === 1;
    ws.roots.forEach(root => {
      const list = shown.filter(p => { const pl = placeOf(p); return pl.section === 'root' && pl.root === root.path; });
      if (single) {
        const body = document.createElement('div');
        body.className = 'tree-section-body';
        rootBody(root, body, list);
        container.appendChild(body);
        return;
      }
      const more = actButton(icons.more, `Actions for ${root.path}`, (btn) => openMenu(btn, rootMenuItems(root), `Actions for ${root.path}`), `rootm:${lower(root.path)}`);
      more.setAttribute('aria-haspopup', 'menu');
      const s = sectionNode({
        key: `root:${lower(root.path)}`, labelHtml: esc(root.path), kind: 'root', title: root.path, actions: [more],
        sub: root.exists ? liveSubline(list) || `<span>${list.length} project${list.length === 1 ? '' : 's'}</span>` : `<span class="is-warn">${icons.warn}Not found</span>`,
      });
      if (s.open) rootBody(root, s.body, list);
      container.appendChild(s.node);
    });
    const other = inSection('other');
    if (other.length) {
      const s = sectionNode({ key: 'other', label: 'Other locations', count: other.length, title: 'Projects outside your projects folders' });
      if (s.open) other.forEach(p => s.body.appendChild(projectNode(p)));
      container.appendChild(s.node);
    }
  } else {
    inSection('other').concat(inSection('root')).sort(byProjectName).forEach(p => container.appendChild(projectNode(p)));
  }

  // Projects with no folder or no services sink to the bottom, closed by default
  const empty = inSection('empty');
  if (empty.length) {
    const s = sectionNode({ key: 'empty', label: 'Empty', count: empty.length, fallback: false, kind: 'empty', title: 'Projects with no folder or no services' });
    if (s.open) {
      empty.forEach(p => s.body.appendChild(projectNode(p)));
      const row = document.createElement('div');
      row.className = 'tree-note';
      const b = smallButton(`Archive all ${empty.length}`, archiveEmptyProjects, 'Move every empty project to Archived');
      b.dataset.focusKey = 'empty:archive';
      row.appendChild(b);
      s.body.appendChild(row);
    }
    container.appendChild(s.node);
  }
  if (archivedProjects().length) container.appendChild(archivedNode());
  if (!projects().length && !ws.prompt && !ws.enabled) container.appendChild(noteNode('No projects yet. Use + to create one.'));

  container.scrollTop = scrollTop;
  // Follow the selected project when it changes section (first command, archived, folder changed)
  const sel = selectedProject();
  const place = sel ? `${placeOf(sel).section}|${placeOf(sel).root || ''}|${placeOf(sel).container?.path || ''}` : null;
  if (sel && lastSelectedPlace && place !== lastSelectedPlace && selection?.kind === 'cmd') pendingScrollKey = pendingScrollKey || `c:${sel.id}:${selection.id}`;
  lastSelectedPlace = place;
  if (pendingScrollKey) {
    const el = container.querySelector(`[data-focus-key="${CSS.escape(pendingScrollKey)}"]`);
    pendingScrollKey = null;
    if (el) { el.scrollIntoView({ block: 'nearest' }); el.focus(); }
  } else if (focusKey) {
    container.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  const shellRow = $('BtnOpenCmd');
  const shellActive = selection?.kind === 'shell';
  shellRow.classList.toggle('active', shellActive);
  if (shellActive) shellRow.setAttribute('aria-current', 'true');
  else shellRow.removeAttribute('aria-current');

  const live = projects().reduce((n, p) => n + liveCount(commandsOf(p)), 0);
  $('TriggerStopAll').innerHTML = `${icons.stop}<span>Stop everything${live ? ` (${live})` : ''}</span>`;
  $('TriggerStopAll').disabled = live === 0;
}

function toggleProject(projectId) {
  if (collapsed.has(projectId)) collapsed.delete(projectId);
  else collapsed.add(projectId);
  writePref('sc.collapsed', [...collapsed]);
  renderSidebar();
}

function expandProject(projectId) {
  if (!collapsed.has(projectId)) return;
  collapsed.delete(projectId);
  writePref('sc.collapsed', [...collapsed]);
}

// ── Project & service actions (tree ▷ / ■ and ⋯ menus) ───────────
async function stopProject(p) {
  const live = liveCount(commandsOf(p));
  if (live > 1) {
    const choice = await confirmDialog({
      title: `Stop all services in ${p.name}?`,
      body: `${live} services are running or starting and will be stopped. Their logs stay available.`,
      actions: [
        { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
        { label: 'Stop all', value: 'stop', variant: 'danger-solid' },
      ],
    });
    if (choice !== 'stop') return;
  }
  window.api.stopAll(p.id);
}

async function folderAction(projectId, commandId, kind) {
  const res = await window.api.openFolder(projectId, commandId, kind);
  if (res && !res.ok) await notify('Couldn\'t open the folder', res.error || 'Try again.');
}

async function chooseFolder(p) {
  const folder = await window.api.selectDirectory();
  if (!folder) return;
  const res = await window.api.setProjectFolder(p.id, folder);
  if (res && !res.ok) await notify('Couldn\'t change the folder', res.error);
}

async function relinkProject(p) {
  const res = await window.api.relinkProject(p.id);
  if (res && !res.ok) await notify('Couldn\'t relink the project', res.error);
}

async function archiveProject(p, archived) {
  const res = await window.api.archiveProject(p.id, archived);
  if (res && !res.ok) await notify(archived ? 'Couldn\'t archive the project' : 'Couldn\'t unarchive the project', res.error);
}

async function pinProject(p, pinned) {
  const res = await window.api.pinProject(p.id, pinned);
  if (res && !res.ok) await notify('Couldn\'t pin the project', res.error);
}

async function archiveEmptyProjects() {
  const n = visibleProjects().filter(p => placeOf(p).section === 'empty').length;
  if (!n) return;
  const choice = await confirmDialog({
    title: `Archive ${n} empty project${n === 1 ? '' : 's'}?`,
    body: 'Projects with no folder or no services move to Archived. You can unarchive them any time.',
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Archive', value: 'archive', variant: 'primary' },
    ],
  });
  if (choice === 'archive') await window.api.archiveEmptyProjects();
}

// ── Master folders ───────────────────────────────────────────────
async function addRoot(opts) {
  let res = await window.api.addRoot(opts);
  if (res && res.needsReplace) {
    const choice = await confirmDialog({
      title: `Use ${res.path} instead?`,
      body: `It holds ${res.contains.join(', ')}, which is already in the list. ${baseName(res.path)} takes its place. Your projects aren't changed.`,
      actions: [
        { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
        { label: `Use ${baseName(res.path)}`, value: 'use', variant: 'primary' },
      ],
    });
    if (choice !== 'use') return;
    res = await window.api.confirmRootReplace();
  }
  if (!res || res.canceled) return;
  if (!res.ok) { await notify('Couldn\'t add that folder', res.error || 'Try again.'); return; }
  setOpen(`notsetup:${lower(res.path)}`, true); // show what it found
}

async function changeRoot(root) {
  const res = await window.api.changeRootPick(root.path);
  if (!res || res.canceled) return;
  if (!res.ok) { await notify('Couldn\'t use that folder', res.error || 'Try again.'); return; }
  const list = (names) => (names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', '));
  const details = [];
  if (res.oldMissing) {
    if (res.stay.length) details.push(`${res.stay.length} project${res.stay.length === 1 ? '' : 's'} move with it: ${list(res.stay)}`);
    if (res.move.length) details.push({ text: `${res.move.length} weren't found there and keep their old folder: ${list(res.move)}`, tone: 'warn' });
  } else {
    if (res.stay.length) details.push(`${res.stay.length} stay in place: ${list(res.stay)}`);
    if (res.move.length) details.push(`${res.move.length} move to Other locations and keep working: ${list(res.move)}`);
  }
  const choice = await confirmDialog({
    title: `Use ${res.path} instead of ${root.path}?`,
    body: res.oldMissing ? `${root.path} isn't there any more. Projects found in the new folder are pointed there.` : 'Nothing is deleted, and running services keep running.',
    details,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: `Use ${baseName(res.path)}`, value: 'use', variant: 'primary' },
    ],
  });
  if (choice !== 'use') return;
  const done = await window.api.changeRootApply();
  if (done && !done.ok) await notify('Couldn\'t change the folder', done.error);
}

async function relinkRoot(root) {
  const res = await window.api.relinkRoot(root.path);
  if (res && !res.ok) await notify('Couldn\'t relink the folder', res.error);
}

async function removeRoot(root) {
  const inside = visibleProjects().filter(p => placeOf(p).root === root.path);
  const live = inside.reduce((n, p) => n + liveCount(commandsOf(p)), 0);
  const choice = await confirmDialog({
    title: `Remove ${root.path} from the list?`,
    body: `${inside.length ? `Its ${inside.length} project${inside.length === 1 ? '' : 's'} move${inside.length === 1 ? 's' : ''} to Other locations${live ? ' and keep running' : ''}. ` : ''}Repos that aren't set up leave the list. Nothing on disk changes.`,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Remove', value: 'remove', variant: 'danger-solid' },
    ],
  });
  if (choice === 'remove') await window.api.removeRoot(root.path);
}

function rootMenuItems(root) {
  const roots = workspace().roots;
  const i = roots.findIndex(r => r.path === root.path);
  const multi = roots.length > 1;
  return [
    { label: 'Rescan', disabled: !root.exists, action: () => window.api.rescanRoot(root.path) },
    { label: 'Open in Explorer', disabled: !root.exists, action: async () => { const r = await window.api.openRoot(root.path); if (r && !r.ok) await notify('Couldn\'t open the folder', r.error); } },
    'separator',
    ...(root.relinkTo ? [{ label: `Relink to ${root.relinkTo}`, action: () => relinkRoot(root) }] : []),
    { label: 'Change folder…', action: () => changeRoot(root) },
    ...(multi ? [
      { label: 'Move up', disabled: i <= 0, action: () => window.api.moveRoot(root.path, -1) },
      { label: 'Move down', disabled: i === roots.length - 1, action: () => window.api.moveRoot(root.path, 1) },
    ] : []),
    { label: 'Remove from list', action: () => removeRoot(root) },
  ];
}

function openRootsMenu() {
  const ws = workspace();
  const items = [];
  if (ws.roots.length === 1) items.push(...rootMenuItems(ws.roots[0]), 'separator');
  if (!ws.roots.length && ws.prompt?.suggestion) items.push({ label: `Use ${ws.prompt.suggestion}`, action: () => addRoot({ suggested: true }) });
  items.push({ label: ws.roots.length ? 'Add another projects folder…' : 'Choose a projects folder…', action: () => addRoot({ pick: true }) });
  const empty = visibleProjects().filter(p => placeOf(p).section === 'empty').length;
  items.push('separator', { label: 'Archive empty projects', hint: empty ? String(empty) : '', disabled: !empty, action: archiveEmptyProjects });
  items.push('separator', { label: 'Reset layout', hint: 'Sizes of the sidebar and panels', action: () => window.layout.reset() });
  openMenu($('BtnRootsMenu'), items, 'Projects folders');
}

async function hideRepo(r, hidden) {
  const res = await window.api.hideRepo(r.path, hidden);
  if (res && !res.ok) await notify(hidden ? 'Couldn\'t hide it' : 'Couldn\'t unhide it', res.error);
}

async function setUp(folder, mode) {
  const res = await window.api.setUpRepo(folder, mode);
  if (!res || !res.ok) { await notify('Couldn\'t set it up', res?.error || 'Try again.'); return; }
  revealProjectId = res.projectIds[0];
  if (projectById(revealProjectId)) render();
  // Commands found but none pre-ticked (composer-only): choose them instead of guessing
  if (res.needsReview) window.api.openImportCommands();
}

function revealNewProject() {
  if (!revealProjectId) return;
  const p = projectById(revealProjectId);
  if (!p) return;
  revealProjectId = null;
  expandProject(p.id);
  const first = commandsOf(p)[0];
  if (first) selection = { kind: 'cmd', projectId: p.id, id: first.id };
  pendingScrollKey = `p:${p.id}`;
}

// ── Regroup: split / combine ─────────────────────────────────────
function commonFolderOf(paths) {
  const parts = paths.filter(Boolean).map(f => f.replace(/[\\/]+$/, '').split(/[\\/]/));
  if (!parts.length) return '';
  const out = [];
  for (let i = 0; i < parts[0].length; i++) {
    if (parts.every(x => x[i] !== undefined && lower(x[i]) === lower(parts[0][i]))) out.push(parts[0][i]);
    else break;
  }
  return out.join('\\');
}

// Split groups = the first folder below the project folder each service runs in (main decides the same way)
function splitGroupCount(p) {
  const groups = new Set();
  commandsOf(p).forEach(c => { const g = folderGroup(p, c); groups.add(g.outside ? '' : lower(g.label.split(/[\\/]/)[0])); });
  return groups.size;
}

async function splitProject(p) {
  const pv = await window.api.splitPreview(p.id);
  if (!pv || !pv.ok) { await notify(`Can't split ${p.name}`, pv?.error || 'Try again.'); return; }
  if (pv.live) { await notify(`Stop ${p.name} first`, 'Its services are running. Stop them, then split the project.'); return; }
  const choice = await confirmDialog({
    title: `Split ${p.name} into ${pv.groups.length} projects?`,
    body: 'Each folder becomes its own project. Services keep their command, env vars, ready line and crash settings.',
    details: [
      ...pv.groups.map(g => `${g.name}: ${g.commands} service${g.commands === 1 ? '' : 's'}${g.stays ? ' (stays in this project)' : ''}`),
      ...pv.warnings.map(text => ({ text, tone: 'warn' })),
    ],
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Split', value: 'split', variant: 'primary' },
    ],
  });
  if (choice !== 'split') return;
  const res = await window.api.splitApply(p.id);
  if (res && !res.ok) await notify(`Couldn't split ${p.name}`, res.error);
}

async function combineProject(p) {
  const found = await window.api.combineCandidates(p.id);
  if (!found || !found.ok) { await notify('Couldn\'t combine', found?.error || 'Try again.'); return; }
  if (!found.projects.length) {
    await notify('Nothing to combine with', `Combine works with projects in the same folder as ${p.name}, like automart's repos. There are none.`);
    return;
  }
  const checklist = found.projects.map(x => ({ id: x.id, label: x.name, sub: x.folder, checked: true }));
  // Default name: the folder they all share (automart for its three repos)
  const common = commonFolderOf([p.baseDirectory, ...found.projects.map(x => x.folder)]);
  const field = { label: 'Name of the combined project', value: baseName(common || p.baseDirectory) };
  const choice = await confirmDialog({
    title: `Combine ${p.name} with…`,
    body: 'They become one project with a folder group per repo. Each repo keeps its branch, commands and env vars.',
    checklist, field,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary' },
      { label: 'Combine', value: 'go', variant: 'primary', autofocus: true },
    ],
  });
  if (choice !== 'go') return;
  const ids = [p.id, ...checklist.filter(x => x.checked).map(x => x.id)];
  if (ids.length < 2) return;
  const pv = await window.api.combinePreview(ids);
  if (!pv || !pv.ok) { await notify('Can\'t combine these', pv?.error || 'Try again.'); return; }
  if (pv.live) { await notify('Stop them first', 'Some of these projects have running services. Stop them, then combine.'); return; }
  if (pv.renames.length) {
    const again = await confirmDialog({
      title: 'Some services get a clearer name',
      body: 'These names appear more than once, so each one says its folder.',
      details: pv.renames,
      actions: [
        { label: 'Cancel', value: null, variant: 'secondary' },
        { label: 'Combine', value: 'go', variant: 'primary', autofocus: true },
      ],
    });
    if (again !== 'go') return;
  }
  const res = await window.api.combineApply(ids, field.value);
  if (res && !res.ok) await notify('Couldn\'t combine', res.error);
}

async function editCommand(projectId, commandId) {
  const db = await window.api.getStore();
  db.activeProject = projectId;
  db.activeCommandToEdit = commandId;
  await window.api.setStore(db);
  window.api.openEditCommand();
}

function openProjectMenu(p, anchor) {
  const cmds = commandsOf(p);
  const live = liveCount(cmds);
  const hasFolder = !!p.baseDirectory && !p.folderMissing;
  const noFolder = p.baseDirectory ? 'The folder is missing' : 'No folder set';
  openMenu(anchor, [
    live
      ? { label: 'Stop all services', hint: `${live} running`, action: () => stopProject(p) }
      : { label: 'Start all services', hint: cmds.length ? `${cmds.length}` : '', disabled: !cmds.length || !!p.folderMissing, action: () => window.api.launchAll(p.id) },
    'separator',
    { label: 'Open folder', hint: 'Explorer', disabled: !hasFolder, title: hasFolder ? p.baseDirectory : noFolder, action: () => folderAction(p.id, null, 'explorer') },
    { label: 'Open in VS Code', disabled: !hasFolder, title: hasFolder ? '' : noFolder, action: () => folderAction(p.id, null, 'vscode') },
    { label: 'Terminal here', disabled: !hasFolder, title: hasFolder ? '' : noFolder, action: () => folderAction(p.id, null, 'terminal') },
    'separator',
    { label: 'Add command…', action: () => withActive(p.id, () => window.api.openAddCommand()) },
    { label: 'Import from folder…', disabled: !hasFolder, title: hasFolder ? '' : noFolder, action: () => withActive(p.id, () => window.api.openImportCommands()) },
    ...(p.folderMissing && p.relinkTo ? [{ label: `Relink to ${baseName(p.relinkTo)}`, title: p.relinkTo, action: () => relinkProject(p) }] : []),
    { label: p.baseDirectory ? 'Change folder…' : 'Choose folder…', action: () => chooseFolder(p) },
    { label: 'Rename…', action: () => withActive(p.id, () => window.api.editProjectName()) },
    { label: 'Colour & icon…', hint: window.identity.describe(p), action: () => editIdentity(p, anchor) },
    { label: p.pinned ? 'Unpin' : 'Pin to top', action: () => pinProject(p, !p.pinned) },
    'separator',
    (() => {
      const n = splitGroupCount(p);
      return { label: n >= 2 ? `Split into ${n} projects…` : 'Split…', disabled: n < 2, title: n < 2 ? 'All its services run in one folder' : 'One project per folder', action: () => splitProject(p) };
    })(),
    { label: 'Combine with…', disabled: !hasFolder, title: hasFolder ? 'Make one project out of this and others in the same folder' : noFolder, action: () => combineProject(p) },
    'separator',
    { label: 'Archive project', disabled: live > 0, title: live ? 'Stop its services first' : 'Hide it under Archived', action: () => archiveProject(p, true) },
  ], `Actions for ${p.name}`);
}

// Colour & icon: the picker previews live in the tree, header and footer; Done saves, Esc reverts
function identityPreview(p) {
  const group = folderGroup(p, commandsOf(p)[0] || {});
  return `<div class="tree-project id-rail ${window.identity.colourClass(p)}"><div class="tree-head"><span class="tree-toggle"><span class="tree-caret">${icons.chevronRight}</span>${tile(p)}<span class="tree-text"><span class="tree-name">${esc(p.name)}</span><span class="tree-sub">${projectSubline(p)}</span></span></span></div></div>`
    + `<span class="meta-crumb">${tile(p, 'sm')}<b>${esc(p.name)}</b>${group.label ? ` › ${esc(group.label)}` : ''}</span>`;
}
function renderIdentity() {
  renderSidebar();
  renderFooter();
  if (selection?.kind === 'cmd' && selectedCmd()) renderServiceHeader(selectedProject(), selectedCmd());
}
function editIdentity(p, anchor) {
  window.identity.openPicker(p, {
    anchor,
    restoreFocus: () => $('ProcessWrapperList').querySelector(`[data-focus-key="${CSS.escape(`m:${p.id}`)}"]`)?.focus(),
    renderPreview: identityPreview,
    onChange: renderIdentity,
    onDone: async (choice) => {
      const auto = choice.auto || {};
      const payload = choice.reset ? { color: null, icon: null, mono: null }
        : { color: choice.color, icon: choice.icon || 'letters', mono: choice.icon ? null : choice.mono };
      // Matching the automatic pick stores nothing, so the project keeps following its stack
      if (!choice.reset && payload.color === auto.color) payload.color = null;
      if (!choice.reset && choice.icon && choice.icon === auto.icon) payload.icon = null;
      if (!choice.reset && !choice.icon && choice.mono === auto.mono && !auto.icon) { payload.icon = null; payload.mono = null; }
      const res = await window.api.setProjectIdentity(p.id, payload);
      if (res && res.ok === false) await notify('Colour & icon not saved', res.error || 'Try again.');
      renderIdentity();
    },
  });
}

$('BtnServiceMore').addEventListener('click', () => {
  const cmd = selectedCmd();
  const p = selectedProject();
  if (!cmd || !p) return;
  const ok = !!cmd.folder && !cmd.folderMissing;
  const why = cmd.folder ? 'The folder is missing' : 'No folder set';
  openMenu($('BtnServiceMore'), [
    { label: 'Open folder', hint: 'Explorer', disabled: !ok, title: ok ? cmd.folder : why, action: () => folderAction(p.id, cmd.id, 'explorer') },
    { label: 'Open in VS Code', disabled: !ok, title: ok ? '' : why, action: () => folderAction(p.id, cmd.id, 'vscode') },
    { label: 'Terminal here', disabled: !ok, title: ok ? '' : why, action: () => folderAction(p.id, cmd.id, 'terminal') },
    'separator',
    { label: 'Edit command…', action: () => editCommand(p.id, cmd.id) },
    { label: 'Copy command', action: () => copyText(cmd.command || '') },
    'separator',
    besideCmd()
      ? { label: 'Close the second log', action: closeBeside }
      : { label: 'Open another log beside…', hint: 'Ctrl+click', action: () => chooseBeside($('BtnServiceMore')) },
  ], `Actions for ${cmd.displayName}`);
});

// ── Main panel ───────────────────────────────────────────────────
function setMainSections(visible) {
  $('MainHeader').hidden = !visible;
  $('LogToolbar').hidden = !visible;
  $('LogSplit').hidden = !visible;
  $('EmptyState').hidden = visible;
  if (!visible) { $('StateBanner').hidden = true; renderedKey = null; setBand(null); }
}

function showEmptyState(title, body, primary, secondary) {
  setMainSections(false);
  $('EmptyTitle').textContent = title;
  $('EmptyBody').textContent = body;
  $('EmptyAction').textContent = primary.label;
  $('EmptyAction').onclick = primary.action;
  $('EmptySecondary').hidden = !secondary;
  if (secondary) {
    $('EmptySecondary').textContent = secondary.label;
    $('EmptySecondary').onclick = secondary.action;
  }
}

// An empty project offers to import what its folder already lists (package.json, artisan, …)
let importProbe = { projectId: null, count: 0 };
async function probeImport(project) {
  if (importProbe.projectId === project.id) return;
  importProbe = { projectId: project.id, count: 0 };
  if (!project.baseDirectory || project.folderMissing || appState.activeProject !== project.id) return;
  const res = await window.api.importScan();
  const count = res && res.ok ? res.groups.reduce((n, g) => n + g.items.length, 0) : 0;
  importProbe = { projectId: project.id, count };
  if (count && !selection) renderMain();
}

function renderMain() {
  if (!projects().length) {
    showEmptyState(
      'No projects yet',
      'Create a project, then add the commands you run every day: dev servers, queue workers, tunnels.',
      { label: 'Create project', action: () => window.api.newProjectCommand() }
    );
    return;
  }
  if (!selection) {
    const project = [activeProject(), ...visibleProjects()].find(p => p && !p.archived);
    if (!project) {
      showEmptyState(
        'All projects are archived',
        'Unarchive one from the bottom of the sidebar, or create a new project.',
        { label: 'Create project', action: () => window.api.newProjectCommand() }
      );
      return;
    }
    probeImport(project);
    const found = importProbe.projectId === project.id ? importProbe.count : 0;
    showEmptyState(
      `No services in ${project.name}`,
      found
        ? `Found ${found} command${found === 1 ? '' : 's'} in ${project.baseDirectory} (package.json, artisan, Procfile…). Import them, or add one by hand.`
        : 'Add the commands you start for this project, like npm run dev or php artisan serve.',
      found
        ? { label: `Import ${found} command${found === 1 ? '' : 's'}…`, action: () => withActive(project.id, () => window.api.openImportCommands()) }
        : { label: 'Add command', action: () => withActive(project.id, () => window.api.openAddCommand()) },
      found ? { label: 'Add command', action: () => withActive(project.id, () => window.api.openAddCommand()) } : null
    );
    return;
  }

  setMainSections(true);

  if (selection.kind === 'shell') renderShellHeader();
  else renderServiceHeader(selectedProject(), selectedCmd());

  $('TerminalInputLine').hidden = selection.kind !== 'shell';
  loadLogStream();
}

function setPill(status, label) {
  const pill = $('StatusPill');
  pill.dataset.status = status;
  pill.querySelector('.status-ind').dataset.status = status;
  $('StatusPillLabel').textContent = label;
}

// The selected project's colour, as a thin band across the top of the main panel
function setBand(project) {
  const band = $('IdBand');
  band.hidden = !project;
  band.className = `id-band${project ? ` ${window.identity.colourClass(project)}` : ''}`;
}

function renderShellHeader() {
  setBand(null);
  $('ServiceName').textContent = 'Shell';
  $('ServiceName').title = 'Shell';
  setPill('shell', 'Shell');
  const dir = activeProject()?.baseDirectory;
  $('ServiceMeta').innerHTML = `<span>${esc(dir || 'Home folder')}</span>`;
  ['BtnStart', 'BtnStartNow', 'BtnRestart', 'BtnStop', 'BtnServiceMore'].forEach(id => { $(id).hidden = true; });
  setBanner(null);
}

function formatUptime(startedAt) {
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function renderServiceHeader(project, cmd) {
  const status = normalizeStatus(cmd.status);
  $('ServiceName').textContent = cmd.displayName;
  $('ServiceName').title = cmd.displayName;
  setPill(status, statusLabel(status));

  const group = folderGroup(project, cmd);
  setBand(project);
  const parts = [`<span class="meta-crumb" title="${esc(cmd.folder || '')}">${tile(project, 'sm')}<b>${esc(project.name)}</b>${group.label ? ` › ${esc(group.label)}` : ''}</span>`];
  if (cmd.branch) parts.push(branchHtml(cmd.branch, cmd.detached));
  if (cmd.command) parts.push(`<span class="meta-cmd" title="${esc(cmd.command)}">$ ${esc(cmd.command)}</span>`);
  if (cmd.url) {
    parts.push(`<button type="button" class="meta-link" data-url="${esc(cmd.url)}" title="Open in browser">${esc(cmd.url)}</button>`);
  } else if (cmd.port) {
    parts.push(`<span title="Configured port">:${esc(cmd.port)}</span>`);
  }
  if (cmd.pid) parts.push(`<span>pid ${esc(cmd.pid)}</span>`);
  if (status === 'running' && cmd.startedAt) parts.push(`<span id="MetaUptime">up ${formatUptime(cmd.startedAt)}</span>`);
  if (status === 'crashed') parts.push(`<span class="t-error">exited with code ${esc(cmd.exitCode ?? '?')}</span>`);
  const env = cmd.envSummary || (Array.isArray(cmd.env) && cmd.env.length ? { count: cmd.env.length, file: cmd.envFile } : (cmd.envFile ? { count: 0, file: cmd.envFile } : null));
  if (env) parts.push(`<span class="env-chip" title="Environment variables for this command">env${env.count ? `: ${esc(env.count)}` : ''}${env.file ? ` · ${esc(env.file)}` : ''}</span>`);
  $('ServiceMeta').innerHTML = parts.join('');
  $('ServiceMeta').querySelector('.meta-link')?.addEventListener('click', (e) => window.api.openExternal(e.currentTarget.dataset.url));

  const live = isLive(status);
  $('BtnStart').hidden = live;
  $('BtnStartNow').hidden = status !== 'waiting';
  $('BtnRestart').hidden = !live || status === 'waiting';
  $('BtnStop').hidden = !live;
  $('BtnServiceMore').hidden = false;
  ['BtnStart', 'BtnStartNow', 'BtnRestart', 'BtnStop'].forEach(id => { $(id).disabled = !!pendingAction; });
  // Nothing to start in a folder that isn't there; the banner says why
  if (!live && cmd.folderMissing) { $('BtnStart').disabled = true; $('BtnStart').title = 'Folder not found'; }
  else $('BtnStart').title = '';

  renderServiceBanner(project, cmd, status);
}

// One banner explains a non-obvious state: folder missing, waiting, blocked, restarting, crashed.
function setBanner(spec) {
  const banner = $('StateBanner');
  if (!spec) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.dataset.tone = spec.tone;
  $('StateBannerText').innerHTML = spec.html;
  const actions = $('StateBannerActions');
  actions.innerHTML = '';
  (spec.actions || []).forEach(a => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn-ghost btn-sm';
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.addEventListener('click', a.run);
    actions.appendChild(b);
  });
}

function goToService(name, projectId = selection?.projectId) {
  const project = projectById(projectId);
  const found = commandsOf(project).find(c => c.displayName === name);
  if (found) selectService(project.id, found.id);
}

function renderServiceBanner(project, cmd, status) {
  if (cmd.folderMissing && !isLive(status)) {
    const actions = [];
    if (project.folderMissing) {
      if (project.relinkTo) actions.push({ label: `Relink to ${baseName(project.relinkTo)}`, title: project.relinkTo, run: () => relinkProject(project) });
      actions.push({ label: 'Change folder…', run: () => chooseFolder(project) });
    } else {
      actions.push({ label: 'Edit command', run: () => editCommand(project.id, cmd.id) });
    }
    setBanner({ tone: 'error', html: `<b>Folder not found:</b> <span class="banner-quote">${esc(cmd.folder || project.baseDirectory)}</span>`, actions });
  } else if (status === 'waiting') {
    setBanner({ tone: 'info', html: `Starts when <b>${esc(cmd.waitingFor)}</b> is ready: its local URL appears, its port starts listening, or it prints its ready line. Gives up after 60s.`, actions: [{ label: `Go to ${cmd.waitingFor}`, run: () => goToService(cmd.waitingFor) }] });
  } else if (status === 'offline' && cmd.blockedBy) {
    setBanner({ tone: 'error', html: `Not started: <b>${esc(cmd.blockedBy)}</b> wasn't ready.`, actions: [{ label: `Go to ${cmd.blockedBy}`, run: () => goToService(cmd.blockedBy) }] });
  } else if (status === 'starting' && cmd.restartAttempt) {
    setBanner({ tone: 'info', html: `Crashed, restarting automatically (attempt <b>${esc(cmd.restartAttempt)}</b>). Stop cancels it.` });
  } else if (status === 'crashed') {
    // The log decides the last error; fill after the log has rendered
    requestAnimationFrame(() => {
      const now = selectedCmd();
      if (!now || now.id !== cmd.id || normalizeStatus(now.status) !== 'crashed') return;
      const last = finder.lastErrorText();
      const lead = cmd.restartGaveUp ? '<b>Crashed again.</b> Auto-restart is paused so it doesn\'t loop.' : `<b>Crashed</b> with exit code ${esc(cmd.exitCode ?? '?')}.`;
      setBanner({
        tone: 'error',
        html: `${lead}${last ? ` Last error: <span class="banner-quote">${esc(last.slice(0, 160))}</span>` : ''}`,
        actions: last ? [{ label: 'Jump to error', run: () => finder.jumpToLastError() }] : [],
      });
    });
  } else {
    setBanner(null);
  }
}

// Footer: the whole machine, not one project
function renderFooter() {
  const footer = $('FooterStatusBarSummary');
  const all = visibleProjects().flatMap(p => commandsOf(p));
  if (!all.length) { footer.textContent = ''; return; }
  const counts = countByStatus(all);
  const order = [['running', 'running'], ['starting', 'starting'], ['waiting', 'waiting'], ['crashed', 'crashed'], ['offline', 'stopped']];
  const liveProjects = visibleProjects().filter(p => liveCount(commandsOf(p))).length;
  const busy = visibleProjects().filter(p => { const c = countByStatus(commandsOf(p)); return c.running + c.starting + c.waiting + c.crashed > 0; }).sort(byProjectName);
  footer.innerHTML = order
    .filter(([key]) => counts[key] > 0)
    .map(([key, word]) => `<span class="footer-stat">${statusIndicator(key)}${counts[key]} ${word}</span>`)
    .join('') + (liveProjects > 1 || busy.length > 1 ? `<span class="footer-sep" aria-hidden="true"></span>${busy.map(footerSegment).join('')}` : '');
  if (window.layout.panelOpen()) renderStackPanel();
}

function footerSegment(p) {
  const c = countByStatus(commandsOf(p));
  const starting = c.starting + c.waiting;
  const words = [c.running && `${c.running} running`, starting && `${starting} starting`, c.crashed && `${c.crashed} crashed`].filter(Boolean).join(', ');
  return `<span class="footer-seg" title="${esc(p.name)}: ${words}">${tile(p, 'sm')}<span class="sr-only">${esc(p.name)}: ${words}</span>`
    + `<span aria-hidden="true">${c.running ? `${statusIndicator('running')}${c.running} ` : ''}${starting ? `${statusIndicator('starting')}${starting} ` : ''}${c.crashed ? `${statusIndicator('crashed')}${c.crashed}` : ''}</span></span>`;
}

function renderPanelToggle() {
  const open = window.layout.panelOpen();
  const b = $('BtnStackPanel');
  b.setAttribute('aria-expanded', String(open));
  b.innerHTML = `${open ? icons.chevronDown : icons.chevronUp}<span>Everything running</span>`;
}

// Everything running, crashed, starting or waiting, across projects (the footer opened up)
function renderStackPanel() {
  const list = $('StackList');
  const items = [];
  visibleProjects().forEach(p => commandsOf(p).forEach(c => {
    const s = normalizeStatus(c.status);
    if (s !== 'offline') items.push({ p, c, s });
  }));
  const rank = { crashed: 0, waiting: 1, starting: 1, running: 2 };
  items.sort((a, b) => (rank[a.s] ?? 3) - (rank[b.s] ?? 3) || collator.compare(a.p.name, b.p.name) || collator.compare(a.c.displayName, b.c.displayName));
  $('StackCount').textContent = items.length ? String(items.length) : '';
  const focusKey = document.activeElement?.dataset?.focusKey;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div class="stack-empty">Nothing is running. Services you start in any project show up here.</div>';
    return;
  }
  items.forEach(({ p, c, s }) => {
    const active = selection?.kind === 'cmd' && selection.projectId === p.id && selection.id === c.id;
    const group = folderGroup(p, c);
    const port = portOf(c);
    const time = s === 'crashed' ? `<span class="t-error">exit ${esc(c.exitCode ?? '?')}</span>`
      : (s === 'running' && c.startedAt ? `<span data-uptime="${esc(c.startedAt)}">up ${formatUptime(c.startedAt)}</span>` : statusLabel(s).toLowerCase());
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `stack-row${active ? ' active' : ''}`;
    b.dataset.focusKey = `stack:${p.id}:${c.id}`;
    b.title = `${c.displayName} · ${p.name} · ${statusLabel(s)}\nCtrl+click to open beside`;
    if (active) b.setAttribute('aria-current', 'true');
    b.innerHTML = `${tile(p, 'sm')}<span class="nm">${statusIndicator(s)}<span>${esc(c.displayName)}</span><span class="sr-only">${statusLabel(s)}</span></span>`
      + `<span class="mono">${esc(p.name)}${group.label ? ` › ${esc(group.label)}` : ''}</span><span class="mono">${port ? `:${esc(port)}` : ''}</span><span class="mono">${time}</span><span class="mono">${c.branch ? branchHtml(c.branch, c.detached) : ''}</span>`;
    b.addEventListener('click', (e) => serviceClick(e, p.id, c.id));
    list.appendChild(b);
  });
  if (focusKey && focusKey.startsWith('stack:')) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// Uptime ticks without re-rendering anything else
setInterval(() => {
  const cmd = selectedCmd();
  const el = $('MetaUptime');
  if (el && cmd && cmd.startedAt) el.textContent = `up ${formatUptime(cmd.startedAt)}`;
  document.querySelectorAll('[data-uptime]').forEach(u => { u.textContent = `up ${formatUptime(Number(u.dataset.uptime))}`; });
}, 1000);

// ── Log stream ───────────────────────────────────────────────────
function streamKeyFor(projectId, commandId) {
  return commandId === null ? SHELL_KEY : `${projectId}:${commandId}`;
}

function currentStreamKey() {
  if (!selection) return null;
  if (selection.kind === 'shell') return SHELL_KEY;
  return streamKeyFor(selection.projectId, selection.id);
}

function isAtBottom() {
  const term = $('Terminal');
  return term.scrollHeight - term.scrollTop - term.clientHeight < 40;
}

function scrollToLatest() {
  const term = $('Terminal');
  term.scrollTop = term.scrollHeight;
  unseenLines = 0;
  $('JumpLatestBtn').hidden = true;
}

function placeholderText() {
  if (selection?.kind === 'shell') return 'Starting shell…';
  return placeholderFor(selectedCmd());
}

function placeholderFor(cmd) {
  const status = normalizeStatus(cmd?.status);
  if (status === 'running' || status === 'starting') return 'Waiting for output…';
  if (status === 'waiting') return 'Waiting for its dependency to be ready…';
  return 'No output yet. Start the service to see its logs here.';
}

function showPlaceholder() {
  $('TerminalLogs').innerHTML = `<div class="log-placeholder">${esc(placeholderText())}</div>`;
  finder.reset();
}

function timeOf(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

function lineElement(entry) {
  const div = document.createElement('div');
  const text = entry.text.replace(/\n$/, '');
  div.className = `log-line is-${entry.stream || 'stdout'}`;
  div.dataset.level = finder.detectLevel(text);
  div.innerHTML = `<span class="log-ts">${entry.ts ? timeOf(entry.ts) : ''}</span><span class="log-text">${window.ansiParser.ansiToHtml(text)}</span>`;
  return div;
}

function appendLines(entries) {
  const fresh = entries.filter(e => e.seq > renderedSeq);
  if (!fresh.length) return;
  renderedSeq = fresh[fresh.length - 1].seq;

  const logs = $('TerminalLogs');
  const term = $('Terminal');
  const follow = isAtBottom();
  logs.querySelector('.log-placeholder')?.remove();

  const els = fresh.map(lineElement);
  const frag = document.createDocumentFragment();
  els.forEach(el => frag.appendChild(el));
  logs.appendChild(frag);
  finder.added(els);

  // Cap the DOM; when reading older lines, keep the viewport anchored as the top is trimmed
  let removedHeight = 0;
  const removed = [];
  while (logs.childElementCount > MAX_DOM_LINES) {
    removedHeight += logs.firstElementChild.offsetHeight;
    removed.push(logs.firstElementChild);
    logs.firstElementChild.remove();
  }
  if (removed.length) finder.removed(removed);

  if (follow) {
    scrollToLatest();
  } else {
    term.scrollTop -= removedHeight;
    unseenLines += fresh.length;
    const btn = $('JumpLatestBtn');
    btn.innerHTML = `${icons.arrowDown}<span>${unseenLines} new line${unseenLines === 1 ? '' : 's'}</span>`;
    btn.hidden = false;
  }

  // A crash banner quotes the last error line, so refresh it when errors arrive
  if (selection?.kind === 'cmd' && els.some(el => el.dataset.level === 'error')) {
    const cmd = selectedCmd();
    if (cmd && normalizeStatus(cmd.status) === 'crashed') renderServiceBanner(selectedProject(), cmd, 'crashed');
  }
}

async function loadLogStream() {
  const key = currentStreamKey();
  if (key === renderedKey) return;
  renderedKey = key;
  renderedSeq = 0;
  unseenLines = 0;
  $('JumpLatestBtn').hidden = true;
  showPlaceholder();

  loadingQueue = [];
  const isShell = selection.kind === 'shell';
  const snapshot = await window.api.getLogs(isShell ? appState.activeProject : selection.projectId, isShell ? null : selection.id);
  if (renderedKey !== key) return; // selection changed while loading

  const queued = loadingQueue;
  loadingQueue = null;
  appendLines([...snapshot.lines, ...queued]);
  scrollToLatest();
  const cmd = selectedCmd();
  if (cmd) renderServiceBanner(selectedProject(), cmd, normalizeStatus(cmd.status));
}

$('Terminal').addEventListener('scroll', () => {
  if (isAtBottom()) {
    unseenLines = 0;
    $('JumpLatestBtn').hidden = true;
  }
});

$('JumpLatestBtn').addEventListener('click', scrollToLatest);

$('ClearLogsBtn').addEventListener('click', () => {
  if (!selection) return;
  if (selection.kind === 'shell') window.api.clearLogs(appState.activeProject, null);
  else window.api.clearLogs(selection.projectId, selection.id);
  showPlaceholder();
  scrollToLatest();
});

window.api.onTerminalLog((payload) => {
  logB.push(payload);
  const key = streamKeyFor(payload.projectId, payload.commandId);
  if (key !== renderedKey) return;
  if (loadingQueue) { loadingQueue.push(payload); return; }
  appendLines([payload]);
});

// ── Selection & actions ──────────────────────────────────────────
function select(next) {
  if (beside && next?.kind === 'cmd' && next.projectId === beside.projectId && next.id === beside.commandId) {
    if (selection?.kind === 'cmd') setBeside({ projectId: selection.projectId, commandId: selection.id });
    else closeBeside();
  }
  if (next?.kind === 'cmd') lastServiceOf.set(next.projectId, next.id);
  selection = next;
  render();
}

function selectShell() {
  $('BtnOpenCmd').click();
}

function serviceClick(e, projectId, commandId) {
  if (e.ctrlKey || e.metaKey) openBeside(projectId, commandId);
  else selectService(projectId, commandId);
}

// ── Second log ───────────────────────────────────────────────────
function besideCmd() {
  if (!beside) return null;
  return commandsOf(projectById(beside.projectId)).find(c => c.id === beside.commandId) || null;
}

function setBeside(next) {
  beside = next;
  writePref('sc.beside', next);
  if (next) logB.open(next.projectId, next.commandId);
}

function openBeside(projectId, commandId) {
  if (selection?.kind !== 'cmd') { selectService(projectId, commandId); return; }
  if (selection.projectId === projectId && selection.id === commandId) return;
  setBeside({ projectId, commandId });
  window.layout.setSplitOpen(true);
  renderPaneTitles();
  $('TerminalB').focus({ preventScroll: true });
}

function closeBeside() {
  const hadFocus = $('LogColB').contains(document.activeElement);
  beside = null;
  writePref('sc.beside', null);
  logB.close();
  window.layout.setSplitOpen(false);
  renderPaneTitles();
  if (hadFocus) $('Terminal').focus({ preventScroll: true });
}

// The services worth putting beside this one: anything running anywhere, then this project's others
function chooseBeside(anchor) {
  const items = [];
  visibleProjects().forEach(p => commandsOf(p).forEach(c => {
    if (selection?.kind === 'cmd' && selection.projectId === p.id && selection.id === c.id) return;
    const s = normalizeStatus(c.status);
    const near = selection?.projectId === p.id;
    if (s === 'offline' && !near) return;
    items.push({ p, c, s, near });
  }));
  if (!items.length) { notify('Nothing to open beside', 'Start a service in another project, or add a second service to this one.'); return; }
  const rank = { crashed: 0, running: 1, starting: 1, waiting: 1, offline: 2 };
  items.sort((a, b) => rank[a.s] - rank[b.s] || (b.near ? 1 : 0) - (a.near ? 1 : 0) || collator.compare(a.c.displayName, b.c.displayName));
  openMenu(anchor, items.slice(0, 12).map(({ p, c, s }) => ({
    label: c.displayName,
    hint: `${p.name}${s === 'offline' ? '' : ` · ${statusLabel(s).toLowerCase()}`}`,
    action: () => openBeside(p.id, c.id),
  })), 'Open another log beside');
}

function paneTitleHtml(p, c, second) {
  const s = normalizeStatus(c.status);
  const port = portOf(c);
  const meta = [
    port ? `<span>:${esc(port)}</span>` : '',
    s === 'running' && c.startedAt ? `<span data-uptime="${esc(c.startedAt)}">up ${formatUptime(c.startedAt)}</span>` : '',
    s === 'crashed' ? `<span class="t-error">exit ${esc(c.exitCode ?? '?')}</span>` : '',
  ].filter(Boolean).join('');
  const actions = second
    ? `<button type="button" class="tree-act" data-act="swap" aria-label="Show ${esc(c.displayName)} in the main view" title="Show in the main view">${icons.swap}</button><button type="button" class="tree-act" data-act="close" aria-label="Close the second log" title="Close">${icons.close}</button>`
    : '';
  return `${tile(p, 'sm')}<b${second ? ' id="PaneNameB"' : ''} title="${esc(`${c.displayName} · ${p.name}`)}">${esc(c.displayName)}</b>${statusIndicator(s)}<span class="sr-only">${statusLabel(s)}, ${esc(p.name)}</span><span class="pane-meta">${meta}</span>${actions}`;
}

function renderPaneTitles() {
  const cmdB = besideCmd();
  if (beside && appState && (!cmdB || projectById(beside.projectId)?.archived)) { closeBeside(); return; } // its service is gone
  const primary = selection?.kind === 'cmd' ? selectedCmd() : null;
  if (cmdB && primary && selection.projectId === beside.projectId && selection.id === beside.commandId) { closeBeside(); return; }
  const open = !!cmdB && !$('LogSplit').hidden;
  window.layout.setSplitOpen(open);
  $('PaneTitleA').hidden = !open;
  if (!open) return;
  const pa = selectedProject();
  $('PaneTitleA').className = `pane-title${primary ? ` ${window.identity.colourClass(pa)}` : ''}`;
  $('PaneTitleA').innerHTML = primary ? paneTitleHtml(pa, primary, false) : `<b>Shell</b>`;
  const pb = projectById(beside.projectId);
  $('PaneTitleB').className = `pane-title ${window.identity.colourClass(pb)}`;
  const focused = $('PaneTitleB').contains(document.activeElement) ? document.activeElement.dataset.act : null;
  $('PaneTitleB').innerHTML = paneTitleHtml(pb, cmdB, true);
  $('PaneTitleB').querySelector('[data-act="swap"]').addEventListener('click', () => selectService(beside.projectId, beside.commandId));
  $('PaneTitleB').querySelector('[data-act="close"]').addEventListener('click', closeBeside);
  if (focused) $('PaneTitleB').querySelector(`[data-act="${focused}"]`)?.focus();
  if (logB.key !== `${beside.projectId}:${beside.commandId}`) logB.open(beside.projectId, beside.commandId);
  else logB.refreshPlaceholder();
}

// Drag a service row onto the log to open it beside
const DRAG_TYPE = 'application/x-stackconsole-service';
function startServiceDrag(e, projectId, commandId) {
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ projectId, commandId }));
  e.dataTransfer.effectAllowed = 'copy';
  if (selection?.kind === 'cmd' && !$('LogSplit').hidden) $('DropHint').hidden = false;
}
function hideDropHint() {
  $('DropHint').hidden = true;
  $('DropHint').classList.remove('is-over');
}
$('LogSplit').addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(DRAG_TYPE) || selection?.kind !== 'cmd') return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  $('DropHint').hidden = false;
  $('DropHint').classList.add('is-over');
});
$('LogSplit').addEventListener('dragleave', (e) => {
  if (!$('LogSplit').contains(e.relatedTarget)) $('DropHint').classList.remove('is-over');
});
$('LogSplit').addEventListener('drop', (e) => {
  const raw = e.dataTransfer.getData(DRAG_TYPE);
  hideDropHint();
  if (!raw) return;
  e.preventDefault();
  try { const t = JSON.parse(raw); openBeside(t.projectId, t.commandId); } catch {}
});
document.addEventListener('dragend', hideDropHint);

// Selecting a service also makes its project the active one, so Add/Edit/Import windows follow
function selectService(projectId, commandId) {
  expandProject(projectId);
  select({ kind: 'cmd', projectId, id: commandId });
  if (appState && appState.activeProject !== projectId) window.api.setActiveProject(projectId);
}

function runAction(fn) {
  const cmd = selectedCmd();
  if (!cmd) return;
  pendingAction = setTimeout(() => { pendingAction = null; render(); }, 5000);
  ['BtnStart', 'BtnStartNow', 'BtnRestart', 'BtnStop'].forEach(id => { $(id).disabled = true; });
  fn(target(cmd));
}

// Start checks the configured port first, so a leftover process gets named instead of a crash
async function startWithPortCheck() {
  const cmd = selectedCmd();
  if (!cmd) return;
  let check = { checked: false };
  try { check = (await window.api.checkPort(target(cmd))) || check; } catch {}
  if (!check.checked || !check.inUse) return runAction(t => window.api.startCommand(t));

  if (check.owner) {
    const elsewhere = check.owner.projectId && check.owner.projectId !== selection.projectId;
    const ownerName = `${check.owner.name}${elsewhere ? ` (${check.owner.projectName})` : ''}`;
    const choice = await confirmDialog({
      title: `Port ${check.port} is used by ${ownerName}`,
      body: `Another StackConsole service already runs on :${check.port}. Change this command's port, or stop the other service first.`,
      actions: [
        { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
        { label: `Go to ${check.owner.name}`, value: 'goto', variant: 'secondary' },
        { label: 'Start anyway', value: 'start', variant: 'primary' },
      ],
    });
    if (choice === 'goto') selectService(check.owner.projectId || selection.projectId, check.owner.id);
    if (choice === 'start') runAction(t => window.api.startCommand(t));
    return;
  }

  const choice = await confirmDialog({
    title: `Port ${check.port} is already in use`,
    body: `${check.name || 'Another program'} (pid ${check.pid}) is listening on :${check.port}. StackConsole didn't start it, so it's probably left over from an earlier session. Stopping it ends that program.`,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Start anyway', value: 'start', variant: 'secondary' },
      { label: `Stop ${check.name || 'it'} and start`, value: 'kill', variant: 'danger-solid' },
    ],
  });
  if (choice === 'start') runAction(t => window.api.startCommand(t));
  if (choice === 'kill') {
    const res = await window.api.freePort(check.pid);
    if (!res.ok) {
      await notify('Couldn\'t stop that process', res.error || 'Try again.');
      return;
    }
    runAction(t => window.api.startCommand(t));
  }
}

$('BtnStart').addEventListener('click', startWithPortCheck);
$('BtnStartNow').addEventListener('click', () => runAction(t => window.api.startCommandNow(t)));
$('BtnStop').addEventListener('click', () => runAction(t => window.api.stopCommand(t)));
$('BtnRestart').addEventListener('click', () => runAction(t => window.api.restartCommand(t)));

$('BtnOpenCmd').addEventListener('click', () => {
  window.api.openCommandPrompt();
  select({ kind: 'shell' });
  $('TerminalInput').focus();
});

$('TriggerStopAll').addEventListener('click', async () => {
  const liveByProject = projects().map(p => ({ p, n: liveCount(commandsOf(p)) })).filter(x => x.n);
  const live = liveByProject.reduce((n, x) => n + x.n, 0);
  if (!live) return;
  const where = liveByProject.length === 1 ? `in ${liveByProject[0].p.name}` : `across ${liveByProject.length} projects (${liveByProject.map(x => x.p.name).join(', ')})`;
  const choice = await confirmDialog({
    title: 'Stop everything?',
    body: `${live === 1 ? '1 service is' : `${live} services are`} running or starting ${where} and will be stopped. Their logs stay available.`,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Stop everything', value: 'stop', variant: 'danger-solid' },
    ],
  });
  if (choice === 'stop') window.api.stopEverything();
});

// Tree keyboard: ↑/↓ move between rows (a service is selected as you land on it, a repo's Set up is
// only focused), → expands and ← collapses a row, ← on a closed row or a service goes to its parent.
$('ProcessWrapperList').addEventListener('keydown', (e) => {
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tree = $('ProcessWrapperList');
  const rows = [...tree.querySelectorAll('.tree-toggle, .svc-row, .repo-setup')];
  const current = document.activeElement;
  const i = rows.indexOf(current);
  if (i === -1) return;
  e.preventDefault();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = rows[e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)];
    next.focus();
    if (next.classList.contains('svc-row')) next.click();
    return;
  }
  const parentToggle = (el) => el.closest('.tree-project, .tree-section')?.parentElement?.closest('.tree-project, .tree-section')?.querySelector(':scope > .tree-head > .tree-toggle, :scope > .tree-toggle');
  if (current.classList.contains('tree-toggle')) {
    const open = current.getAttribute('aria-expanded') === 'true';
    if ((e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) current.click();
    else if (e.key === 'ArrowLeft') parentToggle(current)?.focus();
  } else if (e.key === 'ArrowLeft') {
    current.closest('.tree-project, .tree-section')?.querySelector('.tree-toggle')?.focus();
  }
});

// A crash notification was clicked: show that service, in whichever project it is
window.api.onSelectCommand(({ projectId, commandId }) => {
  if (projectById(projectId)) selectService(projectId, commandId);
});

// ── Shell input ──────────────────────────────────────────────────
const shellHistory = [];
let historyIndex = -1;

$('TerminalInput').addEventListener('keydown', (e) => {
  const input = e.currentTarget;
  if (e.key === 'Enter') {
    const rawCommand = input.value.trim();
    if (!rawCommand || selection?.kind !== 'shell') return;
    window.api.sendTerminalInput({ projectId: appState?.activeProject || null, commandId: null, text: rawCommand });
    shellHistory.unshift(rawCommand);
    historyIndex = -1;
    input.value = '';
    scrollToLatest();
  } else if (e.key === 'ArrowUp' && shellHistory.length) {
    e.preventDefault();
    historyIndex = Math.min(historyIndex + 1, shellHistory.length - 1);
    input.value = shellHistory[historyIndex];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    historyIndex = Math.max(historyIndex - 1, -1);
    input.value = historyIndex === -1 ? '' : shellHistory[historyIndex];
  }
});

// ── Exit confirmation ────────────────────────────────────────────
$('WinBtnClose').addEventListener('click', async () => {
  const live = projects().reduce((n, p) => n + liveCount(commandsOf(p)), 0);
  const choice = await confirmDialog({
    title: 'Quit StackConsole?',
    body: live
      ? `${live} service${live === 1 ? ' is' : 's are'} still running. Quitting stops ${live === 1 ? 'it' : 'them'} and any open shell. Minimize to tray to keep ${live === 1 ? 'it' : 'them'} running.`
      : 'Quitting closes any open shell. Minimize to tray to keep StackConsole in the background.',
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary' },
      { label: 'Minimize to tray', value: 'tray', variant: 'secondary', autofocus: true },
      { label: live ? 'Stop all & quit' : 'Quit', value: 'quit', variant: 'danger-solid' },
    ],
  });
  if (choice === 'tray') window.api.minimizeToTray();
  if (choice === 'quit') window.api.confirmAppExit();
});

// ── Data flow ────────────────────────────────────────────────────
window.api.onDataUpdate((updatedData) => {
  if (appState && updatedData.activeProject !== appState.activeProject) importProbe = { projectId: null, count: 0 };
  // A project that just got commands (e.g. after an import) re-probes next time it's empty
  if (!commandsOf(updatedData.projects?.find(p => p.id === updatedData.activeProject)).length) importProbe = { projectId: null, count: 0 };
  appState = updatedData;
  if (pendingAction) { clearTimeout(pendingAction); pendingAction = null; }
  render();
});

async function initializeConsole() {
  appState = await window.api.getStore();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeConsole);
} else {
  initializeConsole();
}
