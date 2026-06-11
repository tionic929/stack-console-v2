const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  
  openAddCommand: () => ipcRenderer.send('route-add-command'),
  openEditCommand: () => ipcRenderer.send('route-edit-command'),
  newProjectCommand: () => ipcRenderer.send('route-new-project-command'),
  openProjectManager: () => ipcRenderer.send('route-project-manager'),

  openCommandPrompt: () => ipcRenderer.send('route-command-prompt'),
  sendTerminalInput: (payload) => ipcRenderer.send('cmd-terminal-input', payload),

  startCommand: (commandId) => ipcRenderer.send('cmd-start', commandId),
  stopCommand: (commandId) => ipcRenderer.send('cmd-stop', commandId),
  launchAll: () => ipcRenderer.send('cmd-launch-all'),
  stopAll: () => ipcRenderer.send('cmd-stop-all'),
  
  clearLogs: (projectId, commandId) => ipcRenderer.send('cmd-clear-logs', {projectId, commandId}),
  
  selectDirectory: () => ipcRenderer.invoke('open-dir-picker'),

  getStore: () => ipcRenderer.invoke('db-get'),
  setStore: (data) => ipcRenderer.invoke('db-set', data),
  
  onDataUpdate: (callback) => ipcRenderer.on('db-refreshed', (event, data) => callback(data)),
  onTerminalLog: (callback) => ipcRenderer.on('terminal-log', (event, payload) => callback(payload)),

  onRequestCloseConfirmation: (callback) => ipcRenderer.on('request-close-confirmation', () => callback()),
  confirmAppExit: () => ipcRenderer.invoke('confirm-app-exit')
});