# Trend Finder — Backend

Python + Flask backend for the **Trend Finder** page on the Tester.io site. Scrapes
DuckDuckGo's HTML SERP with `requests` + `BeautifulSoup` and returns the top 5
trending results for any topic.

```
trend-finder-backend/
├── server.py         Flask app + /api/trends endpoint
├── scraper.py        DuckDuckGo scraper (calls into requests + bs4)
├── requirements.txt  Python deps (flask, flask-cors, requests, beautifulsoup4, lxml)
└── README.md         This file
```

---

## Run it (Windows / PowerShell)

From the project root `C:\Users\crist\ArcaPH`:

```powershell
# 1. (Optional but recommended) create a venv inside the backend folder
python -m venv trend-finder-backend\.venv
trend-finder-backend\.venv\Scripts\Activate.ps1

# 2. Install dependencies
pip install -r trend-finder-backend\requirements.txt

# 3. Start the server (runs on http://localhost:5000)
python trend-finder-backend\server.py
```

You should see Flask boot output ending with `Running on http://0.0.0.0:5000`.
Leave that terminal open while you use the frontend.

### Without a venv (one-liner)

```powershell
pip install -r trend-finder-backend\requirements.txt
python trend-finder-backend\server.py
```

---

## Use it

While `server.py` is running, open **`trend-finder.html`** in your browser
(either as `file://…/trend-finder.html` or via VS Code Live Server). Type a
topic into the search box and hit **Search**. The page POSTs to
`http://localhost:5000/api/trends` and renders the top 5 cards.

> **The Flask server must be running for the page to return results.** If you
> see *"Backend not reachable — start it with `python trend-finder-backend/server.py`"*
> on the page, the server is down — start it from the command above.

---

## API

### `POST /api/trends`

Request body:
```json
{ "topic": "smart watches" }
```

Success (HTTP 200):
```json
{
  "results": [
    {
      "name":   "The best smart watches of 2026",
      "url":    "https://example.com/best-smart-watches",
      "source": "example.com",
      "image":  "https://example.com/og-image.jpg"
    }
  ]
}
```
`results` contains up to 5 items. `image` is `null` when the result page has no
OpenGraph image.

Failure (non-200, JSON body):
```json
{ "error": "No trending results found for 'xyz'." }
```

| Status | Cause                                                    |
|-------:|----------------------------------------------------------|
| 400    | Missing or invalid `topic`                               |
| 404    | Scrape succeeded but returned zero parsable results      |
| 502    | DuckDuckGo blocked us, or markup unparseable             |
| 504    | Timeout reaching DuckDuckGo                              |

### `GET /api/health`

Cheap liveness check — returns `{ "ok": true, "service": "trend-finder" }`.

---

## Notes

- **Source: Google News RSS** (`https://news.google.com/rss/search`). The path here had a couple of detours: we started on DuckDuckGo's HTML SERP, then pivoted to Bing on 2026-05-18 when DDG stopped parsing — but in 2026 both major engines serve a CAPTCHA / bot-challenge page to plain `requests` traffic instead of organic results (we confirmed with `debug_fetch.py` that Bing returns "One last step — please solve the challenge below"). RSS is purpose-built for machines: structured XML, no JavaScript, no bot walls, still parsed by BeautifulSoup (`xml` parser), so it stays squarely inside the lesson's stack while actually returning live data.
- Most/all results will come back with `image: null` because Google News wraps result links in a `news.google.com/rss/articles/...` redirect that doesn't expose an `og:image` meta tag. That's expected — the frontend renders a "No image" placeholder for those cards.
- The OpenGraph image fetch is best-effort: it has a short timeout and any
  failure simply returns `image: null` for that item (the frontend renders a
  "No image" placeholder).
- CORS is wide-open (`*`) for `/api/*` so the static HTML pages can call the
  API from `file://` or Live Server. Lock this down before shipping anywhere
  real.
