// Project identity in the renderer: the tile (colour + stack mark, general icon or letters) and the
// Colour & icon picker. Identity comes from main (p.identity: automatic unless chosen); a picker preview is
// kept here until Done, so the tree, header and footer show the choice live and Esc can revert it.
(function () {
  const { esc, icons } = window.ui;
  const COLOURS = [['purple', 'Purple'], ['pink', 'Pink'], ['cyan', 'Cyan'], ['brown', 'Brown'], ['sand', 'Sand']];
  const COLOUR_NAMES = Object.fromEntries(COLOURS);
  const preview = new Map(); // projectId -> identity shown while the picker is open

  function readRecent() { try { const v = JSON.parse(localStorage.getItem('sc.recentIcons') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function writeRecent(list) { try { localStorage.setItem('sc.recentIcons', JSON.stringify(list.slice(0, 8))); } catch {} }

  function identityOf(project) {
    return preview.get(project.id) || project.identity || { color: 'sand', icon: null, mono: '?' };
  }

  // size: '' (--tile) · 'sm' (--tile-sm) · 'md' (--tile-md)
  function tile(project, size = '') {
    const id = identityOf(project);
    const svg = id.icon && window.iconMap ? window.iconMap.getIcon(id.icon) : null;
    return `<span class="id-tile idc-${esc(id.color)}${size ? ` ${size}` : ''}" aria-hidden="true">${svg || `<span class="id-letters">${esc(id.mono || '?')}</span>`}</span>`;
  }
  const colourClass = (project) => `idc-${identityOf(project).color}`;
  const describe = (project) => {
    const id = identityOf(project);
    return `${COLOUR_NAMES[id.color] || id.color}, ${id.icon ? (window.iconMap.getIconLabel(id.icon) || id.icon) : `letters ${id.mono}`}`;
  };

  // Icons the project's own data suggests: its commands' stacks first, then general icons its name hints at
  function suggested(project) {
    const keys = [];
    const add = (k) => { if (k && window.iconMap.getIcon(k) && !keys.includes(k)) keys.push(k); };
    add(project.identity?.auto?.icon);
    (project.commands || []).forEach(c => { if (c.icon !== 'generic' && c.icon !== 'terminal') add(c.icon); });
    const words = String(project.name || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    window.iconMap.getGeneralIcons().forEach(g => {
      const names = [g.label.toLowerCase(), ...g.aliases.split(' ')].filter(n => n.length >= 2);
      if (words.some(w => names.some(n => w.startsWith(n) || w.includes(n) && n.length >= 4))) add(g.key);
    });
    ['g:database', 'g:server', 'g:globe', 'g:smartphone', 'g:package', 'g:wrench'].forEach(add);
    return keys.slice(0, 8);
  }

  // ── Picker ─────────────────────────────────────────────────────
  // opts: { anchor, renderPreview(project) → html, onChange(), onDone(choice) }
  let open = null;
  function close(commit) {
    if (!open) return;
    const { el, project, opts, onKey, onDown, start } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    el.remove();
    const choice = preview.get(project.id);
    preview.delete(project.id);
    if (commit && choice && JSON.stringify(choice) !== JSON.stringify(start)) opts.onDone(choice);
    else opts.onChange();
    if (opts.restoreFocus) opts.restoreFocus(); else opts.anchor?.focus?.();
  }

  function openPicker(project, opts) {
    close(false);
    const start = { ...identityOf(project) };
    const state = { ...start, custom: undefined };
    let tab = 'Suggested';
    let query = '';
    const el = document.createElement('div');
    el.className = 'id-picker';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Colour and icon for ${project.name}`);
    document.body.appendChild(el);

    const setPreview = () => {
      preview.set(project.id, { color: state.color, icon: state.icon, mono: state.mono, auto: project.identity?.auto, chosen: true });
      opts.onChange();
      el.querySelector('.idp-preview').innerHTML = opts.renderPreview(project);
      el.querySelector('[data-colour-name]').textContent = COLOUR_NAMES[state.color];
      el.querySelector('[data-icon-name]').textContent = state.icon ? (window.iconMap.getIconLabel(state.icon) || state.icon) : 'Letters';
    };

    // MySQL, ngrok and Composer borrow a general icon: one search shows each drawing once
    const once = (list) => {
      const q = query.toLowerCase();
      const rank = (i) => (i.label.toLowerCase().startsWith(q) ? 0 : i.key.startsWith('g:') ? 1 : 2);
      const best = new Map();
      list.forEach(i => { const b = best.get(i.svg); if (!b || rank(i) < rank(b)) best.set(i.svg, i); });
      return list.filter(i => best.get(i.svg) === i);
    };
    const iconList = () => {
      if (query) return once(window.iconMap.search(query));
      if (tab === 'Recent') return readRecent().map(k => window.iconMap.getIcon(k) ? { key: k, label: window.iconMap.getIconLabel(k), svg: window.iconMap.getIcon(k) } : null).filter(Boolean);
      if (tab === 'Stacks') return window.iconMap.getAllIcons().filter(i => i.key !== 'generic' && i.key !== 'terminal');
      if (tab === 'General') return window.iconMap.getGeneralIcons();
      return suggested(project).map(k => ({ key: k, label: window.iconMap.getIconLabel(k), svg: window.iconMap.getIcon(k) }));
    };

    const renderIcons = () => {
      const list = iconList();
      const grid = el.querySelector('.icon-picker');
      const empty = el.querySelector('.idp-empty');
      el.querySelector('.idp-count').textContent = query ? `${list.length} icon${list.length === 1 ? '' : 's'}` : '';
      el.querySelector('.idp-tabs').hidden = !!query;
      grid.hidden = !list.length;
      empty.hidden = !!list.length;
      if (!list.length) {
        empty.textContent = query ? `No icons match “${query}”. Use letters instead:` : (tab === 'Recent' ? 'Icons you pick show up here.' : '');
      }
      const current = state.icon;
      grid.innerHTML = list.map((i, n) => `<button type="button" class="icon-picker-item" role="radio" data-key="${esc(i.key)}" aria-checked="${i.key === current}" aria-label="${esc(i.label)}" title="${esc(i.label)}" tabindex="${(i.key === current || (n === 0 && !list.some(x => x.key === current))) ? 0 : -1}">${i.svg}</button>`).join('');
      grid.querySelectorAll('.icon-picker-item').forEach(b => {
        b.addEventListener('click', () => pickIcon(b.dataset.key));
        b.addEventListener('mouseenter', () => { if (!open) return; const keep = state.icon; state.icon = b.dataset.key; setPreview(); state.icon = keep; });
      });
      grid.onmouseleave = () => setPreview();
      fit();
    };

    // Beside the anchor, always inside the window (the grid grows with Stacks and search)
    const fit = () => {
      const r = opts.anchor && opts.anchor.isConnected ? opts.anchor.getBoundingClientRect() : (open?.anchorRect || { right: 260, top: 80 });
      if (open) open.anchorRect = r;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      el.style.left = `${Math.max(8, Math.min(r.right + 8, innerWidth - w - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(r.top - 40, innerHeight - h - 8))}px`;
    };

    const pickIcon = (key) => {
      state.icon = key;
      writeRecent([key, ...readRecent().filter(k => k !== key)]);
      setPreview();
      renderIcons();
      el.querySelector(`.icon-picker-item[data-key="${CSS.escape(key)}"]`)?.focus();
    };
    const pickColour = (c) => {
      state.color = c;
      el.querySelectorAll('.idp-swatch').forEach(s => {
        const on = s.dataset.colour === c;
        s.setAttribute('aria-checked', String(on));
        s.tabIndex = on ? 0 : -1;
        s.innerHTML = on ? icons.check || '' : '';
      });
      setPreview();
    };

    el.innerHTML = `
      <div class="idp-head"><b>Colour &amp; icon</b><span>${esc(project.name)}</span></div>
      <section class="idp-sec"><div class="idp-label">Preview <span>${esc('how it looks in the tree and header')}</span></div><div class="idp-preview"></div></section>
      <section class="idp-sec"><div class="idp-label" id="IdpColour">Colour <span data-colour-name></span></div>
        <div class="idp-swatches" role="radiogroup" aria-labelledby="IdpColour">${COLOURS.map(([c, name]) => `<button type="button" class="idp-swatch idc-${c}" role="radio" data-colour="${c}" aria-label="${name}" title="${name}" aria-checked="false" tabindex="-1"></button>`).join('')}</div></section>
      <section class="idp-sec"><div class="idp-label" id="IdpIcon">Icon <span data-icon-name></span></div>
        <label class="find-field idp-search"><span aria-hidden="true">${icons.search}</span><input type="search" placeholder="Search icons and stacks…" aria-label="Search icons" aria-controls="IdpGrid" spellcheck="false" autocomplete="off"></label>
        <span class="idp-count" role="status" aria-live="polite"></span>
        <div class="idp-tabs" role="tablist">${['Suggested', 'Recent', 'Stacks', 'General'].map(t => `<button type="button" class="idp-tab" role="tab" data-tab="${t}" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}">${t}</button>`).join('')}</div>
        <div class="icon-picker" id="IdpGrid" role="radiogroup" aria-labelledby="IdpIcon"></div>
        <p class="idp-empty" hidden></p>
        <label class="idp-letters"><span>Or letters</span><input type="text" class="input-field" maxlength="2" spellcheck="false" autocomplete="off" aria-label="Letters (one or two)"></label>
      </section>
      <div class="idp-foot"><button type="button" class="btn-ghost btn-sm" data-reset>${icons.restart}<span>Reset to automatic</span></button><button type="button" class="btn-primary btn-sm" data-done>Done</button></div>`;

    // wiring
    const search = el.querySelector('.idp-search input');
    const letters = el.querySelector('.idp-letters input');
    letters.value = state.mono || '';
    el.querySelectorAll('.idp-swatch').forEach(s => s.addEventListener('click', () => pickColour(s.dataset.colour)));
    el.querySelectorAll('.idp-tab').forEach(t => t.addEventListener('click', () => {
      tab = t.dataset.tab;
      el.querySelectorAll('.idp-tab').forEach(x => { x.setAttribute('aria-selected', String(x === t)); x.tabIndex = x === t ? 0 : -1; });
      renderIcons();
    }));
    search.addEventListener('input', () => { query = search.value.trim(); renderIcons(); });
    letters.addEventListener('input', () => {
      const v = letters.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 2);
      letters.value = v;
      if (!v) return;
      state.icon = null; state.mono = v;
      setPreview(); renderIcons();
    });
    el.querySelector('[data-done]').addEventListener('click', () => close(true));
    el.querySelector('[data-reset]').addEventListener('click', () => {
      const a = project.identity?.auto || {};
      state.color = a.color || state.color; state.icon = a.icon || null; state.mono = a.mono || state.mono;
      letters.value = state.icon ? '' : state.mono;
      preview.set(project.id, { color: state.color, icon: state.icon, mono: state.mono, auto: a, reset: true });
      pickColour(state.color);
      renderIcons();
    });

    // Keyboard: arrows move inside the colour row, the tabs and the grid (roving tabindex); Esc reverts
    const move = (items, i, d) => { const n = items[(i + d + items.length) % items.length]; items.forEach(x => { x.tabIndex = -1; }); n.tabIndex = 0; n.focus(); return n; };
    const onKey = (e) => {
      const t = e.target;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(false); return; }
      if (e.key === 'Enter' && (t === search || t === letters)) { e.preventDefault(); close(true); return; }
      const group = t.closest('.idp-swatches, .idp-tabs, .icon-picker');
      if (!group) return;
      const items = [...group.querySelectorAll('button')];
      const i = items.indexOf(t);
      if (i === -1) return;
      const cols = group.classList.contains('icon-picker') ? 8 : items.length;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (step && !(group.classList.contains('idp-swatches') || group.classList.contains('idp-tabs')) || (step && Math.abs(step) === 1)) {
        e.preventDefault();
        const n = move(items, i, step);
        if (group.classList.contains('idp-swatches')) pickColour(n.dataset.colour);
        if (group.classList.contains('idp-tabs')) n.click();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault(); move(items, e.key === 'Home' ? -i : items.length - 1 - i, 0);
      } else if (group.classList.contains('icon-picker') && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); search.focus(); search.value += e.key; search.dispatchEvent(new Event('input'));
      }
    };
    const onDown = (e) => { if (!el.contains(e.target)) close(true); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    open = { el, project, opts, onKey, onDown, start };

    open.anchorRect = opts.anchor ? opts.anchor.getBoundingClientRect() : null;
    pickColour(state.color);
    renderIcons();
    setPreview();
    (el.querySelector('.idp-swatch[aria-checked="true"]') || search).focus();
  }

  window.identity = { tile, colourClass, describe, openPicker, identityOf, COLOURS, isOpen: () => !!open };
})();
