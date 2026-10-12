// Downloads the official Windows embeddable Python into vendor/python so the installer ships its own interpreter.
// The stream worker uses only the standard library, so nothing else is installed. Runs before `npm run dist`.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const VERSION = '3.12.10';
const URL = `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-amd64.zip`;
const root = path.join(__dirname, '..');
const target = path.join(root, 'vendor', 'python');
const marker = path.join(target, '.version');

function download(url, file) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, file).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === VERSION) {
    console.log(`[fetch-python] Python ${VERSION} already in vendor/python`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const zip = path.join(root, 'vendor', `python-${VERSION}-embed-amd64.zip`);
  console.log(`[fetch-python] Downloading ${URL}`);
  await download(URL, zip);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${target}' -Force`], { stdio: 'inherit' });
  fs.rmSync(zip, { force: true });
  fs.writeFileSync(marker, VERSION);
  console.log(`[fetch-python] Python ${VERSION} ready in vendor/python`);
})().catch((err) => {
  console.error(`[fetch-python] ${err.message}`);
  process.exit(1);
});
