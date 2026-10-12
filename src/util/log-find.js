// Find bar for the log pane: filter text, level chips with counts, match navigation and
// "only matches". Highlights use the CSS Custom Highlight API, so the log DOM (with its
// ANSI colour spans) is never rewritten. Lines are .log-line elements holding a .log-text span.
(function () {
  const ANSI = /\x1B\[[0-9;?]*[a-zA-Z]/g;
  const ERROR_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:[\w-]+\.)?(?:ERROR|FATAL|CRITICAL|npm ERR!)|^\s*\[error\]|^\s*Traceback \(most recent call last\)|^\s*(?:Uncaught |Unhandled )?\w*(?:Error|Exception):\s/;
  const WARN_RE = /^\s*(?:\[[^\]]*\]\s*)?(?:[\w-]+\.)?(?:WARN(?:ING)?)\b|^\s*npm WARN\b|^\s*\(!\)|^\s*Warning:\s/;
  const MAX_HIGHLIGHTS = 2000;

  function detectLevel(text) {
    const plain = String(text).replace(ANSI, '');
    if (ERROR_RE.test(plain)) return 'error';
    if (WARN_RE.test(plain)) return 'warn';
    return '';
  }

  function create({ logs, term, input, count, nav, prev, next, only, levelButtons }) {
    const hasHighlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
    let query = '';
    let level = 'all';
    let onlyMatches = false;
    let matches = [];
    let current = -1;
    const counts = { all: 0, warn: 0, error: 0 };

    const lines = () => [...logs.querySelectorAll('.log-line')];
    const textOf = (el) => (el.querySelector('.log-text') || el).textContent;
    const levelOk = (el) => level === 'all' || el.dataset.level === level;
    const isMatch = (el) => !!query && textOf(el).toLowerCase().includes(query);

    function renderChips() {
      levelButtons.forEach(btn => {
        const l = btn.dataset.level;
        const name = l === 'all' ? 'All' : l === 'warn' ? 'Warnings' : 'Errors';
        btn.textContent = `${name} ${counts[l]}`;
        btn.setAttribute('aria-pressed', String(l === level));
      });
    }

    function countLine(el, delta) {
      counts.all += delta;
      if (el.dataset.level === 'warn') counts.warn += delta;
      if (el.dataset.level === 'error') counts.error += delta;
    }

    function rangesIn(el) {
      const ranges = [];
      const walker = document.createTreeWalker(el.querySelector('.log-text') || el, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const lower = node.data.toLowerCase();
        let i = lower.indexOf(query);
        while (i !== -1) {
          const r = new Range();
          r.setStart(node, i);
          r.setEnd(node, i + query.length);
          ranges.push(r);
          i = lower.indexOf(query, i + query.length);
        }
      }
      return ranges;
    }

    function paintHighlights() {
      if (!hasHighlights) return;
      CSS.highlights.delete('find-match');
      CSS.highlights.delete('find-current');
      if (!query) return;
      const all = [];
      for (const el of matches) {
        if (all.length >= MAX_HIGHLIGHTS) break;
        all.push(...rangesIn(el));
      }
      CSS.highlights.set('find-match', new Highlight(...all));
      if (matches[current]) CSS.highlights.set('find-current', new Highlight(...rangesIn(matches[current])));
    }

    function renderCount() {
      nav.hidden = !query;
      if (!query) { count.textContent = ''; count.dataset.empty = 'false'; return; }
      count.dataset.empty = String(!matches.length);
      count.textContent = matches.length ? `${current + 1} of ${matches.length}` : 'No matches';
    }

    function applyTo(el) {
      const ok = levelOk(el);
      const hit = isMatch(el);
      el.hidden = !ok || (onlyMatches && query && !hit);
      return ok && hit;
    }

    // Full pass: after the query, level or "only matches" changes
    function apply({ keepCurrent = false } = {}) {
      const prevEl = matches[current];
      matches = lines().filter(applyTo);
      current = keepCurrent && prevEl ? Math.max(matches.indexOf(prevEl), 0) : (matches.length ? matches.length - 1 : -1);
      logs.querySelectorAll('.is-current-match').forEach(e => e.classList.remove('is-current-match'));
      if (matches[current]) matches[current].classList.add('is-current-match');
      renderCount();
      paintHighlights();
    }

    function goTo(index) {
      if (!matches.length) return;
      current = (index + matches.length) % matches.length;
      logs.querySelectorAll('.is-current-match').forEach(e => e.classList.remove('is-current-match'));
      const el = matches[current];
      el.classList.add('is-current-match');
      el.scrollIntoView({ block: 'center' });
      renderCount();
      if (hasHighlights) CSS.highlights.set('find-current', new Highlight(...rangesIn(el)));
    }

    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        query = input.value.trim().toLowerCase();
        apply();
        if (matches.length) goTo(current);
      }, 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); goTo(current + (e.shiftKey ? -1 : 1)); }
      if (e.key === 'Escape') { e.preventDefault(); input.value = ''; query = ''; apply(); term.focus(); }
    });
    prev.addEventListener('click', () => goTo(current - 1));
    next.addEventListener('click', () => goTo(current + 1));
    only.addEventListener('click', () => {
      onlyMatches = !onlyMatches;
      only.setAttribute('aria-pressed', String(onlyMatches));
      apply({ keepCurrent: true });
    });
    levelButtons.forEach(btn => btn.addEventListener('click', () => {
      level = btn.dataset.level;
      renderChips();
      apply({ keepCurrent: true });
      term.scrollTop = term.scrollHeight;
    }));

    renderChips();

    return {
      detectLevel,
      // New stream (another service selected): counts restart, the query stays
      reset() {
        counts.all = counts.warn = counts.error = 0;
        matches = [];
        current = -1;
        lines().forEach(el => countLine(el, 1));
        renderChips();
        apply();
      },
      // Called with freshly appended line elements
      added(els) {
        els.forEach(el => countLine(el, 1));
        renderChips();
        const fresh = els.filter(applyTo);
        if (fresh.length) {
          matches.push(...fresh);
          if (current === -1) current = 0;
          renderCount();
          if (hasHighlights && query) {
            const h = CSS.highlights.get('find-match') || new Highlight();
            fresh.forEach(el => rangesIn(el).forEach(r => h.add(r)));
            CSS.highlights.set('find-match', h);
          }
        }
      },
      removed(els) {
        els.forEach(el => countLine(el, -1));
        matches = matches.filter(m => !els.includes(m));
        if (current >= matches.length) current = matches.length - 1;
        renderChips();
        renderCount();
      },
      isFiltering() { return level !== 'all' || (onlyMatches && !!query); },
      focus() { input.focus(); input.select(); },
      jumpToLastError() {
        const errors = lines().filter(el => el.dataset.level === 'error');
        const el = errors[errors.length - 1];
        if (!el) return false;
        if (el.hidden) { level = 'all'; renderChips(); apply({ keepCurrent: true }); }
        logs.querySelectorAll('.is-current-match').forEach(e => e.classList.remove('is-current-match'));
        el.classList.add('is-current-match');
        el.scrollIntoView({ block: 'center' });
        return true;
      },
      lastErrorText() {
        const errors = lines().filter(el => el.dataset.level === 'error' && !/^\s*\[error\] Process exited/.test(textOf(el)));
        return errors.length ? textOf(errors[errors.length - 1]).trim() : '';
      },
      visibleText(withTimestamps) {
        return lines().filter(el => !el.hidden).map(el => {
          const ts = withTimestamps ? (el.querySelector('.log-ts')?.textContent || '') + ' ' : '';
          return ts + textOf(el);
        }).join('\n');
      },
    };
  }

  window.logFind = { create, detectLevel };
})();
