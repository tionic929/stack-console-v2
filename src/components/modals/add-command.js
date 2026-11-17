window.ui.initWindowControls();
const close = () => window.api.close();
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

let form = null;
let projectId = null; // fixed when the window opened, so a project switch elsewhere can't redirect the save (P5)

async function init() {
  const db = await window.api.getStore();
  projectId = window.ui.windowTarget(db).projectId;
  const project = db?.projects.find(p => p.id === projectId);
  if (!project) return close();
  form = window.commandForm.mount(document.getElementById('CommandForm'), {}, {
    otherCommands: project.commands || [],
    secretsEncrypted: db?.secretsEncrypted,
    projectDir: project.baseDirectory || '',
  });
}

async function submit() {
  if (!form || !form.validate()) return;
  const res = await window.api.addCommand(projectId, form.values());
  if (await window.ui.failed(res)) return;
  close();
}

document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
init();
