// Configure V8 Engine flags BEFORE app lifecycle initialization to optimize memory allocations
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { worker } = require('cluster');

// Force V8 JavaScript runtime engine to aggressively garbage collect heap allocations
app.commandLine.appendSwitch('js-flags', '--max-semi-space-size=1 --max-old-space-size=32 --optimize-for-size');
// Disable heavy, unused browser subsystem caches to reclaim memory footprint
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-speech-api');
app.commandLine.appendSwitch('audio-buffer-size', '4096');

let mainWindow = null;
let addCommandWindow = null;
let editCommandWindow = null;
let addNewProjectWindow = null;
let projectManagerWindow = null;
let isQuittingFromModal = false;

const dbPath = path.join(__dirname, 'data/projects.json');
const defaultSchema = { activeProject: "", projects: [] };

const activeProcesses = new Map();
const activeWorkers = new Map();
const MAX_LOG_LENGTH = 10000; 

function readDatabase() {
  try {
    if(!fs.existsSync(dbPath)) {
      fs.writeFileSync(dbPath, JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return defaultSchema;
    }

    const rawData = fs.readFileSync(dbPath, 'utf8').trim();
    if(!rawData) {
      fs.writeFileSync(dbPath, JSON.stringify(defaultSchema, null, 2), 'utf-8');
      return defaultSchema;
    }
    return JSON.parse(rawData);
  } catch (err) {
    console.error("Database reading error, resolving empty context:", err);
    try {
      fs.writeFileSync(dbPath, JSON.stringify(defaultSchema, null, 2), 'utf-8');
    }
    catch (writeErr) {
      console.error("Critical fallback write disk exception:", writeErr);
    }
    return defaultSchema;
  }
}

function writeDatabase(data) {
  try {
    const payload = data || defaultSchema;
    const jsonString = JSON.stringify(payload, null, 2);

    fs.writeFileSync(dbPath, jsonString, 'utf8');
    
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

  setTimeout(() => {
    try {
      const pythonScriptPath = path.join(__dirname, 'services/stream_worker.py');
      
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
        spawn('taskkill', ['/pid', child.pid, '/f', '/t']);
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
    if (project.status === 'running'){

    }
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
    icon: path.join(__dirname, 'src/assets/logo/stacklogo.ico'), // Forces taskbar tracking to use your custom icon asset
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      enableWebSQL: false
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

    if(mainWindow && mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('request-close-confirmation');
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null;
    
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

ipcMain.on('confirm-app-exit', async() => {
  isQuittingFromModal = true;
  const db = readDatabase();

  db.projects.forEach(p => {
    p.commands.forEach (c => executionEngineStopCleanup(db, p.id, c));
  });

  activeWorkers.forEach((proc) => {
    if (proc && !proc.killed) proc.kill();
  });
  activeWorkers.clear();
  app.quit();
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
  
  // Clean up any lingering shell instance
  if (activeWorkers.has(targetId)) {
    const oldWorker = activeWorkers.get(targetId);
    if (!oldWorker.killed) oldWorker.kill();
    activeWorkers.delete(targetId);
  }

  // Get active directory from your database layout 
  const db = readDatabase(); 
  const activeProject = db.projects.find(p => p.id === db.activeProject);
  const workingDir = activeProject ? activeProject.baseDirectory : app.getPath('home');
  const nativeShell = process.platform === 'win32' ? 'cmd.exe' : 'bash';

  // Spawn your unchanged Python worker script
  const globalShellProcess = spawn('python', [
    path.join(__dirname, 'services/stream_worker.py'),
    nativeShell,
    workingDir
  ]);

  // Register it so cmd-terminal-input can find it!
  activeWorkers.set(targetId, globalShellProcess);

  // Stream stdout logs back to the renderer terminal wrapper
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
        // Fallback capture for unformatted data bursts
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
  // Match precisely via loose equality on your actual data elements
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
      return false;
    }
    writeDatabase(data); 
    return true; 
  } catch (ipcErr) {
    console.error('[Main Process] Error occurring inside db-set handler loop:', ipcErr);
    throw ipcErr;
  }
});

app.whenReady().then(createMainWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});