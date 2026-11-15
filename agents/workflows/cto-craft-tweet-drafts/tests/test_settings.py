from __future__ import annotations

from cto_craft_workflow.settings import (
    DEFAULT_CONTENT_SCHEDULER_BASE_URL,
    load_settings,
)


def test_content_scheduler_defaults_to_prodlike_service(monkeypatch) -> None:
    monkeypatch.delenv("CONTENT_SCHEDULER_BASE_URL", raising=False)

    settings = load_settings(require_secrets=False)

    assert settings.content_scheduler_base_url == DEFAULT_CONTENT_SCHEDULER_BASE_URL
    assert settings.content_scheduler_base_url.endswith(":4004")


def test_fetch_retry_settings_have_safe_defaults(monkeypatch) -> None:
    monkeypatch.delenv("CTO_CRAFT_FETCH_MAX_REQUESTS", raising=False)
    monkeypatch.delenv("CTO_CRAFT_FETCH_BACKOFF_BASE_SECONDS", raising=False)
    monkeypatch.delenv("CTO_CRAFT_FETCH_BACKOFF_MAX_SECONDS", raising=False)

    settings = load_settings(require_secrets=False)

    assert settings.fetch_max_requests == 3
    assert settings.fetch_backoff_base_seconds == 1.0
    assert settings.fetch_backoff_max_seconds == 30.0


def test_fetch_retry_request_budget_is_capped(monkeypatch) -> None:
    monkeypatch.setenv("CTO_CRAFT_FETCH_MAX_REQUESTS", "4")

    try:
        load_settings(require_secrets=False)
    except RuntimeError as exc:
        assert "CTO_CRAFT_FETCH_MAX_REQUESTS" in str(exc)
    else:
        raise AssertionError("expected request budget validation failure")
