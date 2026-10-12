const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  openAddCommand: () => ipcRenderer.send('route-add-command'),
  openEditCommand: () => ipcRenderer.send('route-edit-command'),
  newProjectCommand: () => ipcRenderer.send('route-new-project-command'),
  editProjectName: () => ipcRenderer.send('route-edit-project-name'),
  openProjectManager: () => ipcRenderer.send('route-project-manager'),
  openImportCommands: () => ipcRenderer.send('route-import-commands'),

  openCommandPrompt: () => ipcRenderer.send('route-command-prompt'),
  sendTerminalInput: (payload) => ipcRenderer.send('cmd-terminal-input', payload),

  // Service actions take { projectId, commandId } (or a bare commandId = the active project)
  startCommand: (target) => ipcRenderer.send('cmd-start', target),
  startCommandNow: (target) => ipcRenderer.send('cmd-start-now', target),
  stopCommand: (target) => ipcRenderer.send('cmd-stop', target),
  restartCommand: (target) => ipcRenderer.send('cmd-restart', target),
  launchAll: (projectId) => ipcRenderer.send('cmd-launch-all', projectId),
  stopAll: (projectId) => ipcRenderer.send('cmd-stop-all', projectId),
  stopEverything: () => ipcRenderer.send('cmd-stop-everything'),
  setActiveProject: (projectId) => ipcRenderer.send('set-active-project', projectId),

  openFolder: (projectId, commandId, target) => ipcRenderer.invoke('folder-open', { projectId, commandId, target }),
  setProjectFolder: (projectId, folder) => ipcRenderer.invoke('project-set-folder', { projectId, folder }),
  relinkProject: (projectId) => ipcRenderer.invoke('project-relink', projectId),
  archiveProject: (projectId, archived) => ipcRenderer.invoke('project-archive', { projectId, archived }),
  folderInfo: (folder) => ipcRenderer.invoke('folder-info', folder),
  pinProject: (projectId, pinned) => ipcRenderer.invoke('project-pin', { projectId, pinned }),
  setProjectIdentity: (projectId, choice) => ipcRenderer.invoke('project-identity', { projectId, ...choice }),
  archiveEmptyProjects: () => ipcRenderer.invoke('projects-archive-empty'),

  // Master folders (D:\projects): folders are picked in main's own dialog, never sent by a window
  addRoot: (opts) => ipcRenderer.invoke('roots-add', opts),
  confirmRootReplace: () => ipcRenderer.invoke('roots-confirm-replace'),
  removeRoot: (root) => ipcRenderer.invoke('roots-remove', root),
  moveRoot: (root, delta) => ipcRenderer.invoke('roots-move', { root, delta }),
  rescanRoot: (root) => ipcRenderer.invoke('roots-rescan', root),
  openRoot: (root) => ipcRenderer.invoke('roots-open', root),
  changeRootPick: (root) => ipcRenderer.invoke('roots-change-pick', root),
  changeRootApply: () => ipcRenderer.invoke('roots-change-apply'),
  relinkRoot: (root) => ipcRenderer.invoke('roots-relink', root),
  dismissRootPrompt: () => ipcRenderer.invoke('roots-dismiss-prompt'),
  hideRepo: (path, hidden) => ipcRenderer.invoke('repo-hide', { path, hidden }),
  setUpRepo: (path, mode) => ipcRenderer.invoke('repo-setup', { path, mode }),

  splitPreview: (projectId) => ipcRenderer.invoke('project-split-preview', projectId),
  splitApply: (projectId) => ipcRenderer.invoke('project-split-apply', projectId),
  combineCandidates: (projectId) => ipcRenderer.invoke('project-combine-candidates', projectId),
  combinePreview: (projectIds) => ipcRenderer.invoke('project-combine-preview', projectIds),
  combineApply: (projectIds, name) => ipcRenderer.invoke('project-combine-apply', { projectIds, name }),

  checkPort: (target) => ipcRenderer.invoke('port-check', target),
  freePort: (pid) => ipcRenderer.invoke('port-free', pid),
  importScan: () => ipcRenderer.invoke('import-scan'),
  importApply: (items) => ipcRenderer.invoke('import-apply', items),

  getLogs: (projectId, commandId) => ipcRenderer.invoke('logs-get', { projectId, commandId }),
  clearLogs: (projectId, commandId) => ipcRenderer.send('cmd-clear-logs', {projectId, commandId}),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  selectDirectory: () => ipcRenderer.invoke('open-dir-picker'),

  getStore: () => ipcRenderer.invoke('db-get'),
  setStore: (data) => ipcRenderer.invoke('db-set', data),

  onDataUpdate: (callback) => ipcRenderer.on('db-refreshed', (event, data) => callback(data)),
  onTerminalLog: (callback) => ipcRenderer.on('terminal-log', (event, payload) => callback(payload)),
  onSelectCommand: (callback) => ipcRenderer.on('select-command', (event, payload) => callback(payload)),

  onRequestCloseConfirmation: (callback) => ipcRenderer.on('request-close-confirmation', () => callback()),
  confirmAppExit: () => ipcRenderer.send('confirm-app-exit'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray')
});
