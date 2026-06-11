let appState = null;
let currentSelectedCmdId = null;

document.getElementById('WinBtnMin').addEventListener('click', () => window.api.minimize());
document.getElementById('WinBtnMax').addEventListener('click', () => window.api.maximize());
document.getElementById('WinBtnClose').addEventListener('click', () => window.api.close());

document.getElementById('TriggerProjManager').addEventListener('click', () => window.api.openProjectManager());
document.getElementById('TriggerLaunchAll').addEventListener('click', () => window.api.launchAll());
document.getElementById('TriggerStopAll').addEventListener('click', () => window.api.stopAll());

document.getElementById('BtnStart').addEventListener('click', () => {
  if (currentSelectedCmdId) window.api.startCommand(currentSelectedCmdId);
});
document.getElementById('BtnStop').addEventListener('click', () => {
  if (currentSelectedCmdId) window.api.stopCommand(currentSelectedCmdId);
});
document.getElementById('BtnRestart').addEventListener('click', () => {
  if (currentSelectedCmdId) {
    window.api.stopCommand(currentSelectedCmdId);
    setTimeout(() => window.api.startCommand(currentSelectedCmdId), 800);
  }
});

async function initializeConsole() {
  appState = await window.api.getStore();
  renderSidebarLayout();
}

function renderSidebarLayout() {
  const container = document.getElementById('ProcessWrapperList');
  container.innerHTML = '';
  if (!appState || !appState.projects) return;

  const project = appState.projects.find(p => p.id === appState.activeProject);
  if (!project) {
    document.getElementById('ProjectBadgeLink').textContent = '(None)';
    document.getElementById('ServiceName').textContent = '--';
    document.getElementById('TerminalLogs').innerHTML = '<span class="t-gray">No active project found. Open Project Manager to get started.</span>';
    return;
  }

  document.getElementById('ProjectBadgeLink').textContent = `(${project.name})`;

  project.commands.forEach((cmd, idx) => {
    if (!currentSelectedCmdId && idx === 0) currentSelectedCmdId = cmd.id;

    const row = document.createElement('button');
    row.className = `svc-row ${cmd.id === currentSelectedCmdId ? 'active' : ''}`;
    
    const words = cmd.displayName.split(' ');
    const shortCode = words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : cmd.displayName.substring(0, 2).toUpperCase();

    let avatarBg = 'var(--slate6)';
    if (cmd.displayName.includes('Laravel')) avatarBg = '#E5484D';
    else if (cmd.displayName.includes('Queue')) avatarBg = '#E7BA11';
    else if (cmd.displayName.includes('Vite')) avatarBg = '#6E56CF';
    else if (cmd.displayName.includes('Ngrok')) avatarBg = '#30A46C';

    row.innerHTML = `
      <div class="svc-meta-left">
        <div class="svc-avatar" style="background-color: ${avatarBg};">${shortCode}</div>
        <div class="svc-title-stack">
          <span class="svc-name">${cmd.displayName}</span>
          <span class="svc-port-sub">:${cmd.port || '80'}</span>
        </div>
      </div>
      <div class="status-dot ${cmd.status}"></div>
    `;

    row.addEventListener('click', () => {
      currentSelectedCmdId = cmd.id;
      renderSidebarLayout();
    });

    container.appendChild(row);
  });

  if (currentSelectedCmdId !== null){
    renderActiveConsole();
  } else {
    // Show terminal input line when viewing the Global Command Prompt
    const inputLineContainer = document.getElementById('TerminalInputLine');
    if (inputLineContainer) inputLineContainer.style.display = 'flex';
  }
  renderFooterSummary(project);
}

function renderActiveConsole() {
  // Hide terminal input line for all standard non-interactive command outputs
  const inputLineContainer = document.getElementById('TerminalInputLine');
  if (inputLineContainer) inputLineContainer.style.display = 'none';

  if (!appState || !appState.projects) return;
  const project = appState.projects.find(p => p.id === appState.activeProject);
  const cmd = project?.commands.find(c => c.id === currentSelectedCmdId);
  
  if (!cmd) {
    document.getElementById('ServiceName').textContent = '--';
    document.getElementById('ServiceMetaPid').textContent = '';
    document.getElementById('TerminalLogs').innerHTML = '<span class="t-gray">No selected commands running in workspace context.</span>';
    return;
  }

  document.getElementById('ServiceName').textContent = cmd.displayName;
  document.getElementById('ServiceMetaPid').textContent = cmd.pid ? `:${cmd.port || '80'} — pid ${cmd.pid}` : `:${cmd.port || '80'} — inactive`;
  
  const statusPill = document.getElementById('StatusPill');
  statusPill.setAttribute('data-status', cmd.status);
  document.getElementById('StatusPillLabel').textContent = cmd.status.toUpperCase();

  document.getElementById('TerminalLogs').innerHTML = cmd.logs ? window.ansiParser.ansiToHtml(cmd.logs) : '<span class="t-gray">Console initialized. Waiting for runtime metrics...</span>';
  
  const term = document.getElementById('Terminal');
  term.scrollTop = term.scrollHeight;
}

