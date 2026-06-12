// Configure V8 Engine flags BEFORE app lifecycle initialization to optimize memory allocations
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

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

let mainWindow = null;
let addCommandWindow = null;
let editCommandWindow = null;
let addNewProjectWindow = null;
let projectManagerWindow = null;
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

function checkPythonAvailable() {
  try {
    execSync('python --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const activeProcesses = new Map();
const activeWorkers = new Map();
const MAX_LOG_LENGTH = 10000; 

function readDatabase() {
  try {
    ensureDbDir();
    if(!fs.existsSync(getDbPath())) {
      fs.writeFileSync(getDbPath(), JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return defaultSchema;
    }

    const rawData = fs.readFileSync(getDbPath(), 'utf8').trim();
    if(!rawData) {
      fs.writeFileSync(getDbPath(), JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return defaultSchema;
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
    return defaultSchema;
  }
}

function writeDatabase(data) {
  try {
    ensureDbDir();
    const payload = data || defaultSchema;
    const jsonString = JSON.stringify(payload, null, 2);

    fs.writeFileSync(getDbPath(), jsonString, 'utf8');
    
    if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('db-refreshed', payload);
    if (addCommandWindow && !addCommandWindow.webContents.isDestroyed()) addCommandWindow.webContents.send('db-refreshed', payload);
    if (editCommandWindow && !editCommandWindow.webContents.isDestroyed()) editCommandWindow.webContents.send('db-refreshed', payload);
    if (addNewProjectWindow && !addNewProjectWindow.webContents.isDestroyed()) addNewProjectWindow.webContents.send('db-refreshed', payload);
    if (projectManagerWindow && !projectManagerWindow.webContents.isDestroyed()) projectManagerWindow.webContents.send('db-refreshed', payload);
    return true;
  } catch (err) {
    console.error("[Main Process] Database save exception directly during fs.writeFileSync:", err);
    throw err;
  }
}

function sendTerminalOutput(commandId, text, isError = false) {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('terminal-log', {commandId, text, isError});
  }
}

function updateTrayMenu(appState) {
  if (!tray) return;

  const menuItems = [];
  const activeProject = appState?.projects?.find(p => p.id === appState.activeProject);
  
  if (activeProject && activeProject.commands && activeProject.commands.length > 0) {
    menuItems.push({ label: `Active: ${activeProject.name}`, enabled: false });
    menuItems.push({ type: 'separator' });

    activeProject.commands.forEach(cmd => {
      let statusIndicator = '⚫'; 
      if (cmd.status === 'running') statusIndicator = '🟢';
      if (cmd.status === 'warning') statusIndicator = '🟡'; 

      menuItems.push({
        label: `${statusIndicator} ${cmd.displayName} (:${cmd.port || '80'})`,
        enabled: false 
      });
    });

    menuItems.push({ type: 'separator' });
  } else {
    menuItems.push({ label: 'No Active Projects Found', enabled: false });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push(
    { label: 'Show App', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Quit', click: () => { handleCleanExitSequence(); } } 
  );

  const contextMenu = Menu.buildFromTemplate(menuItems);
  tray.setContextMenu(contextMenu);
}

function executionEngineStart(db, commandId) {
  const project = db.projects.find(p => p.id == db.activeProject);
  if (!project) return;

  const cmdConfig = project.commands.find(c => c.id == commandId);
  if(!cmdConfig || cmdConfig.status === 'running') return;

  const processKey = `${project.id}:${cmdConfig.id}`;
  if(activeProcesses.has(processKey)) return;

  let workingDir = project.baseDirectory || process.cwd();
  
  if (cmdConfig.workingDirectory) {
    const cleanDir = cmdConfig.workingDirectory.trim();
    workingDir = path.isAbsolute(cleanDir)
      ? cleanDir
      : path.join(workingDir, cleanDir);
  }

  cmdConfig.status = 'warning';
  if (!cmdConfig.logs) cmdConfig.logs = "";
  
  cmdConfig.logs += `\r\n[system] Spawning: ${cmdConfig.command} inside ${workingDir}\r\n`;
  writeDatabase(db);
  updateTrayMenu(db);

  setTimeout(() => {
    try {
      const pythonScriptPath = getAssetPath('services/stream_worker.py');
      
      const child = spawn('python', [pythonScriptPath, cmdConfig.command, workingDir], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      activeProcesses.set(processKey, child);
      let dynamicBuffer = "";

      child.stdout.on('data', (data) => {
        dynamicBuffer += data.toString();
        const lines = dynamicBuffer.split('\n');
        dynamicBuffer = lines.pop(); 

        lines.forEach(line => {
          if (!line.trim()) return;
          try {
            const payload = JSON.parse(line);
            
            if (payload.type === 'started') {
              const freshDb = readDatabase();
              const cRef = freshDb.projects.find(p => p.id === project.id)?.commands.find(c => c.id === commandId);
              if (cRef) {
                cRef.status = 'running';
                cRef.pid = payload.pid;
                writeDatabase(freshDb);
                updateTrayMenu(freshDb);
              }
            } 
            else if (payload.type === 'log') {
              const freshDb = readDatabase();
              const pRef = freshDb.projects.find(p => p.id === project.id);
              const cRef = pRef?.commands.find(c => c.id === commandId);
              if (cRef) {
                let updatedLogs = (cRef.logs || "") + payload.text;
                
                if (updatedLogs.length > MAX_LOG_LENGTH) {
                  updatedLogs = "--- Log truncated to maintain process performance ---\n" + updatedLogs.slice(-MAX_LOG_LENGTH);
                }
                
                cRef.logs = updatedLogs;
                writeDatabase(freshDb);
              }
              sendTerminalOutput(commandId, payload.text, payload.pipe === 'stderr');
            }
            else if (payload.type === 'exit') {
              const freshDb = readDatabase();
              const cRef = freshDb.projects.find(p => p.id === project.id)?.commands.find(c => c.id === commandId);
              if (cRef) {
                cRef.logs = (cRef.logs || "") + `\r\n[info] Process exited cleanly with code: ${payload.code}\r\n`;
                executionEngineStopCleanup(freshDb, project.id, cRef);
              }
            }
          } catch (e) {
            sendTerminalOutput(commandId, line + '\n', false);
          }
        });
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        sendTerminalOutput(commandId, `[Python Sync Error] ${output}`, true);
      });

      child.on('error', (err) => {
        const freshDb = readDatabase();
        const cRef = freshDb.projects.find(p => p.id === project.id)?.commands.find(c => c.id === commandId);
        if (cRef) {
          cRef.logs = (cRef.logs || "") + `\r\n[error] Python Engine failed: ${err.message}\r\n`;
          executionEngineStopCleanup(freshDb, project.id, cRef);
        }
      });

    } catch (spawnErr) {
      const freshDb = readDatabase();
      const cRef = freshDb.projects.find(p => p.id === project.id)?.commands.find(c => c.id === commandId);
      if (cRef) {
        cRef.logs = (cRef.logs || "") + `\r\n[exception] Internal core engine crash: ${spawnErr.message}\r\n`;
        executionEngineStopCleanup(freshDb, project.id, cRef);
      }
    }
  }, parseInt(cmdConfig.startupDelay || 0) * 1000);
}

function executionEngineStopCleanup(db, projectId, cmdConfig) {
  if (!cmdConfig) return;
  const processKey = `${projectId}:${cmdConfig.id}`;
  const child = activeProcesses.get(processKey);
  
  if (child) {
    try {
      if (process.platform === 'win32') {
        // Use synchronous killing during single runs or catch errors gracefully to block thread racing
        execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (e) {
      try { child.kill('SIGKILL'); } catch (err) {}
    }
    activeProcesses.delete(processKey);
  }

  cmdConfig.status = 'offline';
  cmdConfig.pid = null;
  writeDatabase(db);
  updateTrayMenu(db);
}

// MODIFIED: Dedicated synchronous process tree-killer loop to guarantee zero orphan processes before app quit
function handleCleanExitSequence() {
  isQuittingFromModal = true;
  
  // 1. Force kill all managed stream python execution engines
  activeProcesses.forEach((child) => {
    if (child && child.pid) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch (e) {}
    }
  });
  activeProcesses.clear();

  // 2. Force kill all global shell workers
  activeWorkers.forEach((proc) => {
    if (proc && proc.pid) {
      try {
        if (process.platform === 'win32') {
          execSync(`taskkill /pid ${proc.pid} /f /t`, { stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
    }
  });
  activeWorkers.clear();

  // 3. Mark database statuses cleanly to offline state
  const db = readDatabase();
  db.projects.forEach(p => {
    p.commands.forEach(c => {
      c.status = 'offline';
      c.pid = null;
    });
  });
  writeDatabase(db);

  app.quit();
}

ipcMain.on('cmd-start', (event, commandId) => {
  const db = readDatabase();
  executionEngineStart(db, commandId);
});

ipcMain.on('cmd-stop', (event, commandId) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === db.activeProject);
  const cmdConfig = project?.commands.find(c => c.id === commandId);
  if (project && cmdConfig) {
    executionEngineStopCleanup(db, project.id, cmdConfig);
  }
});

ipcMain.on('cmd-launch-all', () => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === db.activeProject);
  if (project) {
    project.commands.forEach(cmd => executionEngineStart(db, cmd.id));
  }
});

ipcMain.on('cmd-stop-all', () => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id === db.activeProject);
  if (project) {
    project.commands.forEach(cmd => executionEngineStopCleanup(db, project.id, cmd));
  }
});

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
      backgroundThrottling: true,
      enableWebSQL: false,
      spellcheck: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  });

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
      const db = readDatabase();
      mainWindow.webContents.send('db-refreshed', db);
    }
    hasBeenShown = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    
    // Fallback cleanup if window layout drops unexpectedly
    const db = readDatabase();
    db.projects.forEach(p => {
      p.commands.forEach(c => executionEngineStopCleanup(db, p.id, c));
    });

    if (addCommandWindow) { addCommandWindow.close(); addCommandWindow = null; }
    if (editCommandWindow) { editCommandWindow.close(); editCommandWindow = null; }
    if (projectManagerWindow) { projectManagerWindow.close(); projectManagerWindow = null; }
    if (addNewProjectWindow) { addNewProjectWindow.close(); addNewProjectWindow = null; }
  });
}

// MODIFIED: Routes directly to the centralized exit routine
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
  addCommandWindow = generateWindowFrame(520, 680, 520, 680, false, 'src/components/modals/add-command.html');
  addCommandWindow.on('closed', () => { addCommandWindow = null; });
});

