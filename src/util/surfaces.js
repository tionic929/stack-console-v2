// In-window surfaces that replace the separate tool windows (B-4, B-5), built on window.overlay:
// the Add / Edit command drawer, the New project and Import modals, and a rename modal used when a
// project has no visible tree row to rename inline. Every surface is fixed to the project (and command)
// it was opened for, so switching projects elsewhere can't redirect a save (P5).
(function () {
  const { esc } = window.ui;
  const ov = window.overlay;

  function formBody(intro) {
    const body = document.createElement('form');
    body.className = 'modal-body';
    body.noValidate = true;
    body.addEventListener('submit', (e) => e.preventDefault());
    if (intro) body.innerHTML = `<p class="modal-intro">${esc(intro)}</p>`;
    return body;
  }

  // Saving state, then either the error stays in the surface (nothing typed is lost) or it closes
  async function save(h, run) {
    h.showError('');
    h.setBusy(true);
    let res;
    try { res = await run(); } catch (e) { res = { ok: false, error: String(e?.message || e) }; }
    if (!res || res.ok === false) {
      h.setBusy(false);
      h.showError(res?.error || 'Couldn\'t save. Try again.');
      return null;
    }
    h.close('saved');
    return res;
  }

  // ── B-4: Add / Edit command in a drawer on the right; the log stays visible beside it ──
  // opts: { project, command (edit only), secretsEncrypted, live (edit only), onSaved({ commandId, restarted }) }
  async function commandDrawer({ project, command, secretsEncrypted, live, onSaved }) {
    const editing = !!command;
    const projectId = project.id;
    const commandId = command?.id || null;
    let form = null;
    let initial = '';
    const body = formBody(editing ? '' : `Add a process to ${project.name}. It shows up in the sidebar, ready to start.`);
    const submit = async (h, restart) => {
      if (!form || !form.validate()) return;
      const values = form.values();
      const res = await save(h, () => (editing
        ? window.api.updateCommand(projectId, commandId, values)
        : window.api.addCommand(projectId, values)));
      if (!res) return;
      if (restart) window.api.restartCommand({ projectId, commandId });
      ov.toast(editing ? (restart ? `Saved ${values.displayName}, restarting` : `Saved ${values.displayName}`) : `Added ${values.displayName}`);
      onSaved?.({ commandId: res.commandId || commandId, restarted: !!restart });
    };
    const actions = [{ label: 'Cancel', variant: 'secondary', run: (h) => h.requestClose() }];
    if (editing && live) actions.push({ label: 'Save and restart', variant: 'secondary', run: (h) => submit(h, true) });
    actions.push({ label: editing ? 'Save' : 'Add command', variant: 'primary', primary: true, run: (h) => submit(h, false) });

    const h = await ov.drawer({
      title: editing ? `Edit ${command.displayName}` : 'Add command',
      className: 'command-drawer',
      body,
      actions,
      dirty: () => !!form && JSON.stringify(form.values()) !== initial,
    });
    if (!h) return null; // another drawer had unsaved changes and the user kept editing
    // The form looks its fields up by id, so it mounts once the drawer is in the page
    form = window.commandForm.mount(body, command || {}, {
      otherCommands: project.commands || [],
      selfId: commandId,
      secretsEncrypted,
      projectDir: project.baseDirectory || '',
    });
    initial = JSON.stringify(form.values());
    return h;
  }

  // ── B-5: New project ──
  // onCreated({ projectId, name, folder })
  function newProjectModal({ onCreated } = {}) {
    const body = formBody();
    body.insertAdjacentHTML('beforeend', `
      <div class="form-group">
        <label for="NpName">Project name</label>
        <input type="text" class="input-field" id="NpName" placeholder="e.g. PayrollMS" aria-describedby="NpErr" required autofocus>
        <span class="field-error" id="NpErr" role="alert"></span>
      </div>
      <div class="form-group">
        <label for="NpDir">Project folder <span class="label-optional">(optional)</span></label>
        <div class="input-with-action">
          <input type="text" class="input-field mono" id="NpDir" spellcheck="false" aria-describedby="NpHint">
          <button type="button" class="btn-secondary" id="NpBrowse">Browse…</button>
        </div>
        <span class="field-hint" id="NpHint">Commands run here. StackConsole can import the ones it finds (package.json, artisan, Procfile).</span>
      </div>`);
    const name = body.querySelector('#NpName');
    const dir = body.querySelector('#NpDir');
    const err = body.querySelector('#NpErr');
    const fieldError = (message) => {
      err.textContent = message;
      name.setAttribute('aria-invalid', message ? 'true' : 'false');
      if (message) name.focus();
    };
    name.addEventListener('input', () => fieldError(''));
    body.querySelector('#NpBrowse').addEventListener('click', async () => {
      const picked = await window.api.selectDirectory();
      if (picked) dir.value = picked;
    });
    return ov.modal({
      title: 'New project',
      body,
      width: '480px',
      dirty: () => !!(name.value.trim() || dir.value.trim()),
      actions: [
        { label: 'Cancel', variant: 'secondary', run: (h) => h.requestClose() },
        {
          label: 'Create project', variant: 'primary', primary: true,
          run: async (h) => {
            const projectName = name.value.trim();
            if (!projectName) return fieldError('Give the project a name.');
            const folder = dir.value.trim();
            const res = await save(h, () => window.api.addProject(projectName, folder));
            if (!res) return;
            onCreated?.({ projectId: res.projectId, name: projectName, folder });
          },
        },
      ],
    });
  }

  // ── B-5: Import commands found in the project folder. Servers and workers come pre-ticked ──
  function importModal({ projectId, onImported } = {}) {
    const body = document.createElement('div');
    body.className = 'modal-body';
    body.innerHTML = `
      <p class="modal-intro" id="ImIntro">Looking for commands…</p>
      <p class="field-hint hint-warn" id="ImSkipped" role="note" hidden></p>
      <div class="stacked-list-box" id="ImList" role="group" aria-labelledby="ImIntro" hidden></div>`;
    const found = [];
    const list = body.querySelector('#ImList');
    const intro = body.querySelector('#ImIntro');
    const selected = () => [...list.querySelectorAll('input[type="checkbox"]')].filter(cb => cb.checked).map(cb => found[Number(cb.dataset.index)]);

    const h = ov.modal({
      title: 'Import commands',
      body,
      width: '560px',
      actions: [
        { label: 'Cancel', variant: 'secondary', run: (hh) => hh.requestClose() },
        {
          label: 'Import', variant: 'primary', primary: true,
          run: async (hh) => {
            const items = selected().map(i => ({ name: i.name, command: i.command, icon: i.icon, workingDirectory: i.workingDirectory || '' }));
            if (!items.length) return;
            const res = await save(hh, () => window.api.importApply(items, projectId));
            if (!res) return;
            const n = res.added ?? items.length;
            ov.toast(n ? `Imported ${n} command${n === 1 ? '' : 's'}` : 'Nothing new to import');
            onImported?.(res);
          },
        },
      ],
    });
    const button = h.el.querySelector('.modal-footer-strip .btn-primary');
    const renderButton = () => {
      const n = selected().length;
      button.disabled = n === 0;
      button.textContent = n ? `Import ${n} command${n === 1 ? '' : 's'}` : 'Import';
    };
    renderButton();

    (async () => {
      const res = await window.api.importScan(projectId);
      if (h.closed) return;
      if (!res || !res.ok) { intro.textContent = res?.error || 'Could not read the project folder.'; return; }
      if (res.skipped && res.skipped.length) {
        const skipped = body.querySelector('#ImSkipped');
        skipped.textContent = `Skipped: ${res.skipped.map(s => `${s.file} ${s.reason}`).join('; ')}.`;
        skipped.hidden = false;
      }
      const total = res.groups.reduce((n, g) => n + g.items.length, 0);
      if (!total) {
        intro.textContent = `No new commands found in ${res.dir}. StackConsole looks at package.json, composer.json, Procfile, artisan and manage.py. Commands you already added are left out.`;
        return;
      }
      intro.textContent = `Found in ${res.dir}. Long-running servers and workers are ticked; edit names after importing.`;
      list.hidden = false;
      res.groups.forEach(group => {
        list.insertAdjacentHTML('beforeend', `<div class="import-group-title">${esc(group.source)}</div>`);
        group.items.forEach(item => {
          const index = found.push(item) - 1;
          const id = `im-${index}`;
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
    })();
    return h;
  }

  // ── Rename in a small modal: for a project with no visible tree row (collapsed section, rail) ──
  function renameModal({ project, onRenamed } = {}) {
    const body = formBody();
    body.insertAdjacentHTML('beforeend', `
      <div class="form-group">
        <label for="RnName">Project name</label>
        <input type="text" class="input-field" id="RnName" aria-describedby="RnErr" required autofocus>
        <span class="field-error" id="RnErr" role="alert"></span>
      </div>`);
    const input = body.querySelector('#RnName');
    input.value = project.name || '';
    const h = ov.modal({
      title: `Rename ${project.name}`,
      body,
      width: '420px',
      dirty: () => input.value.trim() !== (project.name || ''),
      actions: [
        { label: 'Cancel', variant: 'secondary', run: (hh) => hh.requestClose() },
        {
          label: 'Rename', variant: 'primary', primary: true,
          run: async (hh) => {
            const name = input.value.trim();
            if (!name) { body.querySelector('#RnErr').textContent = 'The project needs a name.'; input.focus(); return; }
            if (name === project.name) { hh.close(null); return; }
            if (await save(hh, () => window.api.renameProject(project.id, name))) onRenamed?.(name);
          },
        },
      ],
    });
    input.select();
    return h;
  }

  window.surfaces = { commandDrawer, newProjectModal, importModal, renameModal };
})();
