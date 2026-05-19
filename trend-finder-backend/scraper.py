"""
Trend Finder — multi-source scraper.

Pivot history (the scrape source kept hitting bot walls; the eventual landing
spot is structured feeds, not HTML SERPs):

  - v1: DuckDuckGo HTML SERP. Stopped returning parseable rows.
  - v2 (2026-05-18): Bing. CAPTCHA wall to plain requests.
  - v3 (2026-05-19): Google News RSS (single source).
  - v4 (current): Multi-source aggregator — Google News RSS + Reddit JSON +
    Hacker News (Algolia). Per the "Using Trend Finder for Data Collection"
    lesson, the upgrade brings three things at once: more coverage, real
    JSON/RSS endpoints (not HTML scraping), and a richer result schema
    (title / url / source / thumbnail / published).

Each result dict:
  {
    "title":     str,
    "url":       str,
    "source":    "Google News" | "Reddit · r/…" | "Hacker News",
    "thumbnail": Optional[str],
    "published": Optional[str],  # ISO 8601
  }

If every source fails, we raise a typed exception so the Flask layer can map
it to a clean JSON error — no silent fallbacks, no fake data. Partial success
(at least one source returned) is preferred to a blanket failure.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional, List, Iterable
from urllib.parse import urlparse

import feedparser
import requests


# ---- Endpoint constants ----------------------------------------------------

GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search"
REDDIT_SEARCH_ENDPOINT   = "https://www.reddit.com/search.json"
HN_SEARCH_ENDPOINT       = "https://hn.algolia.com/api/v1/search"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
HTTP_TIMEOUT = 12  # seconds per source


# ---- Typed errors ----------------------------------------------------------

class ScrapeError(Exception):
    """Generic scrape failure (parse failed, no usable rows, etc.)."""


class ScrapeTimeout(ScrapeError):
    """Network timeout when fetching a source."""


class ScrapeBlocked(ScrapeError):
    """Source returned a captcha / rate-limit / 4xx page."""


# ---- Result type -----------------------------------------------------------

@dataclass
class TrendItem:
    title: str
    url: str
    source: str
    thumbnail: Optional[str]
    published: Optional[str]

    def to_dict(self) -> dict:
        return asdict(self)


# ---- Helpers ---------------------------------------------------------------

def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _parse_feed_time(struct_time) -> Optional[str]:
    """feedparser exposes parsed time as a struct_time. Convert to ISO."""
    if not struct_time:
        return None
    try:
        return _iso(datetime(*struct_time[:6], tzinfo=timezone.utc))
    except Exception:
        return None


# ---- Source: Google News RSS -----------------------------------------------

def _fetch_google_news(query: str) -> List[TrendItem]:
    url = (
        f"{GOOGLE_NEWS_RSS_ENDPOINT}"
        f"?q={requests.utils.quote(query)}&hl=en-US&gl=US&ceid=US:en"
    )
    # feedparser does its own fetching; pass a User-Agent through the
    # `agent` arg so Google News doesn't get a generic feedparser UA.
    feed = feedparser.parse(url, agent=USER_AGENT)

    # feedparser exposes HTTP errors via .status; .bozo flags parse issues.
    status = getattr(feed, "status", None)
    if status in (403, 429):
        raise ScrapeBlocked(f"Google News returned {status}.")
    if status and status >= 400:
        raise ScrapeError(f"Google News returned HTTP {status}.")

    items: List[TrendItem] = []
    for entry in feed.entries:
        title = (getattr(entry, "title", "") or "").strip()
        link = (getattr(entry, "link", "") or "").strip()
        if not title or not link.startswith("http"):
            continue

        # Try RSS media:thumbnail / media:content; otherwise None.
        thumbnail: Optional[str] = None
        media = getattr(entry, "media_thumbnail", None) or getattr(entry, "media_content", None)
        if isinstance(media, list) and media:
            url_val = media[0].get("url") if isinstance(media[0], dict) else None
            if isinstance(url_val, str) and url_val.startswith("http"):
                thumbnail = url_val

        published = _parse_feed_time(getattr(entry, "published_parsed", None))

        items.append(TrendItem(
            title=title,
            url=link,
            source="Google News",
            thumbnail=thumbnail,
            published=published,
        ))
    return items


# ---- Source: Reddit JSON ---------------------------------------------------

def _fetch_reddit(query: str) -> List[TrendItem]:
    sess = _session()
    try:
        resp = sess.get(
            REDDIT_SEARCH_ENDPOINT,
            params={"q": query, "sort": "hot", "limit": 10},
            timeout=HTTP_TIMEOUT,
        )
    except requests.Timeout as e:
        raise ScrapeTimeout(f"Reddit timeout: {e}") from e
    except requests.RequestException as e:
        raise ScrapeError(f"Reddit network error: {e}") from e

    if resp.status_code in (403, 429):
        raise ScrapeBlocked(f"Reddit returned {resp.status_code}.")
    if resp.status_code >= 400:
        raise ScrapeError(f"Reddit returned HTTP {resp.status_code}.")

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScrapeError(f"Reddit returned non-JSON: {e}") from e

    children = (payload.get("data") or {}).get("children") or []
    items: List[TrendItem] = []
    for child in children:
        data = (child or {}).get("data") or {}
        title = (data.get("title") or "").strip()
        permalink = data.get("permalink") or ""
        if not title or not permalink:
            continue
        url = f"https://www.reddit.com{permalink}"

        # Reddit's `thumbnail` field is often a sentinel like "self" / "default"
        # / "nsfw" rather than a URL. Accept only http(s) values.
        thumb_raw = data.get("thumbnail") or ""
        thumbnail = thumb_raw if isinstance(thumb_raw, str) and thumb_raw.startswith("http") else None

        # subreddit_name_prefixed e.g. "r/technology"
        sub = data.get("subreddit_name_prefixed") or "Reddit"
        source = f"Reddit · {sub}" if sub.startswith("r/") else "Reddit"

        published: Optional[str] = None
        created_utc = data.get("created_utc")
        if isinstance(created_utc, (int, float)) and created_utc > 0:
            try:
                published = _iso(datetime.fromtimestamp(float(created_utc), tz=timezone.utc))
            except Exception:
                published = None

        items.append(TrendItem(
            title=title,
            url=url,
            source=source,
            thumbnail=thumbnail,
            published=published,
        ))
    return items


# ---- Source: Hacker News (Algolia) -----------------------------------------

def _fetch_hn(query: str) -> List[TrendItem]:
    sess = _session()
    try:
        resp = sess.get(
            HN_SEARCH_ENDPOINT,
            params={"query": query, "tags": "story", "hitsPerPage": 10},
            timeout=HTTP_TIMEOUT,
        )
    except requests.Timeout as e:
        raise ScrapeTimeout(f"Hacker News timeout: {e}") from e
    except requests.RequestException as e:
        raise ScrapeError(f"Hacker News network error: {e}") from e

    if resp.status_code in (403, 429):
        raise ScrapeBlocked(f"Hacker News returned {resp.status_code}.")
    if resp.status_code >= 400:
        raise ScrapeError(f"Hacker News returned HTTP {resp.status_code}.")

    try:
        payload = resp.json()
    except ValueError as e:
        raise ScrapeError(f"Hacker News returned non-JSON: {e}") from e

    hits = payload.get("hits") or []
    items: List[TrendItem] = []
    for hit in hits:
        title = (hit.get("title") or "").strip()
        url = (hit.get("url") or "").strip()
        if not title or not url.startswith("http"):
            # Skip Ask HN / Show HN entries without an external link.
            continue

        items.append(TrendItem(
            title=title,
            url=url,
            source="Hacker News",
            thumbnail=None,  # Algolia HN doesn't carry thumbnails.
            published=(hit.get("created_at") or None),
        ))
    return items


# ---- Merging ---------------------------------------------------------------

def _round_robin(*lists: Iterable[TrendItem]) -> List[TrendItem]:
    """Interleave: 1 from list A, 1 from list B, 1 from list C, repeat."""
    iters = [iter(lst) for lst in lists]
    merged: List[TrendItem] = []
    while iters:
        next_iters = []
        for it in iters:
            try:
                merged.append(next(it))
            except StopIteration:
                continue
            next_iters.append(it)
        iters = next_iters
    return merged


# ---- Public API ------------------------------------------------------------

def search_trending(query: str, limit: int = 5) -> List[dict]:
    """Aggregate trending results across Google News, Reddit, and Hacker News.

    Returns up to `limit` items, interleaved round-robin and de-duplicated by URL.
    Partial success is allowed: if at least one source returns, we return what
    we have. If all three sources fail, we raise the most representative error
    (preferring ScrapeBlocked > ScrapeTimeout > ScrapeError).
    """
    sources = [
        ("Google News", _fetch_google_news),
        ("Reddit",      _fetch_reddit),
        ("Hacker News", _fetch_hn),
    ]

    per_source: List[List[TrendItem]] = []
    errors: List[Exception] = []
    for _name, fn in sources:
        try:
            per_source.append(fn(query))
        except (ScrapeBlocked, ScrapeTimeout, ScrapeError) as e:
            errors.append(e)

    if not per_source:
        # All three sources errored — surface the most informative error type.
        for E in (ScrapeBlocked, ScrapeTimeout, ScrapeError):
            for err in errors:
                if isinstance(err, E):
                    raise E(f"All sources failed: {err}")
        raise ScrapeError("All sources failed for unknown reasons.")

    merged = _round_robin(*per_source)

    # De-duplicate by URL while preserving order.
    seen_urls: set = set()
    deduped: List[TrendItem] = []
    for item in merged:
        if item.url in seen_urls:
            continue
        seen_urls.add(item.url)
        deduped.append(item)
        if len(deduped) >= limit:
            break

    if not deduped:
        raise ScrapeError("All sources returned, but no usable items after dedupe.")

    return [it.to_dict() for it in deduped]
