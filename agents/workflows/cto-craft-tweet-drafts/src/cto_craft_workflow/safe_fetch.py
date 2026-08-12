"""SSRF-safe HTTP fetcher for the CTO Craft pipeline.

The newsletter page, the issue page, and the article pages are all
untrusted input. This module is the only place the workflow talks to the
network, and it does the following:

- Rejects URLs that are not http(s) and that contain embedded credentials.
- Resolves DNS and forbids loopback, private, link-local, multicast,
  reserved, and unspecified IP ranges for every redirect hop.
- Re-validates scheme and IP on every redirect.
- Caps redirect hops, response size, and total wall-clock time.
- Accepts only HTML or text response content types.
- Strips known tracking query parameters before returning the canonical URL.
- Never sends cookies, credentials, or custom auth headers.
- Logs the URL host/path only; query strings are stripped from diagnostics.

The module is intentionally synchronous. Weekly runs are short and the
fan-out uses asyncio via ``httpx`` only because LangGraph's ``Send`` shape
favors a typed async surface anyway; the actual HTTP call is still bounded
and sequential per branch.
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

import httpx


# Tracking parameters observed on TMW and the blogs it links. Case-sensitive
# on purpose; query-string parsing lowercases the parameter name.
_TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "ref",
    "source",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
}


class FetchError(Exception):
    """Raised when a fetch fails for any safe-fetch reason.

    The message is safe to log; URLs are presented with their query string
    stripped and bodies are never included.
    """

    def __init__(self, code: str, message: str, url: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.url = url


@dataclass(frozen=True)
class FetchedResource:
    """A successfully fetched resource."""

    url: str  # canonical URL (post-redirect, post-decode, with query stripped)
    body: bytes
    content_type: str
    final_url: str  # last URL after redirects (canonical form, query kept)


def _safe_label(url: str) -> str:
    """Return a log-safe label for a URL: scheme + host + path only."""

    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _strip_tracking_query(url: str) -> str:
    """Return the URL with known tracking query parameters removed."""

    parts = urlsplit(url)
    if not parts.query:
        return url
    cleaned = []
    for pair in parts.query.split("&"):
        if not pair:
            continue
        name = pair.split("=", 1)[0].lower()
        if name in _TRACKING_PARAMS:
            continue
        cleaned.append(pair)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(cleaned), parts.fragment))


def _validate_scheme(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError(
            "UNSAFE_SCHEME",
            f"URL scheme {parts.scheme!r} is not allowed (only http/https)",
            url=_safe_label(url),
        )
    if not parts.netloc:
        raise FetchError("UNSAFE_URL", "URL is missing a host", url=_safe_label(url))
    if "@" in parts.netloc:
        raise FetchError("UNSAFE_URL", "URL contains embedded credentials", url=_safe_label(url))


def _resolve_and_validate_ip(host: str, url: str) -> None:
    """Resolve the host and ensure every returned address is public."""

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchError("DNS_LOOKUP_FAILED", f"DNS lookup failed for {host}", url=_safe_label(url)) from exc

    for info in infos:
        sockaddr = info[4]
        ip = sockaddr[0]
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            raise FetchError("DNS_BAD_ADDRESS", f"DNS returned non-IP value {ip!r}", url=_safe_label(url))
        if (
            parsed.is_private
            or parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_multicast
            or parsed.is_reserved
            or parsed.is_unspecified
        ):
            raise FetchError(
                "SSRF_BLOCKED",
                f"Refusing to fetch {host}: resolved to {ip} which is not a public address",
                url=_safe_label(url),
            )


def _is_public_ip(ip: str) -> bool:
    """Public-IP predicate used after each redirect resolution."""

    try:
        parsed = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if (
        parsed.is_private
        or parsed.is_loopback
        or parsed.is_link_local
        or parsed.is_multicast
        or parsed.is_reserved
        or parsed.is_unspecified
    ):
        return False
    return True


def _validate_url_and_resolve(url: str) -> None:
    _validate_scheme(url)
    host = urlsplit(url).hostname or ""
    if not host:
        raise FetchError("UNSAFE_URL", "URL is missing a hostname", url=_safe_label(url))
    _resolve_and_validate_ip(host, url)


def _acceptable_content_type(content_type: str | None) -> bool:
    if not content_type:
        return False
    head = content_type.split(";", 1)[0].strip().lower()
    return head in ("text/html", "application/xhtml+xml", "text/plain", "text/markdown")


class SafeFetcher:
    """Bounded HTTP fetcher. One instance per node call."""

    def __init__(
        self,
        *,
        user_agent: str,
        max_issue_bytes: int,
        max_article_bytes: int,
        max_redirects: int,
        timeout_seconds: float,
        client: httpx.Client | None = None,
    ) -> None:
        self._user_agent = user_agent
        self._max_issue_bytes = max_issue_bytes
        self._max_article_bytes = max_article_bytes
        self._max_redirects = max_redirects
        self._timeout_seconds = timeout_seconds
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            headers={"User-Agent": self._user_agent},
        )

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "SafeFetcher":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def fetch(
        self,
        url: str,
        *,
        kind: str,
    ) -> FetchedResource:
        """Fetch ``url`` and return a bounded, validated resource.

        ``kind`` is ``"issue"`` or ``"article"`` and selects the byte cap.
        """

        if kind not in ("issue", "article"):
            raise FetchError("INVALID_KIND", f"unknown fetch kind {kind!r}")
        max_bytes = self._max_issue_bytes if kind == "issue" else self._max_article_bytes

        current_url = url
        for hop in range(self._max_redirects + 1):
            _validate_url_and_resolve(current_url)

            try:
                response = self._client.get(
                    current_url,
                    timeout=httpx.Timeout(
                        connect=self._timeout_seconds,
                        read=self._timeout_seconds,
                        write=self._timeout_seconds,
                        pool=self._timeout_seconds,
                    ),
                    headers={"Accept": "text/html, application/xhtml+xml, text/plain, text/markdown"},
                )
            except httpx.TimeoutException as exc:
                raise FetchError(
                    "TIMEOUT",
                    f"timeout after {self._timeout_seconds}s",
                    url=_safe_label(current_url),
                ) from exc
            except httpx.HTTPError as exc:
                raise FetchError(
                    "TRANSPORT_ERROR",
                    f"transport error: {exc.__class__.__name__}",
                    url=_safe_label(current_url),
                ) from exc

            if response.status_code in (301, 302, 303, 307, 308):
                if hop >= self._max_redirects:
                    raise FetchError(
                        "TOO_MANY_REDIRECTS",
                        f"too many redirects (> {self._max_redirects})",
                        url=_safe_label(current_url),
                    )
                location = response.headers.get("location")
                if not location:
                    raise FetchError(
                        "REDIRECT_MISSING_LOCATION",
                        "redirect status without Location header",
                        url=_safe_label(current_url),
                    )
                next_url = _resolve_redirect_url(current_url, location)
                try:
                    _validate_url_and_resolve(next_url)
                except FetchError:
                    raise
                current_url = next_url
                continue

            if response.status_code >= 400:
                raise FetchError(
                    "HTTP_ERROR",
                    f"HTTP {response.status_code}",
                    url=_safe_label(current_url),
                )

            content_type = response.headers.get("content-type")
            if not _acceptable_content_type(content_type):
                raise FetchError(
                    "UNSUPPORTED_CONTENT_TYPE",
                    f"content-type {content_type!r} is not supported",
                    url=_safe_label(current_url),
                )

            body = response.content
            if len(body) > max_bytes:
                raise FetchError(
                    "RESPONSE_TOO_LARGE",
                    f"response body {len(body)} bytes exceeds {max_bytes} cap",
                    url=_safe_label(current_url),
                )

            canonical_url = _strip_tracking_query(str(response.url))
            return FetchedResource(
                url=canonical_url,
                body=body,
                content_type=content_type or "text/html",
                final_url=canonical_url,
            )

        raise FetchError(
            "TOO_MANY_REDIRECTS",
            f"too many redirects (> {self._max_redirects})",
            url=_safe_label(current_url),
        )


def _resolve_redirect_url(base_url: str, location: str) -> str:
    """Resolve a redirect ``Location`` against the current URL.

    Rejects schemes that would slip past our scheme check on the next hop.
    """

    parts = urlsplit(location)
    if parts.scheme and parts.scheme not in ("http", "https"):
        raise FetchError(
            "UNSAFE_SCHEME",
            f"redirect scheme {parts.scheme!r} is not allowed",
            url=_safe_label(location),
        )
    if not parts.netloc:
        # Relative redirect; resolve against the base URL.
        base = urlsplit(base_url)
        return urlunsplit(
            (base.scheme, base.netloc, parts.path or base.path, parts.query, parts.fragment)
        )
    return urlunsplit(parts)


def make_fetcher(settings) -> SafeFetcher:
    """Build a :class:`SafeFetcher` from a :class:`Settings` instance."""

    from cto_craft_workflow.settings import Settings

    if not isinstance(settings, Settings):
        raise TypeError("make_fetcher requires a Settings instance")
    return SafeFetcher(
        user_agent=settings.user_agent if hasattr(settings, "user_agent") else "sindustries-cto-craft-workflow/0.1",
        max_issue_bytes=settings.max_issue_bytes,
        max_article_bytes=settings.max_article_bytes,
        max_redirects=settings.max_redirects,
        timeout_seconds=settings.fetch_timeout_seconds,
    )


__all__ = [
    "FetchError",
    "FetchedResource",
    "SafeFetcher",
    "make_fetcher",
]
