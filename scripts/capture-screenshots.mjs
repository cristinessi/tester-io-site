// scripts/capture-screenshots.mjs
// Spin up a tiny static server, visit the 7 content-rich pages with Puppeteer,
// and write viewport screenshots to /screenshots. Self-contained — runs with:
//   node scripts/capture-screenshots.mjs   (or:  npm run capture)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(ROOT, 'screenshots');
const PORT = 3030;                // own port; avoids clash with any external dev server
const VIEWPORT = { width: 1440, height: 900 };
const SETTLE_MS = 1500;

const PAGES = [
  { url: 'index.html',                file: 'index.png' },
  { url: 'Sights.html',               file: 'sights.png' },
  { url: 'TesterTech.html',           file: 'testertech.png' },
  { url: 'TesterTechGadgets.html',    file: 'testertechgadgets.png' },
  { url: 'product.html',              file: 'product.png' },
  { url: 'tester-2030.html',          file: 'tester-2030.png' },
  { url: 'dashboard.html',            file: 'dashboard.png' },
];

const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css', '.js':'application/javascript',
  '.mjs':'application/javascript', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.mp4':'video/mp4', '.pdf':'application/pdf',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ico':'image/x-icon',
};

// --- minimal static server ----------------------------------------------
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const full = path.normalize(path.join(ROOT, urlPath));
      if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }   // path-traversal guard
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

// --- main ---------------------------------------------------------------
const t0 = Date.now();
if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

console.log(`> Starting static server on :${PORT} ...`);
const server = await startServer();

console.log('> Launching Puppeteer (headless chromium) ...');
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: VIEWPORT,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

let ok = 0, fail = 0;
for (const { url, file } of PAGES) {
  const target = `http://localhost:${PORT}/${url}`;
  const out = path.join(SHOTS_DIR, file);
  process.stdout.write(`  ${file.padEnd(28)} ← ${url}  `);
  const page = await browser.newPage();
  try {
    await page.setViewport(VIEWPORT);
    await page.goto(target, { waitUntil: 'networkidle0', timeout: 45000 });
    // dashboard.html has a password gate; pre-set the sessionStorage flag
    // BEFORE the page's auto-run check so we see the actual dashboard.
    if (url === 'dashboard.html') {
      await page.evaluate(() => sessionStorage.setItem('admin-auth', 'ok'));
      await page.reload({ waitUntil: 'networkidle0', timeout: 45000 });
    }
    // Settle: let any animations / reveal-on-scroll fire.
    await new Promise(r => setTimeout(r, SETTLE_MS));
    await page.screenshot({ path: out, fullPage: false, type: 'png' });
    const bytes = fs.statSync(out).size;
    console.log(`✓  ${(bytes / 1024).toFixed(1)} KB`);
    ok++;
  } catch (err) {
    console.log(`✗  ${err.message}`);
    fail++;
  } finally {
    await page.close();
  }
}

await browser.close();
server.close();

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\nDone in ${dt}s.  ${ok} captured, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
