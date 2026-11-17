window.ui.initWindowControls();
const close = () => window.api.close();
document.getElementById('WinBtnClose').addEventListener('click', close);
document.getElementById('BtnCancel').addEventListener('click', close);

let form = null;
let target = null; // { projectId, commandId }, fixed when the window opened (P5, D1)

async function loadCommandData() {
  const db = await window.api.getStore();
  target = window.ui.windowTarget(db);
  // Older callers set the command as a hint instead of passing it; never fall back to "the first command" (D1)
  if (!target.commandId) target.commandId = db?.activeCommandToEdit || null;
  const project = db?.projects.find(p => p.id === target.projectId);
  const cmdConfig = project?.commands.find(c => c.id === target.commandId);
  if (!cmdConfig) return close();
  form = window.commandForm.mount(document.getElementById('CommandForm'), cmdConfig, {
    otherCommands: project.commands,
    selfId: cmdConfig.id,
    secretsEncrypted: db.secretsEncrypted,
    projectDir: project.baseDirectory || '',
  });
}

async function submit() {
  if (!form || !form.validate()) return;
  const res = await window.api.updateCommand(target.projectId, target.commandId, form.values());
  if (await window.ui.failed(res)) return;
  close();
}

document.getElementById('BtnApply').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
loadCommandData();
