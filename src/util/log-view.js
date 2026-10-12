// A second, read-only log beside the main one: its own stream, scroll and "new lines" button.
// The main log keeps find, levels, copy and clear; this one follows a service until it is closed.
(function () {
  class LogView {
    // opts: { term, logs, jump, lineElement(entry) → element, placeholder() → text, max, arrowIcon }
    constructor(opts) {
      this.o = opts;
      this.key = null;
      this.seq = 0;
      this.queue = null;
      this.unseen = 0;
      opts.term.addEventListener('scroll', () => { if (this.atBottom()) this.hideJump(); });
      opts.jump.addEventListener('click', () => this.scrollToLatest());
    }

    atBottom() {
      const t = this.o.term;
      return t.scrollHeight - t.scrollTop - t.clientHeight < 40;
    }
    hideJump() { this.unseen = 0; this.o.jump.hidden = true; }
    scrollToLatest() { this.o.term.scrollTop = this.o.term.scrollHeight; this.hideJump(); }

    placeholder() {
      const div = document.createElement('div');
      div.className = 'log-placeholder';
      div.textContent = this.o.placeholder();
      this.o.logs.replaceChildren(div);
    }

    async open(projectId, commandId) {
      const key = `${projectId}:${commandId}`;
      if (key === this.key) return;
      this.key = key;
      this.seq = 0;
      this.hideJump();
      this.placeholder();
      this.queue = [];
      let snapshot = { lines: [] };
      try { snapshot = await window.api.getLogs(projectId, commandId); } catch {}
      if (this.key !== key) return; // another service was opened while loading
      const queued = this.queue;
      this.queue = null;
      this.append([...(snapshot.lines || []), ...queued]);
      this.scrollToLatest();
    }

    push(payload) {
      if (!this.key || `${payload.projectId}:${payload.commandId}` !== this.key) return;
      if (this.queue) { this.queue.push(payload); return; }
      this.append([payload]);
    }

    append(entries) {
      const fresh = entries.filter(e => e.seq > this.seq);
      if (!fresh.length) return;
      this.seq = fresh[fresh.length - 1].seq;
      const { logs, term, jump } = this.o;
      const follow = this.atBottom();
      logs.querySelector('.log-placeholder')?.remove();
      const frag = document.createDocumentFragment();
      fresh.forEach(e => frag.appendChild(this.o.lineElement(e)));
      logs.appendChild(frag);
      let removedHeight = 0;
      while (logs.childElementCount > this.o.max) {
        removedHeight += logs.firstElementChild.offsetHeight;
        logs.firstElementChild.remove();
      }
      if (follow) { this.scrollToLatest(); return; }
      term.scrollTop -= removedHeight;
      this.unseen += fresh.length;
      jump.innerHTML = `${this.o.arrowIcon}<span>${this.unseen} new line${this.unseen === 1 ? '' : 's'}</span>`;
      jump.hidden = false;
    }

    // Placeholder text follows the service's status while nothing has printed yet
    refreshPlaceholder() {
      const p = this.o.logs.querySelector('.log-placeholder');
      if (p) p.textContent = this.o.placeholder();
    }

    close() {
      this.key = null;
      this.queue = null;
      this.o.logs.replaceChildren();
      this.hideJump();
    }
  }

  window.LogView = LogView;
})();
