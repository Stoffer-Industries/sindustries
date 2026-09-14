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
