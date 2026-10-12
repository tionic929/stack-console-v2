// Configure V8 Engine flags BEFORE app lifecycle initialization to optimize memory allocations
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, execFileSync } = require('child_process');
const { buildCommandEnv, describeEnv } = require('./main/env');
const { findListener, killPid } = require('./main/ports');
const { scanProjectTree } = require('./main/importer');
const { branchInfo, anyBranchChanged, forgetFolders } = require('./main/git');
const { isDir, commandFolder, relinkCandidate, openFolder } = require('./main/folders');
const { key: folderKey, contains: folderContains, forgetPaths, createRootScanner, buildWorkspace, suggestRoot, checkOverlap } = require('./main/roots');
const { splitPlan, applySplit, combinePlan, applyCombine, combineCandidates, uniqueId } = require('./main/regroup');
const { identities, validate: validateIdentity } = require('./main/identity');

// Force V8 JavaScript runtime engine to aggressively garbage collect heap allocations
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1 --max-old-space-size=32 --optimize-for-size');
// Disable heavy, unused browser subsystem caches to reclaim memory footprint
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('audio-buffer-size', '4096');
// Memory optimizations: disable GPU and disk cache for this text-heavy app
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-disk-cache');
app.commandLine.appendSwitch('disable-background-networking');

// One StackConsole at a time: a second launch focuses the first instead of running a second engine
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

let mainWindow = null;
let addCommandWindow = null;
let editCommandWindow = null;
let addNewProjectWindow = null;
let projectManagerWindow = null;
let editProjectNameWindow = null;
let importCommandsWindow = null;
let isQuittingFromModal = false;
let tray = null;
let hasBeenShown = false;

const defaultSchema = { activeProject: "", projects: [] };

function getDbPath() {
  const base = app.isPackaged ? app.getPath('userData') : __dirname;
  return path.join(base, 'data/projects.json');
}

function ensureDbDir() {
  const dir = path.dirname(getDbPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getAssetPath(relativePath) {
  if (app.isPackaged) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', relativePath);
    if (fs.existsSync(unpacked)) return unpacked;
    return path.join(process.resourcesPath, relativePath);
  }
  return path.join(__dirname, relativePath);
}

// The interpreter that runs services/stream_worker.py. The installer ships its own (resources/python), so users
// don't need Python installed. Dev runs use vendor/python when `npm run fetch-python` has run, else Python on PATH.
let pythonCommand = null;

function resolvePython() {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'python.exe')
    : path.join(__dirname, 'vendor', 'python', 'python.exe');
  for (const candidate of [bundled, 'python', 'python3']) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe', windowsHide: true });
      return candidate;
    } catch {}
  }
  return null;
}

