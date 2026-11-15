"""SSRF-safe HTTP fetcher for the CTO Craft pipeline.

The newsletter page, the issue page, and the article pages are all
untrusted input. This module is the only place the workflow talks to the
network, and it does the following:

- Rejects URLs that are not http(s) and that contain embedded credentials.
- Resolves DNS and forbids loopback, private, link-local, multicast,
  reserved, and unspecified IP ranges for every redirect hop.
- Pins the resolved public IP into the actual TCP/TLS connection so the
  server cannot return a different IP for the second DNS lookup
  (DNS rebinding). The original hostname is preserved in the HTTP ``Host``
  header and, for HTTPS, in the TLS SNI extension.
- Re-validates scheme and IP on every redirect, with a fresh resolve and
  fresh pin per hop (no parent-hop IP reuse).
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
import os
import random
import shutil
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Callable, Iterable, Protocol
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

_ACCEPT_HEADER = "text/html, application/xhtml+xml, text/plain, text/markdown"


@dataclass(frozen=True)
class FetchAttempt:
    """One outbound network request made by :class:`SafeFetcher`."""

    request: int
    transport: str
    code: str
    status: int | None = None
    delay_ms: int = 0

    def as_dict(self) -> dict:
        """Return the JSON-serializable diagnostic representation."""

        return {
            "request": self.request,
            "transport": self.transport,
            "code": self.code,
            "status": self.status,
            "delay_ms": self.delay_ms,
        }


class FetchError(Exception):
    """Raised when a fetch fails for any safe-fetch reason.

    The message is safe to log; URLs are presented with their query string
    stripped and bodies are never included.
    """

    def __init__(
        self,
        code: str,
        message: str,
        url: str | None = None,
        *,
        status: int | None = None,
        attempts: Iterable[FetchAttempt] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.url = url
        self.status = status
        self.attempts = tuple(attempts or ())


@dataclass(frozen=True)
class FetchedResource:
    """A successfully fetched resource."""

    url: str  # canonical URL (post-redirect, post-decode, with query stripped)
    body: bytes
    content_type: str
    final_url: str  # last URL after redirects (canonical form, query kept)
    attempts: tuple[FetchAttempt, ...] = ()


@dataclass(frozen=True)
class TransportResponse:
    """Transport-neutral HTTP response."""

    status_code: int
    headers: dict[str, str]
    body: bytes


class Transport(Protocol):
    """Minimal transport contract used by :class:`SafeFetcher`."""

    name: str

    def fetch(
        self,
        *,
        url: str,
        hostname: str,
        pinned_ip: str,
        max_bytes: int,
    ) -> TransportResponse:
        """Fetch one pinned URL or raise :class:`FetchError`."""


class HttpXTransport:
    """Pinned-IP transport implemented with ``httpx``."""

    name = "httpx"

    def __init__(
        self,
        *,
        client: httpx.Client,
        user_agent: str,
        timeout_seconds: float,
    ) -> None:
        self._client = client
        self._user_agent = user_agent
        self._timeout_seconds = timeout_seconds

    def fetch(
        self,
        *,
        url: str,
        hostname: str,
        pinned_ip: str,
        max_bytes: int,
    ) -> TransportResponse:
        pinned_url = httpx.URL(url).copy_with(host=pinned_ip)
        headers = _build_pinned_headers(hostname)
        headers.setdefault("User-Agent", self._user_agent)
        timeout = httpx.Timeout(
            connect=self._timeout_seconds,
            read=self._timeout_seconds,
            write=self._timeout_seconds,
            pool=self._timeout_seconds,
        )
        request = self._client.build_request(
            "GET", pinned_url, headers=headers, timeout=timeout
        )
        if urlsplit(url).scheme == "https":
            request.extensions["sni_hostname"] = hostname
        try:
            response = self._client.send(request)
        except httpx.TimeoutException as exc:
            raise FetchError(
                "TIMEOUT",
                f"timeout after {self._timeout_seconds}s",
                url=_safe_label(url),
            ) from exc
        except httpx.HTTPError as exc:
            raise FetchError(
                "TRANSPORT_ERROR",
                f"transport error: {exc.__class__.__name__}",
                url=_safe_label(url),
            ) from exc
        return TransportResponse(
            status_code=response.status_code,
            headers={key.lower(): value for key, value in response.headers.items()},
            body=response.content,
        )


class CurlTransport:
    """Pinned-IP transport implemented with the local ``curl`` binary.

    The command is always passed as an argv list with ``shell=False``. The
    validated hostname/IP pair is supplied through ``--resolve`` so curl never
    performs a second DNS lookup, while the original hostname remains in the
    Host header and TLS SNI.
    """

    name = "curl"

    def __init__(
        self,
        *,
        user_agent: str,
        timeout_seconds: float,
        binary: str = "curl",
    ) -> None:
        self._user_agent = user_agent
        self._timeout_seconds = timeout_seconds
        self._binary = binary

    @property
    def available(self) -> bool:
        return shutil.which(self._binary) is not None

    def fetch(
        self,
        *,
        url: str,
        hostname: str,
        pinned_ip: str,
        max_bytes: int,
    ) -> TransportResponse:
        if not self.available:
            raise FetchError(
                "TRANSPORT_UNAVAILABLE",
                "curl transport is unavailable",
                url=_safe_label(url),
            )
        if not _is_global_ip(pinned_ip):
            raise FetchError(
                "SSRF_BLOCKED",
                "refusing to pass a non-public address to curl",
                url=_safe_label(url),
            )

        parts = urlsplit(url)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        timeout = max(1, int(self._timeout_seconds))
        with tempfile.TemporaryDirectory(prefix="cto-craft-curl-") as temp_dir:
            header_path = os.path.join(temp_dir, "headers")
            body_path = os.path.join(temp_dir, "body")
            argv = [
                self._binary,
                "--silent",
                "--show-error",
                "--proto",
                "=http,https",
                "--resolve",
                f"{hostname}:{port}:{pinned_ip}",
                "--connect-timeout",
                str(timeout),
                "--max-time",
                str(timeout),
                "--max-filesize",
                str(max_bytes),
                "--max-redirs",
                "0",
                "--dump-header",
                header_path,
                "--output",
                body_path,
                "--write-out",
                "%{http_code}",
                "--header",
                f"Accept: {_ACCEPT_HEADER}",
                "--header",
                f"Host: {hostname}",
                "--header",
                f"User-Agent: {self._user_agent}",
                url,
            ]
            try:
                completed = subprocess.run(
                    argv,
                    capture_output=True,
                    check=False,
                    timeout=self._timeout_seconds + 1,
                )
            except FileNotFoundError as exc:
                raise FetchError(
                    "TRANSPORT_UNAVAILABLE",
                    "curl transport is unavailable",
                    url=_safe_label(url),
                ) from exc
            except subprocess.TimeoutExpired as exc:
                raise FetchError(
                    "TIMEOUT",
                    f"timeout after {self._timeout_seconds}s",
                    url=_safe_label(url),
                ) from exc

            try:
                with open(header_path, "r", encoding="utf-8", errors="replace") as handle:
                    raw_headers = handle.read()
            except FileNotFoundError:
                raw_headers = ""
            try:
                with open(body_path, "rb") as handle:
                    body = handle.read(max_bytes + 1)
            except FileNotFoundError:
                body = b""

            status_text = completed.stdout.decode("ascii", errors="ignore").strip()
            try:
                status = int(status_text)
            except ValueError:
                status = 0
            headers = _parse_curl_headers(raw_headers)

            if completed.returncode == 47 and 300 <= status < 400:
                # Defence in depth: curl normally returns the 3xx directly
                # without -L. If a platform reports redirect refusal code 47,
                # the captured 3xx is still a response, not a transport error.
                return TransportResponse(status, headers, body)
            if completed.returncode != 0:
                if status:
                    return TransportResponse(status, headers, body)
                raise FetchError(
                    "TRANSPORT_ERROR",
                    f"curl transport error: exit {completed.returncode}",
                    url=_safe_label(url),
                )
            if not status:
                raise FetchError(
                    "TRANSPORT_ERROR",
                    "curl transport returned no HTTP status",
                    url=_safe_label(url),
                )
            return TransportResponse(status, headers, body)


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


def _resolve_and_validate_ip(host: str, url: str) -> str:
    """Resolve ``host`` once and return the first public IP.

    Any returned address that is loopback, private, link-local, multicast,
    reserved, or unspecified aborts the fetch with ``SSRF_BLOCKED``. The
    returned IP is then pinned into the actual TCP/TLS connection by the
    caller, closing the validate-then-refetch DNS-rebinding gap.
    """

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise FetchError("DNS_LOOKUP_FAILED", f"DNS lookup failed for {host}", url=_safe_label(url)) from exc

    pinned_ip: str | None = None
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
        if pinned_ip is None:
            pinned_ip = ip

    if pinned_ip is None:
        raise FetchError(
            "DNS_NO_ADDRESS",
            f"DNS returned no addresses for {host}",
            url=_safe_label(url),
        )
    return pinned_ip


def _validate_url_and_resolve(url: str) -> tuple[str, str]:
    """Validate scheme, resolve host, and return ``(hostname, pinned_ip)``.

    Returns both so the caller can build a request with the URL pointing at
    the pinned IP while the ``Host`` header and TLS SNI advertise the
    original hostname.
    """

    _validate_scheme(url)
    parts = urlsplit(url)
    hostname = parts.hostname or ""
    if not hostname:
        raise FetchError("UNSAFE_URL", "URL is missing a hostname", url=_safe_label(url))
    pinned_ip = _resolve_and_validate_ip(hostname, url)
    return hostname, pinned_ip


def _acceptable_content_type(content_type: str | None) -> bool:
    if not content_type:
        return False
    head = content_type.split(";", 1)[0].strip().lower()
    return head in ("text/html", "application/xhtml+xml", "text/plain", "text/markdown")


def _build_pinned_headers(hostname: str) -> dict:
    """Build headers for a pinned request: original ``Host`` + Accept."""
    return {
        "Accept": _ACCEPT_HEADER,
        "Host": hostname,
    }


def _is_global_ip(value: str) -> bool:
    """Return whether ``value`` is a literal globally routable IP address."""

    try:
        parsed = ipaddress.ip_address(value)
    except ValueError:
        return False
    return parsed.is_global and not any(
        (
            parsed.is_private,
            parsed.is_loopback,
            parsed.is_link_local,
            parsed.is_multicast,
            parsed.is_reserved,
            parsed.is_unspecified,
        )
    )


def _parse_curl_headers(raw: str) -> dict[str, str]:
    """Parse the final HTTP header block written by curl."""

    headers: dict[str, str] = {}
    for line in raw.splitlines():
        if line.upper().startswith("HTTP/"):
            headers = {}
            continue
        if ":" not in line:
            continue
        name, value = line.split(":", 1)
        headers[name.strip().lower()] = value.strip()
    return headers


def _retry_after_seconds(value: str | None) -> float | None:
    """Parse a Retry-After header as seconds or an HTTP date."""

    if not value:
        return None
    raw = value.strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        pass
    try:
        parsed = parsedate_to_datetime(raw)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed is None:
        return None
    import datetime as _datetime

    now = _datetime.datetime.now(_datetime.timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_datetime.timezone.utc)
    return max(0.0, (parsed - now).total_seconds())


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
        curl_transport: Transport | None = None,
        max_requests: int = 3,
        backoff_base_seconds: float = 1.0,
        backoff_max_seconds: float = 30.0,
        sleep_fn: Callable[[float], None] = time.sleep,
        random_fn: Callable[[], float] = random.random,
    ) -> None:
        if max_requests < 1:
            raise ValueError("max_requests must be positive")
        if backoff_base_seconds <= 0 or backoff_max_seconds <= 0:
            raise ValueError("backoff seconds must be positive")
        self._user_agent = user_agent
        self._max_issue_bytes = max_issue_bytes
        self._max_article_bytes = max_article_bytes
        self._max_redirects = max_redirects
        self._timeout_seconds = timeout_seconds
        self._max_requests = max_requests
        self._backoff_base_seconds = backoff_base_seconds
        self._backoff_max_seconds = backoff_max_seconds
        self._sleep_fn = sleep_fn
        self._random_fn = random_fn
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            headers={"User-Agent": self._user_agent},
        )
        self._httpx_transport = HttpXTransport(
            client=self._client,
            user_agent=self._user_agent,
            timeout_seconds=timeout_seconds,
        )
        self._curl_transport = curl_transport or CurlTransport(
            user_agent=self._user_agent,
            timeout_seconds=timeout_seconds,
        )

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "SafeFetcher":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _transport_for_request(self, request_number: int) -> Transport:
        """Select httpx first, curl second, then httpx for request three."""

        if request_number == 2:
            return self._curl_transport
        return self._httpx_transport

    def _backoff_delay(self, retry_number: int, retry_after: float | None = None) -> int:
        if retry_after is not None:
            seconds = min(self._backoff_max_seconds, retry_after)
        else:
            exponential = self._backoff_base_seconds * (4 ** (retry_number - 1))
            bounded = min(self._backoff_max_seconds, exponential)
            # Bounded additive jitter keeps delays monotonic across the two
            # retries in this budget while avoiding synchronized retries.
            seconds = bounded + (bounded * 0.25 * self._random_fn())
        return max(0, int(round(seconds * 1000)))

    def _request_with_retry(
        self,
        *,
        url: str,
        hostname: str,
        pinned_ip: str,
        max_bytes: int,
    ) -> tuple[TransportResponse, list[FetchAttempt]]:
        attempts: list[FetchAttempt] = []
        request_number = 0
        last_error: FetchError | None = None
        while request_number < self._max_requests:
            request_number += 1
            transport = self._transport_for_request(request_number)
            try:
                response = transport.fetch(
                    url=url,
                    hostname=hostname,
                    pinned_ip=pinned_ip,
                    max_bytes=max_bytes,
                )
            except FetchError as exc:
                last_error = exc
                if exc.code == "TRANSPORT_UNAVAILABLE":
                    # The missing binary is not a network request. Use the
                    # current request number for httpx instead.
                    transport = self._httpx_transport
                    try:
                        response = transport.fetch(
                            url=url,
                            hostname=hostname,
                            pinned_ip=pinned_ip,
                            max_bytes=max_bytes,
                        )
                    except FetchError as fallback_exc:
                        last_error = fallback_exc
                        status = fallback_exc.status
                        code = fallback_exc.code
                    else:
                        status = response.status_code
                        code = "HTTP_ERROR" if status >= 400 else "OK"
                        if status < 400:
                            attempts.append(
                                FetchAttempt(request_number, transport.name, code, status, 0)
                            )
                            return response, attempts
                        if status != 429 and status < 500:
                            attempts.append(
                                FetchAttempt(request_number, transport.name, code, status, 0)
                            )
                            raise FetchError(
                                "HTTP_ERROR",
                                f"HTTP {status}",
                                url=_safe_label(url),
                                status=status,
                                attempts=attempts,
                            )
                        response_headers = response.headers
                        body = response.body
                        if len(body) > max_bytes:
                            attempts.append(
                                FetchAttempt(request_number, transport.name, code, status, 0)
                            )
                            raise FetchError(
                                "RESPONSE_TOO_LARGE",
                                f"response body {len(body)} bytes exceeds {max_bytes} cap",
                                url=_safe_label(url),
                                status=status,
                                attempts=attempts,
                            )
                        retry_after = _retry_after_seconds(response_headers.get("retry-after"))
                        delay_ms = (
                            self._backoff_delay(request_number, retry_after)
                            if request_number < self._max_requests
                            else 0
                        )
                        attempts.append(
                            FetchAttempt(request_number, transport.name, code, status, delay_ms)
                        )
                        if request_number >= self._max_requests:
                            raise FetchError(
                                "HTTP_ERROR",
                                f"HTTP {status}",
                                url=_safe_label(url),
                                status=status,
                                attempts=attempts,
                            )
                        if delay_ms:
                            self._sleep_fn(delay_ms / 1000)
                        continue
                else:
                    status = exc.status
                    code = exc.code
            else:
                status = response.status_code
                code = "HTTP_ERROR" if status >= 400 else "OK"
                if status < 400:
                    attempts.append(
                        FetchAttempt(request_number, transport.name, code, status, 0)
                    )
                    return response, attempts
                if status != 429 and status < 500:
                    attempts.append(
                        FetchAttempt(request_number, transport.name, code, status, 0)
                    )
                    raise FetchError(
                        "HTTP_ERROR",
                        f"HTTP {status}",
                        url=_safe_label(url),
                        status=status,
                        attempts=attempts,
                    )
                body = response.body
                if len(body) > max_bytes:
                    attempts.append(
                        FetchAttempt(request_number, transport.name, code, status, 0)
                    )
                    raise FetchError(
                        "RESPONSE_TOO_LARGE",
                        f"response body {len(body)} bytes exceeds {max_bytes} cap",
                        url=_safe_label(url),
                        status=status,
                        attempts=attempts,
                    )
                retry_after = _retry_after_seconds(response.headers.get("retry-after"))
                delay_ms = (
                    self._backoff_delay(request_number, retry_after)
                    if request_number < self._max_requests
                    else 0
                )
                attempts.append(
                    FetchAttempt(request_number, transport.name, code, status, delay_ms)
                )
                if request_number >= self._max_requests:
                    raise FetchError(
                        "HTTP_ERROR",
                        f"HTTP {status}",
                        url=_safe_label(url),
                        status=status,
                        attempts=attempts,
                    )
                if delay_ms:
                    self._sleep_fn(delay_ms / 1000)
                continue

            delay_ms = (
                self._backoff_delay(request_number)
                if request_number < self._max_requests
                else 0
            )
            attempts.append(FetchAttempt(request_number, transport.name, code, status, delay_ms))
            if request_number >= self._max_requests:
                raise FetchError(
                    code,
                    last_error.message if last_error is not None else code,
                    url=(last_error.url if last_error is not None else None) or _safe_label(url),
                    status=status,
                    attempts=attempts,
                )
            if delay_ms:
                self._sleep_fn(delay_ms / 1000)
        raise FetchError(
            "TRANSPORT_ERROR",
            "request budget exhausted",
            url=_safe_label(url),
            attempts=attempts,
        )

    def fetch(
        self,
        url: str,
        *,
        kind: str,
    ) -> FetchedResource:
        """Fetch ``url`` and return a bounded, validated resource.

        ``kind`` is ``"issue"`` or ``"article"`` and selects the byte cap.

        Each hop resolves the target hostname, validates that every
        returned address is public, and pins the first public IP into the
        actual TCP/TLS connection. The HTTP ``Host`` header and TLS SNI
        continue to advertise the original hostname so the connection is
        indistinguishable from a normal client to a cooperative server,
        but a rebinding attacker cannot substitute a private IP because
        the second DNS lookup never happens.
        """

        if kind not in ("issue", "article"):
            raise FetchError("INVALID_KIND", f"unknown fetch kind {kind!r}")
        max_bytes = self._max_issue_bytes if kind == "issue" else self._max_article_bytes

        current_url = url
        current_hostname, current_ip = _validate_url_and_resolve(current_url)
        attempts: list[FetchAttempt] = []

        for hop in range(self._max_redirects + 1):
            response, hop_attempts = self._request_with_retry(
                url=current_url,
                hostname=current_hostname,
                pinned_ip=current_ip,
                max_bytes=max_bytes,
            )
            attempts.extend(hop_attempts)

            if response.status_code in (301, 302, 303, 307, 308):
                if hop >= self._max_redirects:
                    raise FetchError(
                        "TOO_MANY_REDIRECTS",
                        f"too many redirects (> {self._max_redirects})",
                        url=_safe_label(current_url),
                        attempts=attempts,
                    )
                location = response.headers.get("location")
                if not location:
                    raise FetchError(
                        "REDIRECT_MISSING_LOCATION",
                        "redirect status without Location header",
                        url=_safe_label(current_url),
                        attempts=attempts,
                    )
                next_url = _resolve_redirect_url(current_url, location)
                # Per-hop fresh resolve + fresh pin. No parent-hop IP reuse.
                next_hostname, next_ip = _validate_url_and_resolve(next_url)
                current_url = next_url
                current_hostname = next_hostname
                current_ip = next_ip
                continue

            content_type = response.headers.get("content-type")
            if not _acceptable_content_type(content_type):
                raise FetchError(
                    "UNSUPPORTED_CONTENT_TYPE",
                    f"content-type {content_type!r} is not supported",
                    url=_safe_label(current_url),
                    attempts=attempts,
                )

            body = response.body
            if len(body) > max_bytes:
                raise FetchError(
                    "RESPONSE_TOO_LARGE",
                    f"response body {len(body)} bytes exceeds {max_bytes} cap",
                    url=_safe_label(current_url),
                    attempts=attempts,
                )

            canonical_url = _strip_tracking_query(current_url)
            return FetchedResource(
                url=canonical_url,
                body=body,
                content_type=content_type or "text/html",
                final_url=canonical_url,
                attempts=tuple(attempts),
            )

        raise FetchError(
            "TOO_MANY_REDIRECTS",
            f"too many redirects (> {self._max_redirects})",
            url=_safe_label(current_url),
            attempts=attempts,
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
        max_requests=getattr(settings, "fetch_max_requests", 3),
        backoff_base_seconds=getattr(settings, "fetch_backoff_base_seconds", 1.0),
        backoff_max_seconds=getattr(settings, "fetch_backoff_max_seconds", 30.0),
    )


__all__ = [
    "CurlTransport",
    "FetchAttempt",
    "FetchError",
    "FetchedResource",
    "HttpXTransport",
    "SafeFetcher",
    "Transport",
    "TransportResponse",
    "make_fetcher",
]
