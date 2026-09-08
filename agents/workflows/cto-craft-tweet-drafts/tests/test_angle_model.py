from __future__ import annotations

import json
import subprocess

import pytest

from cto_craft_workflow.angle_model import (
    AngleOutput,
    AnglePrompt,
    OpenClawInvocationConfig,
    OpenClawStructuredAngleModel,
    _ANGLE_EVALUATOR_PROMPT,
    _TOM_WORLDVIEW_PROFILE,
    _build_openclaw_message,
    load_prompts,
)


def _prompt() -> AnglePrompt:
    return AnglePrompt(
        system_prompt="system",
        user_message="user",
    )


def _result(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["openclaw"], returncode=0, stdout=json.dumps({"ok": True, "outputs": [{"text": stdout, "mediaUrl": None}]}), stderr="")


def test_openclaw_model_parses_valid_json() -> None:
    calls: list[tuple[list[str], str, float, str]] = []

    def runner(args: list[str], message: str, timeout_seconds: float, cwd: str):
        calls.append((args, message, timeout_seconds, cwd))
        return _result(
            '{"canonical_url":"https://example.com/a","angle":"Good angle","tweet_body":"Tweet","evidence_excerpt":"Excerpt","resonance_score":0.8,"evidence_strength":0.7,"worldview_axes":["anti_fluff"]}'
        )

    model = OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(model="minimax-portal/MiniMax-M3", max_attempts=2),
        runner=runner,
    )

    out = model.evaluate_one(
        prompt=_prompt(),
        canonical_url="https://example.com/a",
        timeout_seconds=12.0,
    )

    assert isinstance(out, AngleOutput)
    assert out.canonical_url == "https://example.com/a"
    assert len(calls) == 1
    args, message, timeout_seconds, _cwd = calls[0]
    assert args[:4] == ["openclaw", "infer", "model", "run"]
    assert "--gateway" in args
    assert "--json" in args
    assert args[-2:] == ["--prompt", "__PROMPT__"]
    assert timeout_seconds == 12.0
    assert "Return exactly one JSON value and nothing else." in message


def test_openclaw_model_retries_invalid_json_then_succeeds() -> None:
    attempts = 0

    def runner(args: list[str], message: str, timeout_seconds: float, cwd: str):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return _result("not json")
        return _result(
            '{"canonical_url":"https://example.com/a","angle":"Good angle","tweet_body":"Tweet","evidence_excerpt":"Excerpt","resonance_score":0.8,"evidence_strength":0.7,"worldview_axes":[]}'
        )

    model = OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(max_attempts=2),
        runner=runner,
    )

    out = model.evaluate_one(
        prompt=_prompt(),
        canonical_url="https://example.com/a",
        timeout_seconds=5.0,
    )

    assert out is not None
    assert attempts == 2


def test_openclaw_model_retries_transient_process_failure_then_succeeds() -> None:
    attempts = 0

    def runner(args: list[str], message: str, timeout_seconds: float, cwd: str):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise subprocess.CalledProcessError(
                1,
                args,
                output="Internal error",
                stderr="",
            )
        return _result(
            '{"canonical_url":"https://example.com/a","angle":"Good angle","tweet_body":"Tweet","evidence_excerpt":"Excerpt","resonance_score":0.8,"evidence_strength":0.7,"worldview_axes":[]}'
        )

    model = OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(max_attempts=2),
        runner=runner,
    )

    out = model.evaluate_one(
        prompt=_prompt(),
        canonical_url="https://example.com/a",
        timeout_seconds=5.0,
    )

    assert out is not None
    assert attempts == 2


def test_openclaw_model_returns_none_after_permanent_failure() -> None:
    attempts = 0

    def runner(args: list[str], message: str, timeout_seconds: float, cwd: str):
        nonlocal attempts
        attempts += 1
        raise subprocess.CalledProcessError(
            1,
            args,
            output="missing scopes: api.responses.write",
            stderr="",
        )

    model = OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(max_attempts=3),
        runner=runner,
    )

    out = model.evaluate_one(
        prompt=_prompt(),
        canonical_url="https://example.com/a",
        timeout_seconds=5.0,
    )

    assert out is None
    assert attempts == 1


def test_openclaw_model_returns_none_after_retry_exhaustion() -> None:
    attempts = 0

    def runner(args: list[str], message: str, timeout_seconds: float, cwd: str):
        nonlocal attempts
        attempts += 1
        return _result('{"canonical_url":"https://wrong.example/a","angle":"Good angle","tweet_body":"Tweet","evidence_excerpt":"Excerpt","resonance_score":0.8,"evidence_strength":0.7,"worldview_axes":[]}')

    model = OpenClawStructuredAngleModel(
        config=OpenClawInvocationConfig(max_attempts=2),
        runner=runner,
    )

    out = model.evaluate_one(
        prompt=_prompt(),
        canonical_url="https://example.com/a",
        timeout_seconds=5.0,
    )

    assert out is None
    assert attempts == 2


def test_openclaw_prompt_includes_schema_and_null_contract() -> None:
    message = _build_openclaw_message(_prompt())
    assert "Allowed outputs:" in message
    assert "- null if no angle qualifies" in message
    assert '"canonical_url"' in message


def test_load_prompts_returns_module_constants() -> None:
    """Defensive regression test: load_prompts() returns the cached module constants.

    Pins the contract that ``load_prompts()`` is a thin wrapper over the
    module-level prompt cache and performs no synchronous file I/O on the
    call path. Identity-equality (``is``) on the strings proves the
    function returns the same object the module-import-time helper
    produced — not a fresh re-read from disk.
    """
    system_prompt, worldview_profile = load_prompts()
    assert system_prompt is _ANGLE_EVALUATOR_PROMPT
    assert worldview_profile is _TOM_WORLDVIEW_PROFILE
    assert isinstance(system_prompt, str)
    assert isinstance(worldview_profile, str)
    assert len(system_prompt) > 0
    assert len(worldview_profile) > 0


def test_load_prompts_is_idempotent_across_calls() -> None:
    """Repeated calls to load_prompts() return the same string objects.

    Pins the cache contract from the call-site perspective: any second
    invocation must hand back the same cached strings as the first, never
    re-read the prompt files. A regression that re-reads synchronously on
    each call would produce distinct string objects per call and fail
    this identity check.
    """
    first_system, first_world = load_prompts()
    second_system, second_world = load_prompts()
    assert second_system is first_system
    assert second_world is first_world