// Spawns the stream worker. -u keeps its output unbuffered even where PYTHONUNBUFFERED is ignored (embedded Python).
function spawnWorker(args, options) {
  return spawn(pythonCommand, ['-u', getAssetPath('services/stream_worker.py'), ...args], options);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ── Runtime state ────────────────────────────────────────────────
// projects.json holds configuration only. Everything that changes while
// processes run (status, pid, logs, detected URL) lives in memory here, so
// log output never touches the disk and a stale renderer can't overwrite it.
const activeProcesses = new Map();   // key -> python worker child
const pendingStarts = new Map();     // key -> startup-delay / restart timeout
const waiters = new Map();           // key -> { depKey, depName, timer }  (start order)
const restartHistory = new Map();    // key -> attempts in the current crash loop
const readyPatterns = new Map();     // key -> lowercased "ready" log line for the current run
const runtime = new Map();           // key -> { status, pid, startedAt, url, detectedPort, exitCode, ... }
const logStore = new Map();          // key -> { seq, lines: [{ seq, ts, stream, text }] }
const activeWorkers = new Map();     // global shell worker(s)

const MAX_LOG_LINES = 5000;
const SHELL_KEY = '__shell__';
const WAIT_TIMEOUT_MS = 60000;
const STABLE_RUN_MS = 60000;         // a run this long resets the crash-loop counter
const RUNTIME_FIELDS = ['status', 'pid', 'logs', 'startedAt', 'url', 'detectedPort', 'exitCode', 'ready', 'waitingFor', 'blockedBy', 'restartAttempt', 'restartGaveUp', 'envSummary', 'folder', 'folderMissing', 'branch', 'detached', 'repoRoot'];
// Derived per project for the windows (folder health, git branch, relink suggestion); never saved
const APP_ID = 'com.stack.console'; // = build.appId in package.json
const PROJECT_DERIVED_FIELDS = ['folderMissing', 'branch', 'detached', 'repoRoot', 'relinkTo', 'identity'];
const LOCAL_URL_PATTERN = /(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;
const ANSI_PATTERN = /\x1B\[[0-9;?]*[a-zA-Z]/g;

function procKey(projectId, commandId) {
  return `${projectId}:${commandId}`;
}

function splitKey(key) {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

function getRuntime(projectId, commandId) {
  return runtime.get(procKey(projectId, commandId)) || { status: 'offline', pid: null };
}

function setRuntime(projectId, commandId, patch) {
  const key = procKey(projectId, commandId);
  runtime.set(key, { ...getRuntime(projectId, commandId), ...patch });
  broadcastState();
}

// ── Secrets (env values marked secret) ───────────────────────────
function secretsEncrypted() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function decryptSecret(entry) {
  if (entry.enc) {
    try { return safeStorage.decryptString(Buffer.from(entry.enc, 'base64')); } catch { return null; }
  }
  return typeof entry.value === 'string' ? entry.value : null;
}

// Renderer → disk: encrypt new secret values; keep the stored one when the form left it untouched.
function sealSecrets(data, previous) {
  const prevCmd = (pId, cId) => previous?.projects?.find(p => p.id === pId)?.commands?.find(c => c.id === cId);
  (data.projects || []).forEach(p => (p.commands || []).forEach(c => {
    if (!Array.isArray(c.env)) return;
    const old = prevCmd(p.id, c.id);
    c.env = c.env.filter(e => e && e.key).map(e => {
      if (!e.secret) return { key: e.key, value: String(e.value ?? '') };
      if (typeof e.value === 'string' && e.value !== '') {
        return secretsEncrypted()
          ? { key: e.key, secret: true, enc: safeStorage.encryptString(e.value).toString('base64') }
          : { key: e.key, secret: true, value: e.value };
      }
      const kept = (old?.env || []).find(o => o.secret && o.key === e.key);
      return kept ? { key: e.key, secret: true, ...(kept.enc ? { enc: kept.enc } : { value: kept.value }) } : { key: e.key, secret: true };
    });
  }));
  return data;
}

function stripRuntime(data) {
  const copy = JSON.parse(JSON.stringify(data || defaultSchema));
  delete copy.activeCommandToEdit;
  delete copy.secretsEncrypted;
  delete copy.workspace;
  (copy.projects || []).forEach(p => {
    PROJECT_DERIVED_FIELDS.forEach(f => delete p[f]);
    (p.commands || []).forEach(c => {
      RUNTIME_FIELDS.forEach(f => delete c[f]);
    });
  });
  return copy;
}

// Folder health and git branch for a project and each command (where it actually runs from).
function folderInfo(project, allFolders) {
  const derived = {};
  if (project.baseDirectory) {
    const exists = isDir(project.baseDirectory);
    derived.folderMissing = !exists;
    if (exists) {
      const git = branchInfo(project.baseDirectory);
      if (git) Object.assign(derived, { branch: git.branch, detached: git.detached, repoRoot: git.root });
    } else {
      derived.relinkTo = relinkCandidate(project.baseDirectory, allFolders);
    }
  }
  return derived;
}

function commandFolderInfo(project, cmd) {
  const folder = commandFolder(project, cmd);
  if (!folder) return { folder: null };
  if (!isDir(folder)) return { folder, folderMissing: true };
  const git = branchInfo(folder);
  return { folder, folderMissing: false, ...(git ? { branch: git.branch, detached: git.detached, repoRoot: git.root } : {}) };
}

// Disk → renderer: merge runtime, and never send secret values (plain or encrypted) to a window.
function withRuntime(data, placement = {}) {
  const copy = stripRuntime(data);
  const allFolders = (copy.projects || []).map(p => p.baseDirectory).filter(Boolean);
  (copy.projects || []).forEach(p => {
    Object.assign(p, folderInfo(p, allFolders));
    (p.commands || []).forEach(c => {
      if (Array.isArray(c.env)) {
        c.env = c.env.map(e => (e.secret ? { key: e.key, secret: true, hasValue: !!(e.enc || e.value) } : e));
      }
      Object.assign(c, commandFolderInfo(p, c), getRuntime(p.id, c.id));
    });
  });
  // Colour + icon per project (automatic unless chosen); projects listed together never share a colour
  const groupOf = (p) => {
    const pl = placement[p.id];
    if (!pl) return p.baseDirectory ? path.dirname(folderKey(p.baseDirectory)) : '(no folder)';
    if (pl.section === 'root') return `root:${folderKey(pl.container ? pl.container.path : pl.root)}`;
    return pl.section;
  };
  const ids = identities(copy.projects || [], groupOf);
  (copy.projects || []).forEach(p => { p.identity = ids[p.id]; });
  copy.secretsEncrypted = secretsEncrypted();
  return copy;
}

function readDatabase() {
  try {
    ensureDbDir();
    if(!fs.existsSync(getDbPath())) {
      fs.writeFileSync(getDbPath(), JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return JSON.parse(JSON.stringify(defaultSchema));
    }

    const rawData = fs.readFileSync(getDbPath(), 'utf8').trim();
    if(!rawData) {
      fs.writeFileSync(getDbPath(), JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return JSON.parse(JSON.stringify(defaultSchema));
    }
    return JSON.parse(rawData);
  } catch (err) {
    console.error("Database reading error, resolving empty context:", err);
    try {
      fs.writeFileSync(getDbPath(), JSON.stringify(defaultSchema, null, 2), 'utf-8');
    }
    catch (writeErr) {
      console.error("Critical fallback write disk exception:", writeErr);
    }
    return JSON.parse(JSON.stringify(defaultSchema));
  }
}

// The edit-command window needs to know which command it opens; keep it in memory, not on disk.
let activeCommandToEdit = null;

function writeDatabase(data) {
  try {
    ensureDbDir();
    if (data && data.activeCommandToEdit) activeCommandToEdit = data.activeCommandToEdit;
    fs.writeFileSync(getDbPath(), JSON.stringify(stripRuntime(data), null, 2), 'utf8');
    broadcastState();
    return true;
  } catch (err) {
    console.error("[Main Process] Database save exception directly during fs.writeFileSync:", err);
    throw err;
  }
}

function getState() {
  const db = readDatabase();
  const workspace = workspaceFor(db);
  const state = withRuntime(db, workspace.placement);
  if (activeCommandToEdit) state.activeCommandToEdit = activeCommandToEdit;
  state.workspace = workspace;
  return state;
}

// ── Master folders (D:\projects) ─────────────────────────────────
// The list lives in projects.json (projectRoots); the scan of each folder and where every project
// sits are derived here on each read and sent with the state, never saved.
const rootScanner = createRootScanner({ onChange: () => broadcastState() });
const rootPaths = (db) => (db.projectRoots || []).filter(r => r && typeof r.path === 'string' && r.path).map(r => r.path);

let suggestionMemo = { sig: null, value: null };
function rootSuggestion(db) {
  const sig = (db.projects || []).map(p => p.baseDirectory || '').join('|');
  if (suggestionMemo.sig !== sig) suggestionMemo = { sig, value: suggestRoot(db.projects || []) };
  return suggestionMemo.value;
}

function workspaceFor(db) {
  const paths = rootPaths(db);
  rootScanner.sync(paths);
  const ws = buildWorkspace(db, rootScanner);
  ws.roots.forEach(r => { if (!r.exists) r.relinkTo = relinkCandidate(r.path, []); });
  ws.prompt = !paths.length && !db.rootsPromptDismissed ? { suggestion: rootSuggestion(db) } : null;
  return ws;
}

const isLiveStatus = (s) => ['running', 'starting', 'waiting'].includes(s);
const projectLive = (p) => (p.commands || []).some(c => isLiveStatus(getRuntime(p.id, c.id).status));

// Logs and last status follow a command that moves to another project (split / combine)
function moveRuntimeKeys(pairs) {
  pairs.forEach(([from, to]) => {
    if (from === to) return;
    if (logStore.has(from)) { logStore.set(to, logStore.get(from)); logStore.delete(from); }
    if (runtime.has(from)) { runtime.set(to, runtime.get(from)); runtime.delete(from); }
    restartHistory.delete(from);
  });
}

function broadcastState() {
  const payload = getState();
  [mainWindow, addCommandWindow, editCommandWindow, addNewProjectWindow, projectManagerWindow, editProjectNameWindow, importCommandsWindow]
    .forEach(win => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('db-refreshed', payload);
    });
  updateTrayMenu(payload);
}

function findCommand(db, projectId, commandId) {
  const project = (db.projects || []).find(p => p.id === projectId);
  const cmd = (project?.commands || []).find(c => c.id === commandId);
  return { project, cmd };
}

// ── Logs ─────────────────────────────────────────────────────────
function appendLog(projectId, commandId, text, stream = 'stdout') {
  if (!text) return;
  const key = commandId === null ? SHELL_KEY : procKey(projectId, commandId);
  if (!logStore.has(key)) logStore.set(key, { seq: 0, lines: [] });
  const store = logStore.get(key);

  const entry = { seq: ++store.seq, ts: Date.now(), stream, text };
  store.lines.push(entry);
  if (store.lines.length > MAX_LOG_LINES) store.lines.splice(0, store.lines.length - MAX_LOG_LINES);

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('terminal-log', { projectId, commandId, ...entry });
  }

  if (commandId !== null && stream !== 'system') detectReady(projectId, commandId, text);
}

// "Ready" = the service printed its local URL (Vite "Local: http://localhost:5173",
// artisan "[http://127.0.0.1:8000]", uvicorn "http://127.0.0.1:8001"), or the
// command's own ready line. Port tracking and start order both build on it.
function detectReady(projectId, commandId, text) {
  const rt = getRuntime(projectId, commandId);
  if (rt.status !== 'running' && rt.status !== 'starting') return;
  if (rt.url && rt.ready) return;
  const plain = text.replace(ANSI_PATTERN, '');
  const patch = {};

  if (!rt.url) {
    const match = plain.match(LOCAL_URL_PATTERN);
    if (match) {
      const host = match[2] === '0.0.0.0' ? 'localhost' : match[2];
      patch.url = `${match[1].toLowerCase()}://${host}:${match[3]}`;
      patch.detectedPort = match[3];
    }
  }
  const pattern = readyPatterns.get(procKey(projectId, commandId));
  if (!rt.ready && (pattern ? plain.toLowerCase().includes(pattern) : !!(patch.url || rt.url))) {
    patch.ready = true;
  }
  if (!Object.keys(patch).length) return;
  setRuntime(projectId, commandId, patch);
  if (patch.ready) releaseWaiters(projectId, commandId);
}

// ── Tray & notifications ─────────────────────────────────────────
const TRAY_STATUS = { running: '🟢', starting: '🟡', waiting: '⏳', crashed: '🔴', offline: '⚫' };

function updateTrayMenu(appState) {
  if (!tray) return;

  // Every project with something running, starting, waiting or crashed: nothing is hidden by "active project"
  const menuItems = [];
  const notable = (c) => ['running', 'starting', 'waiting', 'crashed'].includes(c.status);
  let live = 0;
  (appState?.projects || []).forEach(project => {
    const shown = (project.commands || []).filter(notable);
    if (!shown.length) return;
    menuItems.push({ label: project.name, enabled: false });
    shown.forEach(cmd => {
      if (cmd.status !== 'crashed') live++;
      const port = cmd.detectedPort || cmd.port;
      menuItems.push({ label: `   ${TRAY_STATUS[cmd.status] || TRAY_STATUS.offline} ${cmd.displayName}${port ? ` (:${port})` : ''}`, enabled: false });
    });
    menuItems.push({ type: 'separator' });
  });
  if (!menuItems.length) menuItems.push({ label: 'Nothing running', enabled: false }, { type: 'separator' });

  menuItems.push(
    { label: 'Show App', click: () => showMainWindow() },
    ...(live ? [{ label: `Stop everything (${live})`, click: () => stopAllEverywhere() }] : []),
    { label: 'Quit', click: () => { handleCleanExitSequence(); } }
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

// Only when you're not already looking at StackConsole. Never includes log text (it can hold secrets).
function notifyCrash(projectId, cmd, body) {
  if (cmd.notify === false) return;
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return;
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: `${cmd.displayName} crashed`, body, icon: path.join(__dirname, 'src/assets/logo/stacklogo-x256.ico') });
    // Electron may (re)write its shortcut for this notification, sometimes just after it shows
    n.on('show', () => [0, 2000, 10000].forEach(ms => setTimeout(claimDevShortcut, ms)));
    n.on('click', () => {
      showMainWindow();
      if (mainWindow) mainWindow.webContents.send('select-command', { projectId, commandId: cmd.id });
    });
    n.show();
  } catch (e) {}
}

// ── Process engine ───────────────────────────────────────────────
// Parses the newline-delimited JSON the python stream worker prints.
function attachWorkerOutput(child, onPayload, onRawLine) {
  let dynamicBuffer = "";
  child.stdout.on('data', (data) => {
    dynamicBuffer += data.toString();
    const lines = dynamicBuffer.split('\n');
    dynamicBuffer = lines.pop();

    lines.forEach(line => {
      if (!line.trim()) return;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (e) {
        onRawLine(line + '\n');
        return;
      }
      onPayload(payload);
    });
  });
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (err) {}
  }
}

// The service ended on its own (not via Stop). Non-zero exits are crashes;
// commands set to "Restart automatically" get a few tries with a growing delay.
function markExited(projectId, commandId, child, code, reason) {
  const key = procKey(projectId, commandId);
  if (activeProcesses.get(key) !== child) return; // already stopped by the user
  activeProcesses.delete(key);
  const startedAt = getRuntime(projectId, commandId).startedAt;

  const crashed = reason !== undefined || code !== 0;
  if (reason) appendLog(projectId, commandId, `\n[error] ${reason}\n`, 'system');
  else if (crashed) appendLog(projectId, commandId, `\n[error] Process exited with code ${code}\n`, 'system');
  else appendLog(projectId, commandId, `\n[info] Process exited with code 0\n`, 'system');

  setRuntime(projectId, commandId, {
    status: crashed ? 'crashed' : 'offline',
    pid: null, startedAt: null, url: null, detectedPort: null, ready: false,
    exitCode: crashed ? (code ?? null) : null,
  });
  blockWaiters(projectId, commandId, crashed ? 'crashed' : 'stopped');
  if (crashed) handleCrashPolicy(projectId, commandId, code, startedAt);
}

function handleCrashPolicy(projectId, commandId, code, startedAt) {
  const key = procKey(projectId, commandId);
  const { cmd } = findCommand(readDatabase(), projectId, commandId);
  if (!cmd) return;
  const exitText = code === null || code === undefined ? 'it stopped unexpectedly' : `exit code ${code}`;

  if (cmd.onCrash !== 'restart') {
    notifyCrash(projectId, cmd, `It stopped with ${exitText}.`);
    return;
  }

  const limit = Math.max(1, Math.min(10, parseInt(cmd.restartLimit, 10) || 3));
  if (startedAt && Date.now() - startedAt > STABLE_RUN_MS) restartHistory.delete(key);
  const attempt = (restartHistory.get(key) || 0) + 1;

  if (attempt > limit) {
    restartHistory.delete(key);
    appendLog(projectId, commandId, `[system] Auto-restart paused after ${limit} attempts\n`, 'system');
    setRuntime(projectId, commandId, { restartGaveUp: true, restartAttempt: null });
    notifyCrash(projectId, cmd, `Crashed ${limit} times in a row (${exitText}). Auto-restart is paused.`);
    return;
  }

  restartHistory.set(key, attempt);
  const delay = Math.min(30, 2 ** attempt);
  appendLog(projectId, commandId, `[system] Restarting in ${delay}s (attempt ${attempt} of ${limit})\n`, 'system');
  setRuntime(projectId, commandId, { status: 'starting', restartAttempt: attempt, restartGaveUp: false });
  notifyCrash(projectId, cmd, `It stopped with ${exitText}. Restarting in ${delay}s (${attempt} of ${limit}).`);

  pendingStarts.set(key, setTimeout(() => {
    pendingStarts.delete(key);
    executionEngineStart(projectId, commandId, { force: true, isRestart: true });
  }, delay * 1000));
}

// ── Start order ──────────────────────────────────────────────────
function releaseWaiters(projectId, commandId) {
  const depKey = procKey(projectId, commandId);
  [...waiters.entries()].filter(([, w]) => w.depKey === depKey).forEach(([key, w]) => {
    clearTimeout(w.timer);
    waiters.delete(key);
    const [pId, cId] = splitKey(key);
    appendLog(pId, cId, `[system] ${w.depName} is ready, starting\n`, 'system');
    executionEngineStart(pId, cId, { force: true });
  });
}

function blockWaiters(projectId, commandId, how) {
  const depKey = procKey(projectId, commandId);
  [...waiters.entries()].filter(([, w]) => w.depKey === depKey).forEach(([key, w]) => {
    clearTimeout(w.timer);
    waiters.delete(key);
    const [pId, cId] = splitKey(key);
    appendLog(pId, cId, `\n[error] Not started: ${w.depName} ${how} before it was ready\n`, 'system');
    setRuntime(pId, cId, { status: 'offline', waitingFor: null, blockedBy: w.depName });
    blockWaiters(pId, cId, 'was not started'); // anything waiting on this one is blocked too
  });
}

// Ready by port: a dependency that never prints a URL (MySQL, Redis…) counts as ready once its
// configured port is listening. Polled once a second, and only while something waits on it.
// An explicit ready line wins over this. Known limit: a port already held by another program
// looks "ready" too; the dependency then crashes on EADDRINUSE and its waiters are blocked.
const readyPolls = new Map();        // depKey -> interval

function stopReadyPoll(key) {
  if (!readyPolls.has(key)) return;
  clearInterval(readyPolls.get(key));
  readyPolls.delete(key);
}

function ensureReadyPoll(projectId, commandId) {
  const key = procKey(projectId, commandId);
  if (readyPolls.has(key)) return;
  const { cmd } = findCommand(readDatabase(), projectId, commandId);
  const port = cmd ? String(cmd.port || '').trim() : '';
  if (!/^\d+$/.test(port) || (cmd.readyPattern || '').trim()) return;

  let busy = false;
  readyPolls.set(key, setInterval(async () => {
    const rt = getRuntime(projectId, commandId);
    const wanted = [...waiters.values()].some(w => w.depKey === key);
    if (rt.ready || !wanted || !['running', 'starting'].includes(rt.status)) { stopReadyPoll(key); return; }
    if (rt.status !== 'running' || busy) return; // the process isn't up yet
    busy = true;
    try {
      const listener = await findListener(port);
      const now = getRuntime(projectId, commandId);
      if (listener && !now.ready && now.status === 'running') {
        stopReadyPoll(key);
        appendLog(projectId, commandId, `[system] Port ${port} is listening, ready\n`, 'system');
        setRuntime(projectId, commandId, { ready: true });
        releaseWaiters(projectId, commandId);
      }
    } finally {
      busy = false;
    }
  }, 1000));
}

// Would `commandId` waiting on `depId` close a loop? Follows the startAfter chain.
function createsCycle(project, commandId, depId) {
  const seen = new Set([commandId]);
  let current = depId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = (project.commands || []).find(c => c.id === current)?.startAfter || null;
  }
  return false;
}

function executionEngineStart(projectId, commandId, { force = false, isRestart = false, chain = new Set() } = {}) {
  const db = readDatabase();
  const { project, cmd: cmdConfig } = findCommand(db, projectId, commandId);
  if (!project || !cmdConfig) return;

  const processKey = procKey(project.id, cmdConfig.id);
  const status = getRuntime(project.id, cmdConfig.id).status;
  if (activeProcesses.has(processKey) || pendingStarts.has(processKey)) return;
  if (!isRestart && (status === 'running' || status === 'starting')) return;
  if (!force && waiters.has(processKey)) return;
  if (!isRestart) restartHistory.delete(processKey);

  // Start order: wait for the dependency to be ready (and start it if it isn't running)
  const dep = cmdConfig.startAfter && !force ? (project.commands || []).find(c => c.id === cmdConfig.startAfter) : null;
  if (dep && createsCycle(project, cmdConfig.id, dep.id)) {
    appendLog(project.id, cmdConfig.id, `\n[info] Start order ignored: ${cmdConfig.displayName} and ${dep.displayName} wait for each other. Starting right away.\n`, 'system');
  } else if (dep) {
    const depRt = getRuntime(project.id, dep.id);
    if (!depRt.ready) {
      chain.add(processKey);
      // Register the wait first: a dependency that fails immediately must find (and block) this waiter
      const timer = setTimeout(() => {
        if (!waiters.has(processKey)) return;
        waiters.delete(processKey);
        appendLog(project.id, cmdConfig.id, `\n[error] Gave up waiting for ${dep.displayName} after ${WAIT_TIMEOUT_MS / 1000}s. If it never prints a local URL, give it a port or a "ready" log line.\n`, 'system');
        setRuntime(project.id, cmdConfig.id, { status: 'offline', waitingFor: null, blockedBy: dep.displayName });
      }, WAIT_TIMEOUT_MS);
      waiters.set(processKey, { depKey: procKey(project.id, dep.id), depName: dep.displayName, timer });
      appendLog(project.id, cmdConfig.id, `\n[system] Waiting for ${dep.displayName} to be ready\n`, 'system');
      setRuntime(project.id, cmdConfig.id, { status: 'waiting', waitingFor: dep.displayName, blockedBy: null, exitCode: null });
      if (!['running', 'starting', 'waiting'].includes(depRt.status) && !chain.has(procKey(project.id, dep.id))) {
        executionEngineStart(project.id, dep.id, { chain });
      }
      if (waiters.has(processKey)) ensureReadyPoll(project.id, dep.id);
      return;
    }
  }
  if (waiters.has(processKey)) { clearTimeout(waiters.get(processKey).timer); waiters.delete(processKey); }

  let workingDir = project.baseDirectory || process.cwd();
  if (cmdConfig.workingDirectory) {
    const cleanDir = cmdConfig.workingDirectory.trim();
    workingDir = path.isAbsolute(cleanDir) ? cleanDir : path.join(workingDir, cleanDir);
  }

  if (!fs.existsSync(workingDir)) {
    appendLog(project.id, cmdConfig.id, `\n[error] Folder not found: ${workingDir}. Check the project folder or the command's working directory.\n`, 'system');
    setRuntime(project.id, cmdConfig.id, { status: 'crashed', pid: null, exitCode: null, waitingFor: null });
    blockWaiters(project.id, cmdConfig.id, 'could not start');
    return;
  }

  const { vars, summary } = buildCommandEnv(cmdConfig, { workingDir, projectDir: project.baseDirectory, decrypt: decryptSecret });
  const envNote = describeEnv(summary);
  summary.warnings.forEach(w => appendLog(project.id, cmdConfig.id, `[info] ${w}\n`, 'system'));
  readyPatterns.set(processKey, (cmdConfig.readyPattern || '').trim().toLowerCase());

  appendLog(project.id, cmdConfig.id, `\n[system] Spawning: ${cmdConfig.command} inside ${workingDir}${envNote ? ` (env: ${envNote})` : ''}\n`, 'system');
  setRuntime(project.id, cmdConfig.id, {
    status: 'starting', pid: null, startedAt: null, url: null, detectedPort: null, exitCode: null, ready: false,
    waitingFor: null, blockedBy: null, restartGaveUp: false,
    envSummary: summary.count ? { count: summary.count, file: summary.file, secrets: summary.secrets } : null,
  });

  const delayMs = Math.max(0, parseFloat(cmdConfig.startupDelay) || 0) * 1000;
  const timer = setTimeout(() => {
    pendingStarts.delete(processKey);
    try {
      const child = spawnWorker([cmdConfig.command, workingDir], {
        env: { ...process.env, ...vars, PYTHONUNBUFFERED: '1' }
      });

      activeProcesses.set(processKey, child);

      attachWorkerOutput(child, (payload) => {
        if (activeProcesses.get(processKey) !== child) return;
        if (payload.type === 'started') {
          setRuntime(project.id, cmdConfig.id, { status: 'running', pid: payload.pid, startedAt: Date.now(), restartAttempt: null });
        } else if (payload.type === 'log') {
          appendLog(project.id, cmdConfig.id, payload.text, payload.pipe === 'stderr' ? 'stderr' : 'stdout');
        } else if (payload.type === 'exit') {
          killTree(child);
          markExited(project.id, cmdConfig.id, child, payload.code);
        } else if (payload.type === 'exception' || payload.type === 'error') {
          killTree(child);
          markExited(project.id, cmdConfig.id, child, null, `Could not start: ${payload.message}`);
        }
      }, (rawLine) => appendLog(project.id, cmdConfig.id, rawLine));

      child.stderr.on('data', (data) => {
        appendLog(project.id, cmdConfig.id, `[Python Sync Error] ${data.toString()}`, 'stderr');
      });

      child.on('error', (err) => {
        markExited(project.id, cmdConfig.id, child, null, `Python Engine failed: ${err.message}`);
      });

      // The worker died without reporting an exit code (killed externally, python crash)
      child.on('close', (code) => {
        markExited(project.id, cmdConfig.id, child, code ?? null, code === 0 ? undefined : `Stream worker stopped unexpectedly (code ${code})`);
      });

    } catch (spawnErr) {
      setRuntime(project.id, cmdConfig.id, { status: 'crashed', pid: null });
      appendLog(project.id, cmdConfig.id, `\n[error] Internal core engine crash: ${spawnErr.message}\n`, 'system');
    }
  }, delayMs);
  pendingStarts.set(processKey, timer);
}

// User-initiated stop. Also cancels a start that is waiting on its delay, a dependency, or a restart.
function executionEngineStop(projectId, commandId) {
  const processKey = procKey(projectId, commandId);
  const wasActive = activeProcesses.has(processKey) || pendingStarts.has(processKey) || waiters.has(processKey);
  restartHistory.delete(processKey);

  if (pendingStarts.has(processKey)) {
    clearTimeout(pendingStarts.get(processKey));
    pendingStarts.delete(processKey);
  }
  if (waiters.has(processKey)) {
    clearTimeout(waiters.get(processKey).timer);
    waiters.delete(processKey);
  }

  const child = activeProcesses.get(processKey);
  if (child) {
    activeProcesses.delete(processKey);
    killTree(child);
  }

  if (wasActive) appendLog(projectId, commandId, `\n[system] Stopped by user\n`, 'system');
  setRuntime(projectId, commandId, {
    status: 'offline', pid: null, startedAt: null, url: null, detectedPort: null, exitCode: null, ready: false,
    waitingFor: null, blockedBy: null, restartAttempt: null, restartGaveUp: false,
  });
  blockWaiters(projectId, commandId, 'was stopped');
}

function stopEverything() {
  pendingStarts.forEach(timer => clearTimeout(timer));
  pendingStarts.clear();
  waiters.forEach(w => clearTimeout(w.timer));
  waiters.clear();
  readyPolls.forEach(timer => clearInterval(timer));
  readyPolls.clear();
  activeProcesses.forEach(child => killTree(child));
  activeProcesses.clear();
  activeWorkers.forEach(proc => killTree(proc));
  activeWorkers.clear();
}

// Dedicated synchronous process tree-killer loop to guarantee zero orphan processes before app quit
function handleCleanExitSequence() {
  isQuittingFromModal = true;
  stopEverything();
  app.quit();
}

function activeProjectOf(db) {
  return db.projects.find(p => p.id === db.activeProject);
}

// Service actions name their project ({ projectId, commandId }), so any project's services can be
// controlled from the tree. A bare commandId (older windows, e.g. Project Manager) means the active project.
function resolveTarget(payload) {
  const db = readDatabase();
  if (payload && typeof payload === 'object') {
    const project = db.projects.find(p => p.id === payload.projectId);
    const ok = project && (project.commands || []).some(c => c.id === payload.commandId);
    return ok ? { projectId: project.id, commandId: payload.commandId } : null;
  }
  const project = activeProjectOf(db);
  return project && typeof payload === 'string' ? { projectId: project.id, commandId: payload } : null;
}

function projectFor(projectId) {
  const db = readDatabase();
  return projectId ? db.projects.find(p => p.id === projectId) : activeProjectOf(db);
}

function stopAllEverywhere() {
  readDatabase().projects.forEach(p => (p.commands || []).forEach(cmd => {
    const key = procKey(p.id, cmd.id);
    if (activeProcesses.has(key) || pendingStarts.has(key) || waiters.has(key)) executionEngineStop(p.id, cmd.id);
  }));
}

ipcMain.on('cmd-start', (event, payload) => {
  const t = resolveTarget(payload);
  if (t) executionEngineStart(t.projectId, t.commandId);
});

// "Start now" while waiting: skip the dependency
ipcMain.on('cmd-start-now', (event, payload) => {
  const t = resolveTarget(payload);
  if (t) executionEngineStart(t.projectId, t.commandId, { force: true });
});

ipcMain.on('cmd-stop', (event, payload) => {
  const t = resolveTarget(payload);
  if (t) executionEngineStop(t.projectId, t.commandId);
});

ipcMain.on('cmd-restart', (event, payload) => {
  const t = resolveTarget(payload);
  if (!t) return;
  executionEngineStop(t.projectId, t.commandId);
  executionEngineStart(t.projectId, t.commandId, { force: true });
});

// Start / stop one whole project (the tree's ▷ / ■); without a projectId: the active project
ipcMain.on('cmd-launch-all', (event, projectId) => {
  const project = projectFor(projectId);
  if (project) (project.commands || []).forEach(cmd => executionEngineStart(project.id, cmd.id));
});

ipcMain.on('cmd-stop-all', (event, projectId) => {
  const project = projectFor(projectId);
  if (project) (project.commands || []).forEach(cmd => executionEngineStop(project.id, cmd.id));
});

ipcMain.on('cmd-stop-everything', () => stopAllEverywhere());

ipcMain.on('set-active-project', (event, projectId) => {
  const db = readDatabase();
  if (!db.projects.some(p => p.id === projectId)) return;
  db.activeProject = projectId;
  writeDatabase(db);
});

ipcMain.handle('logs-get', (event, { projectId, commandId }) => {
  const key = commandId === null ? SHELL_KEY : procKey(projectId, commandId);
  const store = logStore.get(key);
  return store ? { seq: store.seq, lines: store.lines } : { seq: 0, lines: [] };
});

ipcMain.on('open-external', (event, url) => {
  if (typeof url === 'string' && LOCAL_URL_PATTERN.test(url)) shell.openExternal(url);
});

// ── Port check (before Start) ────────────────────────────────────
let lastPortCheck = null; // { pid, at }: the only pid 'port-free' may stop

ipcMain.handle('port-check', async (event, payload) => {
  const t = resolveTarget(payload);
  if (!t) return { checked: false };
  const db = readDatabase();
  const { cmd } = findCommand(db, t.projectId, t.commandId);
  const port = cmd && String(cmd.port || '').trim();
  if (!port || !/^\d+$/.test(port)) return { checked: false };

  // Another StackConsole service, in any project, that is (or reports being) on this port
  let owner = null;
  db.projects.forEach(p => (p.commands || []).forEach(c => {
    if (owner || (p.id === t.projectId && c.id === t.commandId)) return;
    const rt = getRuntime(p.id, c.id);
    if (['running', 'starting'].includes(rt.status) && (rt.detectedPort === port || (!rt.detectedPort && String(c.port) === port))) {
      owner = { id: c.id, name: c.displayName, projectId: p.id, projectName: p.name };
    }
  }));
  const listener = await findListener(port);
  if (!listener && !owner) return { checked: true, inUse: false, port };
  if (listener) lastPortCheck = { pid: listener.pid, at: Date.now() };
  return { checked: true, inUse: true, port, pid: listener?.pid || null, name: listener?.name || null, owner };
});

ipcMain.handle('port-free', async (event, pid) => {
  if (!lastPortCheck || lastPortCheck.pid !== pid || Date.now() - lastPortCheck.at > 120000) return { ok: false, error: 'Check the port again before stopping a process.' };
  const ours = [...activeProcesses.values()].some(child => child.pid === pid);
  if (ours) return { ok: false, error: 'That process belongs to StackConsole; stop the service instead.' };
  await killPid(pid);
  lastPortCheck = null;
  return { ok: true };
});

// ── Import commands from the project folder ──────────────────────
ipcMain.handle('import-scan', () => {
  const db = readDatabase();
  const project = activeProjectOf(db);
  if (!project) return { ok: false, error: 'No active project.' };
  return scanProjectTree(project.baseDirectory, project.commands || []);
});

function newCommandId(commands) {
  let id;
  do { id = `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; } while (commands.some(c => c.id === id));
  return id;
}

const importKey = (wd, command) => `${String(wd || '').trim().toLowerCase()}|${String(command || '').trim().toLowerCase()}`;

ipcMain.handle('import-apply', (event, items) => {
  if (!Array.isArray(items)) return { ok: false };
  const db = readDatabase();
  const project = activeProjectOf(db);
  if (!project) return { ok: false, error: 'No active project.' };
  project.commands = project.commands || [];
  const existing = new Set(project.commands.map(c => importKey(c.workingDirectory, c.command)));
  // An app folder must be a real folder directly inside the project folder (frontend, backend)
  const okFolder = (wd) => wd === '' || (/^[^\\/:*?"<>|.][^\\/:*?"<>|]{0,99}$/.test(wd) && !!project.baseDirectory && isDir(path.join(project.baseDirectory, wd)));
  // Validate in main: bounded strings, a plain icon key, no command added twice (e.g. a double click)
  const clean = items
    .filter(i => i && typeof i.command === 'string' && typeof i.name === 'string')
    .map(i => ({ name: i.name.trim().slice(0, 80), command: i.command.trim(), icon: typeof i.icon === 'string' && /^[a-z0-9-]{1,20}$/.test(i.icon) ? i.icon : null, wd: typeof i.workingDirectory === 'string' ? i.workingDirectory.trim() : '' }))
    .filter(i => i.command && i.command.length <= 2000 && okFolder(i.wd) && !existing.has(importKey(i.wd, i.command)) && existing.add(importKey(i.wd, i.command)))
    .slice(0, 50);
  clean.forEach(i => {
    project.commands.push({
      id: newCommandId(project.commands), displayName: i.name || 'Unnamed Command', icon: i.icon,
      command: i.command, workingDirectory: i.wd, port: '', startupDelay: '0',
    });
  });
  writeDatabase(db);
  return { ok: true, added: clean.length };
});

// ── Master folders: add, change, remove, set repos up ───────────
// A folder picked in main's own dialog waits here until the window confirms what it will do
// (replace folders it contains / change a folder); a window never sends a path to add.
let pendingRootPick = null; // { purpose: 'add' | 'change', path, root?, contains?, at }
const takePending = (purpose) => {
  const p = pendingRootPick;
  pendingRootPick = null;
  return p && p.purpose === purpose && Date.now() - p.at < 120000 ? p : null;
};

async function pickFolder(event, title, defaultPath) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title, ...(defaultPath && isDir(defaultPath) ? { defaultPath } : {}) });
  return res.canceled ? null : res.filePaths[0];
}

const findRoot = (db, rootPath) => rootPaths(db).find(p => folderKey(p) === folderKey(rootPath)) || null;

ipcMain.handle('roots-add', async (event, { suggested, pick } = {}) => {
  const db = readDatabase();
  let folder = null;
  if (suggested) folder = rootSuggestion(db);
  else if (pick) folder = await pickFolder(event, 'Choose a folder that holds your projects', rootSuggestion(db));
  if (!folder) return { ok: false, canceled: true };
  if (!isDir(folder)) return { ok: false, error: 'That folder doesn\'t exist.' };
  const check = checkOverlap(folder, rootPaths(db));
  if (check.error) return { ok: false, error: check.error };
  if (check.contains) {
    pendingRootPick = { purpose: 'add', path: folder, contains: check.contains, at: Date.now() };
    return { ok: false, needsReplace: true, path: folder, contains: check.contains };
  }
  db.projectRoots = [...(db.projectRoots || []), { path: folder }];
  writeDatabase(db);
  return { ok: true, path: folder };
});

// The new folder holds folders already in the list: it takes their place
ipcMain.handle('roots-confirm-replace', () => {
  const pick = takePending('add');
  if (!pick) return { ok: false, error: 'Pick the folder again.' };
  const db = readDatabase();
  const drop = new Set(pick.contains.map(folderKey));
  const list = db.projectRoots || [];
  const at = list.findIndex(r => drop.has(folderKey(r.path)));
  const rest = list.filter(r => !drop.has(folderKey(r.path)));
  rest.splice(at === -1 ? rest.length : at, 0, { path: pick.path });
  db.projectRoots = rest;
  writeDatabase(db);
  return { ok: true, path: pick.path };
});

ipcMain.handle('roots-remove', (event, rootPath) => {
  const db = readDatabase();
  const found = findRoot(db, rootPath);
  if (!found) return { ok: false, error: 'Unknown folder.' };
  db.projectRoots = (db.projectRoots || []).filter(r => folderKey(r.path) !== folderKey(found));
  writeDatabase(db);
  return { ok: true };
});

ipcMain.handle('roots-move', (event, { root, delta } = {}) => {
  const db = readDatabase();
  const list = db.projectRoots || [];
  const i = list.findIndex(r => folderKey(r.path) === folderKey(root));
  const j = i + (delta < 0 ? -1 : 1);
  if (i === -1 || j < 0 || j >= list.length) return { ok: false };
  [list[i], list[j]] = [list[j], list[i]];
  writeDatabase(db);
  return { ok: true };
});

ipcMain.handle('roots-rescan', async (event, rootPath) => {
  const db = readDatabase();
  const found = findRoot(db, rootPath);
  if (!found) return { ok: false };
  forgetPaths();
  await rootScanner.rescan(found);
  return { ok: true };
});

ipcMain.handle('roots-open', async (event, rootPath) => {
  const found = findRoot(readDatabase(), rootPath);
  if (!found) return { ok: false, error: 'Unknown folder.' };
  return openFolder('explorer', found, shell);
});

ipcMain.handle('roots-dismiss-prompt', () => {
  const db = readDatabase();
  db.rootsPromptDismissed = true;
  writeDatabase(db);
  return { ok: true };
});

// Projects under a master folder, for the change preview and for relinking
function projectsUnder(db, rootPath) {
  const rk = folderKey(rootPath);
  return (db.projects || []).filter(p => p.baseDirectory && folderContains(rk, folderKey(p.baseDirectory)));
}

// Change a master folder. When the old one is gone (renamed, moved, other drive letter), the projects
// under it can move with it: one relink for all of them instead of one per project.
function replaceRoot(db, oldPath, newPath, relink) {
  const list = db.projectRoots || [];
  const i = list.findIndex(r => folderKey(r.path) === folderKey(oldPath));
  if (i === -1) return 0;
  let moved = 0;
  if (relink) {
    const lower = oldPath.replace(/[\\/]+$/, '').toLowerCase();
    const rebase = (p) => (p.toLowerCase() === lower || p.toLowerCase().startsWith(lower + path.sep) ? newPath.replace(/[\\/]+$/, '') + p.slice(lower.length) : p);
    (db.projects || []).forEach(p => {
      if (!p.baseDirectory) return;
      const next = rebase(p.baseDirectory);
      if (next === p.baseDirectory || !isDir(next)) return; // only projects that are really there
      p.baseDirectory = next;
      moved++;
      (p.commands || []).forEach(c => {
        const wd = (c.workingDirectory || '').trim();
        if (wd && path.isAbsolute(wd)) c.workingDirectory = rebase(wd);
      });
    });
  }
  list[i] = { ...list[i], path: newPath };
  db.projectRoots = list;
  forgetFolders();
  forgetPaths();
  return moved;
}

ipcMain.handle('roots-change-pick', async (event, rootPath) => {
  const db = readDatabase();
  const root = findRoot(db, rootPath);
  if (!root) return { ok: false, error: 'Unknown folder.' };
  const folder = await pickFolder(event, `Replace ${root}`, isDir(root) ? path.dirname(root) : null);
  if (!folder) return { ok: false, canceled: true };
  if (folderKey(folder) === folderKey(root)) return { ok: false, canceled: true };
  const others = rootPaths(db).filter(p => folderKey(p) !== folderKey(root));
  const check = checkOverlap(folder, others);
  if (check.error) return { ok: false, error: check.error };
  if (check.contains) return { ok: false, error: `It holds ${check.contains.join(', ')}, which is already in the list. Remove that first.` };
  const oldMissing = !isDir(root);
  const under = projectsUnder(db, root);
  const fk = folderKey(folder);
  const relinkable = oldMissing ? under.filter(p => isDir(path.join(folder, path.relative(root, p.baseDirectory)))) : [];
  const stay = under.filter(p => folderContains(fk, folderKey(p.baseDirectory)));
  const move = oldMissing ? under.filter(p => !relinkable.includes(p)) : under.filter(p => !stay.includes(p));
  pendingRootPick = { purpose: 'change', root, path: folder, relink: oldMissing && relinkable.length > 0, at: Date.now() };
  return {
    ok: true, root, path: folder, oldMissing, found: !!isDir(folder),
    stay: (oldMissing ? relinkable : stay).map(p => p.name),
    move: move.map(p => p.name),
    relink: oldMissing ? relinkable.length : 0,
  };
});

ipcMain.handle('roots-change-apply', () => {
  const pick = takePending('change');
  if (!pick) return { ok: false, error: 'Pick the folder again.' };
  const db = readDatabase();
  const moved = replaceRoot(db, pick.root, pick.path, pick.relink);
  writeDatabase(db);
  return { ok: true, moved };
});

// Same path on another drive letter (E: → F:), found by main: relink everything under it
ipcMain.handle('roots-relink', (event, rootPath) => {
  const db = readDatabase();
  const root = findRoot(db, rootPath);
  if (!root || isDir(root)) return { ok: false, error: 'Nothing to relink.' };
  const target = relinkCandidate(root, []);
  if (!target) return { ok: false, error: 'No matching folder found. Use "Change folder…".' };
  const moved = replaceRoot(db, root, target, true);
  writeDatabase(db);
  return { ok: true, path: target, moved };
});

// The repo (or container folder) named by the window must be one the scan found and nobody covers
function findOpenItem(db, folder) {
  const k = folderKey(folder);
  for (const r of workspaceFor(db).roots) {
    for (const it of r.items) {
      if (folderKey(it.path) === k) return it;
      if (it.kind === 'folder') { const repo = it.repos.find(rp => folderKey(rp.path) === k); if (repo) return repo; }
    }
  }
  return null;
}

ipcMain.handle('repo-hide', (event, { path: folder, hidden } = {}) => {
  const db = readDatabase();
  const list = db.hiddenRepos || [];
  const k = folderKey(folder);
  if (hidden) {
    if (!findOpenItem(db, folder)) return { ok: false, error: 'Unknown folder.' };
    if (!list.some(p => folderKey(p) === k)) list.push(folder);
    db.hiddenRepos = list;
  } else {
    db.hiddenRepos = list.filter(p => folderKey(p) !== k);
  }
  writeDatabase(db);
  return { ok: true };
});

// A project for `folder` with the commands the scan pre-ticks (servers, workers); its apps included
function projectFromFolder(folder, name, taken) {
  const res = scanProjectTree(folder, []);
  const items = res.ok ? res.groups.flatMap(g => g.items) : [];
  const picked = items.filter(i => i.preselect);
  const commands = [];
  picked.slice(0, 50).forEach(i => commands.push({
    id: newCommandId(commands), displayName: i.name, icon: i.icon || null,
    command: i.command, workingDirectory: i.workingDirectory || '', port: '', startupDelay: '0',
  }));
  return { project: { id: uniqueId(name, taken), name, baseDirectory: folder, commands }, found: items.length, picked: commands.length };
}

// mode: 'repo' (one repo) · 'one' (a container folder as one project, its repos as apps) · 'separate'
ipcMain.handle('repo-setup', (event, { path: folder, mode } = {}) => {
  const db = readDatabase();
  const item = findOpenItem(db, folder);
  if (!item) return { ok: false, error: 'That folder is already set up, or it moved. Try again after the list refreshes.' };
  const taken = new Set((db.projects || []).map(p => p.id));
  const made = [];
  if (item.kind === 'folder' && mode === 'separate') {
    item.repos.filter(r => r.runnable && !r.hidden).forEach(r => made.push(projectFromFolder(r.path, r.name, taken)));
  } else {
    made.push(projectFromFolder(item.path, item.name, taken));
  }
  if (!made.length) return { ok: false, error: 'Nothing runnable found in that folder.' };
  db.projects = [...(db.projects || []), ...made.map(m => m.project)];
  db.activeProject = made[0].project.id;
  writeDatabase(db);
  const one = made.length === 1 ? made[0] : null;
  return {
    ok: true,
    projectIds: made.map(m => m.project.id),
    commands: made.reduce((n, m) => n + m.picked, 0),
    // Found commands but none pre-ticked (composer-only): let the person choose instead of an empty project
    needsReview: !!one && one.picked === 0 && one.found > 0,
  };
});

// Colour & icon picker: null means "automatic" (the stored choice is removed)
ipcMain.handle('project-identity', (event, { projectId, ...choice } = {}) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  const v = validateIdentity(choice);
  if (!v.ok) return v;
  if (v.color) project.color = v.color; else delete project.color;
  if (v.icon) project.icon = v.icon; else delete project.icon;
  if (v.mono) project.mono = v.mono; else delete project.mono;
  writeDatabase(db);
  return { ok: true };
});

ipcMain.handle('project-pin', (event, { projectId, pinned } = {}) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  if (pinned) project.pinned = true; else delete project.pinned;
  writeDatabase(db);
  return { ok: true };
});

// Projects with no folder or no services, archived in one go (none of them can be running)
ipcMain.handle('projects-archive-empty', () => {
  const db = readDatabase();
  let n = 0;
  db.projects.forEach(p => {
    if (p.archived || (p.baseDirectory && (p.commands || []).length)) return;
    p.archived = true;
    n++;
  });
  writeDatabase(db);
  return { ok: true, archived: n };
});

// ── Regroup: split / combine ─────────────────────────────────────
const LIVE_ERROR = 'Stop its running services first.';

ipcMain.handle('project-split-preview', (event, projectId) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  const plan = splitPlan(project);
  if (!plan.ok) return plan;
  return { ok: true, groups: plan.groups, warnings: plan.warnings, live: projectLive(project) };
});

ipcMain.handle('project-split-apply', (event, projectId) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  if (projectLive(project)) return { ok: false, error: LIVE_ERROR };
  const res = applySplit(db, projectId);
  if (!res.ok) return res;
  moveRuntimeKeys(res.moved);
  writeDatabase(db);
  return { ok: true, created: res.created };
});

ipcMain.handle('project-combine-candidates', (event, projectId) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  return { ok: true, projects: combineCandidates(db, project, rootPaths(db)).map(p => ({ id: p.id, name: p.name, folder: p.baseDirectory, commands: (p.commands || []).length })) };
});

ipcMain.handle('project-combine-preview', (event, projectIds) => {
  const db = readDatabase();
  if (!Array.isArray(projectIds)) return { ok: false };
  const plan = combinePlan(db, projectIds, rootPaths(db));
  if (!plan.ok) return plan;
  const live = projectIds.some(id => { const p = db.projects.find(x => x.id === id); return p && projectLive(p); });
  return { ...plan, live };
});

ipcMain.handle('project-combine-apply', (event, { projectIds, name } = {}) => {
  const db = readDatabase();
  if (!Array.isArray(projectIds)) return { ok: false };
  if (projectIds.some(id => { const p = db.projects.find(x => x.id === id); return p && projectLive(p); })) return { ok: false, error: LIVE_ERROR };
  const res = applyCombine(db, projectIds, name, rootPaths(db));
  if (!res.ok) return res;
  moveRuntimeKeys(res.moved);
  writeDatabase(db);
  return { ok: true, projectId: res.projectId };
});

// ── Projects & folders (tree ⋯ menu) ─────────────────────────────
// Folders are resolved here from the saved config; a window only names the project/command.
ipcMain.handle('folder-open', async (event, { projectId, commandId, target } = {}) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  const cmd = commandId ? (project.commands || []).find(c => c.id === commandId) : null;
  if (commandId && !cmd) return { ok: false, error: 'Unknown command.' };
  const folder = cmd ? commandFolder(project, cmd) : project.baseDirectory;
  if (!folder) return { ok: false, error: 'This project has no folder yet. Use "Change folder…".' };
  if (!['explorer', 'vscode', 'terminal'].includes(target)) return { ok: false, error: 'Unknown action.' };
  return openFolder(target, folder, shell);
});

ipcMain.handle('project-set-folder', (event, { projectId, folder } = {}) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  if (typeof folder !== 'string' || !isDir(folder)) return { ok: false, error: 'That folder doesn\'t exist.' };
  project.baseDirectory = folder;
  forgetFolders();
  writeDatabase(db);
  return { ok: true };
});

// Relink to the suggested folder (computed here, not sent by the window)
ipcMain.handle('project-relink', (event, projectId) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project || !project.baseDirectory || isDir(project.baseDirectory)) return { ok: false, error: 'Nothing to relink.' };
  const target = relinkCandidate(project.baseDirectory, db.projects.map(p => p.baseDirectory).filter(Boolean));
  if (!target) return { ok: false, error: 'No matching folder found. Use "Change folder…".' };
  // Commands with absolute working directories under the old folder move with it
  const old = project.baseDirectory;
  (project.commands || []).forEach(c => {
    const wd = (c.workingDirectory || '').trim();
    if (wd && path.isAbsolute(wd) && wd.toLowerCase().startsWith(old.toLowerCase())) c.workingDirectory = target + wd.slice(old.length);
  });
  project.baseDirectory = target;
  forgetFolders();
  writeDatabase(db);
  return { ok: true, folder: target };
});

ipcMain.handle('project-archive', (event, { projectId, archived } = {}) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === projectId);
  if (!project) return { ok: false, error: 'Unknown project.' };
  const live = (project.commands || []).some(c => ['running', 'starting', 'waiting'].includes(getRuntime(project.id, c.id).status));
  if (archived && live) return { ok: false, error: 'Stop its services before archiving it.' };
  if (archived) project.archived = true; else delete project.archived;
  writeDatabase(db);
  return { ok: true };
});

// For the command form's Browse…: where would it run, and on which branch? (read-only)
ipcMain.handle('folder-info', (event, folder) => {
  if (typeof folder !== 'string' || !folder) return { exists: false };
  if (!isDir(folder)) return { exists: false };
  const git = branchInfo(folder);
  return { exists: true, branch: git?.branch || null, detached: !!git?.detached, repoRoot: git?.root || null };
});

// Branch switches and folders appearing/disappearing happen outside StackConsole: check every 5 s
// (one stat per known HEAD + one per folder) and refresh the windows only when something changed.
let lastFolderSnapshot = '';
function folderSnapshot() {
  const db = readDatabase();
  return db.projects.map(p => [p.baseDirectory && isDir(p.baseDirectory), ...(p.commands || []).map(c => { const f = commandFolder(p, c); return f ? isDir(f) : null; })].join(',')).join('|');
}
let folderPolls = 0;
setInterval(() => {
  const minute = ++folderPolls % 12 === 0;
  if (minute) { forgetFolders(); forgetPaths(); } // once a minute: notice `git init` / moved repos / new links
  const snapshot = folderSnapshot();
  if (anyBranchChanged() || snapshot !== lastFolderSnapshot) {
    lastFolderSnapshot = snapshot;
    broadcastState();
  }
  // Master folders: a new clone or a deleted repo shows up within 5 s; files appearing inside a repo within a minute
  rootScanner.poll(rootPaths(readDatabase()), minute);
}, 5000).unref();

// A dev run (electron .) has no installed shortcut, so for notifications Electron writes Start Menu\Programs\Electron.lnk
// for our app ID with electron.exe's icon, and Windows then puts that icon on our taskbar button. Electron rewrites
// that shortcut when it no longer matches (app ID, target, its toast activator), but not for the icon alone: so we only
// swap the icon on Electron's own shortcut, and only while it carries our app ID. Packaged builds use the installer's.
function claimDevShortcut() {
  if (process.platform !== 'win32' || app.isPackaged) return;
  try {
    const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${path.basename(process.execPath, '.exe')}.lnk`);
    const icon = path.join(__dirname, 'src/assets/logo/stacklogo-x256.ico');
    const current = shell.readShortcutLink(link); // throws until Electron has written it
    if (current.appUserModelId !== APP_ID || current.icon === icon) return;
    shell.writeShortcutLink(link, 'update', { icon, iconIndex: 0 });
  } catch {}
}

