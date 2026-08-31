"""Self-healing transport for native Google Gemini GenerateContent calls."""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import httpx

from ..core.engine import (
    AsyncAutofixTransport,
    AutofixTransport,
    HealEvent,
    Route,
    make_clients,
    path_ends_with,
)

_ACTIONS = (":generateContent", ":streamGenerateContent")
_MODEL_MARKER = "/models/"


def _model_bounds(url: httpx.URL) -> Optional[Tuple[int, int]]:
    path = url.path
    end = path.rfind(":")
    marker = path.rfind(_MODEL_MARKER, 0, end)
    return None if marker < 0 or end < marker else (marker + len(_MODEL_MARKER), end)


def _model_from_url(url: httpx.URL) -> Optional[str]:
    bounds = _model_bounds(url)
    return None if bounds is None else url.path[bounds[0]:bounds[1]]


def _replay(url: httpx.URL, body: Dict[str, Any]) -> Tuple[httpx.URL, Dict[str, Any]]:
    next_body = dict(body)
    model = next_body.pop("model", None)
    bounds = _model_bounds(url)
    if not isinstance(model, str) or not model or bounds is None:
        return url, next_body
    bare_model = model[len("models/"):] if model.startswith("models/") else model
    path = f"{url.path[:bounds[0]]}{bare_model}{url.path[bounds[1]:]}"
    return url.copy_with(path=path), next_body


def detect(url: httpx.URL) -> Optional[Route]:
    """Recognize native GenerateContent calls on any configured Google base URL."""
    if not any(path_ends_with(url, action) for action in _ACTIONS):
        return None
    return Route(
        "gemini",
        "chat_completions",
        ("contents",),
        model=_model_from_url(url),
        provider_format="google_generate_content",
        redacted_fields=("contents", "systemInstruction", "tools"),
        replay=_replay,
    )


autofix, autofix_async = make_clients(detect)

__all__ = [
    "autofix",
    "autofix_async",
    "detect",
    "AutofixTransport",
    "AsyncAutofixTransport",
    "HealEvent",
]
