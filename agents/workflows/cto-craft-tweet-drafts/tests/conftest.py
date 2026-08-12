"""Shared test fixtures for the CTO Craft workflow tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> bytes:
    return (FIXTURES_DIR / name).read_bytes()


@pytest.fixture
def archive_html() -> bytes:
    return load_fixture("archive.html")


@pytest.fixture
def issue_html() -> bytes:
    return load_fixture("issue.html")


@pytest.fixture
def article_strong_html() -> bytes:
    return load_fixture("article-strong.html")


@pytest.fixture
def article_generic_html() -> bytes:
    return load_fixture("article-generic.html")


@pytest.fixture
def article_gated_html() -> bytes:
    return load_fixture("article-gated.html")


# Per-URL article HTML fixtures used by the graph integration tests.
# Each URL maps to a fixture whose <link rel="canonical"> matches that
# URL so the extractor returns distinct canonical URLs per article and
# the dedup logic has something to dedup against.
ARTICLE_URL_TO_FIXTURE: dict[str, str] = {
    "https://staysaasy.com/p/slow-iteration": "article-strong.html",
    "https://lethain.com/boundaries/": "article-boundary.html",
    "https://lethain.com/fluff-receipts/": "article-generic.html",
    "https://lethain.com/hiring-receiving-role/": "article-hiring.html",
}


@pytest.fixture
def article_routes() -> dict[str, bytes]:
    """Per-URL article bodies used by the graph transport."""

    return {url: load_fixture(name) for url, name in ARTICLE_URL_TO_FIXTURE.items()}


class FakeTransport(httpx.BaseTransport):
    """A minimal transport that serves a static URL → body map.

    The CTO Craft tests do not need a full mock HTTP library; they only
    need to feed the fetcher's `safe_fetch` parser deterministic bodies.
    """

    def __init__(self, routes: dict[str, tuple[int, bytes, dict[str, str]]] | None = None) -> None:
        self.routes: dict[str, tuple[int, bytes, dict[str, str]]] = routes or {}
        self.calls: list[tuple[str, str]] = []

    def register(self, url: str, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.routes[url] = (status, body, headers or {"content-type": "text/html"})

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append((request.method, url))
        if url not in self.routes:
            return httpx.Response(404, content=b"not found", headers={"content-type": "text/plain"})
        status, body, headers = self.routes[url]
        return httpx.Response(status, content=body, headers=headers)


@pytest.fixture
def fake_transport() -> FakeTransport:
    return FakeTransport()


__all__ = ["FakeTransport", "load_fixture", "FIXTURES_DIR"]
