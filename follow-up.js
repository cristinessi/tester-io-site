// follow-up.js — fetch every contact-form submission from Supabase and
// send each person a follow-up email via Resend. Standalone (no Express
// dependency). Run with:  node follow-up.js
//
// Requires in .env:  SUPABASE_URL (base URL, NO path), SUPABASE_KEY,
//                    RESEND_API_KEY (starts with re_).
require('dotenv').config();
const { SUPABASE_URL, SUPABASE_KEY, RESEND_API_KEY } = process.env;

// Fail fast if anything's missing — better than a confusing 401 later.
const missing = ['SUPABASE_URL', 'SUPABASE_KEY', 'RESEND_API_KEY']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing env vars:', missing.join(', '));
  process.exit(1);
}

// Promise-based sleep used to space out Resend requests (500ms each).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTML body — three sections: (a) product value, (b) testimonial, (c) what's new.
const emailHtml = (name) => `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#15110D">
  <h1 style="font-style:italic;color:#A8853F;font-size:28px;margin:0 0 20px">Hi ${name},</h1>
  <h2 style="font-size:14px;letter-spacing:0.2em;text-transform:uppercase;color:#A8853F">What we do</h2>
  <p style="font-size:16px;line-height:1.7">Tester.io is the quality-engineering studio teams call when their software has to work. We pair senior testers with automation, performance, and security tooling — embedded with your team, accountable for the same metrics you are.</p>
  <h2 style="font-size:14px;letter-spacing:0.2em;text-transform:uppercase;color:#A8853F">What clients say</h2>
  <blockquote style="border-left:2px solid #C6A559;padding:8px 0 8px 16px;margin:16px 0;font-style:italic">&ldquo;They found three production-critical bugs in the first week. We&rsquo;ve been a customer since.&rdquo;<br><span style="font-size:13px;color:#6B6259">&mdash; Iris H., Helix</span></blockquote>
  <h2 style="font-size:14px;letter-spacing:0.2em;text-transform:uppercase;color:#A8853F">What&rsquo;s new</h2>
  <p style="font-size:16px;line-height:1.7">We just shipped <strong>Tester Smart Watch Pro</strong> &mdash; our first hardware product, built with the same rigor we apply to your code.</p>
  <p style="font-size:13px;color:#6B6259;margin-top:32px">&mdash; The Tester.io team</p>
</div>`;

// GET every row's name + email from the submissions table.
async function fetchSubmissions() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions?select=name,email`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

// POST one email through Resend's REST API.
async function sendEmail(to, name) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Tester.io <onboarding@resend.dev>',
      to,
      subject: 'An update from Tester.io',
      html: emailHtml(name),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  return res.json();
}

// Main: fetch all rows, then send sequentially with a 500 ms pause between.
(async () => {
  const rows = await fetchSubmissions();
  console.log(`Found ${rows.length} submission${rows.length === 1 ? '' : 's'}.\n`);
  for (let i = 0; i < rows.length; i++) {
    const { name, email } = rows[i];
    const tag = `  ${i + 1}/${rows.length}`;
    try {
      await sendEmail(email, name || 'there');
      console.log(`${tag}  ✓ sent to ${email}`);
    } catch (err) {
      console.error(`${tag}  ✗ ${email}: ${err.message}`);
    }
    if (i < rows.length - 1) await sleep(500);
  }
  console.log('\nDone.');
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
