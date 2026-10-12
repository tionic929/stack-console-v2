// Project identity: a colour from the identity palette plus an icon (a stack mark, a general icon or 1–2 letters).
// Automatic unless the project stores its own choice. Worked out on every read and never saved, like the branch.

// Order matters only for the automatic pick; names match the --id-<name> tokens in src/tokens.css.
// No green, amber, red (status) or indigo (waiting, focus): see Decision - Workbench layout and identity.
const PALETTE = ['purple', 'pink', 'cyan', 'brown', 'sand'];
const ICON_KEY = /^(g:)?[a-z0-9-]{1,32}$/;
const LETTERS = /^[A-Z0-9]{1,2}$/;
const NOT_STACKS = new Set(['generic', 'terminal']);

function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function initials(name) {
  const words = String(name || '?').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9 _-]/g, ' ').split(/[\s_-]+/).filter(Boolean);
  const raw = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2);
  return raw.toUpperCase();
}

// Letters that differ from the siblings' (two projects called "Smartlab…" in one folder get SL and SM)
function distinctLetters(name, taken) {
  const first = initials(name);
  if (!taken.has(first)) return first;
  const letters = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '');
  for (let i = 1; i < letters.length; i++) {
    const pick = letters[0] + letters[i];
    if (!taken.has(pick)) return pick;
  }
  return first;
}

// The stack most of its commands use (Vite, Laravel…); none → letters
function autoIcon(project) {
  const counts = new Map();
  (project.commands || []).forEach(c => {
    if (c.icon && !NOT_STACKS.has(c.icon)) counts.set(c.icon, (counts.get(c.icon) || 0) + 1);
  });
  let best = null;
  counts.forEach((n, k) => { if (!best || n > best.n) best = { k, n }; });
  return best ? best.k : null;
}

// projects: config objects. groupOf(project) → the list it shows in (a master folder's container, Pinned, Other…).
// Returns { [projectId]: identity }. In one list the first five get five different colours; past five,
// each still differs from the two above it (in name order, as the tree lists them).
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
function identities(projects, groupOf) {
  const groups = new Map();
  projects.forEach(p => {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  });
  const out = {};
  groups.forEach(list => {
    const used = new Set(list.filter(p => PALETTE.includes(p.color)).map(p => p.color)); // chosen colours claim first
    const usedLetters = new Set();
    const recent = [];
    [...list].sort(byName).forEach(p => {
      const start = hash(p.id) % PALETTE.length;
      const ring = PALETTE.map((_, i) => PALETTE[(start + i) % PALETTE.length]);
      const auto = ring.find(c => !used.has(c)) || ring.find(c => !recent.includes(c)) || ring[0];
      const color = PALETTE.includes(p.color) ? p.color : auto;
      used.add(color);
      recent.unshift(color);
      recent.length = Math.min(recent.length, 2);
      const autoLetters = distinctLetters(p.name, usedLetters);
      const mono = p.icon === 'letters' && LETTERS.test(p.mono || '') ? p.mono : autoLetters;
      usedLetters.add(mono);
      const stack = autoIcon(p);
      const icon = p.icon === 'letters' ? null : (p.icon && ICON_KEY.test(p.icon) ? p.icon : stack);
      out[p.id] = { color, icon, mono, custom: !!(p.color || p.icon), auto: { color: auto, icon: stack, mono: autoLetters } };
    });
  });
  return out;
}

// From a window: { color: palette name | null, icon: icon key | 'letters' | null, mono: 'XY' } (null = automatic)
function validate(input) {
  const v = input && typeof input === 'object' ? input : {};
  if (v.color !== null && v.color !== undefined && !PALETTE.includes(v.color)) return { ok: false, error: 'Unknown colour.' };
  if (v.icon !== null && v.icon !== undefined && v.icon !== 'letters' && !ICON_KEY.test(String(v.icon))) return { ok: false, error: 'Unknown icon.' };
  const mono = typeof v.mono === 'string' ? v.mono.trim().toUpperCase() : '';
  if (v.icon === 'letters' && !LETTERS.test(mono)) return { ok: false, error: 'Use one or two letters or digits.' };
  return { ok: true, color: v.color || null, icon: v.icon || null, mono: v.icon === 'letters' ? mono : null };
}

module.exports = { PALETTE, identities, validate, initials, autoIcon };
