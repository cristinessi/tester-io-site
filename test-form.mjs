// test-form.mjs — drive the Tester.io contact form 20 times with mocked
// Supabase calls. Each iteration: open the home page, fill the 3 fields,
// submit, confirm the redirect to /thankyou.html. No real network calls
// to Supabase — page.route() intercepts and fakes a 201 response.
//
// Run with:  node test-form.mjs
// (NOT `npx playwright test` — we use the Playwright LIBRARY, not the
// test runner, so the 20-iteration loop pattern stays simple.)

import { chromium } from '@playwright/test';

const URL_ROOT   = 'http://localhost:3000';
const ITERATIONS = 20;
const SLOW_MO    = 200;    // ms between actions — slow enough to watch
const TIMEOUT    = 60000;  // 60s budget per iteration (covers the 1.5s redirect)

// Distinct names so each iteration looks like a different visitor in any
// dashboard that ends up consuming the data.
const NAMES = [
  'Iris Halloway','Theo Lin','Marisol Pesce','Ren Fukuda','Anya Beck',
  'Caleb Marsh','Dione Rivera','Eli Stratton','Freya Quinn','Gus Aoki',
  'Hana Petrov','Idris Maliki','June Cortez','Kai Tomlin','Lior Greene',
  'Mira Vance','Niko Saari','Ola Brandt','Pia Loeb','Quinn Reyes',
];

const main = async () => {
  // headless:false → visible browser; slowMo throttles every action.
  const browser = await chromium.launch({ headless: false, slowMo: SLOW_MO });
  let pass = 0, fail = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const n = i + 1;
    console.log(`Iteration ${n}/${ITERATIONS}...`);

    // Fresh context per iteration so cookies / form state never leak between runs.
    const ctx  = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(TIMEOUT);

    // Intercept every Supabase call — REST inserts AND the Edge Function the
    // form fires for confirmation email. Returns the fake 201 the spec asked for.
    await page.route('**/*.supabase.co/**', (route) => {
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, name: 'test' }]),
      });
    });

    // Unique data per iteration so the 20 rows look like 20 distinct visitors.
    const name    = NAMES[i % NAMES.length];
    const email   = `tester${n}@example.test`;
    const message = `Iteration ${n} — automated Playwright submission.`;

    try {
      await page.goto(URL_ROOT);
      await page.locator('#cf-name').fill(name);
      await page.locator('#cf-email').fill(email);
      await page.locator('#cf-message').fill(message);
      await page.locator('#cf-submit').click();

      // Form JS shows the inline thank-you for ~1.5s then redirects.
      // waitForURL throws on timeout → that throw is caught below as a failure.
      await page.waitForURL('**/thankyou.html', { timeout: 10000 });
      console.log(`  PASS  ${name} -> thankyou.html`);
      pass++;
    } catch (err) {
      console.error(`  FAIL  ${name}: ${err.message.split('\n')[0]}`);
      fail++;
    } finally {
      await ctx.close();
    }
  }

  await browser.close();
  console.log(`\nDone. ${pass} passed, ${fail} failed (of ${ITERATIONS}).`);
};

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
