// Environment variables for a command: explicit key/value pairs plus an optional .env file.
// Secrets are stored encrypted (Electron safeStorage) and only decrypted here, at spawn time.
const fs = require('fs');
const path = require('path');

// Minimal .env parser: KEY=value, `export KEY=value`, quotes, # comments, \n in double quotes.
function parseDotenv(text) {
  const vars = {};
  String(text).split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) return;
    let value = m[2];
    if (/^"/.test(value)) {
      value = value.replace(/^"((?:[^"\\]|\\.)*)".*$/, '$1').replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (/^'/.test(value)) {
      value = value.replace(/^'([^']*)'.*$/, '$1');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    vars[m[1]] = value;
  });
  return vars;
}

function within(child, root) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Builds the env for a spawn. `decrypt(entry)` returns a secret's plaintext.
// The .env file must sit inside the project folder or the command's working directory.
function buildCommandEnv(cmd, { workingDir, projectDir, decrypt }) {
  const vars = {};
  const summary = { count: 0, file: null, secrets: 0, warnings: [] };

  if (cmd.envFile) {
    const file = path.resolve(workingDir, cmd.envFile);
    const roots = [workingDir, projectDir].filter(Boolean);
    if (!roots.some(root => within(file, root))) {
      summary.warnings.push(`.env file ignored: ${cmd.envFile} is outside the project folder`);
    } else if (!fs.existsSync(file)) {
      summary.warnings.push(`.env file not found: ${file}`);
    } else {
      Object.assign(vars, parseDotenv(fs.readFileSync(file, 'utf8')));
      summary.file = cmd.envFile;
    }
  }

  (Array.isArray(cmd.env) ? cmd.env : []).forEach(entry => {
    if (!entry || !entry.key) return;
    if (entry.secret) {
      const value = decrypt(entry);
      if (value === null) { summary.warnings.push(`Secret ${entry.key} could not be decrypted and was skipped`); return; }
      vars[entry.key] = value;
      summary.secrets++;
    } else {
      vars[entry.key] = String(entry.value ?? '');
    }
  });

  summary.count = Object.keys(vars).length;
  return { vars, summary };
}

function describeEnv(summary) {
  if (!summary.count) return '';
  const parts = [`${summary.count} variable${summary.count === 1 ? '' : 's'}`];
  if (summary.file) parts.push(`from ${summary.file}`);
  if (summary.secrets) parts.push(`${summary.secrets} secret${summary.secrets === 1 ? '' : 's'} hidden`);
  return parts.join(', ');
}

module.exports = { parseDotenv, buildCommandEnv, describeEnv, within };
