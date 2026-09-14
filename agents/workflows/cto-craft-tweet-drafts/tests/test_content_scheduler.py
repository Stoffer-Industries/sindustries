from __future__ import annotations

import httpx
import pytest

from cto_craft_workflow.content_scheduler import ImportClient
from cto_craft_workflow.content_scheduler import ImportError as ContentSchedulerImportError


def test_transport_error_includes_the_attempted_base_url() -> None:
    """A ConnectError must name the URL it tried to reach.

    Regression for the 2026-09-14 incident: the workflow's fallback base
    URL pointed at the wrong port (:4000 instead of the prodlike :4004),
    and the resulting `TRANSPORT_ERROR: transport error: ConnectError`
    message gave no clue *which* URL failed. Diagnosing it required a live
    investigation instead of reading the error. The base URL is not a
    secret, so it is safe to include.
    """

    def _raise_connect_error(*_args: object, **_kwargs: object) -> httpx.Response:
        raise httpx.ConnectError("boom")

    client = ImportClient(
        base_url="http://localhost:4000",
        ingest_secret=None,
        require_secret=False,
    )
    try:
        client._client.post = _raise_connect_error  # type: ignore[method-assign]

        with pytest.raises(ContentSchedulerImportError) as excinfo:
            client.import_drafts([{"sourceRef": "https://example.com/x"}])

        assert excinfo.value.code == "TRANSPORT_ERROR"
        assert "http://localhost:4000" in str(excinfo.value)
    finally:
        client.close()


def test_timeout_error_includes_the_attempted_base_url() -> None:
    def _raise_timeout(*_args: object, **_kwargs: object) -> httpx.Response:
        raise httpx.TimeoutException("boom")

    client = ImportClient(
        base_url="http://localhost:4004",
        ingest_secret=None,
        require_secret=False,
        timeout_seconds=5.0,
    )
    try:
        client._client.post = _raise_timeout  # type: ignore[method-assign]

        with pytest.raises(ContentSchedulerImportError) as excinfo:
            client.import_drafts([{"sourceRef": "https://example.com/x"}])

        assert excinfo.value.code == "TIMEOUT"
        assert "http://localhost:4004" in str(excinfo.value)
    finally:
        client.close()
