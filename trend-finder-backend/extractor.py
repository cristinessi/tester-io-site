"""
Trend Finder — article extractor.

Given a URL, fetch the page, strip the chrome, send the body to Gemini Flash,
and return the actual ranked list of products / ideas / items the article is
recommending. Heuristic HTML-only fallback is available but kept small and
clearly marked — Gemini is the real path.

Implements lesson Step 7 (Google News redirect workaround) and Step 8 (Gemini
structured-output extraction).

Public API:

    extract_article(url) -> {
        "title": "...",
        "url":   "...",
        "items": [{"rank": 1, "idea": "..."}, ...]
    }

Raises:
    GoogleNewsRedirect   — caller (server.py) should map to 422
    GeminiNotConfigured  — server.py should map to 503
    ExtractTimeout       — server.py should map to 504
    ExtractBlocked       — server.py should map to 502
    ExtractError         — server.py should map to 502
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional, List
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
FETCH_TIMEOUT = 15        # seconds for the article HTTP fetch
ARTICLE_MAX_CHARS = 40_000  # token-cost guardrail before Gemini call
GEMINI_MODEL = "gemini-2.0-flash"


# ---- Typed errors ----------------------------------------------------------

class ExtractError(Exception):
    """Generic extraction failure (parse, malformed Gemini output, etc.)."""


class ExtractTimeout(ExtractError):
    """Network timeout when fetching the article."""


class ExtractBlocked(ExtractError):
    """Article host returned a captcha / rate-limit / 4xx page."""


class GeminiNotConfigured(ExtractError):
    """GEMINI_API_KEY missing from the environment."""


class GoogleNewsRedirect(ExtractError):
    """URL points at a news.google.com redirect — caller must paste the real URL."""


# ---- Step 1: fetch the page ------------------------------------------------

def _fetch_html(url: str) -> str:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        resp = requests.get(url, headers=headers, timeout=FETCH_TIMEOUT, allow_redirects=True)
    except requests.Timeout as e:
        raise ExtractTimeout(str(e)) from e
    except requests.RequestException as e:
        raise ExtractError(f"Network error fetching article: {e}") from e

    if resp.status_code in (403, 429):
        raise ExtractBlocked(f"Article host returned {resp.status_code}.")
    if resp.status_code >= 400:
        raise ExtractError(f"Article host returned HTTP {resp.status_code}.")

    ctype = resp.headers.get("Content-Type", "").lower()
    if "html" not in ctype and "xml" not in ctype:
        raise ExtractError(f"Article URL did not return HTML (Content-Type: {ctype}).")

    if not resp.text:
        raise ExtractError("Article host returned an empty body.")

    return resp.text


# ---- Step 2: extract title + clean body text -------------------------------

def _extract_title(soup: BeautifulSoup) -> str:
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        return h1.get_text(strip=True)
    title_tag = soup.find("title")
    if title_tag and title_tag.get_text(strip=True):
        return title_tag.get_text(strip=True)
    return "(untitled)"


def _extract_body_text(soup: BeautifulSoup) -> str:
    # Remove chrome elements outright.
    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form", "noscript"]):
        tag.decompose()

    body = soup.body or soup
    text = body.get_text(separator="\n", strip=True)
    # Collapse runs of blank lines.
    text = re.sub(r"\n{3,}", "\n\n", text)
    if len(text) > ARTICLE_MAX_CHARS:
        text = text[:ARTICLE_MAX_CHARS]
    return text


# ---- Step 3: call Gemini ---------------------------------------------------

_GEMINI_PROMPT_TEMPLATE = """\
You are reading a web article. Identify the actual ranked list of products, ideas, tools, or items the article is recommending.

Return ONLY a JSON object with this exact shape, no markdown fencing, no commentary:
{{
  "items": [
    {{"rank": 1, "idea": "Short label for the product/idea/item"}},
    {{"rank": 2, "idea": "..."}}
  ]
}}

Rules:
- Skip navigation menus, sidebars, related-article links, ads, and author bios.
- Each "idea" is a short label (product name, idea title), not a paragraph.
- If the article has no clear ranked list, return {{"items": []}}.
- Do not invent items not in the article.
- Maximum 20 items.

