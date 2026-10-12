window.ui.initWindowControls();
const close = () => window.api.close();
const nameInput = document.getElementById('InpName');
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

document.getElementById('BtnBrowse').addEventListener('click', async () => {
  const selectedPath = await window.api.selectDirectory();
  if (selectedPath) document.getElementById('InpDir').value = selectedPath;
});

function showError(message) {
  document.getElementById('ErrName').textContent = message;
  nameInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (message) nameInput.focus();
}

async function submit() {
  const rawName = nameInput.value.trim();
  if (!rawName) return showError('Give the project a name.');

  const db = await window.api.getStore();
  db.projects = db.projects || [];

  const systemId = rawName.replace(/\s+/g, '-').toLowerCase();
  if (db.projects.some(p => p.id === systemId)) {
    return showError(`A project called "${rawName}" already exists.`);
  }

  db.projects.push({
    id: systemId,
    name: rawName,
    baseDirectory: document.getElementById('InpDir').value.trim(),
    commands: []
  });
  db.activeProject = systemId;

  await window.api.setStore(db);
  close();
}

nameInput.addEventListener('input', () => showError(''));
document.getElementById('BtnSave').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
nameInput.focus();
