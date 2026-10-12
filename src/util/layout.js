// Resizable regions of the main window (Decision - Workbench layout and identity):
// the sidebar snaps to icons only · compact · full names, the header is full or slim, the stack panel opens
// above the footer, and two logs share the main panel. Sizes are per viewer (localStorage, safe to lose);
// the limits are tokens in tokens.css. Every edge drags, takes the keyboard and resets on double-click.
(function () {
  const KEY = 'sc.layout';
  const SNAP = 12;        // a width this close to compact or full lands on it
  const DEAD = 3;         // pointer travel before a press becomes a drag
  const DEFAULTS = { sidebar: null, lastSidebar: null, header: 'full', panel: 0, lastPanel: null, split: 0.5 };
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (id) => document.getElementById(id);
  const css = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

  function read() {
    try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch { return { ...DEFAULTS }; }
  }
  let state = read();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

  let hooks = {};
  let splitOpen = false;
  let panelWasOpen = null;

  // ── Readout next to the pointer while dragging ─────────────────
  let readoutEl = null;
  function readout(e, text) {
    if (!readoutEl) {
      readoutEl = document.createElement('div');
      readoutEl.className = 'sash-readout';
      readoutEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(readoutEl);
    }
    readoutEl.textContent = text;
    readoutEl.hidden = false;
    const w = readoutEl.offsetWidth;
    readoutEl.style.left = `${Math.min(innerWidth - w - css('--sp-8'), e.clientX + css('--sp-12'))}px`;
    readoutEl.style.top = `${Math.max(css('--sp-8'), e.clientY - css('--sp-32'))}px`;
  }
  function hideReadout() { if (readoutEl) readoutEl.hidden = true; }

  // ── A draggable edge ───────────────────────────────────────────
  // No tooltip: it would cover the edge while you aim for it. spec: { el, axis 'x'|'y', label, controls, value(), preview(delta, start, pos) → { value, text }, commit(value, viaKeyboard), key(e) → value | undefined, reset() }
  function sash(spec) {
    const el = spec.el;
    el.setAttribute('role', 'separator');
    el.tabIndex = 0;
    el.setAttribute('aria-orientation', spec.axis === 'x' ? 'vertical' : 'horizontal');
    el.setAttribute('aria-label', spec.label);
    if (spec.controls) el.setAttribute('aria-controls', spec.controls);
    el.innerHTML = '<span class="sash-grip" aria-hidden="true"></span>';
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      drag = { start: spec.axis === 'x' ? e.clientX : e.clientY, value: spec.value(), moved: false, result: undefined };
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pos = spec.axis === 'x' ? e.clientX : e.clientY;
      if (!drag.moved) {
        if (Math.abs(pos - drag.start) < DEAD) return;
        drag.moved = true;
        document.body.classList.add('is-resizing', spec.axis === 'x' ? 'is-resizing-x' : 'is-resizing-y');
        el.classList.add('is-dragging');
      }
      const r = spec.preview(pos - drag.start, drag.value, pos);
      drag.result = r.value;
      readout(e, r.text);
    });
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      document.body.classList.remove('is-resizing', 'is-resizing-x', 'is-resizing-y');
      el.classList.remove('is-dragging');
      hideReadout();
      if (d.moved && d.result !== undefined) spec.commit(d.result, false);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('dblclick', () => spec.reset());
    el.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const v = spec.key(e);
      if (v === undefined) return;
      e.preventDefault();
      spec.commit(v, true);
    });
  }
  const step = (e) => (e.shiftKey ? css('--sp-32') : css('--sp-8'));
  function animate(el, on) {
    el.classList.toggle('is-animating', on && !reduced.matches);
    if (on) setTimeout(() => el.classList.remove('is-animating'), 200);
  }

  // ── Sidebar: rail · compact · full ─────────────────────────────
  const SB = () => ({ rail: css('--rail-w'), min: css('--sidebar-min'), compact: css('--sidebar-w'), full: css('--sidebar-full'), max: css('--sidebar-max') });
  const DENSITY_TEXT = { rail: 'Icons only', compact: 'Compact', full: 'Full names' };
  function sidebarMax() {
    const s = SB();
    // the main panel keeps one log's width, or two panes plus the line between them; the sidebar's own edge is 1px
    const keep = (splitOpen ? 2 * css('--pane-min') + 1 : css('--log-min')) + 1;
    const room = ($('Workspace').clientWidth || innerWidth) - keep;
    return Math.max(s.min, Math.min(s.max, room));
  }
  function snapSidebar(raw) {
    const s = SB();
    if (raw < (s.rail + s.min) / 2) return s.rail;
    const max = sidebarMax();
    let w = Math.max(s.min, Math.min(max, raw));
    [s.compact, s.full].forEach(m => { if (m <= max && Math.abs(w - m) <= SNAP) w = m; });
    return Math.round(w);
  }
  const densityOf = (w) => (w <= SB().rail ? 'rail' : w >= SB().full ? 'full' : 'compact');
  const sidebarWanted = () => (state.sidebar === null ? SB().compact : state.sidebar);
  // What fits now: the saved width, narrowed while the window (or a split) needs the room
  const sidebarNow = () => { const w = sidebarWanted(); return w <= SB().rail ? SB().rail : Math.min(w, sidebarMax()); };
  function applySidebar(w, anim) {
    const el = $('Sidebar');
    const d = densityOf(w);
    animate(el, !!anim);
    el.style.width = `${w}px`;
    const changed = el.dataset.density !== d;
    el.dataset.density = d;
    const s = $('SashSidebar');
    s.setAttribute('aria-valuenow', String(Math.round(w)));
    s.setAttribute('aria-valuemin', String(SB().rail));
    s.setAttribute('aria-valuemax', String(Math.round(sidebarMax())));
    s.setAttribute('aria-valuetext', `${Math.round(w)} pixels, ${DENSITY_TEXT[d]}`);
    if (changed && hooks.onDensity) hooks.onDensity(d);
  }
  function setSidebar(w, anim = true) {
    state.sidebar = w;
    if (w > SB().rail) state.lastSidebar = w;
    save();
    applySidebar(sidebarNow(), anim);
  }
  function toggleSidebar() {
    const s = SB();
    if (sidebarNow() <= s.rail) setSidebar(Math.max(s.min, state.lastSidebar || s.compact));
    else setSidebar(s.rail);
  }

  // ── Header: full · slim ────────────────────────────────────────
  function applyHeader(v) {
    $('MainHeader').classList.toggle('slim', v === 'slim');
    const s = $('SashHeader');
    s.setAttribute('aria-valuemin', '0');
    s.setAttribute('aria-valuemax', '1');
    s.setAttribute('aria-valuenow', v === 'slim' ? '0' : '1');
    s.setAttribute('aria-valuetext', v === 'slim' ? 'Slim header' : 'Full header');
  }

  // ── Stack panel above the footer: closed, or between --footer-panel-min and -max ──
  function panelMax() {
    const room = $('MainPanel').clientHeight - $('MainHeader').offsetHeight - $('LogToolbar').offsetHeight - $('MainFooter').offsetHeight - css('--log-min-h');
    return Math.max(0, Math.min(css('--footer-panel-max'), room));
  }
  const panelMin = () => css('--footer-panel-min');
  function panelNow() {
    const max = panelMax();
    return state.panel && max >= panelMin() ? Math.min(state.panel, max) : 0;
  }
  function applyPanel(h, anim) {
    const panel = $('StackPanel');
    const open = h > 0;
    animate(panel, !!anim);
    panel.hidden = !open;
    panel.style.height = open ? `${h}px` : '';
    const s = $('SashPanel');
    s.setAttribute('aria-valuemin', '0');
    s.setAttribute('aria-valuemax', String(Math.round(panelMax())));
    s.setAttribute('aria-valuenow', String(Math.round(h)));
    s.setAttribute('aria-valuetext', open ? `Everything running, ${Math.round(h)} pixels` : 'Everything running, closed');
    if (open !== panelWasOpen) { panelWasOpen = open; if (hooks.onPanel) hooks.onPanel(open); }
  }
  function setPanel(h, anim = true) {
    state.panel = h;
    if (h) state.lastPanel = h;
    save();
    applyPanel(panelNow(), anim);
  }
  const panelDefault = () => Math.min(panelMax(), state.lastPanel || css('--footer-panel-default'));
  function togglePanel() { setPanel(panelNow() ? 0 : panelDefault()); }

  // ── Two logs side by side ──────────────────────────────────────
  function splitBounds() {
    const w = $('LogSplit').clientWidth || 1;
    const min = Math.min(0.5, css('--pane-min') / w);
    return { w, min, max: 1 - min };
  }
  function applySplit(ratio) {
    const b = splitBounds();
    const r = Math.max(b.min, Math.min(b.max, ratio));
    $('LogColA').style.flex = splitOpen ? `${r} 1 0` : '';
    $('LogColB').style.flex = splitOpen ? `${1 - r} 1 0` : '';
    const s = $('SashSplit');
    s.setAttribute('aria-valuemin', String(Math.round(b.min * 100)));
    s.setAttribute('aria-valuemax', String(Math.round(b.max * 100)));
    s.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    s.setAttribute('aria-valuetext', `Left log ${Math.round(r * 100)} percent`);
    return r;
  }
  function setSplitOpen(open) {
    if (splitOpen === open) return;
    splitOpen = open;
    $('LogColB').hidden = !open;
    $('SashSplit').hidden = !open;
    $('LogSplit').classList.toggle('is-split', open);
    applySidebar(sidebarNow(), true); // a split needs two panes' room: the sidebar narrows, never the panes
    applySplit(state.split);
  }

  function reapply() {
    applySidebar(sidebarNow(), false);
    applyHeader(state.header);
    applyPanel(panelNow(), false);
    if (splitOpen) applySplit(state.split);
  }

  function reset() {
    state = { ...DEFAULTS };
    save();
    applySidebar(sidebarNow(), true);
    applyHeader('full');
    applyPanel(0, true);
    if (splitOpen) applySplit(0.5);
  }

  function init(h) {
    hooks = h || {};
    sash({
      el: $('SashSidebar'), axis: 'x', label: 'Resize sidebar', controls: 'Sidebar',
      value: () => sidebarNow(),
      preview: (delta, start) => { const w = snapSidebar(start + delta); applySidebar(w, false); return { value: w, text: `${w} px · ${DENSITY_TEXT[densityOf(w)]}` }; },
      commit: (w, kb) => setSidebar(w, kb),
      key: (e) => {
        const s = SB();
        const w = sidebarNow();
        if (e.key === 'ArrowLeft') return w <= s.min ? s.rail : Math.max(s.min, w - step(e));
        if (e.key === 'ArrowRight') return w <= s.rail ? s.min : Math.min(sidebarMax(), w + step(e));
        if (e.key === 'Home') return s.rail;
        if (e.key === 'End') return sidebarMax();
        if (e.key === 'Enter') return w <= s.rail ? Math.max(s.min, Math.min(sidebarMax(), state.lastSidebar || s.compact)) : s.rail;
        return undefined;
      },
      reset: () => setSidebar(SB().compact),
    });
    sash({
      el: $('SashHeader'), axis: 'y', label: 'Header size', controls: 'MainHeader',
      value: () => state.header,
      preview: (delta, start) => {
        const v = delta < -SNAP ? 'slim' : delta > SNAP ? 'full' : start;
        applyHeader(v);
        return { value: v, text: v === 'slim' ? 'Slim header' : 'Full header' };
      },
      commit: (v) => { state.header = v; save(); applyHeader(v); if (state.panel) applyPanel(panelNow(), false); },
      key: (e) => ({ ArrowUp: 'slim', ArrowDown: 'full', Enter: state.header === 'slim' ? 'full' : 'slim' })[e.key],
      reset: () => { state.header = state.header === 'slim' ? 'full' : 'slim'; save(); applyHeader(state.header); },
    });
    sash({
      el: $('SashPanel'), axis: 'y', label: 'Resize the everything-running panel', controls: 'StackPanel',
      value: () => panelNow(),
      preview: (delta, start) => {
        const raw = start - delta;
        const h = raw < panelMin() ? 0 : Math.round(Math.min(panelMax(), raw));
        applyPanel(h, false);
        return { value: h, text: h ? `${h} px` : 'Closed' };
      },
      commit: (h, kb) => setPanel(h, kb),
      key: (e) => {
        const h = panelNow();
        if (e.key === 'ArrowUp') return h ? Math.min(panelMax(), h + step(e)) : panelDefault();
        if (e.key === 'ArrowDown') return h - step(e) < panelMin() ? 0 : h - step(e);
        if (e.key === 'Home') return 0;
        if (e.key === 'End') return panelMax();
        if (e.key === 'Enter') return h ? 0 : panelDefault();
        return undefined;
      },
      reset: togglePanel,
    });
    sash({
      el: $('SashSplit'), axis: 'x', label: 'Resize the two logs', controls: 'LogColA',
      value: () => state.split,
      preview: (delta, start, pos) => {
        const box = $('LogSplit').getBoundingClientRect();
        const r = applySplit((pos - box.left) / (box.width || 1));
        return { value: r, text: `${Math.round(r * box.width)} px · ${Math.round((1 - r) * box.width)} px` };
      },
      commit: (r) => { state.split = applySplit(r); save(); },
      key: (e) => {
        const w = splitBounds().w;
        if (e.key === 'ArrowLeft') return state.split - step(e) / w;
        if (e.key === 'ArrowRight') return state.split + step(e) / w;
        if (e.key === 'Enter' || e.key === 'Home' || e.key === 'End') return e.key === 'Home' ? 0 : e.key === 'End' ? 1 : 0.5;
        return undefined;
      },
      reset: () => { state.split = applySplit(0.5); save(); },
    });

    // Ctrl+B: icons only ↔ the sidebar as it was · Ctrl+J: everything running (the editor conventions)
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); toggleSidebar(); }
      if (k === 'j') { e.preventDefault(); togglePanel(); }
    });
    let t = null;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(reapply, 60); });
    reapply();
  }

  window.layout = {
    init,
    reset,
    reapply,
    toggleSidebar,
    togglePanel,
    setSplitOpen,
    density: () => $('Sidebar').dataset.density || 'compact',
    panelOpen: () => panelNow() > 0,
    splitOpen: () => splitOpen,
  };
})();