function generateWindowFrame(width, height, minW, minH, isResizable, entryHtml) {
  const win = new BrowserWindow({
    width: width,
    height: height,
    minWidth: minW || width,
    minHeight: minH || height,
    resizable: isResizable,
    frame: false,
    backgroundColor: '#0B0D0E',
    icon: path.join(__dirname, 'src/assets/logo/stacklogo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      enableWebSQL: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  });

  // Windows groups taskbar buttons by the app ID set for crash notifications. A dev run (electron .) has no
  // installed shortcut for that ID, so without these details the taskbar showed electron.exe's icon, not ours.
  if (process.platform === 'win32') {
    win.setAppDetails({
      appId: APP_ID,
      appIconPath: path.join(__dirname, 'src/assets/logo/stacklogo-x256.ico'),
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'StackConsole',
    });
  }

  // Pages never navigate or open windows; links to local dev servers go through open-external
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(entryHtml);
  return win;
}

function createMainWindow() {
  mainWindow = generateWindowFrame(1100, 700, 900, 560, true, 'src/index.html');

  mainWindow.on('close', (event) => {
    if(isQuittingFromModal) {
        return;
    }

    event.preventDefault();
    mainWindow.hide();
  })

  mainWindow.on('show', () => {
    if (hasBeenShown && mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('db-refreshed', getState());
    }
    hasBeenShown = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;

    // Fallback cleanup if window layout drops unexpectedly
    stopEverything();

    [addCommandWindow, editCommandWindow, projectManagerWindow, addNewProjectWindow, editProjectNameWindow, importCommandsWindow]
      .forEach(win => { if (win && !win.isDestroyed()) win.close(); });
  });
}

// Routes directly to the centralized exit routine
ipcMain.on('confirm-app-exit', () => {
  handleCleanExitSequence();
});

ipcMain.on('win-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('win-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !win.isResizable()) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('win-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on('minimize-to-tray', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('route-add-command', () => {
  if (addCommandWindow) { addCommandWindow.focus(); return; }
  addCommandWindow = generateWindowFrame(560, 760, 560, 600, true, 'src/components/modals/add-command.html');
  addCommandWindow.on('closed', () => { addCommandWindow = null; });
});

ipcMain.on('route-edit-command', () => {
  if (editCommandWindow) { editCommandWindow.focus(); return; }
  editCommandWindow = generateWindowFrame(560, 760, 560, 600, true, 'src/components/modals/edit-command.html');
  editCommandWindow.on('closed', () => { editCommandWindow = null; activeCommandToEdit = null; });
});

ipcMain.on('route-new-project-command', () => {
  if (addNewProjectWindow) { addNewProjectWindow.focus(); return;}
  addNewProjectWindow = generateWindowFrame(480, 340, 480, 340, false, 'src/components/modals/add-project.html');
  addNewProjectWindow.on('closed', () => {addNewProjectWindow = null; });
});

ipcMain.on('route-project-manager', () => {
  if (projectManagerWindow) { projectManagerWindow.focus(); return; }
  projectManagerWindow = generateWindowFrame(760, 540, 760, 540, false, 'src/components/project-manager.html');
  projectManagerWindow.on('closed', () => { projectManagerWindow = null; });
});

ipcMain.on('route-edit-project-name', () => {
  if (editProjectNameWindow) { editProjectNameWindow.focus(); return; }
  editProjectNameWindow = generateWindowFrame(480, 220, 480, 220, false, 'src/components/modals/edit-project-name.html');
  editProjectNameWindow.on('closed', () => { editProjectNameWindow = null; });
})

ipcMain.on('route-import-commands', () => {
  if (importCommandsWindow) { importCommandsWindow.focus(); return; }
  importCommandsWindow = generateWindowFrame(520, 600, 520, 600, false, 'src/components/modals/import-commands.html');
  importCommandsWindow.on('closed', () => { importCommandsWindow = null; });
});

// Opens the shared shell. An already running shell is kept, so its session and history survive.
ipcMain.on('route-command-prompt', () => {
  const existing = activeWorkers.get('global_shell');
  if (existing && existing.exitCode === null && !existing.killed) return;

  const db = readDatabase();
  const activeProject = activeProjectOf(db);
  let workingDir = activeProject && activeProject.baseDirectory ? activeProject.baseDirectory : app.getPath('home');
  if (!fs.existsSync(workingDir)) {
    appendLog(null, null, `[info] Project folder not found (${workingDir}). Opening the shell in your home folder instead.\n`, 'system');
    workingDir = app.getPath('home');
  }
  const nativeShell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

  const globalShellProcess = spawnWorker([nativeShell, workingDir]);

  activeWorkers.set('global_shell', globalShellProcess);

  attachWorkerOutput(globalShellProcess, (parsed) => {
    if (parsed.type === 'log') appendLog(null, null, parsed.text, parsed.pipe === 'stderr' ? 'stderr' : 'stdout');
    else if (parsed.type === 'exception' || parsed.type === 'error') appendLog(null, null, `[error] Shell could not start: ${parsed.message}\n`, 'system');
  }, (rawLine) => appendLog(null, null, rawLine));

  globalShellProcess.on('close', () => {
    if (activeWorkers.get('global_shell') === globalShellProcess) activeWorkers.delete('global_shell');
    appendLog(null, null, '\n[info] Shell session ended. Open the shell again to start a new one.\n', 'system');
  });
});

ipcMain.on('cmd-terminal-input', (event, { commandId, text }) => {
  const targetId = commandId || 'global_shell';
  const workerProcess = activeWorkers.get(targetId);

  if (workerProcess && !workerProcess.killed) {
    if (!commandId) appendLog(null, null, `$ ${text}\n`, 'input');
    workerProcess.stdin.write(text + '\n');
  }
});

ipcMain.on('cmd-clear-logs', (event, { projectId, commandId }) => {
  const key = commandId === null ? SHELL_KEY : procKey(projectId, commandId);
  const store = logStore.get(key);
  if (store) store.lines = [];
});

ipcMain.handle('open-dir-picker', async (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(targetWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Base Directory'
  });

  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('db-get', () => getState());

ipcMain.handle('db-set', (event, data) => {
  try {
    if (!data || !Array.isArray(data.projects)) {
      broadcastState();
      return false;
    }
    // A command (or project) removed while running would otherwise keep running with no UI to stop it
    const keep = new Set();
    data.projects.forEach(p => (p.commands || []).forEach(c => keep.add(procKey(p.id, c.id))));
    [...activeProcesses.keys(), ...pendingStarts.keys(), ...waiters.keys()].forEach(key => {
      if (keep.has(key)) return;
      const [projectId, commandId] = splitKey(key);
      executionEngineStop(projectId, commandId);
    });
    writeDatabase(sealSecrets(data, readDatabase()));
    return true;
  } catch (ipcErr) {
    console.error('[Main Process] Error occurring inside db-set handler loop:', ipcErr);
    throw ipcErr;
  }
});

function createTray() {
  tray = new Tray(path.join(__dirname, 'src/assets/logo/stacklogo.ico'));
  tray.setToolTip('StackConsole');
  updateTrayMenu(getState());
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return;
  pythonCommand = resolvePython();
  if (!pythonCommand) {
    dialog.showErrorBox(
      'Python Not Found',
      'StackConsole could not find its bundled Python runtime. Please reinstall StackConsole.\n\nRunning from source? Run `npm run fetch-python`, or install Python from https://www.python.org/downloads/ and add it to PATH.'
    );
    app.quit();
    return;
  }

  // Windows shows toast notifications only for an app with a user model id
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
    claimDevShortcut();
  }

  // Drop runtime fields left in projects.json by older versions (logs, stale "running" statuses)
  writeDatabase(readDatabase());

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit — app stays in tray
});