function renderFooterSummary(project) {
  const running = project.commands.filter(c => c.status === 'running').length;
  const starting = project.commands.filter(c => c.status === 'warning').length;
  const offline = project.commands.filter(c => c.status === 'offline').length;
  
  document.getElementById('FooterStatusBarSummary').innerHTML = 
    `${running} running &nbsp; ${starting} starting &nbsp;&bull;&nbsp; ${offline} offline`;
}

document.getElementById('BtnOpenCmd').addEventListener('click', () => {
  currentSelectedCmdId = null; // Unset process context to focus the global shell layout
  
  document.querySelectorAll('.svc-row').forEach(row => row.classList.remove('active'));
  
  document.getElementById('ServiceName').textContent = 'Global Command Prompt';
  document.getElementById('ServiceMetaPid').textContent = 'Interactive shell environment';
  
  const statusPill = document.getElementById('StatusPill');
  statusPill.setAttribute('data-status', 'running');
  document.getElementById('StatusPillLabel').textContent = 'SHELL';
  
  document.getElementById('TerminalLogs').innerHTML = '';  
  
  // Explicitly enable terminal input display line for the Global Command Prompt link
  const inputLineContainer = document.getElementById('TerminalInputLine');
  if (inputLineContainer) inputLineContainer.style.display = 'flex';

  window.api.openCommandPrompt();
});

const terminalInput = document.getElementById('TerminalInput');
const terminalContainer = document.getElementById('Terminal');

terminalContainer.addEventListener('click', () => {
  // Redirect focus only if on the global interactive prompt view shell
  if (currentSelectedCmdId === null && terminalInput) {
    terminalInput.focus();
  }
});

terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    // Safety lock: Absolutely do nothing if looking at process logs
    if (currentSelectedCmdId !== null) return;

    const rawCommand = terminalInput.value.trim();
    if (!rawCommand) return;

    const project = appState?.projects?.find(p => p.id === appState.activeProject);
    document.getElementById('TerminalLogs').insertAdjacentHTML('beforeend', `\n<span style="color: #30A46C;">$ ${rawCommand}</span>\n`);
    
    window.api.sendTerminalInput({
      projectId: project?.id || null,
      commandId: null, // Always targeted to global worker standard inputs
      text: rawCommand
    });

    terminalInput.value = '';
    terminalContainer.scrollTop = terminalContainer.scrollHeight;
  }
});

document.getElementById('ClearLogsBtn').addEventListener('click', () => {
  if (currentSelectedCmdId === null) {
    document.getElementById('TerminalLogs').innerHTML = '';
    return;
  }
  const project = appState.projects.find(p => p.id == appState.activeProject);
  const cmd = project?.commands.find(c => c.id == currentSelectedCmdId);
  if (cmd) {
    cmd.logs = '';
    document.getElementById('TerminalLogs').innerHTML = ''; 
    window.api.clearLogs(project.id, cmd.id);
  }
});

window.api.onTerminalLog((payload) => {
  if (payload.commandId === null && currentSelectedCmdId === null) {
    const term = document.getElementById('Terminal');
    const logsContainer = document.getElementById('TerminalLogs');
    const shouldScroll = term.scrollTop + term.clientHeight >= term.scrollHeight - 50;
    
    logsContainer.insertAdjacentHTML('beforeend', window.ansiParser.ansiToHtml(payload.text));
    if (shouldScroll) {
      term.scrollTop = term.scrollHeight;
    }
    return;
  }

  if (!appState) return;
  const project = appState.projects.find(p => p.id === appState.activeProject);
  const cmd = project?.commands.find(c => c.id === payload.commandId);
  
  if (cmd) {
    cmd.logs = (cmd.logs || "") + payload.text;

    if (payload.commandId === currentSelectedCmdId) {
      const term = document.getElementById('Terminal');
      const logsContainer = document.getElementById('TerminalLogs');
      const shouldScroll = term.scrollTop + term.clientHeight >= term.scrollHeight - 50;
      
      logsContainer.insertAdjacentHTML('beforeend', window.ansiParser.ansiToHtml(payload.text));
      if (shouldScroll) {
        term.scrollTop = term.scrollHeight;
      }
    }
  }
});

window.api.onDataUpdate((updatedData) => {
  appState = updatedData;
  renderSidebarLayout();
});

initializeConsole();