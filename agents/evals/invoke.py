"""Invoke a model once and return the text it produced.

Two transports, deliberately separated from the graders:

- ``infer`` — ``openclaw infer model run``. A raw, single-shot provider
  call with no agent context: the prompt goes in, text comes out, nothing
  else varies. This is the default because it isolates the model's
  reasoning from agent-loop variance, which is what makes two models'
  scores comparable.
- ``agent`` — ``openclaw agent --message-file``. A full agent turn with
  the agent's own ``AGENTS.md`` context and tools. Closer to how the
  factory actually invokes a model, so it is what the factory-shaped evals
  use when the whole agent loop is what is under test.

Both are invoked through bounded subprocesses: an eval that hangs is a
wasted model call and a stalled CI job.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_LIB = _REPO_ROOT / "agents" / "lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from subprocess_safe import safe_run  # noqa: E402  (path set above)

DEFAULT_TIMEOUT_SECONDS = 900.0

# A single argv entry cannot exceed the platform's MAX_ARG_STRLEN
# (256 KiB on macOS). Prompts are passed as one argument on the `infer`
# transport, so refuse rather than fail deep inside exec with an opaque
# E2BIG.
MAX_PROMPT_BYTES = 200_000


class ModelInvocationError(RuntimeError):
    """The model could not be run, or returned nothing usable."""


def _extract_text(payload: dict) -> str:
    """Pull the reply text out of whichever envelope the transport returned."""
    outputs = payload.get("outputs")
    if isinstance(outputs, list) and outputs:
        first = outputs[0]
        if isinstance(first, dict):
            text = first.get("text")
            if isinstance(text, str):
                return text.strip()
    for key in ("text", "reply", "message", "result", "content"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _describe_failure(payload: dict) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()
    if isinstance(error, str) and error.strip():
        return error.strip()
    return "no text output returned"


def invoke_model(
    model: str,
    prompt: str,
    *,
    transport: str = "infer",
    agent: str = "quinn",
    thinking: str | None = "low",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    extra_args: list[str] | None = None,
) -> tuple[str, dict]:
    """Run ``model`` once over ``prompt`` and return ``(text, raw_envelope)``."""
    if transport == "infer":
        if len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise ModelInvocationError(
                f"prompt is {len(prompt.encode('utf-8'))} bytes, over the "
                f"{MAX_PROMPT_BYTES}-byte argument limit for the infer transport; "
                "use the agent transport, or point the eval at a smaller fixture"
            )
        cmd = ["openclaw", "infer", "model", "run", "--model", model, "--json"]
        if thinking:
            cmd += ["--thinking", thinking]
        cmd += extra_args or []
        cmd += ["--prompt", prompt]
    elif transport == "agent":
        cmd = [
            "openclaw",
            "agent",
            "--agent",
            agent,
            "--model",
            model,
            "--json",
        ]
        if thinking:
            cmd += ["--thinking", thinking]
        cmd += extra_args or []
        # `--message-file` avoids the argv size limit entirely.
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".md", delete=False, encoding="utf-8"
        )
        try:
            handle.write(prompt)
            handle.close()
            cmd += ["--message-file", handle.name]
            completed = safe_run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        finally:
            pathlib.Path(handle.name).unlink(missing_ok=True)
        return _finish(completed, model, transport)
    else:
        raise ModelInvocationError(f"unknown transport: {transport!r}")

    completed = safe_run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return _finish(completed, model, transport)


def _finish(
    completed: subprocess.CompletedProcess, model: str, transport: str
) -> tuple[str, dict]:
    stdout = completed.stdout or ""
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        detail = (completed.stderr or stdout or "").strip()[:2000]
        raise ModelInvocationError(
            f"{transport} transport returned non-JSON for {model}: {exc}. {detail}"
        ) from exc
    if not isinstance(payload, dict):
        raise ModelInvocationError(f"{transport} transport returned a non-object payload")
    if payload.get("ok") is False:
        raise ModelInvocationError(f"{model}: {_describe_failure(payload)}")
    text = _extract_text(payload)
    if not text:
        raise ModelInvocationError(
            f"{model}: {_describe_failure(payload)} (no text output returned)"
        )
    return text, payload
