const { esc, avatar, statusIndicator, statusLabel, normalizeStatus, portOf, newCommandId, confirmDialog } = window.ui;
const $ = (id) => document.getElementById(id);
let dbContext = null;
let localSelectedCmdId = null;

window.ui.initWindowControls();
$('WinBtnClose').addEventListener('click', () => window.api.close());
$('MgrCloseWindow').addEventListener('click', () => window.api.close());
$('MgrAddCmd').addEventListener('click', () => window.api.openAddCommand());
$('MgrImport').addEventListener('click', () => window.api.openImportCommands());
$('BtnNewProject').addEventListener('click', () => window.api.newProjectCommand());
$('BtnEditProjectName').addEventListener('click', () => window.api.editProjectName());

function currentProject() {
  return dbContext?.projects?.find(p => p.id === dbContext.activeProject) || null;
}

function selectedCommand() {
  return currentProject()?.commands?.find(c => c.id === localSelectedCmdId) || null;
}

$('MgrEditCmd').addEventListener('click', async () => {
  if (!selectedCommand()) return;
  dbContext.activeCommandToEdit = localSelectedCmdId;
  await window.api.setStore(dbContext);
  window.api.openEditCommand();
});

$('MgrStartCmd').addEventListener('click', () => {
  if (selectedCommand()) window.api.startCommand({ projectId: dbContext.activeProject, commandId: localSelectedCmdId });
});

// Archive hides a project under "Archived" in the main window's tree (not allowed while it runs)
$('BtnArchiveProject').addEventListener('click', async () => {
  const current = currentProject();
  if (!current) return;
  const res = await window.api.archiveProject(current.id, !current.archived);
  if (res && !res.ok) {
    await confirmDialog({ title: 'Couldn\'t change the project', body: res.error || 'Try again.', actions: [{ label: 'OK', value: null, variant: 'primary', autofocus: true }] });
  }
});

$('BtnDeleteProject').addEventListener('click', async () => {
  const current = currentProject();
  if (!current) return;
  const count = (current.commands || []).length;
  const choice = await confirmDialog({
    title: `Delete "${current.name}"?`,
    body: `This removes the project and its ${count} command${count === 1 ? '' : 's'} from StackConsole. Files on disk are not touched.`,
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: 'Delete project', value: 'delete', variant: 'danger-solid' },
    ],
  });
  if (choice !== 'delete') return;
  dbContext.projects = dbContext.projects.filter(p => p.id !== current.id);
  dbContext.activeProject = dbContext.projects.length > 0 ? dbContext.projects[0].id : '';
  localSelectedCmdId = null;
  await window.api.setStore(dbContext);
});

$('ProjectDropdownSelector').addEventListener('change', (e) => {
  localSelectedCmdId = null;
  window.api.setActiveProject(e.target.value);
});

$('BtnBrowseDirectory').addEventListener('click', async () => {
  const current = currentProject();
  if (!current) return;
  const selectedPath = await window.api.selectDirectory();
  if (selectedPath) {
    current.baseDirectory = selectedPath;
    await window.api.setStore(dbContext);
  }
});

$('MgrDupCmd').addEventListener('click', async () => {
  const current = currentProject();
  const source = selectedCommand();
  if (!current || !source) return;
  // Copy the configuration only (runtime fields are stripped by main anyway)
  const { id, displayName, status, pid, startedAt, url, detectedPort, exitCode, ready, waitingFor, blockedBy, restartAttempt, restartGaveUp, envSummary, ...config } = source;
  const duplicate = { ...JSON.parse(JSON.stringify(config)), id: newCommandId(current.commands), displayName: `${displayName} (copy)` };
  current.commands.push(duplicate);
  localSelectedCmdId = duplicate.id;
  await window.api.setStore(dbContext);
});

$('MgrRemoveCmd').addEventListener('click', async () => {
  const current = currentProject();
  const target = selectedCommand();
  if (!current || !target) return;
  const running = ['running', 'starting', 'waiting'].includes(normalizeStatus(target.status));
  const choice = await confirmDialog({
    title: `Remove "${target.displayName}"?`,
    body: running ? 'It is running and will be stopped, then removed from this project.' : 'The command is removed from this project.',
    actions: [
      { label: 'Cancel', value: null, variant: 'secondary', autofocus: true },
      { label: running ? 'Stop and remove' : 'Remove', value: 'remove', variant: 'danger-solid' },
    ],
  });
  if (choice !== 'remove') return;
  current.commands = current.commands.filter(c => c.id !== target.id);
  localSelectedCmdId = null;
  await window.api.setStore(dbContext);
});

