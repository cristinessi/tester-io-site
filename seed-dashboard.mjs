// seed-dashboard.mjs — insert 20 realistic submissions into the Supabase
// table so the admin dashboard has meaningful data to display.
// Run with:  node seed-dashboard.mjs
//
// Requires in .env:  SUPABASE_URL (base, no path) + SUPABASE_KEY (publishable).

import 'dotenv/config';

const { SUPABASE_URL, SUPABASE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
  process.exit(1);
}

const ENDPOINT = `${SUPABASE_URL}/rest/v1/submissions`;

// 20 fake submissions. Distribution: 8 replied, 5 subscribed, some overlap.
// Mixed companies / topics so the dashboard's recent-activity list reads naturally.
const ROWS = [
  { name: 'Iris Halloway',  email: 'iris.h@helix.io',           message: "Launching in Q3 and need a regression-testing partner. Available next week to scope?",     replied: true,  subscribed: true  },
  { name: 'Marek Vahler',   email: 'marek@vahler.studio',       message: "Our checkout flow is flaky under load — random 500s. Can we get a quick triage call?",     replied: false, subscribed: false },
  { name: 'Sasha Lin',      email: 'sasha.lin@northbridge.co',  message: "Looking for SOC 2 compliance testing. Have you worked with fintech before?",               replied: true,  subscribed: false },
  { name: 'Jules Conran',   email: 'jules@conran-co.uk',        message: "Following up after the Q1 demo — we're ready to engage. Send a contract template?",        replied: true,  subscribed: true  },
  { name: 'Pia Strand',     email: 'pia.strand@aperture.dev',   message: "Black Friday is in 8 weeks. Need a perf audit + load plan ASAP.",                          replied: false, subscribed: false },
  { name: 'Theo Okafor',    email: 'theo@quanta-ai.com',        message: "We're hiring two QA engineers but want a fractional partner to bridge the gap.",           replied: true,  subscribed: true  },
  { name: 'Mira Vance',     email: 'mira.vance@firstlight.io',  message: "Investigating an intermittent regression in our mobile build. Open to consultancy?",       replied: false, subscribed: false },
  { name: 'Ben Holstrom',   email: 'ben@holstrom.design',       message: "Mostly curious about your services — sending this to start a conversation.",               replied: false, subscribed: true  },
  { name: 'Anya Beck',      email: 'anya@beck-labs.io',         message: "Manual QA hand-offs have been chaotic. Want to scope a longer engagement.",                replied: true,  subscribed: false },
  { name: 'Caleb Marsh',    email: 'caleb.marsh@drift.studio',  message: "Read the Tester Smart Watch Pro launch — gorgeous work. We make wearables too, let's talk.", replied: true,  subscribed: true  },
  { name: 'Dione Rivera',   email: 'dione@riveraworks.com',     message: "Curious whether you do accessibility audits as part of the standard scope?",                replied: false, subscribed: false },
  { name: 'Eli Stratton',   email: 'eli@stratton.partners',     message: "Our test suite takes 47 minutes. Help us cut that in half?",                                replied: true,  subscribed: false },
  { name: 'Freya Quinn',    email: 'freya.q@cobalt.io',         message: "Looking for an external eye on our API contract testing.",                                  replied: false, subscribed: false },
  { name: 'Gus Aoki',       email: 'gus.aoki@kestrel.co',       message: "Pre-seed startup, two engineers, runway questions — wondering if you do hourly?",           replied: false, subscribed: false },
  { name: 'Hana Petrov',    email: 'hana@petrov.is',            message: "We have a release every Friday and zero automation. Send help.",                            replied: true,  subscribed: false },
  { name: 'Idris Maliki',   email: 'idris@maliki.dev',          message: "Following up on the email I sent in March — has scope changed since?",                      replied: false, subscribed: false },
  { name: 'June Cortez',    email: 'june.cortez@orbital.gg',    message: "Multiplayer game studio. Need someone who's tested networked code before.",                 replied: false, subscribed: false },
  { name: 'Kai Tomlin',     email: 'kai@tomlin.audio',          message: "Indie music app, 12k MAU. Want lightweight crash-rate monitoring + manual smoke tests.",    replied: true,  subscribed: false },
  { name: 'Lior Greene',    email: 'lior.greene@parable.co',    message: "Following the work on Sights.html — beautiful. Adding us to the newsletter please.",        replied: false, subscribed: true  },
  { name: 'Nora Brandt',    email: 'nora.brandt@haven.studio',  message: "Hi! Just exploring options for a Q2 partnership. What does onboarding look like?",          replied: false, subscribed: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
console.log(`Seeding ${ROWS.length} rows to ${ENDPOINT} ...\n`);

for (let i = 0; i < ROWS.length; i++) {
  const row = ROWS[i];
  const tag = `  ${String(i + 1).padStart(2, ' ')}/${ROWS.length}`;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        apikey:          SUPABASE_KEY,
        Authorization:   `Bearer ${SUPABASE_KEY}`,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
    ok++;
    console.log(`${tag}  ✓ ${row.name}  (replied:${row.replied} subscribed:${row.subscribed})`);
  } catch (err) {
    fail++;
    console.error(`${tag}  ✗ ${row.name}: ${err.message}`);
  }
  if (i < ROWS.length - 1) await sleep(60); // be polite to the API
}

console.log(`\nDone. ${ok} inserted, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
