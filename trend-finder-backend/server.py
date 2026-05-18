"""
Tester.io — Trend Finder backend.

Single endpoint: POST /api/trends
  Request:  { "topic": "<search string>" }
  Response: { "results": [ { "name", "image", "source", "url" }, ... up to 5 ] }
            { "error": "<message>" }   (on failure, with non-200 status)

Runs at http://localhost:5000 (Flask default). CORS open for local dev so the
static HTML pages can hit the API from file:// or Live Server.
"""

import os

from flask import Flask, jsonify, request
from flask_cors import CORS

import scraper

app = Flask(__name__)

# CORS — comma-separated allowlist from env var CORS_ORIGINS (production),
# falling back to wildcard for local dev so file:// and Live Server still work.
_cors_env = os.environ.get("CORS_ORIGINS", "").strip()
_cors_origins = [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else "*"
CORS(app, resources={r"/api/*": {"origins": _cors_origins}})


@app.route("/api/trends", methods=["POST"])
def trends():
    payload = request.get_json(silent=True) or {}
    topic = (payload.get("topic") or "").strip()

    if not topic:
        return jsonify({"error": "Missing 'topic' in request body."}), 400
    if len(topic) > 200:
        return jsonify({"error": "Topic is too long (max 200 chars)."}), 400

    try:
        items = scraper.search_trends(topic, limit=5)
    except scraper.ScrapeTimeout as e:
        return jsonify({"error": f"Search timed out: {e}"}), 504
    except scraper.ScrapeBlocked as e:
        return jsonify({"error": f"Search source blocked the request: {e}"}), 502
    except scraper.ScrapeError as e:
        return jsonify({"error": f"Scrape failed: {e}"}), 502

    if not items:
        return jsonify({"error": f"No trending results found for '{topic}'."}), 404

    return jsonify({"results": items}), 200


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "trend-finder"}), 200


if __name__ == "__main__":
    # PORT comes from the platform in production (Render injects it). Local dev
    # falls back to 5000. Listen on all interfaces so it works in WSL/containers too.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
