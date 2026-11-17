// window.api for the Tauri app: the same method names preload.js gave the Electron windows, on top
// of Tauri's invoke and events. The Tauri app injects this file into every window before the page's
// own scripts run, so no page needs a <script> tag for it. Under Electron, preload.js has already
// defined window.api and this file does nothing.
(function () {
  if (window.api || !window.__TAURI_INTERNALS__) return;

  const call = (method, args = {}) => window.__TAURI_INTERNALS__.invoke('api', { method, args });
  // Fire-and-forget calls (ipcRenderer.send in Electron): errors are logged, not thrown
  const send = (method, args) => { call(method, args).catch((e) => console.error(`[api] ${method}:`, e)); };
  const on = (event, handler) => {
    const start = () => window.__TAURI__.event.listen(event, (e) => handler(e.payload));
    if (window.__TAURI__) start();
    else window.addEventListener('DOMContentLoaded', start, { once: true });
  };

  window.api = {
    minimize: () => send('minimize'),
    maximize: () => send('maximize'),
    close: () => send('close'),

    // Tool windows open locked to the project (and command) they are for; it travels in their URL
    openAddCommand: (projectId) => send('openAddCommand', { projectId }),
    openEditCommand: (target) => send('openEditCommand', { target }),
    newProjectCommand: () => send('newProjectCommand'),
    editProjectName: (projectId) => send('editProjectName', { projectId }),
    openProjectManager: () => send('openProjectManager'),
    openImportCommands: (projectId) => send('openImportCommands', { projectId }),

    openCommandPrompt: () => send('openCommandPrompt'),
    sendTerminalInput: (payload) => send('sendTerminalInput', payload || {}),

    // Service actions take { projectId, commandId } (or a bare commandId = the active project)
    startCommand: (target) => send('startCommand', { target }),
    startCommandNow: (target) => send('startCommandNow', { target }),
    stopCommand: (target) => send('stopCommand', { target }),
    restartCommand: (target) => send('restartCommand', { target }),
    launchAll: (projectId) => send('launchAll', { projectId }),
    stopAll: (projectId) => send('stopAll', { projectId }),
    stopEverything: () => send('stopEverything'),
    setActiveProject: (projectId) => send('setActiveProject', { projectId }),

    openFolder: (projectId, commandId, target) => call('openFolder', { projectId, commandId, target }),
    setProjectFolder: (projectId, folder) => call('setProjectFolder', { projectId, folder }),
    relinkProject: (projectId) => call('relinkProject', { projectId }),
    archiveProject: (projectId, archived) => call('archiveProject', { projectId, archived }),
    folderInfo: (folder) => call('folderInfo', { folder }),
    pinProject: (projectId, pinned) => call('pinProject', { projectId, pinned }),
    setProjectIdentity: (projectId, choice) => call('setProjectIdentity', { projectId, ...(choice || {}) }),
    archiveEmptyProjects: () => call('archiveEmptyProjects'),

    // Master folders: folders are picked in the app's own dialog, never sent by a window
    addRoot: (opts) => call('addRoot', opts || {}),
    confirmRootReplace: () => call('confirmRootReplace'),
    removeRoot: (root) => call('removeRoot', { root }),
    moveRoot: (root, delta) => call('moveRoot', { root, delta }),
    rescanRoot: (root) => call('rescanRoot', { root }),
    openRoot: (root) => call('openRoot', { root }),
    changeRootPick: (root) => call('changeRootPick', { root }),
    changeRootApply: () => call('changeRootApply'),
    relinkRoot: (root) => call('relinkRoot', { root }),
    dismissRootPrompt: () => call('dismissRootPrompt'),
    hideRepo: (path, hidden) => call('hideRepo', { path, hidden }),
    setUpRepo: (path, mode) => call('setUpRepo', { path, mode }),

    splitPreview: (projectId) => call('splitPreview', { projectId }),
    splitApply: (projectId) => call('splitApply', { projectId }),
    combineCandidates: (projectId) => call('combineCandidates', { projectId }),
    combinePreview: (projectIds) => call('combinePreview', { projectIds }),
    combineApply: (projectIds, name) => call('combineApply', { projectIds, name }),

    checkPort: (target) => call('checkPort', { target }),
    freePort: (pid) => call('freePort', { pid }),
    importScan: (projectId) => call('importScan', { projectId }),
    importApply: (items, projectId) => call('importApply', { items, projectId }),

    // Specific changes, each naming its project (replace setStore; Phase B)
    addProject: (name, baseDirectory) => call('addProject', { name, baseDirectory }),
    renameProject: (projectId, name) => call('renameProject', { projectId, name }),
    deleteProject: (projectId) => call('deleteProject', { projectId }),
    addCommand: (projectId, command) => call('addCommand', { projectId, command }),
    updateCommand: (projectId, commandId, command) => call('updateCommand', { projectId, commandId, command }),
    removeCommand: (projectId, commandId) => call('removeCommand', { projectId, commandId }),
    duplicateCommand: (projectId, commandId) => call('duplicateCommand', { projectId, commandId }),

    getLogs: (projectId, commandId) => call('getLogs', { projectId, commandId }),
    clearLogs: (projectId, commandId) => send('clearLogs', { projectId, commandId }),
    openExternal: (url) => send('openExternal', { url }),

    selectDirectory: () => call('selectDirectory'),

    getStore: () => call('getStore'),
    // Deprecated: whole-config save; the interface no longer uses it
    setStore: (data) => call('setStore', { data }),

    onDataUpdate: (callback) => on('db-refreshed', callback),
    onTerminalLog: (callback) => on('terminal-logs', (lines) => lines.forEach(callback)),
    // Tauri only: one call per batch of lines (the main window uses this when it exists)
    onTerminalLogBatch: (callback) => on('terminal-logs', callback),
    onSelectCommand: (callback) => on('select-command', callback),

    onRequestCloseConfirmation: (callback) => on('request-close-confirmation', () => callback()),
    confirmAppExit: () => send('confirmAppExit'),
    minimizeToTray: () => send('minimizeToTray'),
  };
})();