ipcMain.on('route-edit-command', () => {
  if (editCommandWindow) { editCommandWindow.focus(); return; }
  editCommandWindow = generateWindowFrame(520, 680, 520, 680, false, 'src/components/modals/edit-command.html');
  editCommandWindow.on('closed', () => { editCommandWindow = null; });
});

ipcMain.on('route-new-project-command', () => {
  if (addNewProjectWindow) { addNewProjectWindow.focus(); return;}
  addNewProjectWindow = generateWindowFrame(520, 680, 520, 680, false, 'src/components/modals/add-project.html');
  addNewProjectWindow.on('closed', () => {addNewProjectWindow = null; });
});

ipcMain.on('route-project-manager', () => {
  if (projectManagerWindow) { projectManagerWindow.focus(); return; }
  projectManagerWindow = generateWindowFrame(760, 540, 760, 540, false, 'src/components/project-manager.html');
  projectManagerWindow.on('closed', () => { projectManagerWindow = null; });
});

ipcMain.on('route-command-prompt', (event) => {
  const targetId = 'global_shell';
  
  if (activeWorkers.has(targetId)) {
    const oldWorker = activeWorkers.get(targetId);
    if (!oldWorker.killed) oldWorker.kill();
    activeWorkers.delete(targetId);
  }

  const db = readDatabase(); 
  const activeProject = db.projects.find(p => p.id === db.activeProject);
  const workingDir = activeProject ? activeProject.baseDirectory : app.getPath('home');
  const nativeShell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

  const globalShellProcess = spawn('python', [
    getAssetPath('services/stream_worker.py'),
    nativeShell,
    workingDir
  ]);

  activeWorkers.set(targetId, globalShellProcess);

  globalShellProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'log') {
          event.sender.send('terminal-log', { commandId: null, text: parsed.text });
        }
      } catch (e) {
        event.sender.send('terminal-log', { commandId: null, text: data.toString() });
      }
    });
  });
});

