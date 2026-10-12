window.ui.initWindowControls();
const close = () => window.api.close();
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

let form = null;

async function init() {
  const db = await window.api.getStore();
  const project = db?.projects.find(p => p.id === db.activeProject);
  form = window.commandForm.mount(document.getElementById('CommandForm'), {}, {
    otherCommands: project?.commands || [],
    secretsEncrypted: db?.secretsEncrypted,
    projectDir: project?.baseDirectory || '',
  });
}

async function submit() {
  if (!form || !form.validate()) return;
  const db = await window.api.getStore();
  const currentProj = db.projects.find(p => p.id === db.activeProject);
  if (currentProj) {
    currentProj.commands = currentProj.commands || [];
    currentProj.commands.push({ id: window.ui.newCommandId(currentProj.commands), ...form.values() });
    await window.api.setStore(db);
  }
  close();
}

document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
init();
