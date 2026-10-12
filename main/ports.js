// Who is listening on a TCP port? Used before Start to explain an "address already in use" crash.
const { execFile } = require('child_process');

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

async function processName(pid) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : null;
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
  return out.trim() || null;
}

// Returns { pid, name } of the process listening on `port`, or null.
async function findListener(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;

  let pid = null;
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // Proto  Local Address  Foreign Address  State  PID
      if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && new RegExp(`[:.]${p}$`).test(cols[1])) {
        pid = Number(cols[4]);
        break;
      }
    }
    // netstat -p tcp skips IPv6 listeners
    if (!pid) {
      const out6 = await run('netstat', ['-ano', '-p', 'tcpv6']);
      for (const line of out6.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 5 && /LISTEN/i.test(cols[3]) && new RegExp(`[:.]${p}$`).test(cols[1])) { pid = Number(cols[4]); break; }
      }
    }
  } else {
    const out = await run('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t']);
    pid = Number(out.split(/\s+/)[0]) || null;
  }
  if (!pid) return null;
  return { pid, name: (await processName(pid)) || `pid ${pid}` };
}

async function killPid(pid) {
  if (process.platform === 'win32') {
    await run('taskkill', ['/pid', String(pid), '/t', '/f']);
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  }
}

module.exports = { findListener, killPid };