ipcMain.on('cmd-terminal-input', (event, { commandId, text }) => {
  const targetId = commandId || 'global_shell';
  const workerProcess = activeWorkers.get(targetId);

  if (workerProcess && !workerProcess.killed) {
    workerProcess.stdin.write(text + '\n');
  } 
});

ipcMain.on('cmd-clear-logs', (event, { projectId, commandId }) => {
  const db = readDatabase();
  const project = db.projects.find(p => p.id == projectId);

  if (project) {
    const cmdConfig = project.commands.find(c => c.id == commandId);
    if (cmdConfig) {
      cmdConfig.logs = ""; 

      if (cmdConfig.status === 'running') {
        cmdConfig.logs = "[system] Terminal logs cleared while process is running...\r\n";      
      }
      writeDatabase(db);
      event.sender.send('db-refreshed', db);
    }
  }
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

ipcMain.handle('db-get', () => readDatabase());

ipcMain.handle('db-set', (event, data) => { 
  try {
    if (!data || !Array.isArray(data.projects)) {
      const fallback = readDatabase();
      writeDatabase(fallback);
      updateTrayMenu(fallback);
      return false;
    }
    writeDatabase(data); 
    updateTrayMenu(data); 
    return true; 
  } catch (ipcErr) {
    console.error('[Main Process] Error occurring inside db-set handler loop:', ipcErr);
    throw ipcErr;
  }
});

function createTray() {
  tray = new Tray(path.join(__dirname, 'src/assets/logo/stacklogo.ico'));
  tray.setToolTip('StackConsole V2');
  
  const activeState = readDatabase();
  updateTrayMenu(activeState);
}

app.whenReady().then(() => {
  if (!checkPythonAvailable()) {
    dialog.showErrorBox(
      'Python Not Found',
      'StackConsole requires Python to be installed and available on your system PATH.\n\nPlease install Python from https://www.python.org/downloads/ and restart the application.'
    );
    app.quit();
    return;
  }

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  // Don't quit — app stays in tray
});