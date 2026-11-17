// One log view, used for both the main log and the second log beside it (D6): its own stream,
// scroll, "new lines" button and DOM cap. Lines arrive in batches and are appended once per batch.
(function () {
  class LogView {
    // opts: { term, logs, jump, lineElement(entry) → element, placeholder() → text, max, arrowIcon,
    //         keyOf(projectId, commandId) → stream key (default "project:command"),
    //         onAdded(els), onRemoved(els), onReset() (find bar), onAppended(els) (e.g. crash banner) }
    constructor(opts) {
      this.o = opts;
      this.keyOf = opts.keyOf || ((projectId, commandId) => `${projectId}:${commandId}`);
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
      this.o.onReset?.();
    }

    // Shows a stream; resolves true once its lines are in, false if it was already shown or
    // another stream was opened while loading.
    async open(projectId, commandId) {
      const key = this.keyOf(projectId, commandId);
      if (key === this.key) return false;
      this.key = key;
      this.seq = 0;
      this.hideJump();
      this.placeholder();
      this.queue = [];
      let snapshot = { lines: [] };
      try { snapshot = await window.api.getLogs(projectId, commandId); } catch {}
      if (this.key !== key) return false;
      const queued = this.queue;
      this.queue = null;
      this.append([...(snapshot.lines || []), ...queued]);
      this.scrollToLatest();
      return true;
    }

    push(payload) {
      this.pushMany([payload]);
    }

    pushMany(batch) {
      if (!this.key) return;
      const mine = batch.filter(p => this.keyOf(p.projectId, p.commandId) === this.key);
      if (!mine.length) return;
      if (this.queue) { this.queue.push(...mine); return; }
      this.append(mine);
    }

    append(entries) {
      const fresh = entries.filter(e => e.seq > this.seq);
      if (!fresh.length) return;
      this.seq = fresh[fresh.length - 1].seq;
      const { logs, term, jump } = this.o;
      const follow = this.atBottom();
      logs.querySelector('.log-placeholder')?.remove();
      const els = fresh.map(e => this.o.lineElement(e));
      const frag = document.createDocumentFragment();
      els.forEach(el => frag.appendChild(el));
      logs.appendChild(frag);
      this.o.onAdded?.(els);
      // Cap the DOM; when reading older lines, keep the viewport anchored as the top is trimmed
      let removedHeight = 0;
      const removed = [];
      while (logs.childElementCount > this.o.max) {
        removedHeight += logs.firstElementChild.offsetHeight;
        removed.push(logs.firstElementChild);
        logs.firstElementChild.remove();
      }
      if (removed.length) this.o.onRemoved?.(removed);
      if (follow) {
        this.scrollToLatest();
      } else {
        term.scrollTop -= removedHeight;
        this.unseen += fresh.length;
        jump.innerHTML = `${this.o.arrowIcon}<span>${this.unseen} new line${this.unseen === 1 ? '' : 's'}</span>`;
        jump.hidden = false;
      }
      this.o.onAppended?.(els);
    }

    // After "Clear": the stream stays open, its shown lines go
    clear() {
      this.placeholder();
      this.scrollToLatest();
    }

    // Placeholder text follows the service's status while nothing has printed yet
    refreshPlaceholder() {
      const p = this.o.logs.querySelector('.log-placeholder');
      if (p) p.textContent = this.o.placeholder();
    }

    // Forget which stream is shown, so the next open() loads it again
    forget() {
      this.key = null;
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
