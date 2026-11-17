// Overlay primitives (B-3, DESIGN-PLAN section 6): modal, drawer, popover, toast, tooltip.
// Every modal and drawer follows the same states: open -> idle -> dirty (closing asks first,
// backdrop click does nothing) -> saving (primary button busy, inputs locked) -> error (message stays,
// nothing lost) -> done (closes, a toast confirms). Focus is trapped in a modal and returns to the
// trigger on close; Esc closes unless there are unsaved changes, then it asks.
(function () {
  const { esc, confirmDialog } = window.ui;
  const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
  const stack = []; // open modals and drawers, topmost last

  // Starts an enter transition without waiting for an animation frame (a hidden window gets none):
  // reading the layout commits the start state, then the class moves it to the end state.
  function enter(el) {
    void el.offsetWidth;
    el.classList.add('is-open');
  }

  async function askDiscard() {
    const choice = await confirmDialog({
      title: 'Discard your changes?',
      body: 'What you changed here has not been saved.',
      actions: [
        { label: 'Keep editing', value: null, variant: 'secondary', autofocus: true },
        { label: 'Discard', value: 'discard', variant: 'danger-solid' },
      ],
    });
    return choice === 'discard';
  }

  // Shared frame: header (title + close), body element, footer with actions and an error line.
  // opts: { kind: 'modal' | 'drawer', title, body (Element), actions: [{ label, variant, primary, run }],
  //         dirty() -> bool, onClose(), className, width }
  function surface(opts) {
    const previous = document.activeElement;
    const titleId = `ov-title-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const root = document.createElement('div');
    root.className = opts.kind === 'modal' ? 'overlay-backdrop' : 'drawer-host';
    const panel = document.createElement(opts.kind === 'modal' ? 'div' : 'aside');
    panel.className = `${opts.kind === 'modal' ? 'overlay-modal' : 'drawer'}${opts.className ? ` ${opts.className}` : ''}`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', titleId);
    if (opts.kind === 'modal') panel.setAttribute('aria-modal', 'true');
    if (opts.width) panel.style.width = opts.width;
    panel.innerHTML = `
      <header class="overlay-head">
        <h2 id="${titleId}">${esc(opts.title)}</h2>
        <button type="button" class="overlay-close" aria-label="Close" title="Close (Esc)">${window.ui.icons.close || '×'}</button>
      </header>
      <div class="overlay-error" role="alert" hidden></div>
      <footer class="modal-footer-strip"></footer>`;
    panel.insertBefore(opts.body, panel.querySelector('.overlay-error'));
    const footer = panel.querySelector('footer');
    const errorLine = panel.querySelector('.overlay-error');
    const variants = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger', 'danger-solid': 'btn-danger is-solid' };
    const buttons = [];
    (opts.actions || []).forEach(a => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = variants[a.variant] || 'btn-secondary';
      b.textContent = a.label;
      b.addEventListener('click', () => a.run(handle));
      footer.appendChild(b);
      buttons.push({ b, a });
    });
    if (!buttons.length) footer.remove();
    root.appendChild(panel);

    let closed = false;
    let busy = false;
    const handle = {
      el: panel,
      body: opts.body,
      get closed() { return closed; },
      // Closes without asking (after a save, or when the caller decided)
      close(value) {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        stack.splice(stack.indexOf(handle), 1);
        root.classList.add('is-leaving');
        // It stays in the page for its exit animation: give up its ids now, so a surface opened
        // right after (with the same form) never binds to these elements
        root.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        root.setAttribute('aria-hidden', 'true');
        const done = () => { root.remove(); opts.onClose?.(value); };
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) done();
        else setTimeout(done, 140);
        if (previous && previous.isConnected && previous.focus) previous.focus();
      },
      // Close as the user asked: confirms first when there are unsaved changes
      async requestClose() {
        if (busy) return;
        if (opts.dirty && opts.dirty() && !(await askDiscard())) return;
        handle.close(null);
      },
      // Saving: primary button shows progress, inputs are locked
      setBusy(on, label = 'Saving…') {
        busy = on;
        panel.querySelectorAll('input, select, textarea, button').forEach(el => {
          if (on) { el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; }
          else { el.disabled = el.dataset.wasDisabled === '1'; delete el.dataset.wasDisabled; }
        });
        buttons.forEach(({ b, a }) => {
          if (!a.primary) return;
          if (on) { b.dataset.label = b.textContent; b.textContent = label; b.setAttribute('aria-busy', 'true'); }
          else { if (b.dataset.label) b.textContent = b.dataset.label; b.removeAttribute('aria-busy'); }
        });
      },
      // Error: the message stays in the surface, nothing typed is lost
      showError(message) {
        errorLine.textContent = message || '';
        errorLine.hidden = !message;
      },
      focusFirst() {
        (panel.querySelector('[autofocus]') || opts.body.querySelector(FOCUSABLE) || panel.querySelector(FOCUSABLE))?.focus();
      },
    };

    function onKey(e) {
      if (stack[stack.length - 1] !== handle) return;
      // Dialogs opened on top (confirm, discard) handle their own keys
      if (document.querySelector('.dialog-backdrop')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handle.requestClose();
        return;
      }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && panel.contains(e.target)) {
        const primary = buttons.find(x => x.a.primary);
        if (primary && !primary.b.disabled) { e.preventDefault(); primary.b.click(); }
        return;
      }
      if (e.key === 'Tab' && opts.kind === 'modal') {
        const items = [...panel.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i + 1) % items.length].focus();
      }
    }

    panel.querySelector('.overlay-close').addEventListener('click', () => handle.requestClose());
    if (opts.kind === 'modal') {
      // Backdrop click closes only when nothing would be lost
      root.addEventListener('mousedown', (e) => {
        if (e.target === root && !(opts.dirty && opts.dirty()) && !busy) handle.close(null);
      });
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    stack.push(handle);
    enter(root);
    handle.focusFirst();
    return handle;
  }

  const modal = (opts) => surface({ ...opts, kind: 'modal' });

  // A drawer is not modal: the rest of the window stays usable. One drawer at a time; opening another
  // asks the first one to close (which confirms if it has unsaved changes).
  async function drawer(opts) {
    const open = stack.find(h => h.el.classList.contains('drawer'));
    if (open) {
      await open.requestClose();
      if (!open.closed) return null;
    }
    return surface({ ...opts, kind: 'drawer' });
  }

  const isOpen = () => stack.length > 0;

  // ── Popover: small, anchored, dismissed by an outside click or Esc ──
  function popover(anchor, content, { onClose, label } = {}) {
    const el = document.createElement('div');
    el.className = 'popover';
    el.setAttribute('role', 'dialog');
    if (label) el.setAttribute('aria-label', label);
    el.appendChild(content);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 4))}px`;
    el.style.top = `${r.bottom + h + 4 > innerHeight ? Math.max(4, r.top - h - 4) : r.bottom + 4}px`;
    enter(el);
    const close = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      el.remove();
      anchor.focus?.();
      onClose?.();
    };
    const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    el.querySelector(FOCUSABLE)?.focus();
    return { el, close };
  }

  // ── Toast: bottom-right results ("Imported 4 commands"), optional action, pauses on hover ──
  function toastStack() {
    let s = document.querySelector('.toast-stack');
    if (!s) {
      s = document.createElement('div');
      s.className = 'toast-stack';
      s.setAttribute('role', 'status');
      s.setAttribute('aria-live', 'polite');
      document.body.appendChild(s);
    }
    return s;
  }

  function toast(message, { tone, action, timeout = 4000 } = {}) {
    const t = document.createElement('div');
    t.className = 'toast';
    if (tone) t.dataset.tone = tone;
    t.innerHTML = `<span class="toast-text">${esc(message)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-ghost btn-sm';
      b.textContent = action.label;
      b.addEventListener('click', () => { dismiss(); action.run(); });
      t.appendChild(b);
    }
    toastStack().appendChild(t);
    enter(t);
    let left = timeout;
    let started = Date.now();
    let timer = setTimeout(dismiss, left);
    t.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
    t.addEventListener('mouseleave', () => { started = Date.now(); timer = setTimeout(dismiss, Math.max(800, left)); });
    function dismiss() {
      clearTimeout(timer);
      t.classList.remove('is-open');
      setTimeout(() => t.remove(), 200);
    }
    return { dismiss };
  }

  // ── Tooltip: any element with data-tip gets a styled tooltip on hover and keyboard focus ──
  let tipEl = null;
  let tipTimer = null;
  function showTip(target) {
    const text = target.dataset.tip;
    if (!text) return;
    tipEl = tipEl || Object.assign(document.createElement('div'), { className: 'tooltip', role: 'tooltip' });
    tipEl.textContent = text;
    document.body.appendChild(tipEl);
    const r = target.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    tipEl.style.left = `${Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4))}px`;
    tipEl.style.top = `${r.bottom + h + 6 > innerHeight ? r.top - h - 6 : r.bottom + 6}px`;
    tipEl.classList.add('is-open');
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tipEl?.classList.remove('is-open');
    tipEl?.remove();
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    hideTip();
    if (t) tipTimer = setTimeout(() => showTip(t), 400);
  });
  document.addEventListener('focusin', (e) => { const t = e.target.closest?.('[data-tip]'); hideTip(); if (t) showTip(t); });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('mousedown', hideTip, true);

  window.overlay = { modal, drawer, popover, toast, isOpen, askDiscard };
})();