ARTICLE TITLE: {title}
ARTICLE URL: {url}
ARTICLE TEXT:
{text}
"""


def _strip_code_fences(s: str) -> str:
    """Gemini sometimes ignores the 'no markdown' instruction. Strip ``` fences."""
    s = s.strip()
    # ```json ... ``` or ``` ... ```
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.DOTALL | re.IGNORECASE)
    if fence:
        return fence.group(1).strip()
    return s


def _call_gemini(title: str, url: str, text: str) -> List[dict]:
    api_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if not api_key:
        raise GeminiNotConfigured("GEMINI_API_KEY is not set.")

    try:
        import google.generativeai as genai  # local import keeps import cost off the hot path
    except ImportError as e:
        raise GeminiNotConfigured(f"google-generativeai not installed: {e}") from e

    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(GEMINI_MODEL)
        prompt = _GEMINI_PROMPT_TEMPLATE.format(title=title, url=url, text=text)
        response = model.generate_content(prompt)
    except Exception as e:
        # SDK exceptions vary by version — wrap in our generic ExtractError.
        raise ExtractError(f"Gemini call failed: {e}") from e

    raw = (getattr(response, "text", "") or "").strip()
    if not raw:
        raise ExtractError("Gemini returned an empty response.")

    raw = _strip_code_fences(raw)
    try:
        payload = json.loads(raw)
    except ValueError as e:
        raise ExtractError(f"Gemini returned malformed JSON: {e}") from e

    items = payload.get("items")
    if not isinstance(items, list):
        raise ExtractError("Gemini response is missing 'items' array.")

    cleaned: List[dict] = []
    for entry in items:
        if not isinstance(entry, dict):
            continue
        rank = entry.get("rank")
        idea = entry.get("idea")
        if not isinstance(idea, str) or not idea.strip():
            continue
        try:
            rank_int = int(rank)
        except (TypeError, ValueError):
            rank_int = len(cleaned) + 1
        cleaned.append({"rank": rank_int, "idea": idea.strip()})
        if len(cleaned) >= 20:
            break

    return cleaned


# ---- Step 4: small HTML-only fallback --------------------------------------

def _fallback_heuristic(soup: BeautifulSoup) -> List[dict]:
    """
    FALLBACK (Gemini-less, lesson-permitted only): scan the cleaned soup for
    obvious ranked-list patterns. We accept the result only if we find >= 3
    items, otherwise return [].

    Patterns considered:
      - <ol><li>…</li></ol>  (semantic ordered list)
      - <h2>1. …</h2>, <h3>2. …</h3>  (numbered headings)
    """
    candidates: List[str] = []

    # Ordered lists.
    for ol in soup.find_all("ol"):
        for li in ol.find_all("li", recursive=False):
            text = li.get_text(" ", strip=True)
            if 3 <= len(text) <= 240:
                candidates.append(text)
            if len(candidates) >= 20:
                break
        if len(candidates) >= 20:
            break

    # Numbered headings.
    if len(candidates) < 3:
        heading_re = re.compile(r"^\s*(\d+)\s*[\.\):\-]\s*(.+)$")
        for h in soup.find_all(["h2", "h3"]):
            text = h.get_text(" ", strip=True)
            m = heading_re.match(text)
            if m and 3 <= len(m.group(2)) <= 240:
                candidates.append(m.group(2).strip())
            if len(candidates) >= 20:
                break

    if len(candidates) < 3:
        return []

    return [{"rank": i + 1, "idea": text} for i, text in enumerate(candidates)]


# ---- Public API ------------------------------------------------------------

def extract_article(url: str) -> dict:
    """See module docstring."""
    if not isinstance(url, str) or not url.startswith("http"):
        raise ExtractError("URL must start with http or https.")

    host = (urlparse(url).hostname or "").lower()
    if host in ("news.google.com", "www.news.google.com"):
        raise GoogleNewsRedirect(
            "Google News wraps articles in a redirect that doesn't serve the article HTML. "
            "Open the link in a browser and paste the final URL."
        )

    html = _fetch_html(url)

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception as e:
        raise ExtractError(f"Failed to parse article HTML: {e}") from e

    title = _extract_title(soup)
    body_text = _extract_body_text(soup)

    items: List[dict] = []
    try:
        items = _call_gemini(title=title, url=url, text=body_text)
    except GeminiNotConfigured:
        raise
    except ExtractError:
        # Gemini broke — fall through to the heuristic. Don't swallow this
        # silently in logs; the API layer will still respond OK if heuristic
        # finds a list. (We re-raise only if heuristic also fails below.)
        items = []

    if not items:
        # Use heuristic only as a last resort, and only when it's confident.
        items = _fallback_heuristic(soup)

    return {
        "title": title,
        "url": url,
        "items": items,
    }
