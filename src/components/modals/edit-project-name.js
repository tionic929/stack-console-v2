window.ui.initWindowControls();
const close = () => window.api.close();
const nameInput = document.getElementById('InpProjName');
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

async function loadProjectData() {
  const db = await window.api.getStore();
  const project = db?.projects.find(p => p.id === db.activeProject);
  if (!project) return close();
  nameInput.value = project.name || '';
  nameInput.select();
}

async function submit() {
  const freshName = nameInput.value.trim();
  if (!freshName) {
    document.getElementById('ErrName').textContent = 'The project needs a name.';
    nameInput.setAttribute('aria-invalid', 'true');
    nameInput.focus();
    return;
  }
  const db = await window.api.getStore();
  const project = db?.projects.find(p => p.id === db.activeProject);
  if (project) {
    project.name = freshName;
    await window.api.setStore(db);
  }
  close();
}

document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
loadProjectData();