function render() {
  renderDropdown();
  renderCommands();
  renderStats();
  renderActions();
}

function renderDropdown() {
  const select = $('ProjectDropdownSelector');
  select.innerHTML = '';
  (dbContext.projects || []).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.archived ? `${p.name} (archived)` : p.name;
    select.appendChild(opt);
  });
  if (!dbContext.projects?.length) select.innerHTML = '<option value="">No projects yet</option>';
  select.value = dbContext.activeProject;
}

function renderCommands() {
  const box = $('CommandsListBox');
  const focusedId = document.activeElement?.dataset?.cmdId;
  box.innerHTML = '';
  const current = currentProject();
  $('InpBaseDir').value = current?.baseDirectory || '';
  if (!current) return;

  if (!current.commands?.length) {
    box.innerHTML = current.baseDirectory
      ? '<div class="list-empty">No commands yet. Add one, or import the ones your project folder already lists.</div>'
      : '<div class="list-empty">No commands yet. Add one, or choose the project folder (Browse…) to import the ones it lists.</div>';
    return;
  }

  current.commands.forEach(cmd => {
    const status = normalizeStatus(cmd.status);
    const port = portOf(cmd);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'stacked-list-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', cmd.id === localSelectedCmdId ? 'true' : 'false');
    item.dataset.cmdId = cmd.id;
    item.innerHTML = `
      ${avatar(cmd)}
      <span class="svc-title-stack">
        <span class="svc-name">${esc(cmd.displayName)}</span>
        <span class="svc-port-sub mono">${esc(cmd.command || '')}</span>
      </span>
      <span class="svc-port-sub">${esc(statusLabel(status))}${port ? ` · :${esc(port)}` : ''}</span>
      ${statusIndicator(status)}`;
    item.addEventListener('click', () => {
      localSelectedCmdId = cmd.id;
      render();
      box.querySelector(`[data-cmd-id="${CSS.escape(cmd.id)}"]`)?.focus();
    });
    item.addEventListener('dblclick', () => $('MgrEditCmd').click());
    box.appendChild(item);
  });

  if (focusedId) box.querySelector(`[data-cmd-id="${CSS.escape(focusedId)}"]`)?.focus();
}

function renderStats() {
  const current = currentProject();
  const cmds = current?.commands || [];
  const running = cmds.filter(c => normalizeStatus(c.status) === 'running').length;
  $('ProjectStats').textContent = cmds.length ? `${cmds.length} total · ${running} running` : '';
}

function renderActions() {
  const project = currentProject();
  const cmd = selectedCommand();
  const live = cmd && ['running', 'starting', 'waiting'].includes(normalizeStatus(cmd.status));
  ['BtnEditProjectName', 'BtnDeleteProject', 'BtnBrowseDirectory', 'MgrAddCmd', 'BtnArchiveProject'].forEach(id => { $(id).disabled = !project; });
  const projectLive = (project?.commands || []).some(c => ['running', 'starting', 'waiting'].includes(normalizeStatus(c.status)));
  $('BtnArchiveProject').textContent = project?.archived ? 'Unarchive' : 'Archive';
  if (project && !project.archived && projectLive) { $('BtnArchiveProject').disabled = true; $('BtnArchiveProject').title = 'Stop its services first'; }
  else $('BtnArchiveProject').title = '';
  $('MgrImport').disabled = !project || !project.baseDirectory;
  $('MgrImport').title = project && !project.baseDirectory ? 'Choose a project folder first' : '';
  ['MgrEditCmd', 'MgrDupCmd', 'MgrRemoveCmd'].forEach(id => { $(id).disabled = !cmd; });
  $('MgrStartCmd').disabled = !cmd || live;
  $('MgrStartCmd').textContent = live ? statusLabel(cmd.status) : 'Start';
  $('FooterHint').textContent = cmd ? `Selected: ${cmd.displayName}` : 'Select a command to edit, start or remove it.';
}

window.api.onDataUpdate((data) => {
  dbContext = data;
  render();
});

(async () => {
  dbContext = await window.api.getStore();
  render();
})();
