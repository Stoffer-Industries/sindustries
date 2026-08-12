"""Content Scheduler import client for the CTO Craft pipeline.

This module is the only place the workflow talks to the Content Scheduler
over the network. The import endpoint is
``POST /api/v1/content-scheduler/imports/cto-craft`` and is authenticated
via the ``x-content-ingest-secret`` header when the API has the secret
configured.

The client is intentionally small: a single ``ImportClient`` with one
method, ``import_drafts``. The graph calls ``import_fn`` (a lambda
wrapping this client) so the rest of the workflow stays HTTP-free.

The HTTP layer is wrapped in :class:`ImportError` so the graph can log
diagnostics without leaking response bodies or secrets.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx


IMPORT_PATH = "/api/v1/content-scheduler/imports/cto-craft"


class ImportError(Exception):
    """Raised when the import endpoint rejects the batch.

    The message is redacted: it never includes the request body, response
    body, or the secret value. The status code and a short classification
    are preserved.
    """

    def __init__(self, code: str, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class ImportResponse:
    """Parsed, validated response from the import endpoint."""

    created_count: int
    skipped_duplicate_count: int
    created_ids: list[str]
    source_refs: list[str]


def _classify_error(status_code: int) -> str:
    if status_code in (401, 403):
        return "AUTH_REJECTED"
    if status_code == 409:
        return "CONFLICT"
    if 400 <= status_code < 500:
        return "BAD_REQUEST"
    if 500 <= status_code < 600:
        return "SERVER_ERROR"
    return "UNKNOWN_ERROR"


class ImportClient:
    """Synchronous Content Scheduler import client."""

    def __init__(
        self,
        *,
        base_url: str,
        ingest_secret: str | None,
        require_secret: bool,
        timeout_seconds: float = 15.0,
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._ingest_secret = ingest_secret
        self._require_secret = require_secret
        self._timeout_seconds = timeout_seconds
        self._client = client or httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            headers={"User-Agent": "sindustries-cto-craft-workflow/0.1"},
        )

    def close(self) -> None:
        if self._client is not None:
            self._client.close()

    def __enter__(self) -> "ImportClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def import_drafts(self, items: list[dict]) -> ImportResponse:
        """Post ``items`` to the import endpoint and return the parsed response."""

        if not isinstance(items, list) or not items:
            raise ImportError("EMPTY_BATCH", "items must be a non-empty list")

        if self._require_secret and not self._ingest_secret:
            raise ImportError(
                "MISSING_SECRET",
                "CONTENT_SCHEDULER_INGEST_SECRET is required but not configured",
            )

        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self._ingest_secret:
            headers["x-content-ingest-secret"] = self._ingest_secret

        try:
            response = self._client.post(
                f"{self._base_url}{IMPORT_PATH}",
                json={"items": items},
                headers=headers,
            )
        except httpx.TimeoutException as exc:
            raise ImportError("TIMEOUT", f"timeout after {self._timeout_seconds}s") from exc
        except httpx.HTTPError as exc:
            raise ImportError(
                "TRANSPORT_ERROR", f"transport error: {exc.__class__.__name__}"
            ) from exc

        if response.status_code >= 400:
            raise ImportError(
                _classify_error(response.status_code),
                f"HTTP {response.status_code}",
                status_code=response.status_code,
            )

        try:
            payload = response.json()
        except json.JSONDecodeError as exc:
            raise ImportError("BAD_JSON", "import response was not valid JSON") from exc

        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise ImportError("BAD_RESPONSE_SHAPE", "import response data was not a dict")

        created = int(data.get("createdCount", 0))
        skipped = int(data.get("skippedDuplicateCount", 0))
        ids = list(data.get("createdIds") or [])
        refs = list(data.get("sourceRefs") or [])
        if created < 0 or skipped < 0:
            raise ImportError("BAD_COUNTS", "counts must be non-negative")
        return ImportResponse(
            created_count=created,
            skipped_duplicate_count=skipped,
            created_ids=[str(i) for i in ids],
            source_refs=[str(r) for r in refs],
        )


def response_to_dict(response: ImportResponse) -> dict:
    """Convert an :class:`ImportResponse` to the dict shape the graph expects."""

    return {
        "createdCount": response.created_count,
        "skippedDuplicateCount": response.skipped_duplicate_count,
        "createdIds": response.created_ids,
        "sourceRefs": response.source_refs,
    }


def make_import_fn(client: ImportClient):
    """Build a graph-compatible ``import_fn`` callable from an :class:`ImportClient`."""

    def _import(items: list[dict]) -> dict:
        return response_to_dict(client.import_drafts(items))

    return _import


__all__ = [
    "ImportError",
    "ImportResponse",
    "ImportClient",
    "IMPORT_PATH",
    "make_import_fn",
    "response_to_dict",
]
