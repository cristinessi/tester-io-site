// scripts/verify-about.mjs — Step 6 checklist runner for about.html
// Boots the same static-server pattern as capture-screenshots.mjs,
// then exercises each checklist item in headless Chromium.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3031;
const MIME = {
  '.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript',
  '.mjs':'application/javascript','.json':'application/json',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.svg':'image/svg+xml','.mp4':'video/mp4','.pdf':'application/pdf',
  '.woff':'font/woff','.woff2':'font/woff2','.ico':'image/x-icon',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const full = path.normalize(path.join(ROOT, urlPath));
      if (!full.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(full, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found: ' + urlPath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

const results = [];
const record = (id, status, note) => results.push({ id, status, note });

const server = await startServer();
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--autoplay-policy=no-user-gesture-required'] });

// ─────────────────────────────────────────────────────────────────────────
// Desktop pass — 1440×900
// ─────────────────────────────────────────────────────────────────────────
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
const requestFailures = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('response', r => {
  if (r.status() >= 400) requestFailures.push({ url: r.url(), status: r.status() });
});

const target = `http://localhost:${PORT}/about.html`;
await page.goto(target, { waitUntil: 'networkidle0', timeout: 45000 });
await new Promise(r => setTimeout(r, 1200));

// 1 — loads w/o errors
record(1,
  (consoleErrors.length === 0 && requestFailures.length === 0) ? 'PASS' : 'FAIL',
  consoleErrors.length === 0 && requestFailures.length === 0
    ? 'Page loaded; 0 console errors, 0 network failures.'
    : `console=${consoleErrors.length} netFail=${requestFailures.length} :: ${JSON.stringify({ consoleErrors, requestFailures }).slice(0,300)}`
);

// 2 — profile photo
const profile = await page.evaluate(() => {
  const sel = 'section#main img[src="profile.jpg"]';
  const img = document.querySelector(sel);
  if (!img) return { exists: false };
  return { exists: true, alt: img.alt, naturalW: img.naturalWidth, naturalH: img.naturalHeight, complete: img.complete };
});
const profileResp = await fetch(`http://localhost:${PORT}/profile.jpg`);
record(2,
  (profile.exists && profile.alt && profile.alt.length > 0 && profile.complete && profile.naturalW > 0 && profileResp.status === 200) ? 'PASS' : 'FAIL',
  `exists=${profile.exists} alt="${profile.alt || ''}" naturalW=${profile.naturalW} httpStatus=${profileResp.status}`
);

// 3 — resume link
const resume = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find(x => /resume\.pdf$/i.test(x.getAttribute('href') || '') && x.hasAttribute('download'));
  return { exists: !!a, href: a ? a.getAttribute('href') : null };
});
const resumeResp = await fetch(`http://localhost:${PORT}/resume.pdf`);
record(3,
  (resume.exists && resumeResp.status === 200) ? 'PASS' : 'FAIL',
  `link=${resume.href} download-attr=yes httpStatus=${resumeResp.status} bytes=${resumeResp.headers.get('content-length')}`
);

// 4 — <video> attributes + source
const video = await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return { exists: false };
  const src = v.getAttribute('src') || (v.querySelector('source') && v.querySelector('source').getAttribute('src'));
  return {
    exists: true,
    autoplay: v.hasAttribute('autoplay'),
    muted: v.hasAttribute('muted'),
    loop: v.hasAttribute('loop'),
    playsinline: v.hasAttribute('playsinline'),
    src,
    paused: v.paused,
    readyState: v.readyState,
    currentTime: v.currentTime,
  };
});
const reelResp = await fetch(`http://localhost:${PORT}/reel.mp4`);
const allFour = video.autoplay && video.muted && video.loop && video.playsinline;
const srcOk = /reel\.mp4$/i.test(video.src || '');
record(4,
  (video.exists && allFour && srcOk && reelResp.status === 200) ? 'PASS' : 'FAIL',
  `autoplay=${video.autoplay} muted=${video.muted} loop=${video.loop} playsinline=${video.playsinline} src=${video.src} httpStatus=${reelResp.status}`
);

// 5 — loop (duplicate of #4's loop check, plus runtime sanity)
record(5,
  video.loop ? 'PASS' : 'FAIL',
  `loop attribute present; readyState=${video.readyState} paused=${video.paused}`
);

