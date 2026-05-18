// tester.io contact-form backend
// POST /api/contact  → validates 3 fields → appends a row to a Google Sheet.
// No DB, no auth beyond Google's service-account JWT.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');

// ----- env --------------------------------------------------------------
const {
  PORT = 3001,
  CORS_ORIGIN = 'http://localhost:3000',
  GOOGLE_SHEET_ID,
  GOOGLE_SHEET_RANGE = 'Sheet1!A:D',
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
} = process.env;

// Fail fast if any required secret is missing — better than a confusing
// 500 on the first submission.
const missing = [
  ['GOOGLE_SHEET_ID', GOOGLE_SHEET_ID],
  ['GOOGLE_SERVICE_ACCOUNT_EMAIL', GOOGLE_SERVICE_ACCOUNT_EMAIL],
  ['GOOGLE_PRIVATE_KEY', GOOGLE_PRIVATE_KEY],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing env vars:', missing.join(', '));
  process.exit(1);
}

// ----- Google Sheets auth (JWT, service account) ------------------------
// The private key in .env contains literal "\n" sequences — Node sees those
// as backslash + n, not newlines. PEM parser needs real newlines, so we
// convert here at module load. Skipping this is the #1 cause of cryptic
// "DECODER routines::unsupported" errors after deploy.
const auth = new google.auth.JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ----- validation -------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, field: 'body', reason: 'missing_body' };
  }
  const name    = typeof body.name === 'string'    ? body.name.trim()    : '';
  const email   = typeof body.email === 'string'   ? body.email.trim()   : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (name.length    < 1 || name.length    > 200)  return { ok: false, field: 'name',    reason: 'bad_length' };
  if (email.length   < 1 || email.length   > 200)  return { ok: false, field: 'email',   reason: 'bad_length' };
  if (!EMAIL_RE.test(email))                       return { ok: false, field: 'email',   reason: 'bad_format' };
  if (message.length < 1 || message.length > 5000) return { ok: false, field: 'message', reason: 'bad_length' };

  return { ok: true, name, email, message };
}

// ----- app --------------------------------------------------------------
const app = express();

app.set('trust proxy', 1);                            // for accurate req.ip behind a proxy
app.use(cors({ origin: CORS_ORIGIN }));               // before json parser, so OPTIONS preflight returns the right headers
app.use(express.json({ limit: '12kb' }));             // 3-field form — 12 KB is plenty

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/contact', async (req, res, next) => {
  const v = validate(req.body);
  if (!v.ok) {
    console.warn(`[contact] invalid_input field=${v.field} reason=${v.reason}`);
    return res.status(400).json({ ok: false, error: 'invalid_input', field: v.field });
  }

  // PII-free debug line — lengths only.
  console.log(
    `[contact] received from ${req.ip} ` +
    `name-len=${v.name.length} email-len=${v.email.length} msg-len=${v.message.length}`
  );

  const t0 = Date.now();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: GOOGLE_SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[new Date().toISOString(), v.name, v.email, v.message]],
      },
    });
    console.log(`[contact] appended row in ${Date.now() - t0}ms`);
    res.json({ ok: true });
  } catch (err) {
    // Sheets API errors include code/message — surface the message in the log
    // (not to the client), and 500 the client.
    console.error(`[contact] sheet error: ${err.message}`);
    next(err);
  }
});

// Final error handler — anything thrown async lands here.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  res.status(500).json({ ok: false, error: 'server_error' });
});

// ----- start ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`tester.io form server :${PORT}`);
  console.log(
    `env: sheetId=${GOOGLE_SHEET_ID ? 'set' : 'MISSING'} ` +
    `range=${GOOGLE_SHEET_RANGE} ` +
    `serviceAccount=${GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'set' : 'MISSING'} ` +
    `cors=${CORS_ORIGIN}`
  );
});
