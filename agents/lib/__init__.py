"""Agents library — shared Python helpers used across agent definitions.

Modules:
- incident_state: Unified agent incident parser (Quinn + Lox) — task 75ec1c8c.
- subprocess_safe: Bounded-time `subprocess.run` / `subprocess.Popen` wrappers — task 8a2df49c.
"""

from .subprocess_safe import DEFAULT_TIMEOUT_SECONDS, safe_popen, safe_run

__all__ = ["safe_run", "safe_popen", "DEFAULT_TIMEOUT_SECONDS"]
