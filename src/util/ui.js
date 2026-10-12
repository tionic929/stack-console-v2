// Shared renderer helpers for every StackConsole window:
// escaping, icons, status labels, service avatars and the in-window confirm dialog.
(function () {
  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  const svg = (body, extra = '') =>
    `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

  const icons = {
    play: svg('<path d="M7 4l13 8-13 8V4z"/>'),
    stop: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
    restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
    folder: svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>'),
    terminal: svg('<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>'),
    arrowDown: svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
    trash: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    chevronUp: svg('<path d="M6 15l6-6 6 6"/>'),
    chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
    chevronRight: svg('<path d="M9 6l6 6-6 6"/>'),
    more: svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
    branch: svg('<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-12 8"/>'),
    warn: svg('<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    check: svg('<path d="M20 6L9 17l-5-5"/>'),
    close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    swap: svg('<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>'),
    edit: svg('<path d="M4 20h4l11-11-4-4L4 16v4z"/>'),
    download: svg('<path d="M12 4v12"/><path d="M6 11l6 6 6-6"/><path d="M4 20h16"/>'),
    // macOS-style caption glyphs, shown inside the dots on hover/focus
    winMin: '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1 4h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    winMax: '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M4 1v6M1 4h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    winClose: '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };

  // "warning" is the pre-v1.1 name of "starting"
  function normalizeStatus(status) {
    if (status === 'warning') return 'starting';
    return ['running', 'starting', 'waiting', 'crashed', 'offline', 'shell'].includes(status) ? status : 'offline';
  }

  const STATUS_LABELS = { running: 'Running', starting: 'Starting', waiting: 'Waiting', crashed: 'Crashed', offline: 'Stopped', shell: 'Shell' };

  function statusLabel(status) {
    return STATUS_LABELS[normalizeStatus(status)];
  }

  function statusIndicator(status) {
    const s = normalizeStatus(status);
    return `<span class="status-ind" data-status="${s}" title="${STATUS_LABELS[s]}" aria-hidden="true"></span>`;
  }

  function initials(name) {
    const words = String(name || '?').trim().split(/\s+/);
    return (words.length >= 2 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }

  // Neutral avatar: the service's icon if it has one, otherwise its initials.
  // Colour is reserved for status, so avatars never use status hues.
  function avatar(cmd) {
    const icon = cmd.icon && window.iconMap ? window.iconMap.getIcon(cmd.icon) : null;
    return `<span class="svc-avatar" aria-hidden="true">${icon || esc(initials(cmd.displayName))}</span>`;
  }

  // Port shown to the user: the one the service actually reported, else the configured one, else nothing.
  function portOf(cmd) {
    return cmd.detectedPort || cmd.port || '';
  }

  function newCommandId(existing) {
    let id;
    do {
      id = `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    } while ((existing || []).some(c => c.id === id));
    return id;
  }

  // In-window confirm dialog. Returns a promise of the chosen action value (or null on Escape/backdrop).
  // actions: [{ label, value, variant: 'primary'|'secondary'|'danger'|'danger-solid', autofocus }]
  // Optional: details (lines listed under the body; { text, tone: 'warn' } for a warning),
  // checklist ([{ label, sub, checked }], updated in place), field ({ label, value }, updated in place).
  function confirmDialog({ title, body, actions, details, checklist, field }) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'dialog-backdrop';
      const titleId = `dlg-title-${Date.now()}`;
      const bodyId = `${titleId}-body`;
      const line = (d) => (typeof d === 'string' ? { text: d } : d);
      backdrop.innerHTML = `
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${bodyId}">
          <h2 id="${titleId}">${esc(title)}</h2>
          <p id="${bodyId}">${esc(body)}</p>
          ${details && details.length ? `<ul class="dialog-details">${details.map(line).map(d => `<li${d.tone ? ` data-tone="${esc(d.tone)}"` : ''}>${esc(d.text)}</li>`).join('')}</ul>` : ''}
          ${field ? `<label class="dialog-field"><span>${esc(field.label)}</span><input type="text" class="input-field" value="${esc(field.value || '')}" maxlength="80"></label>` : ''}
          ${checklist && checklist.length ? `<div class="dialog-checklist">${checklist.map((c, i) => `
            <label class="dialog-check"><input type="checkbox" data-i="${i}" ${c.checked ? 'checked' : ''}>
              <span class="svc-title-stack"><span class="svc-name">${esc(c.label)}</span>${c.sub ? `<span class="svc-port-sub mono">${esc(c.sub)}</span>` : ''}</span></label>`).join('')}</div>` : ''}
          <div class="dialog-actions"></div>
        </div>`;
      backdrop.querySelectorAll('.dialog-check input').forEach(cb => cb.addEventListener('change', () => { checklist[Number(cb.dataset.i)].checked = cb.checked; }));
      const input = backdrop.querySelector('.dialog-field input');
      if (input) input.addEventListener('input', () => { field.value = input.value; });
      const row = backdrop.querySelector('.dialog-actions');
      const variants = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger', 'danger-solid': 'btn-danger is-solid' };
      let focusTarget = null;
      actions.forEach(a => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = variants[a.variant] || 'btn-secondary';
        b.textContent = a.label;
        b.addEventListener('click', () => close(a.value));
        row.appendChild(b);
        if (a.autofocus) focusTarget = b;
      });

      function close(value) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previous && previous.focus) previous.focus();
        resolve(value);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
        if (e.key === 'Enter' && input && document.activeElement === input) { e.preventDefault(); row.querySelector('.btn-primary')?.click(); }
        if (e.key === 'Tab') {
          const items = [...backdrop.querySelectorAll('input, button')];
          const i = items.indexOf(document.activeElement);
          e.preventDefault();
          const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length;
          items[next].focus();
        }
      }

      backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(null); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      (focusTarget || row.querySelector('button')).focus();
    });
  }

  // Popup menu anchored to a button (the tree's ⋯). items: [{ label, hint, action, disabled, danger } | 'separator'].
  // Arrow keys move, Enter/Space run, Esc or a click outside closes and returns focus to the anchor.
  let openMenuState = null;
  function closeMenu(returnFocus = true) {
    if (!openMenuState) return;
    const { el, anchor, onKey, onDown, onMove } = openMenuState;
    openMenuState = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('resize', onMove);
    document.removeEventListener('scroll', onMove, true);
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus) anchor.focus();
  }

  function openMenu(anchor, items, label) {
    const reopen = openMenuState && openMenuState.anchor === anchor;
    closeMenu(false);
    if (reopen) { anchor.focus(); return; }
    const el = document.createElement('div');
    el.className = 'popup-menu';
    el.setAttribute('role', 'menu');
    if (label) el.setAttribute('aria-label', label);
    items.forEach(item => {
      if (item === 'separator') { el.insertAdjacentHTML('beforeend', '<div class="popup-sep" role="separator"></div>'); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = `popup-item${item.danger ? ' is-danger' : ''}`;
      b.disabled = !!item.disabled;
      if (item.title) b.title = item.title;
      b.innerHTML = `<span>${esc(item.label)}</span>${item.hint ? `<span class="popup-hint">${esc(item.hint)}</span>` : ''}`;
      b.addEventListener('click', () => { closeMenu(false); item.action(); });
      el.appendChild(b);
    });
    document.body.appendChild(el);

    // Below the anchor, kept inside the window
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(r.right - w, innerWidth - w - 4))}px`;
    el.style.top = `${r.bottom + h + 4 > innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4}px`;
    anchor.setAttribute('aria-expanded', 'true');

    const enabled = () => [...el.querySelectorAll('.popup-item:not(:disabled)')];
    const onKey = (e) => {
      const list = enabled();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (e.key === 'Tab') { closeMenu(false); }
    };
    const onDown = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(false); };
    // The menu is placed for the current layout: resizing the window or scrolling the list closes it
    const onMove = (e) => { if (e.type === 'resize' || !el.contains(e.target)) closeMenu(false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('scroll', onMove, true);
    openMenuState = { el, anchor, onKey, onDown, onMove };
    enabled()[0]?.focus();
  }

  // Fills the macOS-style window controls in a frameless window's title bar:
  // a 12px coloured dot inside a larger hit area, with its glyph on hover/focus.
  function initWindowControls() {
    const map = { WinBtnMin: icons.winMin, WinBtnMax: icons.winMax, WinBtnClose: icons.winClose };
    Object.entries(map).forEach(([id, glyph]) => {
      const el = document.getElementById(id);
      if (el && !el.innerHTML.trim()) el.innerHTML = `<span class="mac-dot">${glyph}</span>`;
    });
  }

  window.ui = { esc, icons, normalizeStatus, statusLabel, statusIndicator, avatar, portOf, newCommandId, confirmDialog, initWindowControls, openMenu, closeMenu };
})();
