// Shared form for the Add / Edit command windows: fields, labelled controls, icon picker,
// crash policy, start order, environment variables, validation.
(function () {
  const FIELDS = `
    <div class="form-group">
      <label for="InpName">Display name</label>
      <input type="text" class="input-field" id="InpName" placeholder="e.g. Laravel Dev Server" aria-describedby="ErrName" required>
      <span class="field-error" id="ErrName" role="alert"></span>
    </div>

    <div class="form-group">
      <span class="field-label" id="IconLabel">Icon</span>
      <div class="icon-picker" id="IconPicker" role="radiogroup" aria-labelledby="IconLabel"></div>
    </div>

    <div class="form-group">
      <label for="InpCmd">Command</label>
      <input type="text" class="input-field mono" id="InpCmd" placeholder="e.g. php artisan serve" spellcheck="false" aria-describedby="ErrCmd" required>
      <span class="field-error" id="ErrCmd" role="alert"></span>
    </div>

    <div class="form-row-split">
      <div class="form-group" style="flex: 2;">
        <label for="InpDir">Working directory <span class="label-optional">(optional)</span></label>
        <div class="input-with-action">
          <input type="text" class="input-field mono" id="InpDir" placeholder="e.g. frontend" spellcheck="false" aria-describedby="HintDir">
          <button type="button" class="btn-secondary" id="BtnBrowseDir">Browse…</button>
        </div>
        <span class="field-hint" id="HintDir" aria-live="polite">Relative to the project folder, or any folder (another repo works too).</span>
      </div>
      <div class="form-group">
        <label for="InpPort">Port <span class="label-optional">(optional)</span></label>
        <input type="number" class="input-field mono" id="InpPort" placeholder="8000" min="1" max="65535" inputmode="numeric" aria-describedby="HintPort ErrPort">
        <span class="field-hint" id="HintPort">Checked before Start.</span>
        <span class="field-error" id="ErrPort" role="alert"></span>
      </div>
    </div>

    <section class="form-section" aria-labelledby="CrashHead">
      <div class="form-section-head"><span class="field-label" id="CrashHead">When it crashes</span></div>
      <div class="segmented" role="radiogroup" aria-labelledby="CrashHead" id="CrashPolicy">
        <button type="button" role="radio" data-value="stop">Leave it stopped</button>
        <button type="button" role="radio" data-value="restart">Restart automatically</button>
      </div>
      <div class="inline-row" id="RestartRow">
        <label for="InpRestartLimit" class="field-hint">Try</label>
        <input type="number" class="input-field narrow mono" id="InpRestartLimit" min="1" max="10" value="3" inputmode="numeric">
        <span class="field-hint">times, waiting 2s, 4s, 8s… then pause and keep it crashed.</span>
      </div>
      <label class="check-row"><input type="checkbox" id="InpNotify" checked> Show a Windows notification when it crashes and StackConsole isn't in front</label>
    </section>

    <section class="form-section" aria-labelledby="OrderHead">
      <div class="form-section-head"><span class="field-label" id="OrderHead">Start order</span></div>
      <div class="inline-row">
        <label for="InpStartAfter" class="field-hint">Start after</label>
        <select class="dropdown-select grow" id="InpStartAfter"></select>
        <span class="field-hint">is ready</span>
      </div>
      <div class="form-group">
        <label for="InpReadyPattern">Ready when this command prints <span class="label-optional">(optional)</span></label>
        <input type="text" class="input-field mono" id="InpReadyPattern" placeholder='e.g. Application startup complete' spellcheck="false" aria-describedby="HintReady">
        <span class="field-hint" id="HintReady">Other commands can wait for this one. Without a ready line it counts as ready when it prints a local URL (http://localhost:…) or when its port above starts listening.</span>
      </div>
      <div class="inline-row">
        <label for="InpDelay" class="field-hint">Extra delay</label>
        <input type="number" class="input-field narrow mono" id="InpDelay" value="0" min="0" step="0.5" inputmode="decimal" aria-describedby="ErrDelay">
        <span class="field-hint">seconds before starting</span>
        <span class="field-error" id="ErrDelay" role="alert"></span>
      </div>
    </section>

    <section class="form-section" aria-labelledby="EnvHead">
      <div class="form-section-head"><span class="field-label" id="EnvHead">Environment</span><span class="field-hint">Applies on next start</span></div>
      <div class="form-group">
        <label for="InpEnvFile">Load from .env file <span class="label-optional">(optional)</span></label>
        <input type="text" class="input-field mono" id="InpEnvFile" placeholder="e.g. .env.local" spellcheck="false" aria-describedby="HintEnvFile">
        <span class="field-hint" id="HintEnvFile">Relative to the working directory; must stay inside the project folder.</span>
      </div>
      <div id="EnvRows" class="form-group"></div>
      <div class="inline-row">
        <button type="button" class="btn-ghost btn-sm" id="BtnAddEnv">+ Add variable</button>
        <span class="field-hint">Values here override the file. On Windows, use %NAME% inside the command.</span>
      </div>
      <span class="field-hint" id="SecretHint"></span>
      <span class="field-error" id="ErrEnv" role="alert"></span>
    </section>`;

  const EYE = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const LOCK = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  const X = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  // options: { otherCommands: [{id, displayName, startAfter}], secretsEncrypted: bool, selfId }
  function mount(container, initial = {}, options = {}) {
    container.insertAdjacentHTML('beforeend', FIELDS);
    const $ = (id) => document.getElementById(id);
    const picker = $('IconPicker');
    let selectedIcon = initial.icon || '';
    let crashPolicy = initial.onCrash === 'restart' ? 'restart' : 'stop';

    // ── Icon picker (radiogroup)
    const iconOptions = [{ key: '', label: 'No icon (show initials)', svg: '<span aria-hidden="true">Aa</span>' }, ...window.iconMap.getAllIcons()];
    iconOptions.forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'icon-picker-item';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', opt.label);
      btn.title = opt.label;
      btn.dataset.key = opt.key;
      btn.innerHTML = opt.svg;
      btn.addEventListener('click', () => chooseIcon(opt.key, btn));
      picker.appendChild(btn);
    });

    function chooseIcon(key, focusEl) {
      selectedIcon = key;
      picker.querySelectorAll('.icon-picker-item').forEach(b => {
        const on = b.dataset.key === key;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      if (focusEl) focusEl.focus();
    }

    // Radiogroup keyboard pattern: arrows move the choice
    function arrowKeys(group, items, choose) {
      group.addEventListener('keydown', (e) => {
        const list = items();
        const i = list.indexOf(document.activeElement);
        if (i === -1) return;
        const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!delta) return;
        e.preventDefault();
        choose(list[(i + delta + list.length) % list.length]);
      });
    }
    arrowKeys(picker, () => [...picker.querySelectorAll('.icon-picker-item')], (el) => chooseIcon(el.dataset.key, el));

    // ── Crash policy
    const policy = $('CrashPolicy');
    function choosePolicy(value, focusEl) {
      crashPolicy = value;
      policy.querySelectorAll('[role="radio"]').forEach(b => {
        const on = b.dataset.value === value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      $('RestartRow').hidden = value !== 'restart';
      if (focusEl) focusEl.focus();
    }
    policy.querySelectorAll('[role="radio"]').forEach(b => b.addEventListener('click', () => choosePolicy(b.dataset.value, b)));
    arrowKeys(policy, () => [...policy.querySelectorAll('[role="radio"]')], (el) => choosePolicy(el.dataset.value, el));

    // ── Start order: no option may create a loop (A waits for B waits for A)
    const others = (options.otherCommands || []).filter(c => c.id !== options.selfId);
    const waitsOn = (id, target) => {
      const seen = new Set();
      let cur = id;
      while (cur && !seen.has(cur)) {
        if (cur === target) return true;
        seen.add(cur);
        cur = others.find(c => c.id === cur)?.startAfter || null;
      }
      return false;
    };
    const startAfter = $('InpStartAfter');
    startAfter.innerHTML = '<option value="">Nothing, start right away</option>';
    others.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      const loop = options.selfId && waitsOn(c.id, options.selfId);
      opt.textContent = loop ? `${c.displayName} (waits for this one)` : c.displayName;
      opt.disabled = !!loop;
      startAfter.appendChild(opt);
    });
    startAfter.value = others.some(c => c.id === initial.startAfter) ? initial.startAfter : '';

    // ── Environment rows
    const envRows = $('EnvRows');
    const secretHint = $('SecretHint');
    secretHint.textContent = options.secretsEncrypted === false
      ? 'Secrets can\'t be encrypted on this system and are saved as plain text in projects.json.'
      : '';
    secretHint.classList.toggle('hint-warn', options.secretsEncrypted === false);

    function addEnvRow(entry = {}) {
      const row = document.createElement('div');
      row.className = 'env-row';
      row.dataset.secret = entry.secret ? 'true' : 'false';
      row.dataset.hasValue = entry.secret && entry.hasValue ? 'true' : 'false';
      row.innerHTML = `
        <input type="text" class="input-field mono env-key" placeholder="NAME" spellcheck="false" aria-label="Variable name">
        <input class="input-field mono env-value" spellcheck="false" aria-label="Value">
        <button type="button" class="icon-btn env-secret" aria-pressed="false"></button>
        <button type="button" class="icon-btn env-remove" aria-label="Remove variable" title="Remove variable">${X}</button>`;
      const key = row.querySelector('.env-key');
      const value = row.querySelector('.env-value');
      const secretBtn = row.querySelector('.env-secret');
      key.value = entry.key || '';
      const renderSecret = () => {
        const secret = row.dataset.secret === 'true';
        value.type = secret ? 'password' : 'text';
        value.placeholder = secret && row.dataset.hasValue === 'true' ? '•••••• (saved, type to replace)' : 'value';
        secretBtn.innerHTML = secret ? LOCK : EYE;
        secretBtn.setAttribute('aria-pressed', String(secret));
        secretBtn.setAttribute('aria-label', secret ? 'Secret: hidden and encrypted. Click to make visible' : 'Visible value. Click to mark as secret');
        secretBtn.title = secret ? 'Secret (hidden, encrypted)' : 'Mark as secret';
      };
      value.value = entry.secret ? '' : (entry.value ?? '');
      secretBtn.addEventListener('click', () => {
        row.dataset.secret = row.dataset.secret === 'true' ? 'false' : 'true';
        if (row.dataset.secret === 'false') row.dataset.hasValue = 'false';
        renderSecret();
      });
      row.querySelector('.env-remove').addEventListener('click', () => { row.remove(); renderEnvEmpty(); });
      renderSecret();
      envRows.appendChild(row);
      renderEnvEmpty();
      return row;
    }
    function renderEnvEmpty() {
      const empty = envRows.querySelector('.env-empty');
      const rows = envRows.querySelectorAll('.env-row').length;
      if (!rows && !empty) envRows.insertAdjacentHTML('afterbegin', '<span class="env-empty">No variables. The command gets StackConsole\'s own environment.</span>');
      if (rows && empty) empty.remove();
    }
    $('BtnAddEnv').addEventListener('click', () => addEnvRow().querySelector('.env-key').focus());

    // ── Working directory: Browse…, and where it will actually run (folder + git branch)
    const projectDir = (options.projectDir || '').replace(/[\\/]+$/, '');
    const isAbsolute = (p) => /^([A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(p);
    const resolveDir = (value) => {
      const v = value.trim();
      if (!v) return projectDir;
      if (isAbsolute(v)) return v;
      return projectDir ? `${projectDir}\\${v.replace(/^[.\\/]+/, '')}` : '';
    };
    let dirCheck = 0;
    async function renderDirHint() {
      const hint = $('HintDir');
      const folder = resolveDir($('InpDir').value);
      const ticket = ++dirCheck;
      if (!folder) { hint.textContent = 'Relative to the project folder, or any folder (another repo works too).'; hint.classList.remove('hint-warn'); return; }
      const info = window.api.folderInfo ? await window.api.folderInfo(folder) : null;
      if (ticket !== dirCheck || !info) return;
      if (!info.exists) {
        hint.textContent = `Folder not found: ${folder}`;
        hint.classList.add('hint-warn');
        return;
      }
      hint.classList.remove('hint-warn');
      hint.textContent = `Runs in ${folder}${info.branch ? ` · ⎇ ${info.branch}${info.detached ? ' (detached)' : ''}` : ''}`;
    }
    let dirTimer = null;
    $('InpDir').addEventListener('input', () => { clearTimeout(dirTimer); dirTimer = setTimeout(renderDirHint, 250); });
    $('BtnBrowseDir').addEventListener('click', async () => {
      const picked = await window.api.selectDirectory();
      if (!picked) return;
      const lower = picked.toLowerCase();
      const base = projectDir.toLowerCase();
      // Inside the project: keep it relative so the project folder can move; elsewhere: absolute
      if (base && (lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`))) {
        $('InpDir').value = picked.slice(projectDir.length).replace(/^[\\/]+/, '');
      } else {
        $('InpDir').value = picked;
      }
      renderDirHint();
    });

    // ── Initial values
    $('InpName').value = initial.displayName || '';
    $('InpCmd').value = initial.command || '';
    $('InpDir').value = initial.workingDirectory || '';
    $('InpPort').value = initial.port || '';
    $('InpDelay').value = initial.startupDelay || '0';
    $('InpRestartLimit').value = initial.restartLimit || 3;
    $('InpNotify').checked = initial.notify !== false;
    $('InpReadyPattern').value = initial.readyPattern || '';
    $('InpEnvFile').value = initial.envFile || '';
    (Array.isArray(initial.env) ? initial.env : []).forEach(addEnvRow);
    renderEnvEmpty();
    chooseIcon(window.iconMap.getIcon(selectedIcon) ? selectedIcon : '');
    choosePolicy(crashPolicy);
    renderDirHint();

    function setError(inputId, errorId, message) {
      $(errorId).textContent = message;
      if (inputId) $(inputId).setAttribute('aria-invalid', message ? 'true' : 'false');
      return !message;
    }

    function envEntries() {
      return [...envRows.querySelectorAll('.env-row')].map(row => {
        const key = row.querySelector('.env-key').value.trim();
        const value = row.querySelector('.env-value').value;
        if (row.dataset.secret === 'true') {
          // Empty value on a saved secret = keep the stored one (main merges it back)
          return value ? { key, secret: true, value } : { key, secret: true, keep: row.dataset.hasValue === 'true' };
        }
        return { key, value };
      });
    }

    function validate() {
      const port = $('InpPort').value.trim();
      const delay = $('InpDelay').value.trim();
      const limit = $('InpRestartLimit').value.trim();
      const keys = envEntries().map(e => e.key);
      const badKey = keys.find(k => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
      const dupKey = keys.find((k, i) => keys.indexOf(k) !== i);
      const checks = [
        setError('InpName', 'ErrName', $('InpName').value.trim() ? '' : 'Give the service a name.'),
        setError('InpCmd', 'ErrCmd', $('InpCmd').value.trim() ? '' : 'Enter the command to run.'),
        setError('InpPort', 'ErrPort', !port || (/^\d+$/.test(port) && +port >= 1 && +port <= 65535) ? '' : 'Use a port between 1 and 65535.'),
        setError('InpDelay', 'ErrDelay', !delay || (!isNaN(delay) && +delay >= 0) ? '' : 'Use 0 or more seconds.'),
        setError(null, 'ErrEnv', badKey !== undefined ? `"${badKey || '(empty)'}" isn't a valid variable name (letters, digits, _).` : dupKey ? `${dupKey} is listed twice.` : ''),
      ];
      $('InpRestartLimit').value = Math.max(1, Math.min(10, parseInt(limit, 10) || 3));
      const firstInvalid = container.querySelector('[aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
      return checks.every(Boolean);
    }

    function values() {
      return {
        displayName: $('InpName').value.trim(),
        icon: selectedIcon || null,
        command: $('InpCmd').value.trim(),
        workingDirectory: $('InpDir').value.trim(),
        port: $('InpPort').value.trim(),
        startupDelay: $('InpDelay').value.trim() || '0',
        onCrash: crashPolicy,
        restartLimit: parseInt($('InpRestartLimit').value, 10) || 3,
        notify: $('InpNotify').checked,
        startAfter: startAfter.value || null,
        readyPattern: $('InpReadyPattern').value.trim(),
        envFile: $('InpEnvFile').value.trim(),
        env: envEntries(),
      };
    }

    $('InpName').focus();
    return { validate, values };
  }

  // Enter submits, Escape closes: shared by every small form window
  function bindFormKeys(onSubmit, onCancel) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); onSubmit(); }
    });
  }

  window.commandForm = { mount, bindFormKeys };
})();