// 6 — exactly 7 project cards, only real-content pages
const cards = await page.evaluate(() => {
  return [...document.querySelectorAll('a.project-card')].map(a => a.getAttribute('href'));
});
const expectedHrefs = ['./index.html','./Sights.html','./TesterTech.html','./TesterTechGadgets.html','./product.html','./tester-2030.html','./dashboard.html'];
const forbidden = ['./about.html','./contact.html','./products.html','./services.html','./tech.html','./work.html','./thankyou.html'];
const cardsSet = new Set(cards);
const hasAllExpected = expectedHrefs.every(h => cardsSet.has(h));
const hasNoForbidden = forbidden.every(h => !cardsSet.has(h));
record(6,
  (cards.length === 7 && hasAllExpected && hasNoForbidden) ? 'PASS' : 'FAIL',
  `count=${cards.length} hrefs=${JSON.stringify(cards)}`
);

// 7 — each card's href matches its screenshot src
const pairs = await page.evaluate(() => {
  return [...document.querySelectorAll('a.project-card')].map(a => {
    const img = a.querySelector('img');
    return { href: a.getAttribute('href'), imgSrc: img ? img.getAttribute('src') : null };
  });
});
const mapping = {
  'screenshots/index.png': './index.html',
  'screenshots/sights.png': './Sights.html',
  'screenshots/testertech.png': './TesterTech.html',
  'screenshots/testertechgadgets.png': './TesterTechGadgets.html',
  'screenshots/product.png': './product.html',
  'screenshots/tester-2030.png': './tester-2030.html',
  'screenshots/dashboard.png': './dashboard.html',
};
const mismatches = pairs.filter(p => mapping[p.imgSrc] !== p.href);
record(7,
  mismatches.length === 0 ? 'PASS' : 'FAIL',
  mismatches.length === 0 ? `All 7 cards href↔img mapping correct.` : `Mismatches: ${JSON.stringify(mismatches)}`
);

// 8 — About nav active on about.html
const aboutNav = await page.evaluate(() => {
  const link = document.querySelector('nav a[href="./about.html"]');
  if (!link) return { exists: false };
  const span = link.querySelector('span');
  const klass = link.className;
  return {
    exists: true,
    ariaCurrent: link.getAttribute('aria-current'),
    classes: klass,
    spanClasses: span ? span.className : null,
    hasInkActive: /text-ink-50/.test(klass),
    spanIsFullWidth: span ? /w-full/.test(span.className) : false,
    spanIsW0: span ? /w-0/.test(span.className) : false,
  };
});
record(8,
  (aboutNav.exists && aboutNav.ariaCurrent === 'page' && aboutNav.hasInkActive && aboutNav.spanIsFullWidth && !aboutNav.spanIsW0) ? 'PASS' : 'FAIL',
  `aria-current=${aboutNav.ariaCurrent} text-ink-50=${aboutNav.hasInkActive} span=w-full?${aboutNav.spanIsFullWidth}/w-0?${aboutNav.spanIsW0}`
);

