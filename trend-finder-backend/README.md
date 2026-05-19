# Trend Finder — Backend

Python + Flask backend for the **Trend Finder** page on the Tester.io site.
Multi-source trend aggregator (Google News + Reddit + Hacker News) plus a
Gemini-powered article extractor that turns a long ranked-list article into a
structured list of ideas.

```
trend-finder-backend/
├── server.py         Flask app + /api/trending, /api/extract, /api/health
├── scraper.py        Multi-source aggregator (Google News RSS + Reddit JSON + HN Algolia)
├── extractor.py      Article fetch + clean + Gemini Flash → ranked list
├── requirements.txt  Python deps
├── Procfile          Render start command (gunicorn server:app)
├── debug_fetch.py    Diagnostic tool (legacy, kept for reference)
└── README.md         This file
```

---

## What changed in this upgrade

- **Single-source → multi-source.** The scraper now hits Google News RSS, the
  Reddit search JSON endpoint, and the Hacker News Algolia API in sequence,
  merges with a round-robin interleave, de-duplicates by URL, and returns
  the top 5.
- **Better data model.** Each result is now
  `{ title, url, source, thumbnail, published }` (was `name / image`).
- **New `/api/extract` endpoint** powered by **Gemini Flash**. Given a URL,
  fetches the article, strips chrome (`<script>`, `<nav>`, `<aside>`, etc.),
  sends the cleaned body to Gemini, and returns a structured list of the
  ranked items the article was actually recommending.
- **Google News redirect awareness.** The Google News RSS feed's `<link>`
  values are `news.google.com/rss/articles/...` redirects that don't serve
  article HTML directly. `/api/extract` detects this and returns HTTP 422
  with `code: "google_news_redirect"` so the frontend can ask the user to
  paste the final URL.
- **`.env` loading.** Local dev reads `trend-finder-backend/.env` via
  `python-dotenv`; production reads real env vars. `GEMINI_API_KEY` is
  required for `/api/extract`.
- **Default port: 5001** (was 5000). `PORT` env var still wins so Render
  works unchanged.

---

## Setup

### 1. Install dependencies

From the project root `C:\Users\crist\ArcaPH`:

```powershell
# Optional venv
python -m venv trend-finder-backend\.venv
trend-finder-backend\.venv\Scripts\Activate.ps1

# Install
pip install -r trend-finder-backend\requirements.txt
```

### 2. Add your Gemini key

Create `trend-finder-backend/.env` (gitignored) with:

```
GEMINI_API_KEY=your-gemini-api-key-here
```

Without this, `/api/trending` still works fully, but `/api/extract` returns
HTTP 503 with `"Gemini API key not configured on the server."`

### 3. Run the server

```powershell
python trend-finder-backend\server.py
```

Output should end with `Running on http://0.0.0.0:5001` and one of:
- `Gemini: configured`
- `Gemini: missing (set GEMINI_API_KEY in trend-finder-backend/.env)`

The frontend (`trend-finder.html`) talks to `http://localhost:5001/api/...`
when opened locally. Keep this terminal open while you use it.

---

## API

### `GET /api/trending?q=<query>`

Aggregates trending results across Google News, Reddit, and Hacker News.

```bash
curl "http://localhost:5001/api/trending?q=smart+watches"
```

Success (HTTP 200):
```json
{
  "results": [
    {
      "title":     "The best smart watches of 2026",
      "url":       "https://example.com/best-smart-watches",
      "source":    "Google News",
      "thumbnail": "https://example.com/og.jpg",
      "published": "2026-05-12T14:00:00+00:00"
    },
    {
      "title":     "Why I switched from Apple Watch to Garmin",
      "url":       "https://www.reddit.com/r/smartwatch/comments/abc/...",
      "source":    "Reddit · r/smartwatch",
      "thumbnail": null,
      "published": "2026-05-15T09:33:12+00:00"
    }
  ]
}
```

| Status | Cause                                                       |
|-------:|-------------------------------------------------------------|
| 400    | Missing or invalid `q`                                      |
| 404    | All sources succeeded but combined results were empty       |
| 502    | All sources blocked / unparseable                           |
| 504    | All sources timed out                                       |

Partial success (one or two sources fail) still returns 200 with whatever
the surviving source(s) gave us.

### `GET /api/extract?url=<article_url>`

Fetches the article, cleans it, and asks Gemini Flash to extract the ranked
list of items the article is recommending.

```bash
curl "http://localhost:5001/api/extract?url=https://example.com/best-watches"
```

Success (HTTP 200):
```json
{
  "title": "The best smart watches of 2026",
  "url":   "https://example.com/best-watches",
  "items": [
    {"rank": 1, "idea": "Apple Watch Ultra 3"},
    {"rank": 2, "idea": "Garmin Fenix 9"},
    {"rank": 3, "idea": "Samsung Galaxy Watch 8"}
  ]
}
```

| Status | Cause                                                                                  |
|-------:|----------------------------------------------------------------------------------------|
| 400    | Missing / malformed `url`                                                              |
| 422    | URL is a Google News redirect — frontend should ask user to paste the real URL        |
| 502    | Article host blocked, or Gemini returned malformed output                             |
| 503    | `GEMINI_API_KEY` not configured on the server                                          |
| 504    | Article fetch timed out                                                                |

The 422 response also includes `"code": "google_news_redirect"` so the
frontend can distinguish it from other 422s if any are added later.

### `GET /api/health`

```json
{ "ok": true, "service": "trend-finder", "gemini_configured": true }
```

---

## Notes

- **Source: multi-feed.** RSS for Google News, JSON for Reddit + HN. The path
  here had detours — we started on DuckDuckGo HTML, pivoted to Bing on
  2026-05-18 when DDG stopped parsing, but in 2026 both major engines serve a
  CAPTCHA / bot-challenge page to plain `requests` traffic instead of organic
  results. Structured feeds (RSS / JSON) bypass that entirely and stay
  squarely inside the lesson's stack (Flask + requests + BeautifulSoup +
  feedparser).
- **Gemini model.** `gemini-2.0-flash` — fast, cheap, structured-output
  reliable enough for ranked lists with a strict prompt.
- **Fallback.** If Gemini errors or returns an empty list, `extractor.py`
  scans the cleaned soup for `<ol><li>` and numbered `<h2>` / `<h3>` patterns
  and returns those when ≥3 are found. Otherwise the response's `items` is
  `[]` — the frontend should render that as "no ranked list detected."
- **Secrets.** `GEMINI_API_KEY` lives only in `trend-finder-backend/.env`
  (gitignored) for local dev, or as a real env var on Render. The key is
  never logged and never returned to the client.
- CORS is wide-open (`*`) for `/api/*` by default. Lock it down on Render via
  the `CORS_ORIGINS` env var (e.g. `https://tester-io-site.vercel.app`).
