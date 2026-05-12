import puppeteer from 'C:/Users/nateh/AppData/Local/Temp/puppeteer-test/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3];

const outDir = resolve('temporary screenshots');
if (!existsSync(outDir)) {
  await mkdir(outDir, { recursive: true });
}

const files = await readdir(outDir).catch(() => []);
const nums = files
  .map(f => f.match(/^screenshot-(\d+)/))
  .filter(Boolean)
  .map(m => parseInt(m[1], 10));
const next = nums.length ? Math.max(...nums) + 1 : 1;

const name = label
  ? `screenshot-${next}-${label}.png`
  : `screenshot-${next}.png`;
const outPath = resolve(outDir, name);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

try {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
} catch (e) {
  console.error('Navigation issue (continuing):', e.message);
}

await new Promise(r => setTimeout(r, 600));

await page.screenshot({ path: outPath, fullPage: true });
await browser.close();

console.log(`Saved ${outPath}`);
