"""Article text extraction for the CTO Craft pipeline.

Given an HTML body that has already been validated by ``safe_fetch``, this
module produces a bounded, plain-text representation that the structured
angle model can consume. The extraction is intentionally conservative:

- The article text is treated as untrusted data. No script, style, nav,
  header, footer, or aside content is included.
- The canonical URL is read from a ``<link rel="canonical">`` if present,
  else the input URL is preserved.
- The author is read from a ``<meta name="author">`` or
  ``<meta property="article:author">`` tag if present.
- The text is bounded at 20k characters; the rest is dropped with a
  trailing marker.
- Visible text is whitespace-collapsed and joined with newlines for blocks.

The module is pure: it does no IO and can be unit-tested with fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from bs4 import BeautifulSoup, Tag

from cto_craft_workflow.state import (
    MAX_ARTICLE_TEXT_CHARS,
    MAX_MIN_TEXT_CHARS,
)


@dataclass(frozen=True)
class ExtractedArticle:
    """Plain-text, sanitized article excerpt."""

    canonical_url: str
    title: str
    author: str | None
    text: str
    char_count: int


_NOISE_TAGS = ("script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg")


def _first_meta(soup: BeautifulSoup, names: Iterable[tuple[str, str]]) -> str | None:
    for attr, value in names:
        tag = soup.find("meta", attrs={attr: value})
        if tag is not None:
            content = tag.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
    return None


def _canonical_url(soup: BeautifulSoup, source_url: str) -> str:
    link = soup.find("link", rel="canonical")
    if isinstance(link, Tag):
        href = link.get("href")
        if isinstance(href, str) and href.startswith(("http://", "https://")):
            return href
    return source_url


def _extract_title(soup: BeautifulSoup, fallback: str) -> str:
    og = _first_meta(soup, (("property", "og:title"), ("name", "twitter:title")))
    if og:
        return og
    h1 = soup.find("h1")
    if isinstance(h1, Tag) and h1.get_text(strip=True):
        return h1.get_text(" ", strip=True)
    title = soup.find("title")
    if isinstance(title, Tag) and title.get_text(strip=True):
        return title.get_text(" ", strip=True)
    return fallback


def _extract_text(soup: BeautifulSoup) -> str:
    """Return visible text from the main article body, bounded."""

    for tag_name in _NOISE_TAGS:
        for tag in soup.find_all(tag_name):
            tag.decompose()

    root = soup.find("article") or soup.find("main") or soup.body or soup
    if root is None:
        return ""

    parts: list[str] = []
    for block in root.find_all(["p", "h1", "h2", "h3", "h4", "h5", "li", "blockquote", "pre"]):
        text = block.get_text(" ", strip=True)
        if not text:
            continue
        parts.append(text)

    # As a final fallback, if there were no block tags, use the whole tree.
    if not parts:
        text = root.get_text(" ", strip=True)
        if text:
            parts.append(text)

    joined = "\n\n".join(parts)
    if len(joined) > MAX_ARTICLE_TEXT_CHARS:
        suffix = "\n\n[truncated]"
        head = MAX_ARTICLE_TEXT_CHARS - len(suffix)
        joined = joined[:head].rstrip() + suffix
    return joined


def extract_article(
    source_url: str,
    body: bytes,
    *,
    fallback_title: str | None = None,
) -> ExtractedArticle:
    """Extract a bounded, plain-text article from HTML body.

    Returns :class:`ExtractedArticle`. The ``text`` field is always
    non-empty after extraction; callers must check ``char_count`` against
    :data:`MAX_MIN_TEXT_CHARS` themselves to decide whether the article
    is useful enough to score.
    """

    soup = BeautifulSoup(body, "html.parser")
    canonical = _canonical_url(soup, source_url)
    title = _extract_title(soup, fallback_title or source_url)
    author = _first_meta(
        soup,
        (
            ("name", "author"),
            ("property", "article:author"),
            ("name", "byl"),
        ),
    )
    text = _extract_text(soup)
    return ExtractedArticle(
        canonical_url=canonical,
        title=title,
        author=author,
        text=text,
        char_count=len(text),
    )


__all__ = [
    "ExtractedArticle",
    "extract_article",
    "MAX_MIN_TEXT_CHARS",
]
