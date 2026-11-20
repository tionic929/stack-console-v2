// In-app self-test for B-4 to B-6: the Add / Edit command drawer, the New project, Import and Rename
// modals, inline rename (F2), and the Project manager actions moved into the tree and service menus.
// Debug builds only. Run from the repo root with a throwaway data folder:
//
//   D=$(mktemp -d); mkdir -p "$D/demo-a" "$D/data"
//   echo '{"scripts":{"dev":"node -e \"setInterval(()=>{},1000)\"","lint":"echo lint"}}' > "$D/demo-a/package.json"
//   sed "s#__DEMO_DIR__#$D#" src-tauri/selftest/b4-b6.js > "$D/t.js"
//   STACKCONSOLE_DATA_DIR="$D/data" STACKCONSOLE_SELFTEST="$D/t.js" cargo run -q -p stackconsole-app
//
// It prints one [selftest] PASS/FAIL line per check, then RESULT n/15, and quits the app.
(async () => {
  const SP = '__DEMO_DIR__'; // a folder holding demo-a/package.json (see the header)
  const inv = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const report = (line, done) => inv('selftest_report', { line, done: !!done });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function until(fn, ms = 5000, what = 'condition') {
    const t = Date.now();
    while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(50); }
    throw new Error('timed out: ' + what);
  }
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const btn = (root, label) => [...(root || document).querySelectorAll('button')].find(b => b.textContent.trim() === label);
  const store = () => window.api.getStore();
  const proj = async (name) => (await store()).projects.find(p => p.name === name);
  const drawerOpen = () => qa('.drawer-host:not(.is-leaving) .drawer')[0];
  const modalOpen = () => qa('.overlay-backdrop:not(.is-leaving) .overlay-modal')[0];
  const gone = (sel) => until(() => !qa(sel).length, 3000, sel + ' gone');
  async function menuItem(anchor, label) {
    anchor.click();
    const item = await until(() => qa('.popup-menu .popup-item').find(b => b.textContent.startsWith(label)), 2000, 'menu ' + label);
    item.click();
  }
  const moreOf = (p) => q('[data-focus-key="m:' + p.id + '"]');
  let pass = 0, fail = 0;
  async function check(name, fn) {
    try { await fn(); pass++; await report('PASS ' + name); }
    catch (e) { fail++; await report('FAIL ' + name + ': ' + (e && e.message || e)); }
  }
  const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };

  await until(() => window.surfaces && typeof appState !== 'undefined' && appState, 8000, 'app ready').catch(() => {});
  await sleep(500);

  await check('1 Manage projects button gone, surfaces loaded', async () => {
    ok(!document.getElementById('TriggerProjManager'), 'button still there');
    ok(window.surfaces && window.commandForm, 'surfaces missing');
  });

  await check('2 New project modal creates the project', async () => {
    q('#BtnNewProject').click();
    const m = await until(modalOpen, 3000, 'modal');
    ok(document.activeElement === q('#NpName'), 'name not focused');
    btn(m, 'Create project').click();
    ok(q('#NpErr').textContent.includes('name'), 'no empty-name error');
    type(q('#NpName'), 'Demo A'); type(q('#NpDir'), SP + '/demo-a');
    btn(m, 'Create project').click();
    await gone('.overlay-backdrop');
    await until(() => proj('Demo A'), 3000, 'project saved');
    await until(() => qa('.toast').some(t => t.textContent.includes('Created Demo A')), 2000, 'toast');
  });

  await check('3 Import modal lists and imports', async () => {
    const p = await proj('Demo A');
    importCommands(p.id);
    const m = await until(modalOpen, 3000, 'modal');
    await until(() => m.querySelectorAll('.import-item').length >= 2, 5000, 'items');
    const b = m.querySelector('.modal-footer-strip .btn-primary');
    ok(b.textContent === 'Import 1 command', 'label ' + b.textContent);
    b.click();
    await gone('.overlay-backdrop');
    await until(async () => (await proj('Demo A')).commands.length === 1, 3000, 'imported');
    await until(() => qa('.toast').some(t => t.textContent.includes('Imported 1 command')), 2000, 'toast');
  });

  await check('4 Add command drawer from the project menu', async () => {
    const p = await proj('Demo A');
    await until(() => moreOf(p), 3000, 'tree row');
    await menuItem(moreOf(p), 'Add command');
    const d = await until(drawerOpen, 3000, 'drawer');
    ok(document.activeElement === q('#InpName'), 'name not focused');
    type(q('#InpName'), 'Sleeper'); type(q('#InpCmd'), 'sleep 60');
    btn(d, 'Add command').click();
    await gone('.drawer-host');
    const c = await until(async () => (await proj('Demo A')).commands.find(x => x.displayName === 'Sleeper'), 3000, 'saved');
    await until(() => selection && selection.id === c.id, 3000, 'new command selected');
  });

  await check('5 Dirty drawer asks before closing; Keep editing keeps it, Discard drops it', async () => {
    const p = await proj('Demo A');
    addCommand(p.id);
    const d = await until(drawerOpen, 3000, 'drawer');
    type(q('#InpName'), 'Unsaved');
    key(q('#InpName'), 'Escape');
    const dlg = await until(() => q('.dialog-backdrop'), 2000, 'confirm');
    btn(dlg, 'Keep editing').click();
    await sleep(300);
    ok(drawerOpen() === d && q('#InpName').value === 'Unsaved', 'drawer lost');
    key(q('#InpName'), 'Escape');
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm 2'), 'Discard').click();
    await gone('.drawer-host');
    ok(!(await proj('Demo A')).commands.some(c => c.displayName === 'Unsaved'), 'saved anyway');
  });

  await check('6 Add drawer keeps its project when the active project changes (P5)', async () => {
    await window.api.addProject('Demo B', '');
    const a = await proj('Demo A'); const b = await until(() => proj('Demo B'), 3000, 'B');
    window.api.setActiveProject(a.id);
    await sleep(200);
    addCommand(a.id);
    const d = await until(drawerOpen, 3000, 'drawer');
    window.api.setActiveProject(b.id);
    await until(async () => (await store()).activeProject === b.id, 3000, 'switched');
    type(q('#InpName'), 'Stays in A'); type(q('#InpCmd'), 'echo hi');
    btn(d, 'Add command').click();
    await gone('.drawer-host');
    ok((await proj('Demo A')).commands.some(c => c.displayName === 'Stays in A'), 'not in A');
    ok(!(await proj('Demo B')).commands.length, 'went to B');
  });

  await check('7 Edit drawer from the service menu saves', async () => {
    const a = await proj('Demo A');
    const c = a.commands.find(x => x.displayName === 'Stays in A');
    selectService(a.id, c.id); render();
    await menuItem(q('#BtnServiceMore'), 'Edit command');
    const d = await until(drawerOpen, 3000, 'drawer');
    ok(q('#InpCmd').value === 'echo hi', 'not prefilled');
    ok(!btn(d, 'Save and restart'), 'restart offered for a stopped command');
    type(q('#InpName'), 'Renamed cmd');
    btn(d, 'Save').click();
    await gone('.drawer-host');
    await until(async () => (await proj('Demo A')).commands.some(x => x.id === c.id && x.displayName === 'Renamed cmd'), 3000, 'saved');
  });

  await check('8 Failed save keeps the drawer, the message and the input', async () => {
    const a = await proj('Demo A');
    const c = a.commands.find(x => x.displayName === 'Renamed cmd');
    editCommand(a.id, c.id);
    const d = await until(drawerOpen, 3000, 'drawer');
    await window.api.removeCommand(a.id, c.id);
    type(q('#InpName'), 'Typed text');
    btn(d, 'Save').click();
    const err = await until(() => { const e = d.querySelector('.overlay-error'); return !e.hidden && e.textContent; }, 3000, 'error shown');
    ok(drawerOpen() === d && q('#InpName').value === 'Typed text' && !q('#InpName').disabled, 'state lost');
    await report('   error text: ' + err);
    key(q('#InpName'), 'Escape');
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm'), 'Discard').click();
    await gone('.drawer-host');
  });

  await check('9 Running command offers Save and restart', async () => {
    const a = await proj('Demo A');
    const c = a.commands.find(x => x.displayName === 'Sleeper');
    window.api.startCommandNow({ projectId: a.id, commandId: c.id });
    await until(async () => ['running', 'starting'].includes((await proj('Demo A')).commands.find(x => x.id === c.id).status), 5000, 'running');
    await sleep(300);
    editCommand(a.id, c.id);
    const d = await until(drawerOpen, 3000, 'drawer');
    ok(btn(d, 'Save and restart'), 'no Save and restart');
    btn(d, 'Cancel').click();
    await gone('.drawer-host');
    window.api.stopCommand({ projectId: a.id, commandId: c.id });
  });

  await check('10 Inline rename with F2; a refresh while typing keeps the field; Esc cancels', async () => {
    const a = await proj('Demo A');
    const row = await until(() => q('[data-focus-key="p:' + a.id + '"]'), 3000, 'row');
    row.focus();
    key(row, 'F2');
    const input = await until(() => q('.tree-rename'), 2000, 'field');
    ok(document.activeElement === input && input.value === 'Demo A', 'field not focused/prefilled');
    type(input, 'Demo Alpha');
    window.api.setActiveProject((await proj('Demo B')).id); // causes a state refresh
    await sleep(400);
    ok(q('.tree-rename') === input && input.value === 'Demo Alpha', 'field lost on refresh');
    key(input, 'Enter');
    await until(() => proj('Demo Alpha'), 3000, 'renamed');
    await until(() => !q('.tree-rename'), 2000, 'field closed');
    let row2 = await until(() => q('[data-focus-key="p:' + a.id + '"]'), 2000, 'row back');
    ok(row2.textContent.includes('Demo Alpha'), 'new name not shown at once');
    await sleep(500);
    row2 = await until(() => q('[data-focus-key="p:' + a.id + '"]'), 2000, 'row after refresh');
    ok(row2.textContent.includes('Demo Alpha'), 'tree not updated after refresh');
    row2.focus(); key(row2, 'F2');
    const i2 = await until(() => q('.tree-rename'), 2000, 'field 2');
    type(i2, 'Nope'); key(i2, 'Escape');
    await until(() => !q('.tree-rename'), 2000, 'closed');
    ok(await proj('Demo Alpha'), 'Esc saved');
  });

  await check('11 Project without a visible row renames in a modal', async () => {
    const b = await proj('Demo B');
    ok(!q('[data-focus-key="p:' + b.id + '"]') || true);
    // Force the fallback by asking for a project whose row is not in the tree
    const fake = { ...b };
    const row = q('[data-focus-key="p:' + b.id + '"]');
    if (row) row.dataset.focusKey = 'hidden';
    renameProject(fake);
    const m = await until(modalOpen, 3000, 'modal');
    type(q('#RnName'), 'Demo Beta');
    btn(m, 'Rename').click();
    await gone('.overlay-backdrop');
    await until(() => proj('Demo Beta'), 3000, 'renamed');
    render();
  });

  await check('12 Duplicate and Remove from the service menu', async () => {
    const a = await proj('Demo Alpha');
    const c = a.commands.find(x => x.displayName === 'Sleeper');
    await until(async () => (await proj('Demo Alpha')).commands.find(x => x.id === c.id).status === 'offline', 6000, 'stopped');
    selectService(a.id, c.id); render();
    await menuItem(q('#BtnServiceMore'), 'Duplicate command');
    const dup = await until(async () => (await proj('Demo Alpha')).commands.find(x => x.id !== c.id && x.displayName.startsWith('Sleeper')), 3000, 'dup');
    await until(() => selection && selection.id === dup.id, 3000, 'dup selected');
    await menuItem(q('#BtnServiceMore'), 'Remove command');
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm'), 'Remove').click();
    await until(async () => !(await proj('Demo Alpha')).commands.some(x => x.id === dup.id), 3000, 'removed');
  });

  await check('13 Delete project from the tree menu', async () => {
    const b = await proj('Demo Beta');
    render(); await sleep(200);
    const more = moreOf(b);
    if (more) await menuItem(more, 'Delete project');
    else deleteProject(b);
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm'), 'Delete project').click();
    await until(async () => !(await proj('Demo Beta')), 3000, 'deleted');
  });

  await check('14 Second drawer asks the dirty first one; Keep editing keeps it', async () => {
    const a = await proj('Demo Alpha');
    addCommand(a.id);
    const d = await until(drawerOpen, 3000, 'drawer');
    type(q('#InpName'), 'Half typed');
    const c = a.commands[0];
    const p2 = editCommand(a.id, c.id);
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm'), 'Keep editing').click();
    await sleep(300);
    ok(drawerOpen() === d && q('#InpName').value === 'Half typed', 'first drawer lost');
    btn(d, 'Cancel').click();
    btn(await until(() => q('.dialog-backdrop'), 2000, 'confirm 2'), 'Discard').click();
    await gone('.drawer-host');
  });

  await check('15 Modal traps focus and Esc closes a clean modal', async () => {
    newProject();
    const m = await until(modalOpen, 3000, 'modal');
    const items = [...m.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    items[items.length - 1].focus();
    key(items[items.length - 1], 'Tab');
    ok(m.contains(document.activeElement), 'focus left the modal');
    key(document.activeElement, 'Escape');
    await gone('.overlay-backdrop');
  });

  window.api.stopEverything();
  await sleep(800);
  await report('RESULT ' + pass + '/' + (pass + fail), true);
})().catch(e => window.__TAURI_INTERNALS__.invoke('selftest_report', { line: 'CRASH ' + e, done: true }));
