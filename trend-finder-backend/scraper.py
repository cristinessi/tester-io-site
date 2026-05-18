"""
Trend Finder scraper.

Pivot history (the scrape source kept hitting bot walls; the eventual landing
spot is structured XML, not HTML):

  - v1 (initial): DuckDuckGo HTML SERP (`html.duckduckgo.com/html/`). Stopped
    returning parseable result rows — `div.result.results_links` came back
    empty, consistent with a markup change or a soft block.
  - v2 (2026-05-18): Switched to Bing (`www.bing.com/search`). Same outcome
    via a different door: confirmed with `debug_fetch.py` that Bing now serves
    a "One last step — please solve the challenge below" CAPTCHA / bot-check
    page to plain `requests` traffic instead of the organic `li.b_algo` rows.
  - v3 (2026-05-19, this file): Switched to **Google News RSS**
    (`news.google.com/rss/search`). RSS is purpose-built for machines —
    structured XML, no JavaScript, no bot walls, no rate-limit games. Stays
    inside the lesson's stack: Python + Flask + requests + BeautifulSoup
    (BS parses XML natively with the `xml` / `lxml-xml` parser).

For each of the top 5 <item> elements we extract:

  - name   = result title (<title> text)
  - url    = result link (<link> text — Google wraps these in a news.google.com
             redirect; we pass it through as-is, it resolves when clicked)
  - source = publication name (<source> element text, e.g. "Wired")
  - image  = OpenGraph og:image fetched from the result page (best-effort;
             Google News redirect URLs *do* expose an og:image, but it's
             always the Google News logo, so we skip them deliberately and
             leave image=None — the frontend renders a "No image" placeholder)

If scraping fails we raise a typed exception so the Flask layer can map it to a
clean JSON error — no silent fallbacks, no fake data.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, List
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
SERP_TIMEOUT = 15  # seconds
OG_TIMEOUT = 6     # seconds per result page (kept short — image is best-effort)


# ---- Typed errors ----------------------------------------------------------

class ScrapeError(Exception):
    """Generic scrape failure (parse failed, no usable rows, etc.)."""


class ScrapeTimeout(ScrapeError):
    """Network timeout when fetching the feed."""


class ScrapeBlocked(ScrapeError):
    """Source returned a captcha / rate-limit / 4xx page."""


# ---- Helpers ---------------------------------------------------------------

@dataclass
class TrendItem:
    name: str
    url: str
    source: str
    image: Optional[str]

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "url": self.url,
            "source": self.source,
            "image": self.image,
        }


def _domain_of(url: str) -> str:
    try:
        host = urlparse(url).hostname or ""
        host = host.lower()
        if host.startswith("www."):
            host = host[4:]
        return host
    except Exception:
        return ""


def _fetch_og_image(url: str, session: requests.Session) -> Optional[str]:
    """Best-effort fetch of an OpenGraph image. Returns None on any failure."""
    try:
        r = session.get(url, timeout=OG_TIMEOUT, allow_redirects=True)
        if r.status_code >= 400:
            return None
        ctype = r.headers.get("Content-Type", "").lower()
        if "html" not in ctype:
            return None
        soup = BeautifulSoup(r.text, "lxml")
        # Try og:image, then twitter:image as a fallback.
        for prop in ("og:image", "og:image:url", "twitter:image", "twitter:image:src"):
            tag = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
            if tag and tag.get("content"):
                content = tag["content"].strip()
                if content.startswith("//"):
                    return "https:" + content
                if content.startswith("/"):
                    # Relative path — best to skip rather than guess origin.
                    return None
                if content.startswith("http"):
                    return content
        return None
    except requests.RequestException:
        return None
    except Exception:
        return None


# ---- Public API ------------------------------------------------------------

def search_trends(topic: str, limit: int = 5) -> List[dict]:
    """Scrape Google News RSS for `<topic>` and return up to `limit` items.

    Raises ScrapeTimeout / ScrapeBlocked / ScrapeError on failure.
    """
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "en-US,en;q=0.9",
    })

    try:
        resp = session.get(
            GOOGLE_NEWS_RSS_ENDPOINT,
            params={"q": topic, "hl": "en-US", "gl": "US", "ceid": "US:en"},
            timeout=SERP_TIMEOUT,
        )
    except requests.Timeout as e:
        raise ScrapeTimeout(str(e)) from e
    except requests.RequestException as e:
        raise ScrapeError(f"Network error contacting Google News: {e}") from e

    if resp.status_code in (403, 429):
        raise ScrapeBlocked(f"Google News returned {resp.status_code}.")
    if resp.status_code >= 400:
        raise ScrapeError(f"Google News returned HTTP {resp.status_code}.")

    body = resp.text
    if not body:
        raise ScrapeError("Google News returned an empty response body.")

    try:
        soup = BeautifulSoup(body, "xml")
    except Exception as e:
        raise ScrapeError(f"Failed to parse Google News RSS as XML: {e}") from e

    item_nodes = soup.find_all("item")
    if not item_nodes:
        raise ScrapeError("Google News RSS contained no <item> elements.")

    items: List[TrendItem] = []
    for node in item_nodes:
        if len(items) >= limit:
            break

        title_el = node.find("title")
        link_el = node.find("link")
        source_el = node.find("source")

        name = (title_el.get_text(strip=True) if title_el else "").strip()
        url = (link_el.get_text(strip=True) if link_el else "").strip()
        if not name or not url:
            continue
        if not url.startswith("http"):
            continue

        if source_el and source_el.get_text(strip=True):
            source = source_el.get_text(strip=True)
        else:
            source = _domain_of(url) or "news.google.com"

        items.append(TrendItem(name=name, url=url, source=source, image=None))

    if not items:
        raise ScrapeError("Google News RSS had items but none had a usable title/link.")

    # Best-effort OpenGraph image fetch per item. Skip Google News redirect
    # URLs explicitly: they *do* expose og:image, but it's always the Google
    # News logo, which makes every card look identical — better to leave
    # image=None and let the frontend render the "No image" placeholder.
    for item in items:
        host = (urlparse(item.url).hostname or "").lower()
        if host == "news.google.com" or host == "www.news.google.com":
            continue
        item.image = _fetch_og_image(item.url, session)

    return [it.to_dict() for it in items]
