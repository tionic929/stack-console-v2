window.ui.initWindowControls();
const close = () => window.api.close();
const nameInput = document.getElementById('InpProjName');
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

let projectId = null; // fixed when the window opened (P5)

function showError(message) {
  document.getElementById('ErrName').textContent = message;
  nameInput.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (message) nameInput.focus();
}

async function loadProjectData() {
  const db = await window.api.getStore();
  projectId = window.ui.windowTarget(db).projectId;
  const project = db?.projects.find(p => p.id === projectId);
  if (!project) return close();
  nameInput.value = project.name || '';
  nameInput.select();
}

async function submit() {
  const freshName = nameInput.value.trim();
  if (!freshName) return showError('The project needs a name.');
  const res = await window.api.renameProject(projectId, freshName);
  if (!res || !res.ok) return showError(res?.error || 'The name could not be saved.');
  close();
}

nameInput.addEventListener('input', () => showError(''));
document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
loadProjectData();
