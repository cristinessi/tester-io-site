"""
Tester.io — Trend Finder backend.

Endpoints:
  GET  /api/trending?q=<query>          Multi-source aggregator
                                        (Google News + Reddit + Hacker News)
  GET  /api/extract?url=<article_url>   Gemini-powered article → ranked-list
                                        extractor
  GET  /api/health                      Liveness probe

Runs at http://localhost:5001 by default (override with PORT). CORS origins
come from CORS_ORIGINS (comma-separated allowlist); falls back to wildcard
for local dev so file:// and Live Server still work.

The GEMINI_API_KEY env var is required for /api/extract. .env is loaded
automatically (via python-dotenv) if present at trend-finder-backend/.env.
"""

import os
import sys

# Load .env BEFORE we read environment variables. Wrap so prod doesn't break
# if python-dotenv isn't installed for some reason.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass

from flask import Flask, jsonify, request
from flask_cors import CORS

import scraper
import extractor


app = Flask(__name__)

# CORS — comma-separated allowlist from env var CORS_ORIGINS (production),
# falling back to wildcard for local dev so file:// and Live Server still work.
_cors_env = os.environ.get("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else "*"
CORS(app, resources={r"/api/*": {"origins": _cors_origins}})


# ---- Endpoints -------------------------------------------------------------

@app.route("/api/trending", methods=["GET"])
def trending():
    query = (request.args.get("q") or "").strip()
    if not query:
        return jsonify({"error": "Missing 'q' query parameter."}), 400
    if len(query) > 200:
        return jsonify({"error": "Query is too long (max 200 chars)."}), 400

    try:
        items = scraper.search_trending(query, limit=5)
    except scraper.ScrapeTimeout as e:
        return jsonify({"error": f"Search timed out: {e}"}), 504
    except scraper.ScrapeBlocked as e:
        return jsonify({"error": f"Search source blocked the request: {e}"}), 502
    except scraper.ScrapeError as e:
        return jsonify({"error": f"Scrape failed: {e}"}), 502

    if not items:
        return jsonify({"error": f"No trending results found for '{query}'."}), 404

    return jsonify({"results": items}), 200


@app.route("/api/extract", methods=["GET"])
def extract():
    url = (request.args.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Missing 'url' query parameter."}), 400
    if not url.startswith("http"):
        return jsonify({"error": "'url' must start with http or https."}), 400
    if len(url) > 2048:
        return jsonify({"error": "URL is too long (max 2048 chars)."}), 400

    try:
        payload = extractor.extract_article(url)
    except extractor.GoogleNewsRedirect as e:
        return jsonify({
            "error": "Google News redirect — please open the article and paste the final URL.",
            "code":  "google_news_redirect",
            "detail": str(e),
        }), 422
    except extractor.GeminiNotConfigured as e:
        return jsonify({
            "error": "Gemini API key not configured on the server.",
            "detail": str(e),
        }), 503
    except extractor.ExtractTimeout as e:
        return jsonify({"error": f"Article fetch timed out: {e}"}), 504
    except extractor.ExtractBlocked as e:
        return jsonify({"error": f"Article host blocked the request: {e}"}), 502
    except extractor.ExtractError as e:
        return jsonify({"error": f"Extraction failed: {e}"}), 502

    return jsonify(payload), 200


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "service": "trend-finder",
        "gemini_configured": bool(os.environ.get("GEMINI_API_KEY")),
    }), 200


# ---- Startup log -----------------------------------------------------------

def _startup_log() -> None:
    if os.environ.get("GEMINI_API_KEY"):
        print("Gemini: configured", file=sys.stdout, flush=True)
    else:
        print("Gemini: missing (set GEMINI_API_KEY in trend-finder-backend/.env)",
              file=sys.stdout, flush=True)


# Run once at import time so gunicorn (which never executes __main__) also logs it.
_startup_log()


if __name__ == "__main__":
    # PORT comes from the platform in production (Render injects it). Local dev
    # falls back to 5001. Listen on all interfaces so it works in WSL/containers too.
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)
