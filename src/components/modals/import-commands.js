// Checklist of commands found in the project folder. Servers and workers are pre-ticked; one-off tasks aren't.
const { esc } = window.ui;
const $ = (id) => document.getElementById(id);
const close = () => window.api.close();
let found = [];

window.ui.initWindowControls();
$('WinBtnClose').addEventListener('click', close);
$('BtnCancel').addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

function selected() {
  return [...$('ImportList').querySelectorAll('input[type="checkbox"]')]
    .filter(cb => cb.checked)
    .map(cb => found[Number(cb.dataset.index)]);
}

function renderButton() {
  const n = selected().length;
  $('BtnImport').disabled = n === 0;
  $('BtnImport').textContent = n ? `Import ${n} command${n === 1 ? '' : 's'}` : 'Import';
}

async function init() {
  const res = await window.api.importScan();
  if (!res || !res.ok) {
    $('ImportIntro').textContent = res?.error || 'Could not read the project folder.';
    return;
  }
  // Files that exist but couldn't be used (invalid JSON, too large, outside the folder)
  if (res.skipped && res.skipped.length) {
    $('ImportSkipped').textContent = `Skipped: ${res.skipped.map(s => `${s.file} ${s.reason}`).join('; ')}.`;
    $('ImportSkipped').hidden = false;
  }

  const total = res.groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    $('ImportIntro').textContent = `No new commands found in ${res.dir}. StackConsole looks at package.json, composer.json, Procfile, artisan and manage.py. Commands you already added are left out.`;
    return;
  }

  $('ImportIntro').textContent = `Found in ${res.dir}. Long-running servers and workers are ticked; edit names after importing.`;
  const list = $('ImportList');
  list.hidden = false;
  res.groups.forEach(group => {
    list.insertAdjacentHTML('beforeend', `<div class="import-group-title">${esc(group.source)}</div>`);
    group.items.forEach(item => {
      const index = found.push(item) - 1;
      const id = `imp-${index}`;
      list.insertAdjacentHTML('beforeend', `
        <label class="import-item" for="${id}">
          <input type="checkbox" id="${id}" data-index="${index}" ${item.preselect ? 'checked' : ''}>
          <span class="svc-title-stack">
            <span class="svc-name">${esc(item.name)}</span>
            <span class="svc-port-sub mono" title="${esc(item.detail || item.command)}">${esc(item.command)}</span>
          </span>
          <span class="kind-tag" data-kind="${esc(item.kind)}">${esc(item.kind)}</span>
        </label>`);
    });
  });
  list.addEventListener('change', renderButton);
  renderButton();
  list.querySelector('input')?.focus();
}

$('BtnImport').addEventListener('click', async () => {
  const items = selected().map(i => ({ name: i.name, command: i.command, icon: i.icon, workingDirectory: i.workingDirectory || '' }));
  if (!items.length) return;
  $('BtnImport').disabled = true;
  await window.api.importApply(items);
  close();
});

init();
