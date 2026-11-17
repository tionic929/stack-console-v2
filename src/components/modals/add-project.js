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
  const res = await window.api.addProject(rawName, document.getElementById('InpDir').value.trim());
  if (!res || !res.ok) return showError(res?.error || 'The project could not be created.');
  close();
}

nameInput.addEventListener('input', () => showError(''));
document.getElementById('BtnSave').addEventListener('click', submit);
window.commandForm.bindFormKeys(submit, close);
nameInput.focus();