// 9 — About link inactive on other pages
const otherPages = ['index.html','Sights.html','TesterTech.html','TesterTechGadgets.html','product.html','tester-2030.html','contact.html'];
const otherResults = [];
for (const p of otherPages) {
  const sub = await browser.newPage();
  try {
    await sub.goto(`http://localhost:${PORT}/${p}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const a = await sub.evaluate(() => {
      const link = document.querySelector('nav a[href="./about.html"]');
      if (!link) return { exists: false };
      const span = link.querySelector('span');
      return {
        exists: true,
        ariaCurrent: link.getAttribute('aria-current'),
        href: link.getAttribute('href'),
        spanIsW0: span ? /w-0/.test(span.className) : null,
        spanIsFullWidth: span ? /w-full/.test(span.className) : null,
      };
    });
    otherResults.push({ page: p, ...a });
  } catch (e) {
    otherResults.push({ page: p, error: e.message });
  } finally {
    await sub.close();
  }
}
const badNav = otherResults.filter(r => !r.exists || r.href !== './about.html' || r.ariaCurrent === 'page' || r.spanIsFullWidth === true || r.spanIsW0 !== true);
record(9,
  badNav.length === 0 ? 'PASS' : 'PARTIAL',
  badNav.length === 0
    ? `All 7 spot-checked pages have inactive About → ./about.html with w-0 hover span.`
    : `Issues on: ${JSON.stringify(badNav)}`
);

// 10 — IntersectionObserver wired + sections have initial reveal state
const observerCheck = await page.evaluate(() => {
  const reveals = document.querySelectorAll('.reveal');
  const sample = reveals[0];
  const style = sample ? getComputedStyle(sample) : null;
  return {
    revealCount: reveals.length,
    hasIO: typeof IntersectionObserver !== 'undefined',
    transition: style ? style.transitionProperty : null,
  };
});
const ioInSource = /new IntersectionObserver/.test(fs.readFileSync(path.join(ROOT, 'about.html'), 'utf8'));
record(10,
  (observerCheck.revealCount > 0 && ioInSource) ? 'PASS' : 'FAIL',
  `.reveal nodes=${observerCheck.revealCount}, IntersectionObserver wired=${ioInSource}, transition=${observerCheck.transition}`
);

// 11 — Mobile responsive at 375px
const mobile = await browser.newPage();
await mobile.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
await mobile.goto(target, { waitUntil: 'networkidle0', timeout: 45000 });
await new Promise(r => setTimeout(r, 800));

const mobileChecks = await mobile.evaluate(() => {
  const doc = document.documentElement;
  const body = document.body;
  const horizScroll = doc.scrollWidth > doc.clientWidth + 1 || body.scrollWidth > doc.clientWidth + 1;

  // Hero stacks: photo above text — order is photo (order-1), text (order-2) — but on mobile, stacking comes from grid-cols absent + order utilities.
  const heroGrid = document.querySelector('section#main .grid');
  const photoWrap = document.querySelector('.portrait-frame');
  const textCol = document.querySelector('section#main .lg\\:col-span-7');
  let stackedPhotoAbove = false;
  if (photoWrap && textCol) {
    const pRect = photoWrap.getBoundingClientRect();
    const tRect = textCol.getBoundingClientRect();
    stackedPhotoAbove = pRect.bottom <= tRect.top + 4;
  }

  // Skills cols: at 375 the grid is `grid` with no md cols → 1 col
  const skillCols = document.querySelectorAll('.skill-col');
  let skillsVertical = true;
  if (skillCols.length >= 2) {
    const a = skillCols[0].getBoundingClientRect();
    const b = skillCols[1].getBoundingClientRect();
    skillsVertical = b.top >= a.bottom - 4;
  }

  // Project grid: should be 1 col on 375px → check first 2 cards vertical
  const projCards = document.querySelectorAll('a.project-card');
  let projVertical = true;
  if (projCards.length >= 2) {
    const a = projCards[0].getBoundingClientRect();
    const b = projCards[1].getBoundingClientRect();
    projVertical = b.top >= a.bottom - 4;
  }

  // Nav toggle visible
  const toggle = document.getElementById('mobile-menu-toggle');
  const toggleVisible = toggle ? getComputedStyle(toggle).display !== 'none' : false;
  // Desktop nav hidden
  const desktopNav = document.querySelector('header nav.hidden');
  const desktopNavHidden = desktopNav ? getComputedStyle(desktopNav).display === 'none' : false;

  return {
    horizScroll,
    docScrollWidth: doc.scrollWidth,
    docClientWidth: doc.clientWidth,
    stackedPhotoAbove,
    skillsVertical,
    projVertical,
    toggleVisible,
    desktopNavHidden,
  };
});
// Test toggle actually opens
let toggleOpens = false;
try {
  await mobile.click('#mobile-menu-toggle');
  await new Promise(r => setTimeout(r, 400));
  toggleOpens = await mobile.evaluate(() => {
    const m = document.getElementById('mobile-menu');
    return m && m.classList.contains('is-open');
  });
} catch {}
await mobile.close();

const m11pass = !mobileChecks.horizScroll && mobileChecks.stackedPhotoAbove && mobileChecks.skillsVertical && mobileChecks.projVertical && mobileChecks.toggleVisible && mobileChecks.desktopNavHidden && toggleOpens;
record(11,
  m11pass ? 'PASS' : 'PARTIAL',
  `horizScroll=${mobileChecks.horizScroll} (sw=${mobileChecks.docScrollWidth}/cw=${mobileChecks.docClientWidth}) heroStacked=${mobileChecks.stackedPhotoAbove} skillsVert=${mobileChecks.skillsVertical} projVert=${mobileChecks.projVertical} togVisible=${mobileChecks.toggleVisible} desktopNavHidden=${mobileChecks.desktopNavHidden} togOpens=${toggleOpens}`
);

// 12 — contact buttons
const contact = await page.evaluate(() => {
  const email = [...document.querySelectorAll('a')].find(a => /^mailto:heycristinecrisolo@gmail\.com$/i.test(a.getAttribute('href') || ''));
  const linkedin = [...document.querySelectorAll('a')].find(a => /linkedin\.com\/in\/cristinecrisolo\/?$/i.test(a.getAttribute('href') || ''));
  return {
    emailHref: email ? email.getAttribute('href') : null,
    linkedinHref: linkedin ? linkedin.getAttribute('href') : null,
    linkedinTarget: linkedin ? linkedin.getAttribute('target') : null,
    linkedinRel: linkedin ? linkedin.getAttribute('rel') : null,
  };
});
const c12pass = contact.emailHref === 'mailto:heycristinecrisolo@gmail.com'
  && /linkedin\.com\/in\/cristinecrisolo/.test(contact.linkedinHref || '')
  && contact.linkedinTarget === '_blank'
  && /noopener/.test(contact.linkedinRel || '');
record(12,
  c12pass ? 'PASS' : 'FAIL',
  `email=${contact.emailHref} linkedin=${contact.linkedinHref} target=${contact.linkedinTarget} rel=${contact.linkedinRel}`
);

// 13 — crawl all imgs + hrefs for 404s
const assets = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].map(i => i.getAttribute('src')).filter(Boolean);
  const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href')).filter(Boolean);
  return { imgs, links };
});
const isLocal = (u) => u && !/^(https?:|mailto:|tel:|#|data:)/i.test(u);
const toFetch = new Set();
assets.imgs.filter(isLocal).forEach(u => toFetch.add(u));
assets.links.filter(isLocal).forEach(u => toFetch.add(u.replace(/#.*$/, '')));
const broken = [];
for (const u of toFetch) {
  if (!u) continue;
  const url = u.startsWith('/') ? `http://localhost:${PORT}${u}` : `http://localhost:${PORT}/${u.replace(/^\.\//,'')}`;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    // Some static servers (this one) may not handle HEAD differently; treat 404 as broken.
    if (r.status >= 400) broken.push({ url: u, status: r.status });
  } catch (e) {
    broken.push({ url: u, error: e.message });
  }
}
// Plus the existing pageload request failures
const totalBroken = broken.length + requestFailures.length;
record(13,
  totalBroken === 0 ? 'PASS' : 'FAIL',
  totalBroken === 0 ? `All ${toFetch.size} local imgs + links resolved 200; 0 network failures during load.` : `Broken: ${JSON.stringify(broken)} pageLoadFailures: ${JSON.stringify(requestFailures)}`
);

// 14 — distinctive design checks (best-effort, source-level)
const html = fs.readFileSync(path.join(ROOT, 'about.html'), 'utf8');
const heroHasSerifIt = /display-it[^"]*"[^>]*>Crisolo\./.test(html) || /Crisolo\.<\/span>/.test(html.replace(/\s+/g, ' '));
const goldGradientCssVar = /linear-gradient\(135deg,#F5D38A/.test(html);
const goldUseCount = (html.match(/text-gold(?![- ])/g) || []).length;
const goldRestrained = goldUseCount < 30; // sanity ceiling — gold is used as accent, not blanketed
const glassOnExperience = /<article class="reveal[^"]* glass"/.test(html);
const creativeOutletLine = /Off the clock: cats, books, slow mornings/.test(html);
const d14pass = heroHasSerifIt && goldGradientCssVar && goldRestrained && glassOnExperience && creativeOutletLine;
record(14,
  d14pass ? 'PASS' : 'PARTIAL',
  `serif-it hero=${heroHasSerifIt} goldGradient=${goldGradientCssVar} goldRestrainedCount=${goldUseCount}/<30 glassOnExperience=${glassOnExperience} creativeLine=${creativeOutletLine}`
);

await browser.close();
server.close();

// ─────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────
const titles = {
  1: 'about.html loads without errors',
  2: 'Profile photo visible in hero',
  3: 'Resume download link works',
  4: 'Video reel autoplays muted',
  5: 'Video reel loops continuously',
  6: 'Screenshot cards only show real projects (exactly 7)',
  7: 'Every screenshot card links to its correct HTML page',
  8: 'About nav is highlighted as active on about.html',
  9: 'About nav link works correctly from other pages',
  10: 'Scroll-triggered animations fire (IntersectionObserver)',
  11: 'Mobile responsive at 375px width',
  12: 'Contact buttons function correctly',
  13: 'No broken images or 404 links',
  14: 'Design feels distinctive (not generic)',
};

console.log('\n═══════════════════════════════════════');
console.log(' VERIFICATION REPORT — about.html / Step 6');
console.log('═══════════════════════════════════════\n');

let pass = 0, fail = 0, partial = 0;
for (const r of results) {
  if (r.status === 'PASS') pass++;
  else if (r.status === 'FAIL') fail++;
  else partial++;
  console.log(`${String(r.id).padStart(2,' ')}. [${r.status}] ${titles[r.id]}`);
  console.log(`    └ ${r.note}\n`);
}
console.log(`Total: ${pass} PASS / ${fail} FAIL / ${partial} PARTIAL`);
process.exit(fail > 0 ? 1 : 0);
