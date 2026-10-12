window.ui.initWindowControls();
const close = () => window.api.close();
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

let form = null;
let targetCommandId = null;

async function loadCommandData() {
  const db = await window.api.getStore();
  const currentProj = db?.projects.find(p => p.id === db.activeProject);
  if (!currentProj) return close();
  targetCommandId = db.activeCommandToEdit || (currentProj.commands[0] ? currentProj.commands[0].id : null);
  const cmdConfig = currentProj.commands.find(c => c.id === targetCommandId);
  if (!cmdConfig) return close();
  form = window.commandForm.mount(document.getElementById('CommandForm'), cmdConfig, {
    otherCommands: currentProj.commands,
    selfId: cmdConfig.id,
    secretsEncrypted: db.secretsEncrypted,
    projectDir: currentProj.baseDirectory || '',
  });
}

async function submit() {
  if (!form || !form.validate()) return;
  const db = await window.api.getStore();
  const currentProj = db.projects.find(p => p.id === db.activeProject);
  const cmdConfig = currentProj?.commands.find(c => c.id === targetCommandId);
  if (cmdConfig) {
    Object.assign(cmdConfig, form.values());
    await window.api.setStore(db);
  }
  close();
}

document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
loadCommandData();
